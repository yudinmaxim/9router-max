// MCP client: talk to remote MCP servers.
//
// This is the single place that knows how to speak MCP to someone else's
// server. It existed as a 105-line `probeMcp` inside
// `api/cli-tools/cowork-mcp-tools/route.js`, which could initialize and list
// tools but could not call one, and which hung on every server that answered
// `text/event-stream` — `await response.text()` does not return until the
// server closes the stream, and a streamable-HTTP MCP response is meant to stay
// open. It also validated the URL once with `assertPublicUrl` and then fetched
// with bare `fetch`, so a validated public URL could 30x its way to an internal
// target; `fetchPublic` re-validates each redirect.
//
// Transport here is streamable HTTP (POST a JSON-RPC message, read the reply,
// which may arrive as JSON or as an SSE stream). Legacy GET-based SSE, where
// the client opens an event stream and is handed a POST endpoint, is reported
// as unsupported rather than half-attempted: no server in the catalogue we
// probe speaks it, and an untested guess here would be worse than an error.

import { fetchPublic } from "@/shared/utils/ssrfGuard.js";

/** Protocol revision this client negotiates. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * `text/event-stream` bodies are read incrementally and abandoned as soon as
 * the reply we asked for arrives — the stream does not end on its own.
 */
async function readSseForId(res, id) {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let msg;
        try {
          msg = JSON.parse(payload);
        } catch {
          continue; // keep-alive or partial frame
        }
        if (msg && msg.id === id) return msg;
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return null;
}

function baseHeaders(extra) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    ...extra,
  };
}

/**
 * One JSON-RPC round trip. Returns `{ ok, message }` — a transport/auth
 * failure comes back as `{ ok: false, reason }` rather than a thrown error, so
 * callers probing many servers don't need try/catch per server.
 *
 * `allowLocal` is only ever set by callers that have already established the
 * target is the operator's own machine (self-hosted MCP inside 9router); a
 * remote caller must not be able to reach it.
 */
async function rpc(url, { id, method, params, headers, sessionId, timeoutMs = DEFAULT_TIMEOUT_MS, allowLocal = false, expectResponse = true }) {
  const body = expectResponse
    ? { jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }
    : { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchPublic(
      url,
      {
        method: "POST",
        headers: baseHeaders(sessionId ? { ...headers, "mcp-session-id": sessionId } : headers),
        body: JSON.stringify(body),
        signal: ac.signal,
      },
      { allowLocal }
    );

    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "auth", status: res.status };
    }
    if (!expectResponse) {
      // Fire-and-forget notification: the body is a stream we will never read.
      res.body?.cancel?.().catch(() => {});
      return { ok: true, message: null };
    }
    if (!res.ok) {
      return { ok: false, reason: "http", status: res.status };
    }

    const session = res.headers.get("mcp-session-id") || "";
    const ct = res.headers.get("content-type") || "";
    let message;
    if (ct.includes("text/event-stream")) {
      message = await readSseForId(res, id);
    } else {
      message = await res.json().catch(() => null);
    }
    if (!message) return { ok: false, reason: "no-response" };
    if (message.error) return { ok: false, reason: "rpc", error: message.error, sessionId: session };
    return { ok: true, message, sessionId: session };
  } catch (e) {
    // The SSRF guard throws before any socket is opened. Callers map this to a
    // 400 (refusal), not to a 502 — it is not an upstream failure.
    if (/^Blocked URL/.test(String(e?.message || ""))) {
      return { ok: false, reason: "blocked", error: String(e.message) };
    }
    return { ok: false, reason: e?.name === "AbortError" ? "timeout" : "network", error: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * initialize → notifications/initialized, returning the session id the server
 * assigned (may be empty: stateless servers do not use one).
 */
export async function mcpInitialize({ url, headers, timeoutMs = DEFAULT_TIMEOUT_MS, allowLocal = false }) {
  const init = await rpc(url, {
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "9router", version: "1" },
    },
    headers,
    timeoutMs,
    allowLocal,
  });
  if (!init.ok) return init;

  // Required by the spec before any other call, and answered with no content —
  // on an SSE server this request's stream would otherwise never close.
  await rpc(url, {
    method: "notifications/initialized",
    params: {},
    headers,
    sessionId: init.sessionId,
    timeoutMs,
    allowLocal,
    expectResponse: false,
  });

  return { ok: true, sessionId: init.sessionId || "", serverInfo: init.message?.result?.serverInfo || null };
}

/** Tool declarations, with their input schemas intact. */
export async function mcpListTools({ url, headers, transport = "http", sessionId = "", timeoutMs = DEFAULT_TIMEOUT_MS, allowLocal = false }) {
  if (transport === "sse") {
    // Legacy GET-based SSE: needs an event stream to learn the POST endpoint.
    return { ok: false, reason: "unsupported-transport", tools: [] };
  }
  const r = await rpc(url, { id: 2, method: "tools/list", headers, sessionId, timeoutMs, allowLocal });
  if (!r.ok) return { ok: false, ...r, tools: [] };
  return { ok: true, tools: r.message?.result?.tools || [], sessionId: r.sessionId || sessionId };
}

/**
 * Invoke a tool. Content is flattened to text blocks plus a JSON blob when the
 * result is structured — callers that render tool output do not want to walk
 * MCP's content union themselves.
 */
export async function mcpCallTool({ url, headers, transport = "http", name, args = {}, sessionId = "", timeoutMs = DEFAULT_TIMEOUT_MS, allowLocal = false }) {
  if (transport === "sse") {
    return { ok: false, reason: "unsupported-transport", content: [], isError: false };
  }
  const r = await rpc(url, {
    id: 3,
    method: "tools/call",
    params: { name, arguments: args },
    headers,
    sessionId,
    timeoutMs,
    allowLocal,
  });
  if (!r.ok) return { ok: false, ...r, content: [], isError: false };
  const result = r.message?.result || {};
  return {
    ok: true,
    content: Array.isArray(result.content) ? result.content : [],
    structuredContent: result.structuredContent ?? null,
    isError: Boolean(result.isError),
  };
}

/**
 * What the dashboard's tool picker needs: a flat `{name, description}` list,
 * with auth-requiring servers reported as such instead of as an empty list, so
 * the UI can tell "this server needs a token" from "this server has no tools".
 */
export async function probeMcpServer({ url, transport, headers, timeoutMs = DEFAULT_TIMEOUT_MS, allowLocal = false }) {
  const init = await mcpInitialize({ url, headers, timeoutMs, allowLocal });
  if (!init.ok) {
    return {
      requiresAuth: init.reason === "auth",
      blocked: init.reason === "blocked",
      error: init.reason === "auth" ? null : init.reason,
      tools: [],
    };
  }
  const list = await mcpListTools({ url, headers, transport, sessionId: init.sessionId, timeoutMs, allowLocal });
  if (!list.ok) {
    return {
      requiresAuth: list.reason === "auth",
      blocked: list.reason === "blocked",
      error: list.reason === "auth" ? null : list.reason,
      tools: [],
    };
  }
  return {
    requiresAuth: false,
    tools: list.tools.map((t) => ({ name: t.name, description: t.description || "" })),
  };
}