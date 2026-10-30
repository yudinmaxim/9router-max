/**
 * ACP child session factory — creates and handshakes with internal ACP agents.
 *
 * This is the prod implementation of the `openChild` contract used by
 * AcpAgentServer. Given a provider id and workspace/mcp params, it spawns
 * a child agent (codex-acp, opencode-acp, …), runs the ACP handshake
 * (initialize → session/new), and returns a ChildHandle the server can
 * use to route a dialogue.
 *
 * Reuses the ACP client machinery from acpBase.js/acpClientCore.js and
 * the existing executor specs, so there is no protocol duplication.
 */
import { spawnAcpChild, createAcpClientCore } from "../executors/lib/acpClientCore.js";
import { resolveSpawnPlan } from "../executors/lib/acpBase.js";
import { agentSpawnCommand } from "../executors/lib/acpCommon.js";
import { collectModelCatalog, currentAgentModel } from "../executors/lib/acpBase.js";
import { getExecutor } from "../executors/index.js";

const PROTOCOL_VERSION = 1;

/**
 * @param {object} options
 * @param {string} options.providerId  registry id (e.g. "codex-acp")
 * @param {object} options.spec        ACP spec from executor.acp (exe, envVar, …)
 * @param {(level: string, msg: string) => void} [options.log]
 */
export function createChildFactory({ providerId, spec, log = () => {} }) {
  const provider = providerId;

  /**
   * Open a live child session with the ACP agent.
   *
   * @param {object} opts
   * @param {string} opts.cwd          workspace directory
   * @param {Array} opts.mcpServers    MCP servers to register (empty array for now)
   * @returns {Promise<ChildHandle>}
   */
  async function openChild({ cwd, mcpServers }) {
    const { exe, args, envVar, versionsDir, extraDirs, adapter } = spec;

    const { env, proxyTrace, bin } = await resolveSpawnPlan({
      acp: spec,
      providerId,
      proxyOptions: null,
      log,
    });

    const spawnArgs = args || ["acp"];
    const { cmd, shell } = agentSpawnCommand(bin, spawnArgs);

    const child = spawnAcpChild({
      cmd,
      args: spawnArgs,
      env,
      cwd,
      shell,
    });

    const core = createAcpClientCore({
      child,
      trace: (event, data) => log("debug", `ACP trace ${event}: ${JSON.stringify(data)}`),
    });

    let sessionResult = null;
    let catalog = [];
    let currentModel = null;

    const onceSessionNew = new Promise((resolve, reject) => {
      const onMessage = (msg) => {
        if (msg.method === "session/new" && !sessionResult) {
          sessionResult = msg.params?.result || msg.result;
          catalog = collectModelCatalog(sessionResult);
          currentModel = currentAgentModel(sessionResult);
          resolve();
        }
      };
      core.onMessage(onMessage);
    });

    core.sendRpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: "9router", version: "1.0" },
      capabilities: {},
    });

    const sessionNewId = core.sendRpc("session/new", { cwd, mcpServers });

    if (!sessionNewId) {
      throw new Error("failed to send session/new request");
    }

    await onceSessionNew;

    const sessionId = sessionResult?.sessionId || "";

    return {
      provider,
      sessionId,
      catalog,
      currentModel,
      configOptions: sessionResult?.configOptions,
      sendRpc: core.sendRpc,
      onMessage: core.onMessage,
      dispose: core.dispose,
    };
  }

  return { openChild };
}
