/**
 * OpenCode (ACP) — the local `opencode` CLI driven over the Agent Client Protocol
 * (JSON-RPC 2.0 on stdio) by open-sse/executors/opencode-acp.js.
 *
 * NoAuth: the CLI holds its own credentials (`opencode auth login`) and the executor
 * spawns it with the inherited environment.
 *
 * ## Loop guard
 *
 * A user's opencode config usually points back at 9router, so opencode's own model
 * catalog contains entries like `nine-router/oc/space-bunny-free`. Registering this
 * provider means 9router spawns opencode, which would then call 9router again. The
 * executor filters those ids out via `isSelfRouted` and refuses to select them; the
 * `models` list below mirrors that filtering. Changing opencode's default model to
 * point somewhere else removes the entries rather than the guard — the guard stays.
 *
 * ## Model ids
 *
 * Ids are opencode's own provider-qualified names (`opencode/big-pickle`). The
 * executor resolves the client's id against the catalog returned by `session/new`,
 * falling back to `default` when it cannot place the request.
 *
 * Trade-off: opencode runs its own shell/fs tools and reports them over ACP, so
 * client-supplied `tools` are not callable through this provider. One request = one
 * complete turn.
 */
export default {
  id: "opencode-acp",
  priority: 44,
  hasFree: true,
  alias: "oacp",
  uiAlias: "oacp",
  display: {
    name: "OpenCode (ACP)",
    icon: "terminal",
    color: "#F4B860",
    textIcon: "OA",
    website: "https://opencode.ai",
    notice: {
      signupUrl: "https://opencode.ai",
      text: "Install `opencode` and run `opencode auth login`. 9router then drives it over ACP; override the binary path with CLI_OPENCODE_BIN.",
    },
  },
  category: "free",
  // Runs a local binary over ACP and holds no credential row: its availability
  // is measured (see lib/acpStatus.js), never assumed.
  localAgent: true,
  // Without this the provider is absent from USAGE_SUPPORTED_PROVIDERS,
  // so /api/providers/client filtered its connection out of the usage
  // page — the agent was serving traffic while showing nothing there.
  features: { usage: true },
  noAuth: true,
  transport: {
    baseUrl: "opencode://acp/stdio",
    format: "openai",
    forceStream: true,
    noAuth: true,
  },
  // Verified against the agent on 2026-10-19: every id below answered a
  // request through the router. The list used to carry models Zen has since
  // retired — space-bunny-free among them, which the gateway now answers with
  // "ModelDeprecated" — so the published catalog pointed at models that could
  // not be served, and a client's default model failed on its first request.
  //
  // This is a snapshot and it will go stale again: the agent's own catalog
  // moves. `passthroughModels` keeps unknown ids routable, so a model that
  // appears upstream works before this list catches up — it just is not
  // discoverable in /v1/models until it is listed here.
  models: [
    { id: "default", name: "Auto (OpenCode Picks)" },
    { id: "beam-free", name: "Beam Free" },
    { id: "big-pickle", name: "Big Pickle" },
    { id: "longcat-2.5-preview-free", name: "LongCat 2.5 Preview Free" },
    { id: "mimo-v2.6-flash-free", name: "MiMo-V2.6-Flash Free" },
    { id: "minimax-m3.1-flash-free", name: "MiniMax M3.1 Flash Free" },
    { id: "nemotron-3-ultra-free", name: "Nemotron 3 Ultra Free" },
    { id: "nemotron-3.5-lightning-free", name: "Nemotron 3.5 Lightning Free" },
    { id: "nemotron-3.5-super-vl-free", name: "Nemotron 3.5 Super VL Free" },
  ],
  passthroughModels: true,
};