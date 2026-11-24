import fs from "node:fs";
import path from "node:path";
import { getMcpServers } from "@/models";
import { getMcpProxyKey, MCP_PROXY_KEY_HEADER } from "@/lib/mcp/proxyKey";

const HOST_RUNNER_DEFAULT_IN = "/var/lib/9r-runner/in";
const HOST_RUNNER_DEFAULT_OUT = "/var/lib/9r-runner/out";

let warnedMissingPlugin = false;

/**
 * Loopback base the agents are told to use.
 *
 * The agents we spawn are local processes, so 127.0.0.1 is always reachable for
 * them; the router's own listening port is what we have to get right, and that
 * is PORT — the standalone server reads it the same way (see server.js).
 */
function proxyBase() {
  const port = Number(process.env.PORT) || 20128;
  return `http://127.0.0.1:${port}`;
}

function envFlag(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

/**
 * Optional local stdio MCP server for whitelisted host-side commands.
 *
 * Deliberately opt-in: operators who never mount the queue directories must
 * keep the previous behaviour. The plugin itself never executes commands — it
 * writes a request file for host-runner/daemon.py and waits for the result.
 *
 * Shape matches buildClientToolsMcp(): no `type` (agents infer stdio from
 * `command`) and `env` as an array of {name, value}, which is what the live
 * ACP union accepts. An object there kills the whole session with -32603.
 */
function hostRunnerTarget() {
  if (!envFlag(process.env.NINEROUTER_HOST_RUNNER)) return null;

  const configured = process.env.NINEROUTER_HOST_RUNNER_PLUGIN;
  const pluginPath = path.resolve(
    configured || path.join(process.cwd(), "host-runner", "plugin.mjs")
  );
  if (!fs.existsSync(pluginPath)) {
    if (!warnedMissingPlugin) {
      warnedMissingPlugin = true;
      console.warn(
        `[hostrunner] plugin not found at ${pluginPath}; set NINEROUTER_HOST_RUNNER_PLUGIN ` +
          "or mount host-runner/ into the container"
      );
    }
    return null;
  }

  return {
    name: "hostrunner",
    command: process.execPath,
    args: [pluginPath],
    env: [
      {
        name: "HOST_RUNNER_IN_DIR",
        value: process.env.HOST_RUNNER_IN_DIR || HOST_RUNNER_DEFAULT_IN,
      },
      {
        name: "HOST_RUNNER_OUT_DIR",
        value: process.env.HOST_RUNNER_OUT_DIR || HOST_RUNNER_DEFAULT_OUT,
      },
    ],
  };
}

/**
 * Describe every enabled MCP server as an ACP `mcpServers` entry.
 *
 * Registry servers always get `type: "http"` pointing at our own proxy,
 * whatever the upstream transport is — streamable-http and legacy SSE are then
 * the proxy's problem rather than something every agent has to agree on. The
 * credential is never included: the agent only learns the proxy URL and the
 * shared key, and the token stays in the router's database.
 *
 * Returns [] when nothing is registered and the host runner is disabled, which
 * keeps the previous `mcpServers: []` behaviour intact for operators who never
 * touched either feature.
 */
export async function buildMcpProxyTargets() {
  let servers = [];
  try {
    const loaded = await getMcpServers({ isActive: true });
    if (Array.isArray(loaded)) servers = loaded;
  } catch {
    // A broken registry must not disable an independently configured host runner.
  }

  const targets = [];
  if (servers.length > 0) {
    const base = proxyBase();
    const key = getMcpProxyKey();
    for (const server of servers) {
      targets.push({
        type: "http",
        name: server.name || server.id,
        url: `${base}/api/mcp-proxy/${server.id}`,
        // `headers` is a sequence of {name, value}, not an object — verified live.
        // cursor-agent rejects the whole session with -32603 invalid_union on an
        // object, which kills every MCP server including ones that were fine, and
        // its error enumerates the rejected variants before the accepted one, so
        // the cause is not visible unless you read all three.
        headers: [{ name: MCP_PROXY_KEY_HEADER, value: key }],
      });
    }
  }

  const local = hostRunnerTarget();
  if (local) targets.push(local);
  return targets;
}
