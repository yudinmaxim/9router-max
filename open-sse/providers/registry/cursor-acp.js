/**
 * Cursor Agent (ACP) — the local `cursor-agent` CLI driven over the Agent Client Protocol
 * (JSON-RPC 2.0 on stdio) by open-sse/executors/cursor-acp.js.
 *
 * NoAuth: the CLI holds its own credentials (`cursor-agent login` →
 * ~/.cursor/cli-config.json) and the executor spawns it with the inherited env.
 *
 * Model ids are the bracket-free name part of cursor's own ids. Upstream ids
 * (`gpt-5.3-codex[reasoning=medium,fast=false]`) carry an option list that cursor validates
 * strictly, so the executor re-attaches it by matching the name against the
 * `availableModels` catalog returned by session/new — see resolveCursorModelId.
 *
 * Trade-off: cursor runs its own shell/fs tools and reports them over ACP, so
 * client-supplied `tools` are not callable through this provider. One request = one
 * complete cursor turn.
 */
export default {
  id: "cursor-acp",
  priority: 45,
  hasFree: true,
  alias: "ca",
  uiAlias: "ca",
  display: {
    name: "Cursor Agent (ACP)",
    icon: "terminal",
    color: "#00D4AA",
    textIcon: "CA",
    website: "https://cursor.com",
    notice: {
      signupUrl: "https://cursor.com/cli",
      text: "Install `cursor-agent` (npm i -g cursor-agent) and run `cursor-agent login`. 9router then drives it over ACP; override the binary path with CLI_CURSOR_BIN.",
    },
  },
  category: "free",
  // Without this the provider is absent from USAGE_SUPPORTED_PROVIDERS,
  // so /api/providers/client filtered its connection out of the usage
  // page — the agent was serving traffic while showing nothing there.
  features: { usage: true },
  noAuth: true,
  transport: {
    baseUrl: "cursor://acp/stdio",
    format: "openai",
    forceStream: true,
    noAuth: true,
  },
  models: [
    { id: "default", name: "Auto (Cursor Picks)" },
    { id: "grok-4.7", name: "Grok 4.7", contextLength: 256000 },
    { id: "grok-4.6", name: "Grok 4.6" },
    { id: "composer-2.5", name: "Composer 2.5" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", contextLength: 300000 },
    { id: "claude-opus-5", name: "Claude Opus 5", contextLength: 300000 },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8", contextLength: 300000 },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol", contextLength: 272000 },
    { id: "gpt-5.5", name: "GPT 5.5", contextLength: 272000 },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", contextLength: 300000 },
    { id: "claude-fable-5", name: "Claude Fable 5", contextLength: 300000 },
    { id: "grok-4.5", name: "Grok 4.5" },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
    { id: "gemini-3.7-flash", name: "Gemini 3.7 Flash" },
    { id: "muse-spark-1.3", name: "Muse Spark 1.3", contextLength: 300000 },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra", contextLength: 272000 },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextLength: 300000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 300000 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextLength: 200000 },
    { id: "gpt-5.3-codex", name: "GPT 5.3 Codex" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", contextLength: 300000 },
    { id: "gpt-5.4", name: "GPT 5.4", contextLength: 272000 },
    { id: "claude-opus-4-6", name: "Claude Opus 4.6", contextLength: 200000 },
    { id: "claude-opus-4-5", name: "Claude Opus 4.5" },
    { id: "gpt-5.2", name: "GPT 5.2" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna", contextLength: 272000 },
    { id: "gemini-3.6-flash", name: "Gemini 3.6 Flash" },
    { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro" },
    { id: "gpt-5.4-mini", name: "GPT 5.4 Mini" },
    { id: "gpt-5.4-nano", name: "GPT 5.4 Nano" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", contextLength: 300000 },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", contextLength: 200000 },
    { id: "gpt-5.1", name: "GPT 5.1" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3.5-flash", name: "Gemini 3.5 Flash" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", contextLength: 200000 },
    { id: "gpt-5-mini", name: "GPT 5 Mini" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "kimi-k3", name: "Kimi K3" },
    { id: "kimi-k2.7-code", name: "Kimi k2.7 Code" },
    { id: "glm-5.2", name: "GLM 5.2" },
    { id: "glm-5p3", name: "GLM 5p3" },
    { id: "glm-5p3-flash", name: "GLM 5p3 Flash" },
  ],
  passthroughModels: true,
};
