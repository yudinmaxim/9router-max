/**
 * CursorAcpExecutor — routes completions through the locally installed
 * `cursor-agent` binary via the Agent Client Protocol (ACP, JSON-RPC 2.0 over
 * stdio). Credentials are whatever the CLI already holds (`cursor-agent login`
 * → ~/.cursor/cli-config.json); the subprocess inherits the parent env, so this
 * provider is noAuth.
 *
 * Protocol flow (verified against cursor-agent 2026.07.16):
 *   1. Spawn `cursor-agent acp`.
 *   2. initialize (protocolVersion 1)
 *      → session/new { cwd, mcpServers: [] }
 *        The agent answers with `models.currentModelId` + `models.availableModels`
 *        (ids look like `gpt-5.3-codex[reasoning=medium,fast=false]` — the
 *        bracketed options are PART of the id and an empty `[]` is invalid).
 *   3. session/set_model { sessionId, modelId } when the client asked for
 *      something other than the CLI's current model.
 *   4. session/prompt { sessionId, prompt: [{ type: "text", text }] } →
 *      a stream of `session/update` notifications:
 *        - agent_message_chunk → assistant text
 *        - agent_thought_chunk → reasoning
 *        - tool_call / tool_call_update → the agent running ITS OWN tools
 *      then a result carrying `stopReason`.
 *
 * Why one request = one full turn: cursor executes its own shell/fs tools and
 * reports them over ACP; there is no client-tool channel in this build (its
 * `agentCapabilities.mcpCapabilities` advertises http/sse only, and MCP tools
 * dispatch to a stub that never calls back). So `tool_call` notifications are
 * progress, not OpenAI `tool_calls` — re-emitting them would double-execute.
 * `body.tools` from the client are therefore ignored; the cursor agent runs the
 * task end to end with its own toolbelt.
 *
 * Binary discovery: CLI_CURSOR_BIN env → installer/known paths → PATH.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "./base.js";
import { rpc, resolveWorkspaceCwd, buildPromptText, extractMessages, estimateTokens } from "./lib/acpCommon.js";

const PROVIDER_ID = "cursor-acp";
const ACP_URL = "cursor://acp/stdio";

// Model id used when the client's choice can't be matched to the CLI catalog.
const AUTO_MODEL = "default[]";

// ─── Binary discovery ────────────────────────────────────────────────────────

function resolveCursorAgentBin() {
  const envBin = process.env.CLI_CURSOR_BIN?.trim();
  if (envBin) return envBin;

  const isWin = process.platform === "win32";
  const home = os.homedir();
  const exe = isWin ? "cursor-agent.exe" : "cursor-agent";

  // Installers drop the binary under ~/.local/share/cursor-agent/versions/<ver>/
  // and symlink it into ~/.local/bin. The server often runs detached (tray,
  // launchd) without a login shell, so PATH alone can miss ~/.local/bin — probe
  // explicit locations, newest version dir first.
  const candidates = [];
  if (isWin) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", "cursor-agent", exe),
      path.join(home, ".local", "bin", exe),
      path.join(home, "scoop", "shims", exe),
    );
  } else {
    const versionsDir = path.join(home, ".local", "share", "cursor-agent", "versions");
    try {
      const versions = fs
        .readdirSync(versionsDir)
        .filter((v) => fs.existsSync(path.join(versionsDir, v, exe)))
        .sort()
        .reverse();
      for (const v of versions) candidates.push(path.join(versionsDir, v, exe));
    } catch {
      /* no versioned install */
    }
    candidates.push(
      path.join(home, ".local", "bin", exe),
      path.join(home, ".local", "share", "cursor-agent", "bin", exe),
      "/opt/homebrew/bin/cursor-agent",
      "/usr/local/bin/cursor-agent",
      "/usr/bin/cursor-agent",
    );
  }
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return exe;
}

// ─── Model id resolution ─────────────────────────────────────────────────────

/** `gpt-5.3-codex[reasoning=medium]` → `gpt-5.3-codex` */
export function cursorModelName(modelId) {
  return String(modelId || "").split("[")[0].trim();
}

