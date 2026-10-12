/**
 * AcpAgentExecutor — routes a completion through a locally installed coding
 * agent over the Agent Client Protocol (JSON-RPC 2.0 over stdio).
 *
 * One class serves every ACP-speaking CLI: `cursor-agent acp`, `opencode acp`,
 * `omp acp`, `codex acp`. Credentials are whatever the CLI already holds; the
 * subprocess inherits the parent env, so these providers are noAuth.
 *
 * Protocol flow (verified by probing cursor-agent 2026.07.16, opencode 1.18.35
 * and omp 18.8.0 — all three speak protocolVersion 1):
 *   1. Spawn `<bin> acp`.
 *   2. initialize (protocolVersion 1).
 *   3. session/new { cwd, mcpServers: [] } → sessionId plus a model catalog.
 *   4. Pick a model from the catalog and pin it with
 *      `session/set_config_option { sessionId, configId: "model", value }`.
 *   5. session/prompt { sessionId, prompt: [{ type: "text", text }] } →
 *      a stream of `session/update` notifications, then a result with
 *      `stopReason`.
 *
 * Model selection is the one part that differs between agents, and this is the
 * part worth understanding:
 *   - `session/new` returns `models.availableModels` (cursor) or
 *     `configOptions[]` (opencode, omp). Both are read here and merged.
 *   - `session/set_model` exists on cursor and opencode but NOT on omp, which
 *     only has `session/set_mode`. `session/set_config_option` with
 *     `configId: "model"` is the one call all three accept — verified to return
 *     the updated `configOptions` on each. The field is `configId`, not
 *     `optionId`; sending the latter yields `-32602 Unknown ACP config option`.
 *   - opencode additionally validates that a model id is provider-qualified
 *     (`opencode/big-pickle`), rejecting a bare name with `-32602`.
 *
 * Why one request = one full turn: the agent runs its own shell/fs tools and
 * reports them over ACP. There is no client-tool channel in these builds —
 * `agentCapabilities.mcpCapabilities` advertises http/sse only, and MCP tools
 * dispatch to a stub that never calls back. So `tool_call` notifications are
 * progress, not OpenAI `tool_calls`; re-emitting them would double-execute.
 * `body.tools` from the client are therefore ignored and the agent runs the
 * task end to end with its own toolbelt.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "../base.js";
import { rpc, resolveWorkspaceCwd, buildPromptText, extractMessages, estimateTokens, agentSpawnCommand } from "./acpCommon.js";

const ACP_URL = "acp://stdio";

// Cursor's explicit "let the agent decide" entry. Other agents have no
// equivalent, so this is only ever used when the catalog actually contains it.
const AUTO_MODEL = "default[]";

// ─── Binary discovery ────────────────────────────────────────────────────────

/**
 * Locate an agent CLI the way the installers actually lay it out.
 *
 * The server usually runs detached (tray, launchd) without a login shell, so
 * PATH alone is not reliable — several of these binaries live in ~/.local/bin
 * or under an nvm prefix that a non-login shell never reads. Probe the
 * installer-specific locations first, then fall back to the bare name and let
 * the spawn report the failure.
 *
 * @param {object} spec
 * @param {string} spec.envVar     env override, e.g. CLI_CURSOR_BIN
 * @param {string} spec.exe        binary name, e.g. cursor-agent
 * @param {string} [spec.versionsDir]  dir holding <version>/<exe> subdirs
 * @param {string[]} [spec.extraDirs]   additional absolute dirs to probe
 */
