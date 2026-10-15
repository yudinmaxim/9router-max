import { getMcpServers } from "@/models";
import { getMcpProxyKey, MCP_PROXY_KEY_HEADER } from "@/lib/mcp/proxyKey";

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

/**
 * Describe every enabled MCP server as an ACP `mcpServers` entry.
 *
 * The agents always get `type: "http"` pointing at our own proxy, whatever the
 * upstream transport is — streamable-http and legacy SSE are then the proxy's
 * problem rather than something every agent has to agree on. The credential is
 * never included: the agent only learns the proxy URL and the shared key, and
 * the token stays in the router's database.
 *
 * Returns [] when nothing is registered, which is what keeps the previous
 * `mcpServers: []` behaviour intact for operators who never touched the registry.
 */
export async function buildMcpProxyTargets() {
  let servers;
  try {
    servers = await getMcpServers({ isActive: true });
  } catch {
    return [];
  }
  if (!Array.isArray(servers) || servers.length === 0) return [];

  const base = proxyBase();
  const key = getMcpProxyKey();
  return servers.map((server) => ({
    type: "http",
    name: server.name || server.id,
    url: `${base}/api/mcp-proxy/${server.id}`,
    headers: { [MCP_PROXY_KEY_HEADER]: key },
  }));
}