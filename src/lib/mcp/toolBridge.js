// The router's own MCP side: turn the registry into OpenAI function tools, and
// execute the ones a model calls.
//
// Phase 2b handed the registry to ACP agents through our own proxy — the agent
// speaks MCP itself and the router only relays. This is the other side: for an
// OpenAI-compatible provider the router is the one talking to the model, so the
// router is the one that has to speak MCP on the model's behalf.
//
// The engine never touches the database, so this bridge is built in the app
// layer and handed to `handleChatCore` as an argument, exactly like
// `acpPermissions` and `pxpipeTransform`.
//
// Naming: OpenAI function names must match [A-Za-z0-9_-] and cap at 64 chars, so
// the `server.tool` shape MCP uses on the wire cannot be handed over verbatim —
// the dot is illegal. The prefix is `mcp9r__` and not the `mcp__` that Claude and
// Cowork clients already use for their own connectors: those names are subject
// to the dedup rules in open-sse/utils/toolDeduper.js, which strip built-in web
// tools when they see `mcp__exa__*` or `mcp__tavily__*`, and a registry entry must
// not be able to trigger that for an unrelated tool set. Collisions inside our
// own namespace are resolved the only way they can be — by refusing the second
// server to claim a name the first already took.

import { getMcpServers, resolveMcpServerForProxy } from "@/models";
import { mcpInitialize, mcpListTools, mcpCallTool } from "@/lib/mcp/client.js";

export const MCP_TOOL_PREFIX = "mcp9r__";

const LIST_TTL_MS = 60_000;
const MAX_NAME = 64;
const CALL_TIMEOUT_MS = 20_000;
/** A tool result is model context. Past this it is truncated rather than dropped. */
const MAX_RESULT_CHARS = 8_000;

/** OpenAI-safe, collision-free, and reversible only through `owned` — the name is
 *  the model's handle, never a parse target. */
function mangle(serverName, toolName) {
  const slug = (s) => String(s || "").replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  const head = `${MCP_TOOL_PREFIX}${slug(serverName)}__`;
  const tail = slug(toolName) || "tool";
  const room = MAX_NAME - head.length;
  if (room >= 4) return head + tail.slice(0, room);
  // A server name long enough to leave no usable room: hash rather than truncate
  // to something that could collide with a different server's tool.
  const hash = Math.abs(hashString(`${serverName}/${toolName}`)).toString(36).slice(0, 6);
  return `${MCP_TOOL_PREFIX}x_${hash}_${tail.slice(0, MAX_NAME - head.length - 8)}`;
}

function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

/** MCP content union → one flat string the model can read. */
export function flattenMcpContent({ content = [], structuredContent = null } = {}) {
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (typeof block === "string") { parts.push(block); continue; }
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[image content omitted]");
    else if (block.type === "resource") {
      parts.push(block.resource?.text ?? `[resource: ${block.resource?.uri || "unknown"}]`);
    } else if (block.text !== undefined) parts.push(String(block.text));
    else parts.push(JSON.stringify(block));
  }
  if (structuredContent !== null && structuredContent !== undefined) {
    parts.push(JSON.stringify(structuredContent));
  }
  const text = parts.join("\n").trim();
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n…(truncated)` : text;
}

/** Cache is module-level and keyed by id+updatedAt, so an edit to a server shows
 *  up on the next request after the TTL without anyone having to restart. */
const listCache = new Map();

async function listServerTools(server) {
  const cached = listCache.get(server.id);
  if (cached && cached.stamp === server.updatedAt && Date.now() - cached.at < LIST_TTL_MS) {
    return cached.tools;
  }
  const target = await resolveMcpServerForProxy(server.id);
  if (!target || target.disabled || target.tokenError) {
    listCache.set(server.id, { stamp: server.updatedAt, at: Date.now(), tools: [] });
    return [];
  }
  const init = await mcpInitialize({ url: target.url, headers: target.headers, allowLocal: target.allowLocal });
  if (!init.ok) {
    listCache.set(server.id, { stamp: server.updatedAt, at: Date.now(), tools: [] });
    return [];
  }
  const list = await mcpListTools({
    url: target.url,
    headers: target.headers,
    transport: target.transport,
    sessionId: init.sessionId,
    allowLocal: target.allowLocal,
  });
  const tools = list.ok ? list.tools : [];
  listCache.set(server.id, { stamp: server.updatedAt, at: Date.now(), tools });
  return tools;
}

/**
 * Build the router-side MCP bridge.
 *
 * Returns null when nothing is registered or nothing usable is — that is the
 * path every operator who never touched the registry takes, and it must stay
 * free of side effects so the hot request path does no extra work for them.
 *
 * @returns {Promise<null | {list(): Promise<Array>, call(name, args): Promise<{ok, text, isError}>, has(): boolean}>}
 */
export async function buildMcpToolBridge() {
  let servers;
  try {
    servers = await getMcpServers({ isActive: true });
  } catch {
    return null;
  }
  if (!Array.isArray(servers) || servers.length === 0) return null;
  // The legacy GET-based SSE transport is reported unsupported by the client
  // rather than half-attempted, so those servers can contribute nothing.
  const usable = servers.filter((s) => s.transport !== "sse" && s.url);
  if (usable.length === 0) return null;

  let empty = true;
  /** mangled name → { serverId, toolName } */
  const owned = new Map();

  async function list() {
    empty = true;
    owned.clear();
    const out = [];
    for (const server of usable) {
      let tools = [];
      try {
        tools = await listServerTools(server);
      } catch {
        tools = [];
      }
      for (const tool of tools) {
        if (!tool?.name) continue;
        const name = mangle(server.name || server.id, tool.name);
        if (owned.has(name)) continue; // first server wins the name
        owned.set(name, { serverId: server.id, toolName: tool.name });
        out.push({
          type: "function",
          function: {
            name,
            description: tool.description || `MCP tool ${tool.name} on server ${server.name || server.id}`,
            parameters: tool.inputSchema || tool.input_schema || { type: "object", properties: {} },
          },
        });
      }
    }
    if (out.length > 0) empty = false;
    return out;
  }

  async function call(name, args) {
    const entry = owned.get(name);
    if (!entry) return { ok: false, text: `Unknown MCP tool: ${name}`, isError: true };
    const target = await resolveMcpServerForProxy(entry.serverId);
    if (!target || target.disabled) return { ok: false, text: "MCP server is disabled", isError: true };
    if (target.tokenError) return { ok: false, text: target.tokenError, isError: true };
    const init = await mcpInitialize({ url: target.url, headers: target.headers, allowLocal: target.allowLocal });
    if (!init.ok) return { ok: false, text: `MCP initialize failed (${init.reason})`, isError: true };
    const r = await mcpCallTool({
      url: target.url,
      headers: target.headers,
      transport: target.transport,
      name: entry.toolName,
      args: args || {},
      sessionId: init.sessionId,
      timeoutMs: CALL_TIMEOUT_MS,
      allowLocal: target.allowLocal,
    });
    if (!r.ok) return { ok: false, text: `MCP call failed (${r.reason})`, isError: true };
    return { ok: true, text: flattenMcpContent(r), isError: r.isError === true };
  }

  return { list, call, has: () => !empty };
}