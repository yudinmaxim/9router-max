/**
 * KodaAcpExecutor — routes completions through the locally installed
 * `koda --acp` binary over the Agent Client Protocol (JSON-RPC 2.0 on stdio).
 *
 * Koda specifics (probed against 1.1.2):
 *   - Binary: `koda`, flag `--acp` (also `--experimental-acp`).
 *   - `session/new` returns `models.availableModels` (provider-qualified ids like
 *     `koda-pro`, `claude-opus-5.5`, ...). No `session/set_model` needed — the
 *     model is pinned via `session/set_config_option { configId: "model" }` like
 *     omp, when the option exists.
 *   - Auth: `koda-auth` or `skip`; we use `skip` (no credential row).
 *   - MCP: http + sse only (no stdio). hostrunner is exposed to koda through
 *     9router's HTTP MCP proxy when registered as a server.
 *
 * Binary discovery: CLI_KODA_BIN env → known paths → PATH.
 */

import path from "node:path";
import os from "node:os";
import { AcpAgentExecutor } from "./lib/acpBase.js";

const PROVIDER_ID = "koda-acp";

export class KodaAcpExecutor extends AcpAgentExecutor {
  constructor() {
    super(PROVIDER_ID, {
      exe: "koda",
      args: ["--acp"],
      envVar: "CLI_KODA_BIN",
      extraDirs: [
        path.join(os.homedir(), ".local", "bin"),
        path.join(os.homedir(), ".nvm", "versions", "node", "v24.19.0", "bin"),
      ],
      label: "Koda",
      errorType: "koda_acp_error",
      installHint: "Install with `npm i -g @kodadev/koda-cli` and run `koda` once.",
    });
  }
}

export default KodaAcpExecutor;