export function resolveAgentBin({ envVar, exe, versionsDir, extraDirs = [] }) {
  const envBin = process.env[envVar]?.trim();
  if (envBin) return envBin;

  const isWin = process.platform === "win32";
  const home = os.homedir();
  const bin = isWin ? `${exe}.exe` : exe;

  const candidates = [];
  if (versionsDir) {
    try {
      const versions = fs
        .readdirSync(versionsDir)
        .filter((v) => fs.existsSync(path.join(versionsDir, v, bin)))
        .sort()
        .reverse();
      for (const v of versions) candidates.push(path.join(versionsDir, v, bin));
    } catch {
      /* no versioned install */
    }
  }

  if (isWin) {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "Programs", exe, bin),
      path.join(home, ".local", "bin", bin),
      path.join(home, "scoop", "shims", bin),
    );
  } else {
    candidates.push(path.join(home, ".local", "bin", bin));
  }

  candidates.push(...extraDirs);
  candidates.push(
    "/opt/homebrew/bin/" + bin,
    "/usr/local/bin/" + bin,
    "/usr/bin/" + bin,
  );

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* ignore */
    }
  }
  return bin;
}

// ─── Model id resolution ─────────────────────────────────────────────────────

/** `gpt-5.3-codex[reasoning=medium]` → `gpt-5.3-codex` */
export function acpModelName(modelId) {
  return String(modelId || "").split("[")[0].trim();
}

/** `opencode/big-pickle` → `big-pickle` — the provider qualifier is not part of the name */
function acpModelBase(modelId) {
  const name = acpModelName(modelId);
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

/** Separator-insensitive form: `claude-opus-5-5` and `claude-opus-5.5` both → `claudeopus55` */
function canonModelName(modelId) {
  return acpModelName(modelId).toLowerCase().replace(/[._\- /]+/g, "");
}

/**
 * A model that routes back into this router would make the agent call the
 * gateway that spawned it — an unbounded loop. Users do configure their CLIs
 * that way (omp's default `model` option is literally `nine-router/oc-robust`),
 * so the catalog has to be screened, not trusted.
 */
export function isSelfRouted(modelId) {
  return /(nine-?router|9router|localhost:2012[78]|127\.0\.0\.1:2012[78])/i.test(String(modelId || ""));
}

/**
 * Read the model catalog out of a `session/new` result, merging the two shapes
 * agents use: `models.availableModels` (cursor) and a `configOptions` entry
 * with `id === "model"` (opencode, omp).
 *
 * Options come back as either plain strings or `{ id | modelId, name }`
 * objects, so both are normalized here. Lookups are by `id`/`category`, never by
 * index — omp lists `mode` first, so position means nothing.
 */
export function collectModelCatalog(sessionResult) {
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const id = typeof value === "string" ? value : (value?.modelId ?? value?.id);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  const available = sessionResult?.models?.availableModels;
  if (Array.isArray(available)) available.forEach(push);

  const options = sessionResult?.configOptions;
  if (Array.isArray(options)) {
    for (const opt of options) {
      const id = typeof opt === "string" ? opt : opt?.id;
      if (id !== "model") continue;
      const values = typeof opt === "object" ? (opt.values ?? opt.options ?? opt.enumValues) : null;
      if (Array.isArray(values)) values.forEach(push);
      else if (typeof opt?.currentValue === "string") push(opt.currentValue);
    }
  }

  return out;
}

/** The agent's currently selected model, from either response shape. */
export function currentAgentModel(sessionResult) {
  const current = sessionResult?.models?.currentModelId;
  if (typeof current === "string" && current) return current;
  const options = sessionResult?.configOptions;
  if (Array.isArray(options)) {
    for (const opt of options) {
      if (opt && typeof opt === "object" && opt.id === "model" && typeof opt.currentValue === "string") {
        return opt.currentValue;
      }
    }
  }
  return "";
}

/**
 * Map a client-sent model id onto an exact id from the agent's catalog.
 *
 * Clients address models without the bracketed option list and often without
 * the provider qualifier (`oca/big-pickle` → `big-pickle`), while agents insist
 * on both — cursor answers `-32602 Invalid model value` for an unknown id and
 * opencode rejects an unqualified one. Match order: exact id → exact name →
 * exact base name → separator-insensitive name → shortest name prefix (so
 * `gpt-5.4` picks `gpt-5.4`, not `gpt-5.4-mini`).
 *
 * With no catalog at all (older CLI) the request is forwarded untouched. An
 * unmatched id degrades to the agent's current model rather than erroring.
 */
export function resolveAgentModelId(requested, catalog, current = "") {
  const want = String(requested || "").trim();
  const ids = Array.isArray(catalog) ? catalog : [];
  const usable = ids.filter((id) => !isSelfRouted(id));

  if (!want) return usable[0] || current || "";
  if (!usable.length) return want;
  if (usable.includes(want)) return want;

  const wantName = acpModelName(want).toLowerCase();
  const wantBase = acpModelBase(want).toLowerCase();
  const byLength = (a, b) => acpModelName(a).length - acpModelName(b).length;

  const byExactName = (target) => usable.find((id) => acpModelName(id).toLowerCase() === target);
  const exactName = byExactName(wantName);
  if (exactName) return exactName;
  const exactBase = byExactName(wantBase);
  if (exactBase) return exactBase;

  const canonWant = canonModelName(want);
  const canonExact = usable.find((id) => canonModelName(id) === canonWant);
  if (canonExact) return canonExact;

  const prefixed = usable.filter((id) => acpModelName(id).toLowerCase().startsWith(wantName)).sort(byLength);
  if (prefixed.length) return prefixed[0];

  const canonPrefixed = usable.filter((id) => canonModelName(id).startsWith(canonWant)).sort(byLength);
  if (canonPrefixed.length) return canonPrefixed[0];

  // Nothing matched: let the agent choose. `default[]` is cursor's explicit
  // Auto entry and is preferred over whatever the CLI happens to be pinned to;
  // agents without it fall back to their current model.
  return AUTO_MODEL && usable.includes(AUTO_MODEL) ? AUTO_MODEL : (current || usable[0]);
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
      // cancelled / tool_use / unknown — the agent finished the turn either way.
      return "stop";
  }
}

