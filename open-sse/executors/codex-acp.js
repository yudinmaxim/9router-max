/**
 * CodexAcpExecutor — routes completions through the locally installed Codex CLI
 * over the Agent Client Protocol.
 *
 * Codex does not speak ACP from its own binary. `codex acp` parses "acp" as a
 * prompt for the interactive TUI and exits with "stdin is not a terminal", so
 * there is no subcommand to spawn. What Codex does ship is `app-server`, and the
 * ACP adapter wraps it (see open-sse/executors/lib/acpAdapter.js).
 *
 * Registered unconditionally: whether the adapter or the CLI is installed is not
 * a reason to hide the provider from the registry, and the spawn error carries
 * the install hint.
 *
 * Credentials are the CLI's own — `codex login` writes ~/.codex/auth.json and the
 * adapter reads it through the spawned process's inherited environment, so this
 * provider stays noAuth and needs no key in the router.
 */

import path from "node:path";
import os from "node:os";
import { AcpAgentExecutor, resolveAgentBin } from "./lib/acpBase.js";
import { resolveInstalledBin } from "./lib/acpStatus.js";

const PROVIDER_ID = "codex-acp";

export class CodexAcpExecutor extends AcpAgentExecutor {
  constructor() {
    super(PROVIDER_ID, {
      // The bridge speaks ACP on stdio directly — there is no `acp` subcommand
      // to append, so args stay empty.
      exe: "codex-acp",
      args: [],
      adapter: PROVIDER_ID,
      envVar: "CLI_CODEX_ACP_BIN",
      extraDirs: [path.join(os.homedir(), ".local", "bin")],
      label: "Codex",
      errorType: "codex_acp_error",
      installHint:
        "Install the Codex CLI (`npm i -g @openai/codex`), run `codex login`, " +
        "then set up the ACP adapter from the provider card (or set CLI_CODEX_ACP_BIN)",
      // Point the adapter at the user's CLI rather than the copy it bundles,
      // which would otherwise silently lag behind an updated install.
      env: () => {
        const codex = resolveInstalledBin({ envVar: "CLI_CODEX_BIN", exe: "codex" });
        return codex ? { CODEX_PATH: codex } : {};
      },
    });
  }
}

export default CodexAcpExecutor;