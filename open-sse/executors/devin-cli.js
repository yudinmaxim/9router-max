/**
 * DevinCliExecutor — routes completions through the official Devin CLI binary
 * via the Agent Client Protocol (ACP) JSON-RPC 2.0 over stdio.
 *
 * Protocol flow:
 *   1. Spawn `devin acp` (default agent = full built-in tools: fs/shell/search).
 *      Set CLI_DEVIN_AGENT_TYPE=summarizer for a tool-less, text-only mode.
 *   2. Send: initialize → session/new (with model + cwd + mcpServers) → session/prompt.
 *   3. Receive: session/update notifications (agent_message_chunk = reply text,
 *      tool_call/tool_call_update = built-in tool invocations, surfaced as text).
 *      When devin calls a client-tool from the exposed MCP ("Calling mcp_X from
 *      clientTools"), it is bridged to an OpenAI tool_use and the turn ends.
 *   4. Emit deltas as OpenAI-compatible SSE chunks.
 *   5. Kill subprocess on _cognition.ai/agent_stopped or error.
 *
 * Auth: noAuth — the subprocess inherits the parent env and uses credentials
 * stored by `devin auth login` (~/.local/share/devin/credentials.toml).
 *
 * Binary discovery: CLI_DEVIN_BIN env → PATH lookup → platform installer paths.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.js";
import { rpc, resolveWorkspaceCwd, buildPromptText, extractMessages, agentSpawnCommand } from "./lib/acpCommon.js";

// ─── Binary discovery ────────────────────────────────────────────────────────

function resolveDevinBin() {
  // 1. Explicit override
  const envBin = process.env.CLI_DEVIN_BIN?.trim();
  if (envBin) return envBin;

  const isWin = process.platform === "win32";
  const home = os.homedir();

  // 2. Known installer / package-manager locations. spawn uses shell:false on
  //    macOS/Linux, so process.env.PATH alone may miss ~/.local/bin, Homebrew,
  //    Scoop, etc. when the server runs detached (tray/daemon/launchd) without
  //    a login shell — probe these explicitly before falling back to PATH.
  const candidates = isWin
    ? [
      // Official installer: %LOCALAPPDATA%\devin\cli\bin\devin.exe
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "devin", "cli", "bin", "devin.exe"),
      path.join(home, ".local", "bin", "devin.exe"),
      path.join(home, "scoop", "shims", "devin.exe"),
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "devin", "devin.exe"),
    ]
    : [
      path.join(home, ".local", "share", "devin", "bin", "devin"),
      path.join(home, ".devin", "bin", "devin"),
      path.join(home, ".local", "bin", "devin"), // pipx / user install
      "/opt/homebrew/bin/devin",                  // Homebrew (Apple Silicon)
      "/usr/local/bin/devin",                     // Homebrew (Intel) / manual
      "/usr/bin/devin",
    ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  // 3. Fallback — rely on process.env.PATH
  return isWin ? "devin.exe" : "devin";
}

// ─── Client-tools → MCP bridge ───────────────────────────────────────────────
// The bridge itself lives in lib/acpClientTools.js — it is protocol-level, not
// devin-specific. devin only discovers MCP tools whose name carries the `mcp_`
// prefix, so it is the one agent that configures a prefix.
import {
  buildClientToolsMcp,
  cleanupToolCallSink,
  clientToolDeclarations,
  createToolCallSink,
  detectClientToolName,
  drainToolCallSink,
  extractClientToolResults,
  fromMcpToolName,
} from "./lib/acpClientTools.js";

const DEVIN_CLIENT_TOOL_PREFIX = "mcp_";

// ─── DevinCliExecutor ─────────────────────────────────────────────────────────

export class DevinCliExecutor extends BaseExecutor {
  constructor() {
    super("devin-cli", { id: "devin-cli", baseUrl: "devin://acp/stdio" });
  }

  buildUrl() {
    return "devin://acp/stdio";
  }

  buildHeaders() {
    return {};
  }

  transformRequest() {
    return null;
  }

  async execute({ model, body, credentials, signal, log }) {
    const b = body ?? {};
    const messages = extractMessages(b);
    const promptText = buildPromptText(messages);
    const workspaceCwd = resolveWorkspaceCwd(b);
    const devinBin = resolveDevinBin();

    log?.info?.(
      "DEVIN",
      `devin acp → model=${model}, bin=${devinBin}, cwd=${workspaceCwd}`
    );

    // Optional MCP servers via DEVIN_MCP_SERVERS (JSON object, devin config format):
    //   {"echo":{"command":"/abs/node","args":["/srv/echo.js"],"env":{"K":"V"}}}
    // Plus body.tools (OpenAI schema) → exposed as a "clientTools" MCP
    // server so devin can invoke client-defined tools (bridged back in Phase 2).
    // When any are present, a throwaway XDG_CONFIG_HOME holds devin/config.json so
    // the agent auto-connects them (session/new mcpServers alone doesn't spawn
    // them — see ACP mcp/connect, still unstable). Cleaned up on finish.
    // NOTE: this replaces the user's global devin MCP config for the subprocess.
    let mcpConfigDir = null;
    const mcpServers = {};
    const mcpJson = process.env.DEVIN_MCP_SERVERS?.trim();
    if (mcpJson) {
      try {
        Object.assign(mcpServers, JSON.parse(mcpJson));
      } catch (e) {
        log?.info?.("DEVIN", `DEVIN_MCP_SERVERS parse failed: ${e.message}`);
      }
    }
    const clientTools = Array.isArray(b.tools) ? b.tools.filter(Boolean) : [];
    const clientToolResults = extractClientToolResults(messages, {
      prefix: DEVIN_CLIENT_TOOL_PREFIX,
    });
    // The bridge records real calls here. devin does name the tool in its
    // notification title, so the title path below still works, but the sink
    // does not depend on an agent's prose staying the same shape.
    const clientToolSink = clientTools.some((t) => t?.function?.name || t?.name)
      ? createToolCallSink()
      : null;
    const clientToolsMcp = buildClientToolsMcp(clientTools, clientToolResults, {
      prefix: DEVIN_CLIENT_TOOL_PREFIX,
      scriptFile: "9router-devin-client-tools.mjs",
      sink: clientToolSink || "",
      // devin's config.json takes env as an object; the ACP stdio variant
      // cursor/opencode validate against wants an array of {name, value}.
      envAsObject: true,
    });
    const hasClientTools = !!clientToolsMcp;
    const knownClientTools = new Set(
      clientToolDeclarations(clientTools, DEVIN_CLIENT_TOOL_PREFIX).map((t) => t.name)
    );
    if (clientToolsMcp) {
      // devin's config.json keys the servers itself, so the ACP `name` field
      // has no place there and is dropped rather than sent as an unknown key.
      const { name: _bridgeName, ...bridgeServer } = clientToolsMcp;
      mcpServers["clientTools"] = bridgeServer;
      const seeded = Object.keys(clientToolResults).length;
      log?.info?.(
        "DEVIN",
        `exposing ${clientTools.length} client tool(s) as MCP` +
          (seeded ? ` (seeded ${seeded} result(s))` : "")
      );
    }
    if (Object.keys(mcpServers).length) {
      try {
        mcpConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "devin-mcp-"));
        const cfgDev = path.join(mcpConfigDir, "devin");
        fs.mkdirSync(cfgDev, { recursive: true });
        fs.writeFileSync(
          path.join(cfgDev, "config.json"),
          JSON.stringify({ mcpServers })
        );
        log?.info?.("DEVIN", `mcp config written → ${mcpConfigDir}`);
      } catch (e) {
        log?.info?.("DEVIN", `mcp config write failed: ${e.message}`);
        mcpConfigDir = null;
      }
    }
    const cleanupMcp = () => {
      if (!mcpConfigDir) return;
      try {
        fs.rmSync(mcpConfigDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      mcpConfigDir = null;
    };

    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const emit = (data) => controller.enqueue(enc.encode(data));

        // Inherit the parent environment so devin resolves stored CLI credentials
        // (~/.local/share/devin/credentials.toml from `devin auth login`). Do NOT
        // inject WINDSURF_API_KEY: this provider is noAuth, and a bogus/leaked key
        // overrides stored creds and makes devin return -32000 "invalid api key".
        const env = { ...process.env };
        // DEVIN_PERMISSION_MODE is deliberately NOT defaulted to "bypass" here.
        // An explicit CLI_DEVIN_PERMISSION_MODE / DEVIN_PERMISSION_MODE in the
        // environment still passes through via the spread above.
        //
        // Leaving the agent in its own default mode means it asks before running
        // shell/exec tools, and this executor answers those requests below. That
        // is strictly safer than blanket authority: the grant is routed through
        // 9router, so it is logged and attributable instead of invisible. Using
        // bypass did not change what was approved — the handler below approves
        // every request either way.
        if (mcpConfigDir) env.XDG_CONFIG_HOME = mcpConfigDir;
        if (mcpConfigDir) env.XDG_CONFIG_HOME = mcpConfigDir;

        // Agent type: default (omitted) = full agent with built-in tools
        // (fs/shell/search) so the model can actually perform tasks. Override to
        // `summarizer` (no tools, text-only) via CLI_DEVIN_AGENT_TYPE for a safer,
        // tool-less mode. WARNING: the default agent can run shell commands and
        // modify the filesystem on the host running 9router — only expose locally.
        const agentType = process.env.CLI_DEVIN_AGENT_TYPE?.trim();
        const acpArgs = ["acp"];
        if (agentType) acpArgs.push("--agent-type", agentType);

        // Spawn in the client workspace cwd (from <cwd> env context) so built-in
        // file tools create/delete relative paths in the user's project.
        // MCP config still comes from XDG_CONFIG_HOME (throwaway), not project .devin/.
        const { cmd, args: spawnArgs, shell } = agentSpawnCommand(devinBin, acpArgs);
        const child = spawn(cmd, spawnArgs, {
          env,
          cwd: workspaceCwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell,
        });

        let spawnError = null;
        let stdinClosed = false;

        child.on("error", (err) => {
          spawnError = err;
          const msg =
            err.message.includes("ENOENT") || err.message.includes("not found")
              ? `Devin CLI not found: ${devinBin}. Install via https://cli.devin.ai or set CLI_DEVIN_BIN env var.`
              : `Devin CLI spawn error: ${err.message}`;
          emit(
            `data: ${JSON.stringify({ error: { message: msg, type: "devin_cli_error", code: "spawn_failed" } })}\n\n`
          );
          emit("data: [DONE]\n\n");
          controller.close();
          cleanupToolCallSink(clientToolSink);
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            if (!child.killed) child.kill("SIGTERM");
          });
        }

        // ── JSON-RPC state machine ──────────────────────────────────────────
        let idCounter = 1;
        let sessionId = null;
        let initDone = false;
        let sessionCreated = false;
        let promptSent = false;
        const responseId = `chatcmpl-devin-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let roleEmitted = false;
        let totalText = "";
        let finished = false;

        const sendRpc = (method, params) => {
          if (stdinClosed || child.stdin.destroyed) return;
          const id = idCounter++;
          try {
            child.stdin.write(rpc(method, params, id));
          } catch {
            /* ignore write errors after close */
          }
          return id;
        };

        // Emit a content delta as an OpenAI-compatible SSE chunk (handles the
        // leading role chunk once).
        const emitDelta = (delta) => {
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
              })}\n\n`
            );
            roleEmitted = true;
          }
          totalText += delta;
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`
          );
        };

        // Emit an OpenAI tool_call delta (function calling). Ends the turn with
        // finish_reason "tool_calls" so the client executes and returns tool_result.
        let toolUseEmitted = false;
        // ACP tool_call is upsert-by-id: the first event has title, a later update
        // may only carry rawInput (title omitted). Track pending client-tool calls.
        const pendingClientTools = new Map(); // toolCallId → original tool name
        const takeSinkCall = () => {
          if (!clientToolSink || toolUseEmitted) return false;
          const calls = drainToolCallSink(clientToolSink);
          if (!calls.length) return false;
          toolUseEmitted = true;
          emitToolUse(
            fromMcpToolName(calls[0].name, DEVIN_CLIENT_TOOL_PREFIX),
            calls[0].arguments,
            `call_${Date.now()}`
          );
          finish(null, "tool_calls");
          return true;
        };
        const emitToolUse = (toolName, args, toolCallId) => {
          const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
          if (!roleEmitted) {
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
              })}\n\n`
            );
            roleEmitted = true;
          }
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: toolCallId,
                        type: "function",
                        function: { name: toolName, arguments: argsStr },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            })}\n\n`
          );
        };

        const finish = (error, finishReason = "stop") => {
          if (finished) return;
          finished = true;

          if (error) {
            emit(
              `data: ${JSON.stringify({ error: { message: error, type: "devin_cli_error" } })}\n\n`
            );
          } else {
            // Emit finish chunk
            emit(
              `data: ${JSON.stringify({
                id: responseId,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
                usage: {
                  prompt_tokens: Math.ceil(promptText.length / 4),
                  completion_tokens: Math.ceil(totalText.length / 4),
                  total_tokens: Math.ceil((promptText.length + totalText.length) / 4),
                  estimated: true,
                },
              })}\n\n`
            );
          }
          emit("data: [DONE]\n\n");

          // Gracefully close stdin → devin will exit
          try {
            if (!stdinClosed) {
              stdinClosed = true;
              child.stdin.end();
            }
          } catch {
            /* ignore */
          }

          // Give it 2s to exit cleanly, then SIGKILL
          const killTimer = setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2000);
          killTimer.unref?.();

          controller.close();
          cleanupMcp();
          cleanupToolCallSink(clientToolSink);
        };

        // ── stdout reader (NDJSON) ──────────────────────────────────────────
        let buffer = "";

        child.stdout.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let nl;
          // Each ACP message is a newline-terminated JSON line
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;

            let msg;
            try {
              msg = JSON.parse(line);
            } catch {
              continue; // ignore non-JSON lines (banner text, etc.)
            }

            // ── Initialize response ───────────────────────────────────────
            if (!initDone && msg.result !== undefined && !msg.method) {
              initDone = true;
              // Create session with the client workspace cwd so agent file tools
              // resolve relative paths against the project (not /tmp).
              // `mcpServers` is required by devin 3000.2.x (must be a sequence);
              // omitting it returns -32602 "Invalid params: missing field mcpServers".
              sendRpc("session/new", {
                cwd: workspaceCwd,
                mcpServers: [],
                model: model || undefined,
              });
              continue;
            }

            // ── session/new response → get sessionId ──────────────────────
            if (initDone && !sessionCreated && msg.result !== undefined && !msg.method) {
              const res = msg.result || {};
              sessionId = res.sessionId || null;
              if (!sessionId) {
                finish("Devin ACP: session/new returned no sessionId");
                return;
              }
              sessionCreated = true;
              // Send the prompt. devin 3000.2.x expects `prompt` (a sequence),
              // not `content` — using `content` returns -32602 "missing field prompt".
              promptSent = true;
              sendRpc("session/prompt", {
                sessionId,
                prompt: [{ type: "text", text: promptText }],
              });
              continue;
            }

            // ── session/prompt response (ack / final result) ────────────
            if (sessionCreated && promptSent && msg.result !== undefined && !msg.method) {
              // Devin 3000.2.x only resolves session/prompt with the final result
              // (stopReason) after streaming completes. Streaming notifications are
              // handled below; nothing to do here unless we never streamed.
              if (!roleEmitted) {
                const res = msg.result || undefined;
                const content = extractResultText(res);
                if (content) {
                  totalText = content;
                  emitDelta(content);
                }
                const stopReason = (res && res.stopReason) || "";
                if (stopReason && stopReason !== "cancelled") {
                  finish();
                  return;
                }
              }
              continue;
            }

            // ── Permission requests → approve, but log every grant ──
            // Devin asks before running shell/exec tools; as a headless proxy we
            // have nobody to prompt, so we approve. The approval is recorded here
            // rather than hidden behind the agent's bypass mode, which would give
            // it blanket authority with no trace.
            if (msg.method === "session/request_permission" && msg.id !== undefined) {
              const options = msg.params?.options || [];
              const allow =
                options.find((o) => /allow/i.test(String(o.kind || ""))) || options[0];
              if (allow) {
                console.warn(
                  `[devin-cli] approving ${String(allow.kind || "unspecified")} ` +
                  `permission for tool ${String(msg.params?.toolCallId || "?")} ` +
                  "(no operator to prompt — 9router runs this provider headless)"
                );
                child.stdin.write(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: msg.id,
                    result: { outcome: { outcome: "selected", optionId: allow.optionId } },
                  }) + "\n"
                );
              }
              continue;
            }

            // ── Agent stopped notification (devin 3000.2.x stop signal) ───
            if (msg.method === "_cognition.ai/agent_stopped" || msg.method === "$/agent_stopped") {
              const cause = msg.params?.cause;
              if (cause === "error") {
                // devin uses errorMessage on this notification (not message/error).
                const errText =
                  msg.params?.errorMessage ||
                  msg.params?.message ||
                  msg.params?.error ||
                  "Devin agent error";
                finish(String(errText));
              } else {
                finish();
              }
              return;
            }

            // ── Streaming notifications (session/update) ──────────────────
            if (msg.method === "session/update" || msg.method === "$/update") {
              const params = msg.params;
              if (!params) continue;

              // devin 3000.2.x nests the payload under params.update.sessionUpdate;
              // older devin used a flat params.type.
              const update = params.update || {};
              const type = update.sessionUpdate || params.type;
              const contentField = update.content !== undefined ? update.content : params.content;
              const deltaText =
                typeof contentField === "string"
                  ? contentField
                  : contentField?.text ?? params.delta ?? params.text ?? "";

              // ── Client-tool bridge: devin calling a tool from our exposed MCP ──
              // ACP title shape: "Calling mcp_<name> from clientTools".
              // tool_call is upsert-by-id: title may only appear on the first event,
              // rawInput on a later tool_call_update. Track pending ids so we don't
              // require both fields on the same notification.
              if (
                hasClientTools &&
                !toolUseEmitted &&
                (type === "tool_call" || type === "tool_call_update")
              ) {
                if (hasClientTools && !toolUseEmitted && takeSinkCall()) return;
                const tcId = update.toolCallId;
                // devin names the tool in `title` ("Calling mcp_x from clientTools")
                // rather than a structured field; detectClientToolName matches the
                // declared names against whatever text the notification carries.
                const detected = detectClientToolName(update, knownClientTools, DEVIN_CLIENT_TOOL_PREFIX);
                if (tcId && detected) pendingClientTools.set(tcId, detected);
                const origName = tcId ? pendingClientTools.get(tcId) : null;
                if (origName && update.rawInput) {
                  toolUseEmitted = true;
                  pendingClientTools.delete(tcId);
                  emitToolUse(origName, update.rawInput, tcId || `call_${Date.now()}`);
                  finish(null, "tool_calls");
                  return;
                }
                continue;
              }

              if (type === "agent_message_chunk" || type === "message_delta" || type === "text_delta" || type === "content_delta") {
                if (deltaText) emitDelta(deltaText);
              } else if (type === "agent_thought_chunk") {
                // Internal reasoning — not surfaced to the client.
              } else if (type === "message_stop" || type === "stop" || type === "done") {
                finish();
                return;
              } else if (type === "error") {
                finish(String(params.message || params.error || "Devin ACP error"));
                return;
              }
              continue;
            }

            // ── Error responses ───────────────────────────────────────────
            if (msg.error) {
              finish(`Devin ACP error ${msg.error.code}: ${msg.error.message}`);
              return;
            }
          }
        });

        child.stderr.on("data", (chunk) => {
          log?.debug?.("DEVIN", `stderr: ${chunk.toString("utf8").slice(0, 200)}`);
        });

        child.on("close", (code) => {
          if (!finished) {
            if (code !== 0 && !spawnError) {
              finish(roleEmitted ? undefined : `Devin CLI exited with code ${code}`);
            } else {
              finish();
            }
          } else {
            cleanupMcp();
          }
        });

        // ── Send initialize ───────────────────────────────────────────────
        sendRpc("initialize", {
          protocolVersion: "0.3",
          clientInfo: { name: "9router", version: "1.0" },
          capabilities: {},
        });
      },
    });

    return {
      response: new Response(sseStream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      }),
      url: "devin://acp/stdio",
      headers: {},
      transformedBody: {
        model,
        cwd: workspaceCwd,
        clientTools: clientTools.map((t) => t?.function?.name || t?.name).filter(Boolean),
        clientToolResults: Object.keys(clientToolResults),
        mcpServers: Object.keys(mcpServers),
        promptLength: Array.isArray(body?.messages)
          ? body.messages.length
          : Array.isArray(body?.input)
            ? body.input.length
            : 0,
      },
    };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Extract text from a final ACP session/prompt result object across common shapes.
function extractResultText(result) {
  // { message: { content: "..." } }
  // { messages: [{ content: "..." }] }
  // { content: "..." }
  // { text: "..." }
  if (typeof result.content === "string") return result.content;
  if (typeof result.text === "string") return result.text;
  const msg = result.message;
  if (msg && typeof msg.content === "string") return msg.content;
  const msgs = result.messages;
  if (Array.isArray(msgs)) {
    return msgs
      .filter((m) => m.role === "assistant")
      .map((m) => String(m.content || ""))
      .join("\n");
  }
  return "";
}

export default DevinCliExecutor;