/** Separator-insensitive form: `claude-opus-5-5` and `claude-opus-5.5` both → `claudeopus55` */
function canonModelName(modelId) {
  return cursorModelName(modelId).toLowerCase().replace(/[._\- ]+/g, "");
}

/**
 * Map a client-sent model id onto an exact id from the CLI's `availableModels`.
 *
 * Clients address models bracket-free (`cx/gpt-5.3-codex`), and the bracketed
 * option list is mandatory upstream — cursor answers `-32602 Invalid model value`
 * for anything it doesn't know. Match order: exact id → exact name part →
 * separator-insensitive name → shortest name prefix (so `gpt-5.4` picks
 * `gpt-5.4`, not `gpt-5.4-mini`). With no catalog (older CLI) the request is
 * forwarded untouched; an unmatched id degrades to Auto rather than erroring.
 */
export function resolveCursorModelId(requested, availableModels = []) {
  const want = String(requested || "").trim();
  const ids = availableModels.map((m) => (typeof m === "string" ? m : m?.modelId)).filter(Boolean);
  if (!want) return ids.includes(AUTO_MODEL) ? AUTO_MODEL : ids[0] || AUTO_MODEL;
  if (!ids.length) return want;
  if (ids.includes(want)) return want;

  const wantName = cursorModelName(want).toLowerCase();
  const byLength = (a, b) => cursorModelName(a).length - cursorModelName(b).length;

  const exact = ids.find((id) => cursorModelName(id).toLowerCase() === wantName);
  if (exact) return exact;

  const canonWant = canonModelName(want);
  const canonExact = ids.find((id) => canonModelName(id) === canonWant);
  if (canonExact) return canonExact;

  const prefixed = ids
    .filter((id) => cursorModelName(id).toLowerCase().startsWith(wantName))
    .sort(byLength);
  if (prefixed.length) return prefixed[0];

  const canonPrefixed = ids.filter((id) => canonModelName(id).startsWith(canonWant)).sort(byLength);
  if (canonPrefixed.length) return canonPrefixed[0];

  return ids.includes(AUTO_MODEL) ? AUTO_MODEL : ids[0];
}

// ─── ACP stop reason → OpenAI finish_reason ──────────────────────────────────

function mapStopReason(stopReason) {
  switch (String(stopReason || "")) {
    case "end_turn":
    case "stop":
    case "endTurn":
    case "":
      return "stop";
    case "max_tokens":
    case "maxTokens":
      return "length";
    case "refusal":
      return "content_filter";
    default:
      // cancelled / tool_use / unknown — cursor finished the turn either way.
      return "stop";
  }
}

// ─── CursorAcpExecutor ───────────────────────────────────────────────────────

export class CursorAcpExecutor extends BaseExecutor {
  constructor() {
    super(PROVIDER_ID, { id: PROVIDER_ID, baseUrl: ACP_URL, noAuth: true });
  }

  buildUrl() {
    return ACP_URL;
  }

  buildHeaders() {
    return {};
  }

  transformRequest() {
    return null;
  }

  async refreshCredentials() {
    // Credentials live in the CLI's own store; nothing for 9router to refresh.
    return null;
  }

  needsRefresh() {
    return false;
  }

