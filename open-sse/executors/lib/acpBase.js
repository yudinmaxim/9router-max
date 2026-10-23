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
 * reports them over ACP. Two facts shape the protocol work here, both verified
 * against `opencode acp` rather than assumed:
 *
 *   - `session/request_permission` is a request, not a notification. The agent
 *     blocks the turn until the client answers; unanswered means the turn never
 *     returns. It is not gated on clientCapabilities — it arrives even when the
 *     client advertises nothing. Always answered; what we answer comes from the
 *     permission policy (see acpPermissions.js), which the dashboard configures
 *     per router and per provider.
 *   - `tool_call` / `tool_call_update` notifications are the agent narrating
 *     its *own* sandbox tools. Re-emitting them as OpenAI `tool_calls` would
 *     double-execute, so they are logged, not forwarded. Their `kind` is also
 *     the only truthful record of what an action is: the permission request
 *     itself reports `kind: "other"` for both reads and writes.
 *
 * Client-side `body.tools` therefore reach the agent the other way round: the
 * agent advertises `mcpCapabilities: {http: true, sse: true}`, so registering
 * a bridge MCP server in `session/new` is the supported path for handing the
 * agent tools it cannot run itself. That bridge is live: `./acpClientTools.js`
 * declares `body.tools` as a stdio MCP server registered in `session/new`, and
 * when the agent calls one we emit an OpenAI `tool_calls` delta and end the
 * turn. The agent's own tools stay inside its sandbox and are only logged.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { BaseExecutor } from "../base.js";
import { ensureAcpAdapter } from "./acpAdapter.js";
import { createAcpTransport } from "./acpTransport.js";
import { acpSessionKey, acquireAcpSession, peekAcpSession, findAcpSession, putAcpSession, markAcpSessionDead } from "./acpSessionPool.js";
import { resolveWorkspaceCwd, buildPromptText, extractMessages, estimateTokens, agentSpawnCommand } from "./acpCommon.js";
import { stripHistoryForContext } from "../../services/capacityAdapter.js";
import { getCapabilitiesForModel } from "../../providers/capabilities.js";
import {
  classifyAction,
  rememberToolKind,
  targetPaths,
  decidePermission,
  mergePolicies,
  parsePolicyInput,
  chooseOption,
} from "./acpPermissions.js";
import { ACP_PERMISSION_HEADER, ACP_PERMISSION_BODY_KEY, ACP_DEFAULTS_HEADER, ACP_DEFAULTS_BODY_KEY, ACP_LIFECYCLE_LOG_ENV, ACP_LIFECYCLE_LOG_PATH } from "../../config/runtimeConfig.js";
import {
  CLIENT_TOOLS_SERVER_NAME,
  buildClientToolsMcp,
  cleanupToolCallSink,
  clientToolDeclarations,
  createToolCallSink,
  detectClientToolName,
  drainToolCallSink,
  extractClientToolResults,
  fromMcpToolName,
  unwrapClientToolArgs,
} from "./acpClientTools.js";

const ACP_URL = "acp://stdio";

/**
 * Opt-in lifecycle tracing for ACP child processes.
 *
 * The router runs detached under the tray (stdout → /dev/null), so console
 * logging is invisible when diagnosing "why did the pooled child die between
 * turns". One line per lifecycle event, appended to a file. The path comes from
 * config — see ACP_LIFECYCLE_LOG_ENV / ACP_LIFECYCLE_LOG_PATH — and tracing is
 * off unless one of them is set. Callers pass hosts only; no credentials.
 */
