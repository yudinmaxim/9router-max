/**
 * OpenCodeAcpExecutor — routes completions through the locally installed
 * `opencode acp` binary over the Agent Client Protocol.
 *
 * opencode specifics (probed against 1.18.35):
 *   - `session/new` returns `configOptions`, not `models.availableModels`.
 *     The model option is the entry with `id === "model"`.
 *   - Model ids are provider-qualified: `opencode/big-pickle`. Sending a bare
 *     name earns `-32602 model not found`, so the catalog must be used.
 *   - `session/set_config_option { configId: "model", value }` is accepted.
 *
 * Binary discovery: CLI_OPENCODE_BIN env → nvm/known paths → PATH.
 */

import path from "node:path";
import os from "node:os";
import { AcpAgentExecutor } from "./lib/acpBase.js";

const PROVIDER_ID = "opencode-acp";

export class OpenCodeAcpExecutor extends AcpAgentExecutor {
  constructor() {
    super(PROVIDER_ID, {
      exe: "opencode",
      envVar: "CLI_OPENCODE_BIN",
      extraDirs: [
        path.join(os.homedir(), ".local", "bin"),
        path.join(os.homedir(), ".nvm", "versions", "node", "v24.18.0", "bin"),
      ],
      label: "OpenCode",
      errorType: "opencode_acp_error",
      installHint: "Install with `npm i -g opencode` and run `opencode auth login`",
    });
  }
}