// ─── AcpAgentExecutor ────────────────────────────────────────────────────────

export class AcpAgentExecutor extends BaseExecutor {
  /**
   * @param {string} providerId  registry id this instance is registered under
   * @param {object} spec
   * @param {string} spec.exe        binary name, e.g. `omp`
   * @param {string} spec.envVar     env override for the binary path
   * @param {string} [spec.args]     args after the binary (default `["acp"]`)
   * @param {string} [spec.tag]      log tag (default: the provider id, uppercased)
   * @param {string} [spec.label]    human-readable agent name for error messages
   * @param {string} spec.installHint  how to install, shown when the binary is missing
   * @param {string} [spec.versionsDir]
   * @param {string[]} [spec.extraDirs]
   */
  constructor(providerId, spec) {
    super(providerId, { id: providerId, baseUrl: ACP_URL, noAuth: true });
    this.acp = {
      args: ["acp"],
      tag: providerId.toUpperCase(),
      label: providerId,
      errorType: "acp_error",
      extraDirs: [],
      ...spec,
    };
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
    const { exe, envVar, args, tag, label, installHint, errorType, versionsDir, extraDirs } = this.acp;
    const b = body ?? {};
    const messages = extractMessages(b);
    const promptText = buildPromptText(messages);
    const workspaceCwd = resolveWorkspaceCwd(b);
    const bin = resolveAgentBin({ envVar, exe, versionsDir, extraDirs });

    log?.info?.(tag, `${exe} ${args.join(" ")} → model=${model}, bin=${bin}, cwd=${workspaceCwd}`);

    const sseStream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        // `close` can race `error` (both fire when the binary is missing), and
        // the agent may emit trailing notifications after we stop the turn — so
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

        // Inherit the parent environment: the CLI reads its stored auth and its
        // default model from its own config files. Nothing is injected — a bogus
        // key here would override the agent's own credentials.
        const env = { ...process.env };

        const { cmd, args: spawnArgs, shell } = agentSpawnCommand(bin, args);
        const child = spawn(cmd, spawnArgs, {
          env,
          cwd: workspaceCwd,
          stdio: ["pipe", "pipe", "pipe"],
          shell,
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
        let catalog = [];
        let resolvedModelId = null;

        const responseId = `chatcmpl-acp-${Date.now()}`;
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
                error: { message: error, type: errorType, ...(errorCode ? { code: errorCode } : {}) },
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
          const missing = err.message.includes("ENOENT") || err.message.includes("not found");
          finish(
            missing
              ? `${label} CLI not found: ${bin}. ${installHint} (or set ${envVar}).`
              : `${label} CLI spawn error: ${err.message}`,
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
              // -32602). The agent runs its own tools; we pass none.
              sendRpc("session/new", { cwd: workspaceCwd, mcpServers: [] });
              continue;
            }

            // ── session/new response → sessionId + model catalog ──────────
            if (initDone && !sessionCreated && msg.result !== undefined && !msg.method) {
              const res = msg.result || {};
              sessionId = res.sessionId || null;
              if (!sessionId) {
                finish(`ACP: session/new returned no sessionId`);
                return;
              }
              sessionCreated = true;
              catalog = collectModelCatalog(res);
              const current = currentAgentModel(res);
              resolvedModelId = resolveAgentModelId(model, catalog, current);
              log?.debug?.(tag, `session=${sessionId} current=${current} requested=${model} → ${resolvedModelId}`);

              if (resolvedModelId && isSelfRouted(resolvedModelId)) {
                finish(
                  `ACP: refusing to route back into 9router. The ${label} catalog only offers self-referential models; point the agent at a real upstream, or exclude this provider.`,
                  "stop",
                  "self_routed"
                );
                return;
              }

              if (resolvedModelId && resolvedModelId !== current) {
                sendRpc("session/set_config_option", {
                  sessionId,
                  configId: "model",
                  value: resolvedModelId,
                });
              } else {
                startPrompt();
              }
              continue;
            }

            // ── session/set_config_option response → send the prompt ───────
            if (sessionCreated && !promptSent && msg.result !== undefined && !msg.method) {
              startPrompt();
              continue;
            }

            // ── session/prompt response (final result) ───────────────────
            if (sessionCreated && promptSent && msg.result !== undefined && !msg.method) {
              const res = msg.result || undefined;
              const stopReason = res?.stopReason || "";
              if (stopReason === "cancelled" && !roleEmitted) {
                finish(`ACP: turn cancelled before any output`);
                return;
              }
              finish(null, mapStopReason(stopReason));
              return;
            }

            // ── client capability requests we deliberately don't answer ───
            // the agent may ask the client to sample/stop/elicitation, or to
            // read or write a file. These builds have no such client channel;
            // replying would only stall the turn, so the request is left
            // unanswered.
            if (msg.method && msg.id !== undefined && msg.id !== null) {
              if (
                msg.method === "session/request_permission" ||
                msg.method === "fs/read_text_file" ||
                msg.method === "fs/write_text_file"
              ) {
                log?.debug?.(tag, `unanswered client request: ${msg.method}`);
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
                // The agent is running its own tools — progress only. Surfacing
                // these as OpenAI tool_calls would re-run them client-side.
                if (update.status === "pending" || type === "tool_call") {
                  log?.debug?.(tag, `tool: ${update.title || update.kind || "?"}`);
                }
              } else if (type === "session_info_update") {
                log?.debug?.(tag, `title: ${update.title || ""}`);
              }
              continue;
            }

            // ── error responses ──────────────────────────────────────────
            if (msg.error) {
              const detail = msg.error.data
                ? ` (${JSON.stringify(msg.error.data)})`
                : "";
              finish(`${label} ACP error ${msg.error.code}: ${msg.error.message}${detail}`);
              return;
            }
          }
        });

        child.stderr.on("data", (chunkData) => {
          log?.debug?.(tag, `stderr: ${chunkData.toString("utf8").slice(0, 200)}`);
        });

        child.on("close", (code) => {
          if (finished) return;
          if (code !== 0 && !spawnError && !roleEmitted) {
            finish(`${label} CLI exited with code ${code}`);
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