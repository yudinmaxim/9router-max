/**
 * Codex (ACP) — the local `codex` CLI driven over the Agent Client Protocol
 * (JSON-RPC 2.0 on stdio) by open-sse/executors/codex-acp.js.
 *
 * NoAuth: the CLI holds its own credentials (`codex login`) and the executor spawns
 * it with the inherited environment.
 *
 * ## Model ids
 *
 * Only `default` is listed. Codex advertises its catalog through the adapter's
 * ACP `session/new`, and the executor matches whatever the client asks for
 * against it (falling back to `default` when it cannot place the request), so a
 * guessed static list would be wrong twice over: stale on the next Codex
 * release, and invisible to clients that only read `/v1/models`. Shipping an
 * empty `models` was the worst of both — the provider existed but was
 * discoverable only by guessing its id, which is how the `oc/*` ids in the
 * opencode config went stale in the first place.
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
      text: "Install the `codex` CLI and run `codex login`. Codex has no `acp` subcommand, so 9router drives it through an ACP adapter it installs on first use; override the binary with CLI_CODEX_ACP_BIN. The model list is discovered at call time from the CLI itself.",
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
  models: [{ id: "default", name: "Auto (Codex Picks)" }],
  passthroughModels: true,
};