  async execute({ model, body, signal, log }) {
    const b = body ?? {};
    const messages = extractMessages(b);
    const promptText = buildPromptText(messages);
    const workspaceCwd = resolveWorkspaceCwd(b);
    const bin = resolveCursorAgentBin();

    log?.info?.("CURSOR-ACP", `cursor-agent acp → model=${model}, bin=${bin}, cwd=${workspaceCwd}`);

    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        // `close` can race `error` (both fire when the binary is missing), and
        // cursor may emit trailing notifications after we stop the turn — so
        // every write goes through here and a closed controller is final.
        let streamClosed = false;
        const emit = (data) => {
          if (streamClosed) return;
          try {
            controller.enqueue(enc.encode(data));
          } catch {
            streamClosed = true;
          }
        };
        const closeStream = () => {
          if (streamClosed) return;
          streamClosed = true;
          controller.close();
        };

        // Inherit the parent environment: cursor-agent reads its stored auth
        // from ~/.cursor/cli-config.json and its model choice from
        // ~/.cursor/acp-config.json. Nothing is injected — a bogus key here
        // would override the CLI's own credentials.
        const env = { ...process.env };

        const child = spawn(bin, ["acp"], {
          env,
          cwd: workspaceCwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell: process.platform === "win32",
        });

        let spawnError = null;
        let stdinClosed = false;

        if (signal) {
          signal.addEventListener("abort", () => {
            if (!child.killed) child.kill("SIGTERM");
          });
        }

        // ── JSON-RPC state machine ──────────────────────────────────────────
        let idCounter = 1;
        let initDone = false;
        let sessionCreated = false;
        let promptSent = false;
        let sessionId = null;
        let availableModels = [];
        let resolvedModelId = null;

        const responseId = `chatcmpl-cursor-${Date.now()}`;
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

        const chunk = (delta, finishReason = null, extra = {}) => {
          emit(
            `data: ${JSON.stringify({
              id: responseId,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta, finish_reason: finishReason }],
              ...extra,
            })}\n\n`
          );
        };

        // Leading role chunk, emitted once before any content/reasoning delta.
        const ensureRole = () => {
          if (roleEmitted) return;
          chunk({ role: "assistant", content: "" });
          roleEmitted = true;
        };

        const emitDelta = (text) => {
          if (!text) return;
          ensureRole();
          totalText += text;
          chunk({ content: text });
        };

        const emitReasoning = (text) => {
          if (!text) return;
          ensureRole();
          chunk({ reasoning_content: text });
        };

        const finish = (error, finishReason = "stop", errorCode) => {
          if (finished) return;
          finished = true;

          if (error) {
            emit(
              `data: ${JSON.stringify({
                error: { message: error, type: "cursor_acp_error", ...(errorCode ? { code: errorCode } : {}) },
              })}\n\n`
            );
          } else {
            if (!roleEmitted) chunk({ role: "assistant", content: "" });
            chunk(
              {},
              finishReason,
              {
                usage: {
                  prompt_tokens: estimateTokens(promptText),
                  completion_tokens: estimateTokens(totalText),
                  total_tokens: estimateTokens(promptText) + estimateTokens(totalText),
                  estimated: true,
                },
              }
            );
          }
          emit("data: [DONE]\n\n");

          try {
            if (!stdinClosed) {
              stdinClosed = true;
              child.stdin.end();
            }
          } catch {
            /* ignore */
          }

          // Give the CLI a moment to exit cleanly, then make sure it does.
          const killTimer = setTimeout(() => {
            if (!child.killed) child.kill("SIGKILL");
          }, 2000);
          killTimer.unref?.();

          closeStream();
        };

        child.on("error", (err) => {
          spawnError = err;
          const missing =
            err.message.includes("ENOENT") || err.message.includes("not found");
          finish(
            missing
              ? `Cursor Agent CLI not found: ${bin}. Install with \`npm i -g cursor-agent\` (or see https://cursor.com/cli) and run \`cursor-agent login\`, or set CLI_CURSOR_BIN.`
              : `Cursor Agent CLI spawn error: ${err.message}`,
            "stop",
            missing ? "spawn_failed" : "spawn_error"
          );
        });

        const startPrompt = () => {
          promptSent = true;
          sendRpc("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: promptText }],
          });
        };

        // ── stdout reader (NDJSON) ──────────────────────────────────────────
        let buffer = "";

