// HTTP status codes
export const HTTP_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  PAYMENT_REQUIRED: 402,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  NOT_ACCEPTABLE: 406,
  REQUEST_TIMEOUT: 408,
  RATE_LIMITED: 429,
  SERVER_ERROR: 500,
  BAD_GATEWAY: 502,
  SERVICE_UNAVAILABLE: 503,
  GATEWAY_TIMEOUT: 504
};

// Re-export error config (backward compat)
export { ERROR_TYPES, DEFAULT_ERROR_MESSAGES, BACKOFF_CONFIG, COOLDOWN_MS } from "./errorConfig.js";

// Cache TTLs (seconds)
export const CACHE_TTL = {
  userInfo: 300,    // 5 minutes
  modelAlias: 3600  // 1 hour
};

// Memory management config
export const MEMORY_CONFIG = {
  sessionTtlMs: 2 * 60 * 60 * 1000,
  sessionCleanupIntervalMs: 30 * 60 * 1000,
  dnsCacheTtlMs: 5 * 60 * 1000,
  proxyDispatchersMaxSize: 20,
};

// Parse a positive integer env override, falling back to a default.
function envMs(name, def) {
  const raw = process.env[name];
  if (raw == null || raw === "") return def;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : def;
}

function envUrl(name, def) {
  const raw = process.env[name]?.trim();
  return raw || def;
}

// SearXNG endpoint used by the unauthenticated web-search provider.
// Configure this for a separate Docker service or remote SearXNG instance.
export const SEARXNG_URL = envUrl("SEARXNG_URL", "http://localhost:8888/search");

// Inter-chunk stall timeout (once tokens are flowing). Generous headroom so
// slow reasoning models aren't aborted mid-stream. Env: STREAM_STALL_TIMEOUT_MS.
export const STREAM_STALL_TIMEOUT_MS = envMs("STREAM_STALL_TIMEOUT_MS", 360 * 1000);

// Time-to-first-token timeout (prompt prefill). Env: STREAM_FIRST_CHUNK_TIMEOUT_MS.
export const STREAM_FIRST_CHUNK_TIMEOUT_MS = envMs("STREAM_FIRST_CHUNK_TIMEOUT_MS", 200 * 1000);

// Fetch connect timeout: abort if upstream doesn't return response headers within this duration
export const FETCH_CONNECT_TIMEOUT_MS = envMs("FETCH_CONNECT_TIMEOUT_MS", 60 * 1000);

// Gemini native TTS fetch timeout: abort if Google does not return response headers in time.
export const GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS = envMs("GEMINI_NATIVE_TTS_FETCH_TIMEOUT_MS", 45 * 1000);

// Server-side MCP tool loop: how many times one client request may re-dispatch
// to run the MCP tools the model asked for. Each round is a full upstream call,
// so this is a cost ceiling as much as a correctness one — a model looping on a
// failing tool must not be able to spend the caller's quota indefinitely.
// Env: MCP_TOOL_LOOP_MAX.
const MCP_TOOL_LOOP_MAX_RAW = Number.parseInt(process.env.MCP_TOOL_LOOP_MAX ?? "", 10);
export const MCP_TOOL_LOOP_MAX = Number.isFinite(MCP_TOOL_LOOP_MAX_RAW) && MCP_TOOL_LOOP_MAX_RAW > 0
  ? MCP_TOOL_LOOP_MAX_RAW
  : 4;

// Default token limits
export const DEFAULT_MAX_TOKENS = 64000;
export const DEFAULT_MIN_TOKENS = 32000;

export const TOKEN_SAVER_HEADER = "x-9router-token-saver";

// ─── ACP agent permissions ───────────────────────────────────────────────────
// When an ACP agent wants to run a tool it asks the client
// (session/request_permission) and blocks the turn until it is answered.
// 9router is a headless proxy with nobody to prompt, so it decides from policy.
//
// Per-action, split by whether the target is inside the agent's working
// directory. `execute` and `delete` are split like the others only so the shape
// stays uniform — a shell can reach anything, so scoping them by location buys
// nothing on its own; set them to `deny` if that is the point.
//
// Values:
//   always — allow, and answer with the agent's own `allow_always` option so it
//            stops asking for the rest of the session (an ACP session is one
//            request, so "this session" == "this call chain")
//   once   — allow this single call; the agent may ask again
//   deny   — refuse with `reject_once`. The agent marks the tool failed and
//            finishes the turn normally, so refusing is safe, not fatal.
export const ACP_PERMISSION_ACTIONS = ["read", "search", "edit", "move", "delete", "execute", "fetch", "other"];

