/**
 * Per-ACP-agent user settings.
 *
 * An ACP agent has no account row — it is a local process that carries its own
 * credentials — so there is nowhere else for "which of the agent's models do I
 * want published" and "how should it behave" to live. They go in the settings
 * blob under `acpAgents`, keyed by provider id, the same way ACP permissions
 * are layered per provider.
 *
 * Shape:
 *   acpAgents[providerId] = {
 *     enabledModels: string[],   // published to /v1/models; absent = "use the registry list"
 *     defaults: { mode, collaboration_mode, thought_level, ... }  // applied per session
 *   }
 */

import { getSettings, updateSettings } from "@/lib/localDb";

const EMPTY = { enabledModels: null, defaults: {} };

/**
 * @returns {Promise<{enabledModels: string[]|null, defaults: Record<string, string>}>}
 *   `enabledModels: null` means the user has not chosen yet, and the static
 *   registry list stays in effect — discovery must not silently empty a
 *   provider that was working before this feature existed.
 */
export async function getAcpAgentSettings(providerId) {
  const settings = await getSettings();
  const entry = settings.acpAgents?.[providerId] || {};
  return {
    enabledModels: Array.isArray(entry.enabledModels) ? entry.enabledModels : null,
    defaults: entry.defaults && typeof entry.defaults === "object" ? entry.defaults : {},
  };
}

export async function getAllAcpAgentSettings() {
  const settings = await getSettings();
  return settings.acpAgents && typeof settings.acpAgents === "object" ? settings.acpAgents : {};
}

/**
 * Shallow-merge a patch into one provider's entry, leaving other providers and
 * unrelated keys in `acpAgents` untouched.
 */
export async function saveAcpAgentSettings(providerId, patch) {
  const settings = await getSettings();
  const all = { ...(settings.acpAgents && typeof settings.acpAgents === "object" ? settings.acpAgents : {}) };
  const current = all[providerId] || {};

  const next = { ...current };
  if (patch.enabledModels !== undefined) {
    next.enabledModels = Array.isArray(patch.enabledModels) ? patch.enabledModels : null;
  }
  if (patch.defaults !== undefined) {
    next.defaults = { ...(current.defaults || {}), ...(patch.defaults || {}) };
  }

  all[providerId] = next;
  await updateSettings({ acpAgents: all });
  return next;
}

/**
 * Options that may be applied as per-session defaults.
 *
 * Deliberately allow-listed rather than taken from whatever the agent
 * advertises: these are config ids the executor pins with
 * `session/set_config_option`, and an agent is free to advertise anything it
 * likes (Codex lists model and mode; opencode lists mode too). Letting an
 * agent invent a key here would let a remote catalog pick what the router
 * pins on every session.
 */
export const ALLOWED_DEFAULT_OPTIONS = ["mode", "collaboration_mode", "thought_level", "reasoning_effort"];

export function sanitizeDefaults(defaults) {
  const out = {};
  for (const [key, value] of Object.entries(defaults || {})) {
    if (!ALLOWED_DEFAULT_OPTIONS.includes(key)) continue;
    if (typeof value !== "string" || !value.trim()) continue;
    out[key] = value.trim();
  }
  return out;
}