/**
 * Client tool bridge: OpenAI `body.tools` → an MCP server the ACP agent calls.
 *
 * Agents reached over ACP speak the protocol's own tool surface plus whatever
 * MCP servers we register in `session/new`. They do not read OpenAI
 * function-calling schemas from the request body — verified: `body.tools`
 * arrives and is ignored. So client tools are handed over the other way round:
 * declared as a throwaway stdio MCP server, and when the agent calls one we
 * emit an OpenAI `tool_calls` delta and end the turn with `finish_reason:
 * "tool_calls"`. The client runs the tool and replies; that next request
 * re-spawns the agent with the full history, and the tool result from that
 * history is seeded back into the server so a repeat call gets real data
 * instead of a placeholder.
 *
 * Tool schemas travel in ACP_CLIENT_TOOLS, prior results in
 * ACP_CLIENT_TOOL_RESULTS — env rather than argv so results (arbitrary client
 * output, possibly large) never appear in a process listing.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Name the bridge server is registered under in `session/new`. */
export const CLIENT_TOOLS_SERVER_NAME = "clientTools";

const CLIENT_TOOLS_MCP_SCRIPT = `
import readline from "node:readline";
const TOOLS = JSON.parse(process.env.ACP_CLIENT_TOOLS || "[]");
const RESULTS = JSON.parse(process.env.ACP_CLIENT_TOOL_RESULTS || "{}");
const rl = readline.createInterface({ input: process.stdin });
function send(o){ process.stdout.write(JSON.stringify(o) + "\\n"); }
rl.on("line", (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === "initialize") {
    send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "clientTools", version: "1.0" } } });
  } else if (m.method === "tools/list") {
    send({ jsonrpc: "2.0", id: m.id, result: { tools: TOOLS } });
  } else if (m.method === "tools/call") {
    const name = m.params?.name || "";
    const seeded = RESULTS[name];
    const text = seeded !== undefined
      ? String(seeded)
      : "(awaiting client tool_result)";
    process.stderr.write("[client-tools] tool_call name=" + name + " seeded=" + (seeded !== undefined) + "\\n");
    send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
  }
});
`.trimStart();

function writeBridgeScript(scriptFile) {
  const scriptPath = path.join(os.tmpdir(), scriptFile);
  // Always rewrite so bridge upgrades land without a server restart.
  fs.writeFileSync(scriptPath, CLIENT_TOOLS_MCP_SCRIPT);
  return scriptPath;
}

/**
 * Name mangling. Some agents (devin) only discover an MCP tool whose name
 * carries a provider-specific prefix; others reject unknown prefixes on names
 * they already accept. So the prefix is per-agent, not global.
 */
export function toMcpToolName(name, prefix = "") {
  if (!prefix) return name;
  return name.startsWith(prefix) ? name : prefix + name;
}

export function fromMcpToolName(name, prefix = "") {
  if (!prefix) return name;
  return name.startsWith(prefix) ? name.slice(prefix.length) : name;
}

/**
 * OpenAI tools ([{type:"function",function:{name,description,parameters}}]) →
 * MCP declarations ([{name,description,inputSchema}]).
 */
export function clientToolDeclarations(tools, prefix = "") {
  const out = [];
  for (const t of tools || []) {
    const f = t?.function || t;
    if (!f?.name) continue;
    out.push({
      name: toMcpToolName(f.name, prefix),
      description: f.description || "",
      inputSchema: f.parameters || f.input_schema || { type: "object", properties: {} },
    });
  }
  return out;
}

/**
 * MCP stdio server entry for `session/new`, or null when the caller sent no
 * usable tools. An ACP `mcpServers` element for stdio is
 * `{name, command, args, env}`.
 */
export function buildClientToolsMcp(tools, resultMap, options = {}) {
  const { prefix = "", scriptFile = "9router-acp-client-tools.mjs" } = options;
  const declarations = clientToolDeclarations(tools, prefix);
  if (!declarations.length) return null;
  const env = { ACP_CLIENT_TOOLS: JSON.stringify(declarations) };
  if (resultMap && Object.keys(resultMap).length) {
    env.ACP_CLIENT_TOOL_RESULTS = JSON.stringify(resultMap);
  }
  return {
    name: CLIENT_TOOLS_SERVER_NAME,
    command: process.execPath,
    args: [writeBridgeScript(scriptFile)],
    env,
  };
}

/**
 * Tool results from conversation history, keyed by MCP tool name.
 *
 * Handles both wire shapes: OpenAI (`assistant.tool_calls` + `role:"tool"`) and
 * Claude (`tool_use` / `tool_result` content blocks), because the same history
 * reaches the executor after translation and the shape depends on which
 * translator ran.
 */
export function extractClientToolResults(messages, options = {}) {
  const { prefix = "" } = options;
  const idToMcpName = new Map();
  const results = {};
  for (const m of messages || []) {
    if (m?.role === "assistant" && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name || tc?.name;
        if (tc?.id && name) idToMcpName.set(tc.id, toMcpToolName(name, prefix));
      }
    }
    if (m?.role === "assistant" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_use" && b.id && b.name) {
          idToMcpName.set(b.id, toMcpToolName(b.name, prefix));
        }
      }
    }
    if (m?.role === "tool" && m.tool_call_id) {
      const mcpName = idToMcpName.get(m.tool_call_id);
      if (mcpName) {
        results[mcpName] =
          typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      }
    }
    if (m?.role === "user" && Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b?.type === "tool_result" && b.tool_use_id) {
          const mcpName = idToMcpName.get(b.tool_use_id);
          if (mcpName) {
            const c = b.content;
            results[mcpName] = typeof c === "string" ? c : JSON.stringify(c ?? "");
          }
        }
      }
    }
  }
  return results;
}

/**
 * Decide whether a `tool_call` / `tool_call_update` notification is the agent
 * invoking one of our bridged tools, and return the original (unprefixed)
 * client tool name.
 *
 * There is no structured field carrying the tool name across the agents we
 * support — devin puts it in `title` as `Calling mcp_<name> from clientTools`,
 * others report something else entirely. So this matches against the declared
 * names in whatever text the notification carries. That is safe in the
 * direction that matters: a false positive needs an agent to name one of our
 * tools in a notification about its own tool, and a false negative only costs
 * the client one tool call.
 *
 * @param {object} update        the session/update payload
 * @param {Set<string>} known    declared MCP tool names
 * @param {string} [prefix]
 * @returns {string|null}
 */
export function detectClientToolName(update, known, prefix = "") {
  if (!update || !known || !known.size) return null;
  const haystacks = [
    update.toolName,
    update.name,
    update.meta?.toolName,
    update.meta?.title,
    update.title,
  ].filter((s) => typeof s === "string" && s);
  for (const hay of haystacks) {
    for (const mcpName of known) {
      if (hay === mcpName || new RegExp(`\\b${escapeRe(mcpName)}\\b`).test(hay)) {
        return fromMcpToolName(mcpName, prefix);
      }
    }
  }
  return null;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}