export const ACP_PERMISSION_VALUES = ["always", "once", "deny"];

export const ACP_PERMISSION_HEADER = "x-9router-acp-permissions";

// Body-level equivalent of the header, for clients that cannot set headers.
export const ACP_PERMISSION_BODY_KEY = "acp_permissions";

// Per-request override for the agent options pinned on the provider page
// ({"mode":"read-only"}). Same layering as ACP permissions: request beats
// dashboard, and neither is persisted.
export const ACP_DEFAULTS_HEADER = "x-9router-acp-defaults";
export const ACP_DEFAULTS_BODY_KEY = "acp_defaults";

// Permissive by default: the agent is a local process running as the user and
// would act regardless of what we answer, so refusing only removes capability
// the user asked for by driving an agent. Tighten per action in the dashboard.
export const DEFAULT_ACP_PERMISSIONS = Object.freeze(
  Object.fromEntries(
    ACP_PERMISSION_ACTIONS.map((action) => [action, Object.freeze({ inside: "always", outside: "always" })])
  )
);

// ACP agents that ship no `acp` subcommand of their own and therefore need a
// bridge process on stdio. Codex is the case that matters today: the CLI has
// app-server but no ACP, so `codex acp` is parsed as a prompt for the
// interactive TUI and exits with "stdin is not a terminal".
//
// `package` is installed on demand into <DATA_DIR>/acp-agents/<slug> and spawned
// from there, so the user never installs anything by hand. `envVar` overrides
// the resolved binary, matching the CLI_*_BIN convention used for agent CLIs.
export const ACP_ADAPTERS = {
  "codex-acp": {
    slug: "codex",
    package: "@agentclientprotocol/codex-acp",
    bin: "codex-acp",
    envVar: "CLI_CODEX_ACP_BIN",
    // The adapter drives this binary; without it the adapter falls back to its
    // own bundled codex, which may lag behind the user's installed CLI.
    codexEnvVar: "CLI_CODEX_BIN",
  },
};

// npm install of an adapter is small but not instant; keep it out of the request
// path's failure window (see acpAdapter.js, which installs on first use).
export const ACP_ADAPTER_INSTALL_TIMEOUT_MS = 180000;

// After a failed install, don't retry on every request — an offline machine
// would otherwise pay the timeout on each one.
export const ACP_ADAPTER_RETRY_COOLDOWN_MS = 600000;

// Optional lifecycle tracing for ACP child processes (see acpBase.acpTrace).
//
// Off by default: when both are empty nothing is written and the cost is a
// single falsy check per event. Enable it either with the env var (good for a
// one-off investigation) or by pointing the constant at a file (good for a
// machine where ACP sessions get diagnosed routinely). The env wins so an
// operator does not have to rebuild to turn it on.
export const ACP_LIFECYCLE_LOG_ENV = "ACP_DEBUG_LOG";
export const ACP_LIFECYCLE_LOG_PATH = "";

// Retry config for 429 responses (legacy - kept for backward compatibility)
export const RETRY_CONFIG = {
  maxAttempts: 2,
  delayMs: 2000
};

// Default retry config by status code: { attempts, delayMs }
// Backward compat: if value is a number, treated as attempts with RETRY_CONFIG.delayMs
export const DEFAULT_RETRY_CONFIG = {
  429: { attempts: 0, delayMs: 0 },
  502: { attempts: 3, delayMs: 3000 },
  503: { attempts: 3, delayMs: 2000 },
  504: { attempts: 2, delayMs: 3000 }
};

// Normalize a retry entry to { attempts, delayMs }
export function resolveRetryEntry(entry) {
  if (entry == null) return { attempts: 0, delayMs: RETRY_CONFIG.delayMs };
  if (typeof entry === "number") return { attempts: entry, delayMs: RETRY_CONFIG.delayMs };
  return {
    attempts: entry.attempts || 0,
    delayMs: entry.delayMs != null ? entry.delayMs : RETRY_CONFIG.delayMs
  };
}

// Requests containing these texts will bypass provider
export const SKIP_PATTERNS = [
  "Please write a 5-10 word title for the following conversation:"
];
