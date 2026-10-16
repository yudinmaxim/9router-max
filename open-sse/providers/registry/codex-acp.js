/**
 * Codex (ACP) — the local `codex` CLI driven over the Agent Client Protocol
 * (JSON-RPC 2.0 on stdio) by open-sse/executors/codex-acp.js.
 *
 * NoAuth: the CLI holds its own credentials (`codex login`) and the executor spawns
 * it with the inherited environment.
 *
 * ## No models are listed
 *
 * Unlike cursor, opencode and omp, this has not been verified against a real `codex`
 * binary — the CLI was not installed on the machine where this executor was written.
 * Rather than copy a guessed catalog, the provider ships empty and relies on
 * `passthroughModels`: the executor resolves the client's id against the catalog
 * returned by `session/new` at call time, so any model codex offers works without a
 * registry edit here. Add a static list once the CLI has been run locally.
 *
 * Trade-off: codex runs its own shell/fs tools and reports them over ACP, so
 * client-supplied `tools` are not callable through this provider. One request = one
 * complete turn.
 */
export default {
  id: "codex-acp",
  priority: 42,
  hasFree: true,
  alias: "cxc",
  uiAlias: "cxc",
  display: {
    name: "Codex (ACP)",
    icon: "terminal",
    color: "#10A37F",
    textIcon: "CX",
    website: "https://openai.com/codex",
    notice: {
      signupUrl: "https://openai.com/codex/cli/",
      text: "Install the `codex` CLI and run `codex login`. 9router then drives it over ACP; override the binary path with CLI_CODEX_BIN. The model list is discovered at call time from the CLI itself.",
    },
  },
  category: "free",
  // Without this the provider is absent from USAGE_SUPPORTED_PROVIDERS,
  // so /api/providers/client filtered its connection out of the usage
  // page — the agent was serving traffic while showing nothing there.
  features: { usage: true },
  noAuth: true,
  transport: {
    baseUrl: "codex://acp/stdio",
    format: "openai",
    forceStream: true,
    noAuth: true,
  },
  models: [],
  passthroughModels: true,
};