        child.stdout.on("data", (chunkData) => {
          buffer += chunkData.toString("utf8");
          let nl;
          // Each ACP message is a newline-terminated JSON line.
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

            // ── initialize response → open a session ──────────────────────
            if (!initDone && msg.result !== undefined && !msg.method) {
              initDone = true;
              // `mcpServers` must be a sequence (an object is rejected with
              // -32602). Cursor runs its own tools; we pass none.
              sendRpc("session/new", { cwd: workspaceCwd, mcpServers: [] });
              continue;
            }

            // ── session/new response → sessionId + model catalog ──────────
            if (initDone && !sessionCreated && msg.result !== undefined && !msg.method) {
              const res = msg.result || {};
              sessionId = res.sessionId || null;
              if (!sessionId) {
                finish("Cursor ACP: session/new returned no sessionId");
                return;
              }
              sessionCreated = true;
              availableModels = Array.isArray(res.models?.availableModels)
                ? res.models.availableModels
                : [];
              const current = res.models?.currentModelId || "";
              resolvedModelId = resolveCursorModelId(model, availableModels);
              log?.debug?.(
                "CURSOR-ACP",
                `session=${sessionId} current=${current} requested=${model} → ${resolvedModelId}`
              );

              if (resolvedModelId && resolvedModelId !== current) {
                const modelId = resolvedModelId;
                sendRpc("session/set_model", { sessionId, modelId });
              } else {
                startPrompt();
              }
              continue;
            }

            // ── session/set_model response → send the prompt ──────────────
            if (sessionCreated && !promptSent && msg.result !== undefined && !msg.method) {
              startPrompt();
              continue;
            }

            // ── session/prompt response (final result) ───────────────────
            if (sessionCreated && promptSent && msg.result !== undefined && !msg.method) {
              const res = msg.result || undefined;
              const stopReason = res?.stopReason || "";
              if (stopReason === "cancelled" && !roleEmitted) {
                finish("Cursor ACP: turn cancelled before any output");
                return;
              }
              finish(null, mapStopReason(stopReason));
              return;
            }

            // ── client capability requests we deliberately don't answer ───
            // cursor-agent may ask the client to sample/stop elicitation. This
            // build has no such client channel; replying would only stall the
            // turn, so the request is left unanswered.
            if (msg.method && msg.id !== undefined && msg.id !== null) {
              if (
                msg.method === "session/request_permission" ||
                msg.method === "fs/read_text_file" ||
                msg.method === "fs/write_text_file"
              ) {
                log?.debug?.("CURSOR-ACP", `unanswered client request: ${msg.method}`);
              }
              continue;
            }

            // ── session/update notifications ─────────────────────────────
            if (msg.method === "session/update") {
              const params = msg.params || {};
              const update = params.update || params;
              const type = update.sessionUpdate || params.sessionUpdate || update.type;

              if (type === "agent_message_chunk" || type === "message_delta") {
                const content = update.content ?? params.content;
                emitDelta(typeof content === "string" ? content : (content?.text ?? ""));
              } else if (type === "agent_thought_chunk") {
                const content = update.content ?? params.content;
                emitReasoning(typeof content === "string" ? content : (content?.text ?? ""));
              } else if (type === "tool_call" || type === "tool_call_update") {
                // Cursor is running its own tools — progress only. Surfacing
                // these as OpenAI tool_calls would re-run them client-side.
                if (update.status === "pending" || type === "tool_call") {
                  log?.debug?.("CURSOR-ACP", `tool: ${update.title || update.kind || "?"}`);
                }
              } else if (type === "session_info_update") {
                log?.debug?.("CURSOR-ACP", `title: ${update.title || ""}`);
              }
              continue;
            }

            // ── error responses ──────────────────────────────────────────
            if (msg.error) {
              const detail = msg.error.data
                ? ` (${JSON.stringify(msg.error.data)})`
                : "";
              finish(`Cursor ACP error ${msg.error.code}: ${msg.error.message}${detail}`);
              return;
            }
          }
        });

        child.stderr.on("data", (chunkData) => {
          log?.debug?.("CURSOR-ACP", `stderr: ${chunkData.toString("utf8").slice(0, 200)}`);
        });

        child.on("close", (code) => {
          if (finished) return;
          if (code !== 0 && !spawnError && !roleEmitted) {
            finish(`Cursor Agent CLI exited with code ${code}`);
          } else {
            // Streamed fine (or produced nothing) — close out as a normal turn.
            finish();
          }
        });

        // ── handshake ───────────────────────────────────────────────────────
        sendRpc("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "9router", version: this.config?.version || "1.0" },
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
      url: ACP_URL,
      headers: {},
      transformedBody: {
        model,
        cwd: workspaceCwd,
        messages: messages.length,
        promptLength: promptText.length,
        clientToolsIgnored: Array.isArray(b.tools) ? b.tools.length : 0,
      },
    };
  }
}

export default CursorAcpExecutor;