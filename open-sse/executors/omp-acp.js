/**
 * OmpAcpExecutor — routes completions through the locally installed
 * `omp acp` binary over the Agent Client Protocol.
 *
 * omp specifics (probed against 18.8.0):
 *   - `session/set_model` does NOT exist here (-32603 Unknown ACP ext method).
 *     Only `session/set_mode` and `session/set_config_option` do, which is why
 *     the shared base pins the model through `configId: "model"`.
 *   - `session/new` returns `configOptions` with `mode` listed FIRST, so the
 *     model option must be found by `id`, never by position.
 *
 * Note: a stock omp install may have its `model` option pointing back at this
 * router (`nine-router/oc-robust`). The base class screens self-routed models
 * out of the catalog and refuses the turn rather than looping.
 *
 * Binary discovery: CLI_OMP_BIN env → known paths → PATH.
 */

import path from "node:path";
import os from "node:os";
import { AcpAgentExecutor } from "./lib/acpBase.js";

const PROVIDER_ID = "omp-acp";

export class OmpAcpExecutor extends AcpAgentExecutor {
  constructor() {
    super(PROVIDER_ID, {
      exe: "omp",
      envVar: "CLI_OMP_BIN",
      extraDirs: [path.join(os.homedir(), ".local", "bin")],
      label: "OMP",
      errorType: "omp_acp_error",
      installHint: "Install with `npm i -g omp`",
    });
  }
}