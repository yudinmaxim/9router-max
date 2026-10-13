/**
 * OMP (ACP) — the local `omp` CLI driven over the Agent Client Protocol
 * (JSON-RPC 2.0 on stdio) by open-sse/executors/omp-acp.js.
 *
 * ## Why this provider ships with no models
 *
 * omp's model catalog comes entirely from `~/.omp/agent/config.yml`. On a machine
 * where omp is configured to talk to 9router — the normal setup when omp is used
 * directly as a Zed agent — that file resolves its model roles to
 * `nine-router/ca/...`, which is by definition 9router itself. Registering this
 * provider would then mean 9router spawns omp, which calls 9router.
 *
 * The executor's `isSelfRouted` guard rejects those ids rather than following the
 * loop, so requests fail with a clear upstream error instead of recursing. That is
 * the intended behaviour, but it means the provider is only useful once omp has at
 * least one model pointing somewhere other than 9router.
 *
 * `passthroughModels` is on so ids start working the moment such a model is
 * configured, with no registry edit here.
 *
 * To make this provider useful: set a real upstream in `~/.omp/agent/config.yml`.
 */
export default {
  id: "omp-acp",
  priority: 43,
  hasFree: true,
  alias: "oac",
  uiAlias: "oac",
  display: {
    name: "OMP (ACP)",
    icon: "terminal",
    color: "#9D7CD8",
    textIcon: "OMP",
    website: "https://omp.ai",
    notice: {
      text: "Install `omp`. This provider lists no models until omp has at least one model in ~/.omp/agent/config.yml that does not point back at 9router — otherwise every request would just loop into this router. Override the binary path with CLI_OMP_BIN.",
    },
  },
  category: "free",
  noAuth: true,
  transport: {
    baseUrl: "omp://acp/stdio",
    format: "openai",
    forceStream: true,
    noAuth: true,
  },
  models: [],
  passthroughModels: true,
};