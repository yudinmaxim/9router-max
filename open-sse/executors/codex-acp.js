/**
 * CodexAcpExecutor — routes completions through the locally installed
 * `codex acp` binary over the Agent Client Protocol.
 *
 * Registered unconditionally: whether the binary is installed is not a reason
 * to hide the provider from the registry, and the spawn error already carries
 * the install hint. The listing itself must not require a local toolchain.
 *
 * Binary discovery: CLI_CODEX_BIN env → nvm/known paths → PATH.
 */

import path from "node:path";
import os from "node:os";
import { AcpAgentExecutor } from "./lib/acpBase.js";

const PROVIDER_ID = "codex-acp";

export class CodexAcpExecutor extends AcpAgentExecutor {
  constructor() {
    super(PROVIDER_ID, {
      exe: "codex",
      envVar: "CLI_CODEX_BIN",
      extraDirs: [
        path.join(os.homedir(), ".local", "bin"),
        path.join(os.homedir(), ".nvm", "versions", "node", "v24.18.0", "bin"),
      ],
      label: "Codex",
      errorType: "codex_acp_error",
      installHint: "Install with `npm i -g @openai/codex` and run `codex login`",
    });
  }
}