function acpTracePath() {
  const fromEnv = process.env[ACP_LIFECYCLE_LOG_ENV];
  return (typeof fromEnv === "string" && fromEnv.trim()) || ACP_LIFECYCLE_LOG_PATH || "";
}
function acpTrace(event, data = {}) {
  const file = acpTracePath();
  if (!file) return;
  try {
    fs.appendFileSync(file, `${new Date().toISOString()} ${event} ${JSON.stringify(data)}\n`);
  } catch {
    /* a tracing failure must never affect the request */
  }
}

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

  // extraDirs are directories, not binary paths. Accept either: a directory
  // gets the exe appended, an explicit file is taken as-is.
  candidates.push(
    ...extraDirs.map((entry) => {
      try {
        if (fs.statSync(entry).isFile()) return entry;
      } catch {
        /* not a file — treat it as a directory */
      }
      return path.join(entry, bin);
    })
  );

  // nvm keeps one dir per installed Node version, and only the current one has
  // the agent's global bin on PATH. Scanning (newest first) beats naming a
  // single version, which silently misses as soon as the user upgrades Node.
  const nvmVersions = path.join(home, ".nvm", "versions", "node");
  try {
    for (const version of fs
      .readdirSync(nvmVersions)
      .filter((v) => fs.existsSync(path.join(nvmVersions, v, bin)))
      .sort()
      .reverse()) {
      candidates.push(path.join(nvmVersions, version, bin));
    }
  } catch {
    /* no nvm install */
  }

  // PATH before the system directories: it is what the user actually runs from
  // their shell, whereas /usr/bin holds whatever a distro package installed
  // months ago and never updated.
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, bin));
  }

  candidates.push(
    "/opt/homebrew/bin/" + bin,
    "/usr/local/bin/" + bin,
    "/usr/bin/" + bin,
  );

  for (const candidate of candidates) {
    try {
      // Must be a regular file. existsSync also accepts directories, and
      // spawning one surfaces as a bare `EACCES` rather than "not installed",
      // which reads like a permissions problem instead of a bad lookup.
      if (fs.statSync(candidate).isFile()) return candidate;
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
 * that way — an omp used as a Zed agent resolves its `model` option to
 * `nine-router/ca/...` — so the catalog has to be screened, not trusted.
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
    // Catalog option shapes differ per agent: cursor sends `{modelId}`,
    // opencode and omp send `{value, name}`. Accept all three — silently
    // dropping `{value}` entries left the catalog empty, which made the
    // resolver pass the bare requested name straight to the agent and earn
    // `-32602 model not found`.
    const id = typeof value === "string" ? value : (value?.modelId ?? value?.id ?? value?.value);
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
/**
 * Catalog entries that are safe to select: everything except ids that point
 * back at this gateway.
 */
export function usableAgentModels(catalog) {
  const ids = Array.isArray(catalog) ? catalog : [];
  return ids.filter((id) => !isSelfRouted(id));
}

export function resolveAgentModelId(requested, catalog, current = "") {
  const want = String(requested || "").trim();
  const usable = usableAgentModels(catalog);

  if (!want) return usable[0] || current || "";
  if (!usable.length) return want;
  if (usable.includes(want)) return want;

  const wantName = acpModelName(want).toLowerCase();
  const wantBase = acpModelBase(want).toLowerCase();
  const byLength = (a, b) => acpModelName(a).length - acpModelName(b).length;

  const byExactName = (target) => usable.find((id) => acpModelName(id).toLowerCase() === target);
  const exactName = byExactName(wantName);
  if (exactName) return exactName;

  // Agent ids may be provider-qualified (`opencode/space-bunny-free`) while the
  // client asked for the bare name. Match on the part after the slash — without
  // this no opencode id ever matches, and the fallback below hands back the
  // CLI's current model, which is often a self-routed id.
  const byBase = (target) => usable.find((id) => acpModelBase(id).toLowerCase() === target);
  const exactBase = byBase(wantBase);
  if (exactBase) return exactBase;

  const canonWant = canonModelName(acpModelBase(want));
  const canonExact = usable.find((id) => canonModelName(acpModelBase(id)) === canonWant);
  if (canonExact) return canonExact;

  const prefixed = usable.filter((id) => acpModelBase(id).toLowerCase().startsWith(wantName)).sort(byLength);
  if (prefixed.length) return prefixed[0];

  const canonPrefixed = usable.filter((id) => canonModelName(acpModelBase(id)).startsWith(canonWant)).sort(byLength);
  if (canonPrefixed.length) return canonPrefixed[0];

  // Nothing matched: let the agent choose. `default[]` is cursor's explicit
  // Auto entry and is preferred over whatever the CLI happens to be pinned to;
  // agents without it fall back to their current model. A current model that
  // points back at this router is skipped — using it would make the agent call
  // the gateway that spawned it.
  if (AUTO_MODEL && usable.includes(AUTO_MODEL)) return AUTO_MODEL;
  if (current && !isSelfRouted(current)) return current;
  return usable[0];
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
   * @param {string} [spec.adapter]  ACP_ADAPTERS key — the CLI has no `acp`
   *   subcommand, so this bridge package is resolved and installed instead
   * @param {object|(() => object)} [spec.env]  extra env for the child process,
   *   merged over the inherited one (a function is called per request)
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

  async execute({ model, body, credentials, acpPermissions, acpSessionDefaults, mcpProxyTargets, proxyOptions = null, signal, log }) {
    const { exe, envVar, args, tag, label, installHint, errorType, versionsDir, extraDirs } = this.acp;
    const b = body ?? {};
    const contextWindow = getCapabilitiesForModel(this.providerId, model).contextWindow || 200000;
    const guardedBody = stripHistoryForContext(b, contextWindow);
    if (guardedBody !== b) log?.debug?.(tag, `trimmed ACP history for ${model}`);
    const messages = extractMessages(guardedBody);
    const promptText = buildPromptText(messages);
    const workspaceCwd = resolveWorkspaceCwd(b);
    // Resolved here rather than inside the stream's start(), which runs with the
    // stream as `this`.
    // Inherit the parent environment: the CLI reads its stored auth and its
    // default model from its own config files. Nothing is injected — a bogus
    // key here would override the agent's own credentials. A spec may add
    // its own entries (CODEX_PATH and friends); those still merge over the
    // inherited set rather than replacing it.
    const env = { ...process.env, ...(this.acp.env?.() || this.acp.env || {}) };
    if (proxyOptions?.connectionProxyEnabled && proxyOptions.connectionProxyUrl) {
      env.HTTP_PROXY = proxyOptions.connectionProxyUrl;
      env.HTTPS_PROXY = proxyOptions.connectionProxyUrl;
      env.ALL_PROXY = proxyOptions.connectionProxyUrl;
      if (proxyOptions.connectionNoProxy) env.NO_PROXY = proxyOptions.connectionNoProxy;
      log?.info?.("ACP_PROXY", JSON.stringify({
        provider: this.providerId,
        enabled: true,
        poolId: proxyOptions.connectionProxyPoolId || null,
        strict: proxyOptions.strictProxy === true,
        protocol: (() => { try { return new URL(proxyOptions.connectionProxyUrl).protocol; } catch { return null; } })(),
        host: (() => { try { return new URL(proxyOptions.connectionProxyUrl).hostname; } catch { return null; } })(),
      }));
    } else {
      log?.info?.("ACP_PROXY", JSON.stringify({ provider: this.providerId, enabled: false }));
    }
    // Host/pool only — the lifecycle trace must not carry proxy credentials.
    const proxyTrace = {
      proxyEnabled: Boolean(proxyOptions?.connectionProxyEnabled && proxyOptions.connectionProxyUrl),
      proxyPoolId: proxyOptions?.connectionProxyPoolId || null,
      proxyHost: (() => {
        try { return proxyOptions?.connectionProxyUrl ? new URL(proxyOptions.connectionProxyUrl).hostname : null; }
        catch { return null; }
      })(),
      // The pools all sit on 127.0.0.1 and differ only by port, so without it
      // a rotation trace would be unreadable.
      proxyPort: (() => {
        try { return proxyOptions?.connectionProxyUrl ? new URL(proxyOptions.connectionProxyUrl).port || null : null; }
        catch { return null; }
      })(),
    };
    // Agents whose CLI has no ACP subcommand spawn a bridge instead (see
    // acpAdapter.js), which may need installing on this machine the first time.
    const bin = this.acp.adapter
      ? (await ensureAcpAdapter(this.acp.adapter)) ||
        resolveAgentBin({ envVar, exe, versionsDir, extraDirs })
      : resolveAgentBin({ envVar, exe, versionsDir, extraDirs });

    // Permission policy, most specific last: router default → per-connection →
    // request body → request header. The request layers let a client loosen or
    // tighten for one call without persisting anything.
    const rawHeaders = credentials?.rawHeaders || {};
    const headerValue = rawHeaders[ACP_PERMISSION_HEADER];
    const bodyValue = b?.metadata?.[ACP_PERMISSION_BODY_KEY];
    const policy = mergePolicies(
      acpPermissions,
      parsePolicyInput(bodyValue),
      parsePolicyInput(Array.isArray(headerValue) ? headerValue[0] : headerValue)
    );

    // Options the operator pinned on the provider page. The request may override
    // them for one call, the same layering ACP permissions use — a per-request
    // header beats the dashboard without persisting anything.
    const requestDefaults = (() => {
      const headerValue2 = credentials?.rawHeaders?.[ACP_DEFAULTS_HEADER];
      const bodyValue2 = b?.metadata?.[ACP_DEFAULTS_BODY_KEY];
      return parsePolicyInput(bodyValue2) || parsePolicyInput(
        Array.isArray(headerValue2) ? headerValue2[0] : headerValue2
      );
    })();
    const sessionDefaults = { ...(acpSessionDefaults || {}), ...(requestDefaults || {}) };
    // `toolCallId → kind`, filled from session/update as the agent narrates its
    // own tools. The permission request reports `kind: "other"` for everything,
    // so this map is the only truthful source of what the action is.
    const seenToolKinds = new Map();

    // Client tools the caller sent in `body.tools`. Agents do not read these
    // from the request body — they only see MCP servers registered in
    // `session/new` — so they are bridged. Agents that rename bridged tools to
    // something the caller never declared would misreport the call back, so
    // the prefix stays empty unless the agent forces one.
    const clientToolPrefix = this.acp.clientToolPrefix || "";
    const clientTools = Array.isArray(b.tools) ? b.tools.filter(Boolean) : [];
    const clientToolResults = extractClientToolResults(messages, { prefix: clientToolPrefix });
    // ACP carries no structured field for which MCP tool an agent is invoking —
    // verified live, cursor-agent reports a bridged call as
    // {title:"MCP: tool", rawInput:{}} with neither name nor arguments. The
    // bridge server is the only process that sees them, so it records calls in
    // a per-request sink we drain.
    let clientToolSink = clientTools.some((t) => t?.function?.name || t?.name)
      ? createToolCallSink()
      : null;
    const clientToolsMcp = buildClientToolsMcp(clientTools, clientToolResults, {
      prefix: clientToolPrefix,
      scriptFile: this.acp.clientToolsScriptFile || "9router-acp-client-tools.mjs",
      sink: clientToolSink || "",
    });
    const knownClientTools = new Set(
      clientToolDeclarations(clientTools, clientToolPrefix).map((t) => t.name)
    );
    if (clientToolsMcp) {
      log?.info?.(
        tag,
        `bridging ${clientTools.length} client tool(s) as MCP` +
          (Object.keys(clientToolResults).length
            ? ` (seeded ${Object.keys(clientToolResults).length} result(s))`
            : "")
      );
    }

    log?.info?.(tag, `${exe} ${args.join(" ")} → model=${model}, bin=${bin}, cwd=${workspaceCwd}`);

    const sseStream = new ReadableStream({
      async start(controller) {
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
        // key here would override the agent's own credentials. A spec may add
        // its own entries (CODEX_PATH and friends); those still merge over the
        // inherited set rather than replacing it. Resolved out here because the
        // `start()` callback below runs with the stream as `this`.
        const sessionConnection = credentials?.connectionId || credentials?.connectionName;
        const sessionIdentity = sessionConnection
          ? { provider: this.providerId, connection: sessionConnection, cwd: workspaceCwd, model }
          : null;
        const sessionKey = sessionIdentity
          ? acpSessionKey({
              ...sessionIdentity,
              proxy: proxyOptions?.connectionProxyEnabled ? proxyOptions.connectionProxyUrl : "",
              noProxy: proxyOptions?.connectionNoProxy || "",
            })
          : null;
        let pooled = null;
        let releaseSession = null;
        // True once this turn stored its child in the pool (fresh session).
        let sessionPooledNow = false;
        let child;
        let transport;
        const { cmd, args: spawnArgs, shell } = agentSpawnCommand(bin, args);
        const existing = sessionKey ? peekAcpSession(sessionKey) : null;
        // A pooled entry can outlive its child: the child may exit on its own,
        // be killed by an aborted turn, or die with the pool entry still in the
        // map. Reusing its closed transport would hang the turn forever, so a
        // dead child demotes the entry to a plain `prior` (resume source).
        const reusable = Boolean(
          existing && !existing.dead && existing.sessionId &&
          existing.child && existing.child.exitCode === null && !existing.child.killed
        );
        const prior = existing || (sessionIdentity ? findAcpSession(sessionIdentity) : null);
        if (reusable) {
          const acquired = await acquireAcpSession(sessionKey);
          pooled = acquired.entry;
          releaseSession = acquired.release;
          child = pooled.child;
          transport = pooled.transport;
          acpTrace("reuse", { provider: this.providerId, pid: child.pid, sessionId: pooled.sessionId, ...proxyTrace });
        } else {
          child = spawn(cmd, spawnArgs, {
            env,
            cwd: workspaceCwd,
            stdio: ["pipe", "pipe", "pipe"],
            shell,
          });
          acpTrace("spawn", { provider: this.providerId, pid: child.pid, cmd, hadEntry: Boolean(existing), ...proxyTrace });
        }

        let spawnError = null;
        let stdinClosed = false;

        if (signal) {
          signal.addEventListener("abort", () => {
            acpTrace("abort-signal", { provider: this.providerId, pid: child.pid, killed: child.killed, finished });
            if (!child.killed) child.kill("SIGTERM");
          });
        }

        // ── JSON-RPC state machine ──────────────────────────────────────────
        let idCounter = 1;
        let initDone = false;
        let sessionCreated = false;
        let promptSent = false;
        let resumeAttempted = false;
        // Id of the in-flight session/resume|session/new request, so an empty
        // answer to *our* call is told apart from the unrelated response frames
        // agents emit while initialization is still completing.
        let sessionCreateRequestId = null;
        let sessionId = pooled?.sessionId || prior?.sessionId || null;
        let catalog = pooled?.catalog || prior?.catalog || [];
        if (pooled?.sessionId) {
          initDone = true;
          sessionCreated = true;
        }
        let resolvedModelId = null;
        // Config options still to pin on this session, applied one RPC at a
        // time before the prompt. The agent blocks on each, so they cannot be
        // fired in parallel.
        const pendingConfigSets = [];
        // In-flight `session/set_config_option` request ids → configId, so the
        // error handler can tell an option rejection from a turn failure.
        const configSetIds = new Map();

        const responseId = `chatcmpl-acp-${Date.now()}`;
        const created = Math.floor(Date.now() / 1000);
        let roleEmitted = false;
        let totalText = "";
        let finished = false;

        if (!transport) transport = createAcpTransport(child);
        const sendRpc = (method, params, beforeSend = null) => {
          const id = idCounter++;
          // Two ids have to be known before the write leaves: a config pin (so a
          // rejection maps to its option) and the session/new|resume call (so an
          // empty answer maps to our own request). An agent may answer inside
          // `stdin.write` — a test double does, and a fast local agent can — so
          // anything registered after the send can be raced by its own reply.
          if (method === "session/set_config_option") {
            configSetIds.set(id, { configId: params?.configId ?? "", value: params?.value });
          }
          if (beforeSend) beforeSend(id);
          const ok = transport.send(method, params, id);
          acpTrace("rpc-send", { provider: this.providerId, pid: child?.pid, id, method, ok: Boolean(ok) });
          if (!ok) configSetIds.delete(id);
          return ok ? id : null;
        };
        let removeMessageListener = null;

        // Answer an agent-initiated request under the id the agent chose.
        // Must not touch idCounter — that counter tracks requests we made, and
        // reusing its values would collide with their in-flight responses.
        const sendRpcRaw = (obj) => transport.sendRaw(obj);

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

        // The agent called a tool the client declared. Surface it as an OpenAI
        // tool_call and end the turn with `finish_reason: "tool_calls"` — the
        // client runs the tool and its result comes back on the next request.
        let toolUseEmitted = false;
        let sinkPoll = null;
        const pendingClientTools = new Map(); // toolCallId → original tool name
        const emitToolUse = (toolName, args, toolCallId) => {
          const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? {});
          ensureRole();
          chunk({
            tool_calls: [
              { index: 0, id: toolCallId, type: "function", function: { name: toolName, arguments: argsStr } },
            ],
          });
        };

        /**
         * Drain the sink and, if the agent called one of our tools, surface it
         * and end the turn. Returns true when it handled the call.
         */
        const takeSinkCall = () => {
          if (!clientToolSink || toolUseEmitted) return false;
          const calls = drainToolCallSink(clientToolSink);
          if (!calls.length) return false;
          const call = calls[0];
          toolUseEmitted = true;
          emitToolUse(fromMcpToolName(call.name, clientToolPrefix), call.arguments, `call_${Date.now()}`);
          finish(null, "tool_calls");
          return true;
        };

        const finish = (error, finishReason = "stop", errorCode) => {
          if (finished) return;
          finished = true;
          acpTrace("finish", {
            provider: this.providerId,
            pid: child.pid,
            error: error || null,
            finishReason,
            pooled: Boolean(pooled),
            pooledNow: sessionPooledNow,
            hadRelease: Boolean(releaseSession),
          });
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

          removeMessageListener?.();
          removeMessageListener = null;
          // A pooled child stays alive between turns — that is the whole point
          // of the pool. Both the reused entry (`releaseSession`) and a session
          // pooled during this turn (`sessionPooledNow`) must skip the stdin
          // close + SIGKILL below, otherwise the pool keeps a dead child.
          if (releaseSession || sessionPooledNow) {
            releaseSession?.();
            releaseSession = null;
            if (sinkPoll) {
              clearInterval(sinkPoll);
              sinkPoll = null;
            }
            cleanupToolCallSink(clientToolSink);
            clientToolSink = null;
            closeStream();
            return;
          }
          try {
            if (!stdinClosed) {
              stdinClosed = true;
              acpTrace("stdin-end", { provider: this.providerId, pid: child.pid });
              child.stdin.end();
            }
          } catch {
            /* ignore */
          }

          // Give the CLI a moment to exit cleanly, then make sure it does.
          const killTimer = setTimeout(() => {
            acpTrace("sigkill-timer", { provider: this.providerId, pid: child.pid, killed: child.killed });
            if (!child.killed) child.kill("SIGKILL");
          }, 2000);
          killTimer.unref?.();

          if (sinkPoll) {
            clearInterval(sinkPoll);
            sinkPoll = null;
          }
          cleanupToolCallSink(clientToolSink);
          clientToolSink = null;

          closeStream();
        };

        // Safety net for an agent that calls a bridged tool without announcing
        // it in the notification stream. Every cursor-agent build tested does
        // announce, so this is cheap insurance rather than the main path.
        if (clientToolsMcp) {
          sinkPoll = setInterval(() => {
            if (finished || toolUseEmitted) return;
            if (takeSinkCall()) {
              clearInterval(sinkPoll);
              sinkPoll = null;
            }
          }, 50);
          sinkPoll.unref?.();
        }

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
          acpTrace("prompt", { provider: this.providerId, pid: child.pid, sessionId, model });
          // A dead transport rejects nothing — `send` just returns void. Without
          // this check the turn would wait forever for a response that can
          // never arrive, holding the session queue behind it.
          if (!sendRpc("session/prompt", {
            sessionId,
            prompt: [{ type: "text", text: promptText }],
          })) {
            if (sessionKey && peekAcpSession(sessionKey)?.child === child) markAcpSessionDead(sessionKey);
            finish(`${label} ACP transport closed before the prompt could be sent`);
          }
        };

        /**
         * Send the next queued `session/set_config_option`, if any.
         *
         * These are the operator's dashboard choices (access mode, collaboration
         * mode, reasoning level) plus the model this request resolved to. A
         * failed option must not cost the turn: the agent's own default stands
         * and the prompt still goes out.
         */
        const sendNextConfigOption = () => {
          const next = pendingConfigSets.shift();
          if (!next) return;
          // The id is registered inside sendRpc, before the write reaches the
          // agent, so a rejection is matched to this option either way.
          if (sendRpc("session/set_config_option", {
            sessionId,
            configId: next.configId,
            value: next.value,
          }) === null) {
            // stdin already closed — the close handler will finish the turn.
            return;
          }
        };

        // ── stdout reader (NDJSON) ──────────────────────────────────────────
        removeMessageListener = transport.onMessage((msg) => {

            // ── initialize response → open a session ──────────────────────
            if (!initDone && msg.result !== undefined && !msg.method) {
              initDone = true;
              acpTrace("initialized", { provider: this.providerId, pid: child.pid, resume: Boolean(prior?.sessionId && !pooled) });
              if (prior?.sessionId && !pooled) {
                resumeAttempted = true;
                acpTrace("resume", { provider: this.providerId, pid: child.pid, sessionId: prior.sessionId });
                sendRpc("session/resume", { sessionId: prior.sessionId, cwd: workspaceCwd }, (id) => {
                  sessionCreateRequestId = id;
                });
                return;
              }
              // `mcpServers` must be a sequence (an object is rejected with
              // -32602). Empty unless the caller sent tools we are bridging —
              // the agent runs its own tools either way.
              acpTrace("session-new", { provider: this.providerId, pid: child.pid, fallback: resumeAttempted });
              sendRpc("session/new", {
                cwd: workspaceCwd,
                // The client-tool bridge first: agents may rename a bridged tool,
                // and that mapping is already proven in live runs. Router-level
                // MCP servers follow, addressed at the proxy rather than at their
                // upstream so no credential reaches the agent process.
                mcpServers: [
                  ...(clientToolsMcp ? [clientToolsMcp] : []),
                  ...(Array.isArray(mcpProxyTargets) ? mcpProxyTargets : []),
                ],
              }, (id) => { sessionCreateRequestId = id; });
              return;
            }

            // ── session/resume or session/new response → sessionId + model catalog ──
            if (initDone && !sessionCreated && (msg.result !== undefined || msg.error) && !msg.method) {
              const res = msg.result || {};
              if (resumeAttempted && msg.error) {
                resumeAttempted = false;
                sendRpc("session/new", {
                  cwd: workspaceCwd,
                  mcpServers: [
                    ...(clientToolsMcp ? [clientToolsMcp] : []),
                    ...(Array.isArray(mcpProxyTargets) ? mcpProxyTargets : []),
                  ],
                }, (id) => { sessionCreateRequestId = id; });
                return;
              }
              sessionId = res.sessionId || (resumeAttempted ? prior?.sessionId : null);
              // ACP agents may emit an unrelated response while session
              // initialization is still completing; those frames carry no
              // session state and are still ignored. What must NOT be ignored
              // is an empty answer to our own session/new|session/resume: no
              // session will ever arrive from it, and without this branch the
              // turn waits forever (and holds the session queue behind it).
              if (!sessionId) {
                const flow = resumeAttempted ? "session/resume" : "session/new";
                if (msg.error) finish(`ACP: ${flow} failed: ${msg.error.message || "unknown error"}`);
                else if (sessionCreateRequestId !== null && msg.id === sessionCreateRequestId) {
                  finish(`ACP: ${flow} returned no sessionId`);
                }
                return;
              }
              sessionCreated = true;
              catalog = collectModelCatalog(res);
              const current = currentAgentModel(res);
              resolvedModelId = resolveAgentModelId(model, catalog, current);
              log?.debug?.(tag, `session=${sessionId} current=${current} requested=${model} → ${resolvedModelId}`);
              if (sessionKey) {
                // `currentModel` is what this session is pinned to (what the agent
                // reported, or what we are about to pin). A pooled reuse must
                // compare against it: the stored `catalog` is a bare id list, so
                // currentAgentModel() over it answers "" and every reuse would
                // re-pin a model the agent already sits on — a call some agents
                // answer with -32602.
                putAcpSession(sessionKey, {
                  child,
                  transport,
                  sessionId,
                  catalog,
                  cwd: workspaceCwd,
                  currentModel: resolvedModelId || current,
                });
                sessionPooledNow = true;
                acpTrace("pooled", { provider: this.providerId, pid: child.pid, sessionId });
              }

              const refuseSelfRoute = () => finish(
                `ACP: refusing to route back into 9router. The ${label} catalog only offers self-referential models; point the agent at a real upstream, or exclude this provider.`,
                "stop",
                "self_routed"
              );

              if (resolvedModelId && isSelfRouted(resolvedModelId)) {
                refuseSelfRoute();
                return;
              }

              // The check above only inspects the id we picked. A bare request
              // such as `space-bunny-free` looks harmless while every model the
              // agent actually has is self-routed — the agent would fuzzy-match
              // it back to its 9router entry and call this gateway again, one
              // process per hop. Refuse on the catalog itself, before any model
              // is chosen, so the loop cannot start.
              if (catalog.length && !usableAgentModels(catalog).length) {
                refuseSelfRoute();
                return;
              }

              // Operator's dashboard choices first, so the model this request asked for
              // wins over whatever the agent had selected. `model` is excluded:
              // it is decided below, from this request.
              for (const [configId, value] of Object.entries(sessionDefaults)) {
                if (configId === "model" || typeof value !== "string" || !value) return;
                pendingConfigSets.push({ configId, value });
              }

              if (resolvedModelId && resolvedModelId !== current) {
                pendingConfigSets.push({ configId: "model", value: resolvedModelId });
              }
              // Nothing to pin — the agent's own defaults stand and the turn
              // goes out immediately.
              if (pendingConfigSets.length) sendNextConfigOption();
              else startPrompt();
              return;
            }

            // ── session/set_config_option response → next option, then prompt ─
            if (sessionCreated && !promptSent && msg.result !== undefined && !msg.method) {
              const applied = configSetIds.get(msg.id);
              configSetIds.delete(msg.id);
              if (applied?.configId === "model") {
                // The pin landed: record it so the next reuse compares against
                // what the session is actually on instead of re-pinning.
                const entry = sessionKey ? peekAcpSession(sessionKey) : null;
                if (entry?.child === child) entry.currentModel = applied.value;
              }
              if (pendingConfigSets.length) {
                sendNextConfigOption();
              } else {
                startPrompt();
              }
              return;
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

            // ── permission requests → decided by policy, always answered ──
            // The agent blocks the turn until this is answered: left hanging,
            // a prompt that touches a tool never returns (verified against
            // `opencode acp` — it emits tool_call pending/in_progress, then
            // waits on session/request_permission indefinitely). 9router is a
            // headless proxy with nobody to prompt, so it answers from the
            // configured policy instead of blanket-approving.
            if (msg.method === "session/request_permission" && msg.id !== undefined && msg.id !== null) {
              const toolCall = msg.params?.toolCall || {};
              const action = classifyAction(toolCall, seenToolKinds);
              const paths = targetPaths(toolCall);
              const decided = decidePermission({
                action,
                paths,
                policy,
                workspaceCwd,
                log,
              });
              const option = chooseOption(msg.params?.options, decided.value);

              if (option) {
                if (decided.value === "deny") {
                  log?.warn?.(
                    tag,
                    `refusing ${action} for ${String(toolCall.toolCallId || "?")} — ` +
                      `${decided.reason}; policy says deny`
                  );
                } else {
                  log?.debug?.(
                    tag,
                    `${decided.value === "always" ? "approving for session" : "approving"} ` +
                      `${action} for ${String(toolCall.toolCallId || "?")} — ${decided.reason}`
                  );
                }
                sendRpcRaw({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { outcome: { outcome: "selected", optionId: option.optionId } },
                });
              } else {
                // Nothing to select. We must still answer — an unanswered
                // request blocks the agent's turn indefinitely, which reaches
                // the caller as a hang with no error. Cancelling is the honest
                // outcome: it tells the agent to stop rather than proceed
                // unapproved, and it lets the turn terminate.
                log?.debug?.(tag, `session/request_permission had no options — cancelling (${action})`);
                sendRpcRaw({
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: { outcome: { outcome: "cancelled" } },
                });
              }
              return;
            }

            // ── client channel we genuinely do not implement ───────────────
            // fs/* and elicitation would require a real client-side capability
            // channel; these builds do not expose one. Leaving them unanswered
            // is safe — the agent self-executes its own tools and only reaches
            // for fs/* when the client advertised those capabilities, which we
            // do not (see the initialize handshake above).
            if (msg.method && msg.id !== undefined && msg.id !== null) {
              log?.debug?.(tag, `unanswered client request: ${msg.method}`);
              return;
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
                // Remembers what kind of action this is. The permission request
                // that follows reports `kind: "other"`, so this notification is
                // where the real answer lives.
                rememberToolKind(seenToolKinds, update);

                // Client-tool bridge, authoritative path: the bridge server
                // recorded the real name and arguments, because this
                // notification carries neither.
                if (clientToolsMcp && !toolUseEmitted && takeSinkCall()) return;

                // Client-tool bridge, fallback: agents that do name the tool in
                // the notification (devin: "Calling mcp_x from clientTools").
                // ACP upserts tool calls by id — the first event may carry only
                // the name, a later update only `rawInput` — so remember the name
                // until the arguments show up.
                if (clientToolsMcp && !toolUseEmitted) {
                  const tcId = update.toolCallId;
                  const detected = detectClientToolName(update, knownClientTools, clientToolPrefix);
                  if (tcId && detected) pendingClientTools.set(tcId, detected);
                  const origName = tcId ? pendingClientTools.get(tcId) : null;
                  const abandoned = update.status === "cancelled" || update.status === "failed";
                  if (origName && abandoned) {
                    // The agent gave up on this call — usually because the
                    // permission request above was denied. Do not hand the
                    // client a tool_call the agent is not going to make.
                    pendingClientTools.delete(tcId);
                    return;
                  }
                  if (origName && update.rawInput) {
                    pendingClientTools.delete(tcId);
                    toolUseEmitted = true;
                    // codex-acp carries its internal MCP envelope here
                    // ({server, tool, arguments}) — unwrap, or the client
                    // forwards the wrapper to the real tool as its arguments.
                    emitToolUse(origName, unwrapClientToolArgs(update.rawInput), tcId || `call_${Date.now()}`);
                    finish(null, "tool_calls");
                    return;
                  }
                  return;
                }

                // The agent runs its own tools against its own sandbox — these
                // are progress reports, not calls the client should service.
                // Surfacing them as OpenAI tool_calls would re-run them
                // client-side.
                if (update.status === "pending" || type === "tool_call") {
                  log?.debug?.(tag, `tool: ${update.title || update.kind || "?"}`);
                }
              } else if (type === "session_info_update") {
                log?.debug?.(tag, `title: ${update.title || ""}`);
              }
              return;
            }

            // ── error responses ──────────────────────────────────────────
            if (msg.error) {
              acpTrace("rpc-error", {
                provider: this.providerId,
                pid: child?.pid,
                id: msg.id,
                code: msg.error.code,
                message: msg.error.message,
                data: msg.error.data ?? null,
              });
              const detail = msg.error.data
                ? ` (${JSON.stringify(msg.error.data)})`
                : "";
              // A rejected config option is the agent saying "I don't offer
              // this option" (typically -32602). The operator's default was
              // aspirational — the agent's own default stands and the prompt
              // still goes out (see sendNextConfigOption).
              const rejected = configSetIds.get(msg.id);
              if (rejected !== undefined) {
                configSetIds.delete(msg.id);
                log?.debug?.(
                  tag,
                  `config option rejected, continuing: ${rejected.configId} (${msg.error.code}: ${msg.error.message})`
                );
                acpTrace("config-option-rejected", {
                  provider: this.providerId,
                  pid: child?.pid,
                  configId: rejected.configId,
                  code: msg.error.code,
                  remaining: pendingConfigSets.length,
                });
                if (pendingConfigSets.length) sendNextConfigOption();
                else startPrompt();
                return;
              }
              finish(`${label} ACP error ${msg.error.code}: ${msg.error.message}${detail}`);
              return;
            }
        });

        child.stderr.on("data", (chunkData) => {
          log?.debug?.(tag, `stderr: ${chunkData.toString("utf8").slice(0, 200)}`);
        });

        child.on("close", (code) => {
          acpTrace("close", {
            provider: this.providerId,
            pid: child.pid,
            code,
            signal: child.signalCode,
            finished,
            pooled: Boolean(pooled),
            pooledNow: sessionPooledNow,
          });
          // Whoever owned the child, a closed one must never stay in the pool:
          // a stale entry makes the next turn reuse a dead transport and hang.
          // Compare the child so a late exit cannot evict a newer healthy entry.
          if (sessionKey && peekAcpSession(sessionKey)?.child === child) markAcpSessionDead(sessionKey);
          if (finished) return;
          if (code !== 0 && !spawnError && !roleEmitted) {
            finish(`${label} CLI exited with code ${code}`);
          } else {
            // Streamed fine (or produced nothing) — close out as a normal turn.
            finish();
          }
        });

        // ── handshake ───────────────────────────────────────────────────────
        if (pooled?.sessionId) {
          // What the session is pinned to, recorded when it entered the pool
          // (and refreshed below when a pin succeeds). Falling back to the
          // catalog-derived value would compute "" — the catalog is a bare id
          // list — and re-pin a model the agent is already on.
          const current =
            pooled.currentModel ||
            currentAgentModel({ configOptions: catalog }) ||
            "";
          resolvedModelId = resolveAgentModelId(model, catalog, current);
          for (const [configId, value] of Object.entries(sessionDefaults)) {
            if (configId !== "model" && typeof value === "string" && value) {
              pendingConfigSets.push({ configId, value });
            }
          }
          if (resolvedModelId && resolvedModelId !== current) {
            pendingConfigSets.push({ configId: "model", value: resolvedModelId });
          }
          if (pendingConfigSets.length) sendNextConfigOption();
          else startPrompt();
        } else {
          sendRpc("initialize", {
            protocolVersion: 1,
            clientInfo: { name: "9router", version: this.config?.version || "1.0" },
            capabilities: {},
          });
        }
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
        clientTools: clientTools.map((t) => t?.function?.name || t?.name).filter(Boolean),
        clientToolResults: Object.keys(clientToolResults),
        clientToolsBridged: clientToolsMcp ? CLIENT_TOOLS_SERVER_NAME : null,
      },
    };
  }
}