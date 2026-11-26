/**
 * Koda (ACP) — the local `koda --acp` CLI driven over the Agent Client
 * Protocol (JSON-RPC 2.0 on stdio) by open-sse/executors/koda-acp.js.
 *
 * Koda is an ACP-speaking agent with its own model catalog (koda-base,
 * koda-pro, plus claude/gpt/gemini/deepseek/...). Models come from the
 * session/new response, so none are hardcoded here — passthroughModels is on.
 *
 * Auth: none (noAuth). Koda supports koda-auth or skip; we skip.
 *
 * MCP: koda supports http + sse only (no stdio). hostrunner is exposed via
 * 9router's HTTP MCP proxy when registered as a server in the DB.
 */
export default {
  id: "koda-acp",
  priority: 44,
  hasFree: true,
  alias: "kda",
  uiAlias: "kda",
  display: {
    name: "Koda (ACP)",
    icon: "terminal",
    color: "#7C3AED",
    textIcon: "KD",
    website: "https://koda.dev",
    notice: {
      text: "Install `koda` (`npm i -g @kodadev/koda-cli`). Override the binary path with CLI_KODA_BIN. Koda supports http/sse MCP only — hostrunner is reachable via 9router's HTTP MCP proxy.",
    },
  },
  category: "free",
  localAgent: true,
  features: { usage: true },
  noAuth: true,
  authType: "none",
  authModes: ["none"],
  transport: {
    baseUrl: "koda://acp/stdio",
    format: "openai",
    forceStream: true,
    noAuth: true,
  },
  models: [{ id: "koda-base", name: "Koda Base (auto)" }],
  passthroughModels: true,
};
