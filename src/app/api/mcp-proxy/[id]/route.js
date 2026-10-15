import { NextResponse } from "next/server";
import { resolveMcpServerForProxy } from "@/models";
import { fetchPublic } from "@/shared/utils/ssrfGuard.js";
import { MCP_PROXY_KEY_HEADER, isMcpProxyKeyValid } from "@/lib/mcp/proxyKey.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Streamable HTTP speaks two response shapes on the same POST: a single
// application/json body, or text/event-stream. Both are forwarded untouched, so
// the agent sees exactly what the MCP server produced — including the
// mcp-session-id header, whose lifetime this proxy deliberately does not manage.
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

function outgoingHeaders(target, request) {
  const headers = {
    accept: request.headers.get("accept") || "application/json, text/event-stream",
    "user-agent": "9router-mcp-proxy",
  };
  // The session id belongs to the MCP server, not to us: the agent sends back
  // whatever initialize handed it, and the upstream decides whether it is live.
  const sessionId = request.headers.get("mcp-session-id");
  if (sessionId) headers["mcp-session-id"] = sessionId;
  for (const [key, value] of Object.entries(target.headers || {})) headers[key] = value;
  return headers;
}

function forwardResponse(upstream) {
  const headers = {};
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
  });
  if (headers["content-type"]?.includes("text/event-stream")) {
    // Without this an intermediary will happily buffer the whole stream, which
    // for MCP means the agent waits for a response that is already written.
    headers["cache-control"] = "no-cache, no-transform";
    headers["x-accel-buffering"] = "no";
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

async function handle(request, { params, method }) {
  const { id } = await params;

  if (!isMcpProxyKeyValid(request.headers.get(MCP_PROXY_KEY_HEADER))) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const target = await resolveMcpServerForProxy(id);
  if (!target) return NextResponse.json({ error: "unknown MCP server" }, { status: 404 });
  if (target.disabled) return NextResponse.json({ error: "MCP server is disabled" }, { status: 409 });
  if (target.tokenError) return NextResponse.json({ error: target.tokenError }, { status: 500 });

  const init = {
    method,
    headers: outgoingHeaders(target, request),
  };
  if (method === "POST" || method === "PUT") {
    init.body = await request.text();
    init.headers["content-type"] = request.headers.get("content-type") || "application/json";
  }

  try {
    const upstream = await fetchPublic(target.url, init, { allowLocal: target.allowLocal });
    return forwardResponse(upstream);
  } catch (error) {
    return NextResponse.json({ error: `upstream unreachable: ${error.message}` }, { status: 502 });
  }
}

// POST — JSON-RPC message, response forwarded as JSON or SSE.
export async function POST(request, context) {
  return handle(request, { ...context, method: "POST" });
}

// GET — the server-initiated half of streamable HTTP, if the agent opens one.
export async function GET(request, context) {
  return handle(request, { ...context, method: "GET" });
}

// DELETE — session teardown, forwarded so the upstream can reclaim state.
export async function DELETE(request, context) {
  return handle(request, { ...context, method: "DELETE" });
}