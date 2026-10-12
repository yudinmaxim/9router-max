/**
 * CursorAcpExecutor — routes completions through the locally installed
 * `cursor-agent` binary over the Agent Client Protocol (JSON-RPC 2.0 over stdio).
 *
 * The protocol, the model-catalog shapes and the absence of a client tool
 * channel are all documented in ./lib/acpBase.js — this file only describes
 * what is specific to cursor.
 *
 * Credentials are whatever the CLI already holds (`cursor-agent login` →
 * ~/.cursor/cli-config.json); the subprocess inherits the parent env, so this
 * provider is noAuth.
 *
 * Binary discovery: CLI_CURSOR_BIN env → installer/known paths → PATH.
 */

import path from "node:path";
import os from "node:os";
import { AcpAgentExecutor, resolveAgentBin, acpModelName, resolveAgentModelId } from "./lib/acpBase.js";

const PROVIDER_ID = "cursor-acp";

// Model id used when the client's choice can't be matched to the CLI catalog.
const AUTO_MODEL = "default[]";

export function resolveCursorAgentBin() {
  return resolveAgentBin({
    envVar: "CLI_CURSOR_BIN",
    exe: "cursor-agent",
    versionsDir: path.join(os.homedir(), ".local", "share", "cursor-agent", "versions"),
    extraDirs: [path.join(os.homedir(), ".local", "share", "cursor-agent", "bin")],
  });
}

/** `gpt-5.3-codex[reasoning=medium]` → `gpt-5.3-codex` */
export function cursorModelName(modelId) {
  return acpModelName(modelId);
}

/**
 * Map a client-sent model id onto an exact id from the CLI's `availableModels`.
 *
 * Kept as a named export because the cursor tests pin this behaviour; the
 * implementation is shared with the other ACP agents.
 */
export function resolveCursorModelId(requested, availableModels = []) {
  const catalog = availableModels.map((m) => (typeof m === "string" ? m : m?.modelId)).filter(Boolean);
  const resolved = resolveAgentModelId(requested, catalog);
  if (resolved) return resolved;
  return catalog.includes(AUTO_MODEL) ? AUTO_MODEL : catalog[0] || AUTO_MODEL;
}

// ─── CursorAcpExecutor ───────────────────────────────────────────────────────

export class CursorAcpExecutor extends AcpAgentExecutor {
  constructor() {
    super(PROVIDER_ID, {
      exe: "cursor-agent",
      envVar: "CLI_CURSOR_BIN",
      versionsDir: path.join(os.homedir(), ".local", "share", "cursor-agent", "versions"),
      extraDirs: [path.join(os.homedir(), ".local", "share", "cursor-agent", "bin")],
      label: "Cursor Agent",
      errorType: "cursor_acp_error",
      installHint: "Install with `npm i -g cursor-agent` (or see https://cursor.com/cli) and run `cursor-agent login`",
    });
  }
}

export default CursorAcpExecutor;