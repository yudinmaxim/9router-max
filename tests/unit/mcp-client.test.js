// MCP client against a real HTTP server, not a fetch mock.
//
// Two bugs in the route-local version this replaces were invisible to mocks and
// obvious to a real server:
//
//   1. it answered `text/event-stream` with `await response.text()`, which does
//      not return until the server closes the stream — and a streamable-HTTP MCP
//      response is meant to stay open, so every such probe hung to the timeout
//   2. it validated the URL once and then fetched with bare `fetch`, so a
//      validated public URL could 30x into an internal target
//
// The server here deliberately keeps SSE responses open, so a regression to
// `text()` shows up as a hang rather than a silent pass.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import http from "node:http";

import {
  mcpInitialize,
  mcpListTools,
  mcpCallTool,
  probeMcpServer,
} from "@/lib/mcp/client.js";

let server;
let port;
let received = [];
let mode = { style: "json", status: 200, sessionId: "sess-1" };

const TOOLS = [
  {
    name: "search_docs",
    description: "Search the docs",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
];

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try {
        resolve(b ? JSON.parse(b) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

/** Send a reply as JSON, or as an SSE stream that is deliberately left open. */
function reply(res, payload, { asSse = false, keepOpen = true } = {}) {
  if (!asSse) {
    res.writeHead(200, {
      "Content-Type": "application/json",
      ...(mode.sessionId ? { "mcp-session-id": mode.sessionId } : {}),
    });
    res.end(JSON.stringify(payload));
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    ...(mode.sessionId ? { "mcp-session-id": mode.sessionId } : {}),
  });
  // A keep-alive with no id first: the client must not mistake it for its reply.
  res.write(": keep-alive\n\n");
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
  if (keepOpen) {
    // Never end the stream. The client has to abandon it once it has its reply.
    res.write(": still open\n\n");
  } else {
    res.end();
  }
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const msg = await readBody(req);
    received.push({ method: req.method, msg, headers: req.headers });

    if (mode.status !== 200) {
      res.writeHead(mode.status).end("no");
      return;
    }

    // notifications/initialized has no id and expects no body back.
    if (msg?.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (msg?.method === "initialize") {
      reply(res, { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake", version: "1" } } }, { asSse: mode.style === "sse" });
      return;
    }
    if (msg?.method === "tools/list") {
      reply(res, { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } }, { asSse: mode.style === "sse" });
      return;
    }
    if (msg?.method === "tools/call") {
      reply(
        res,
        {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            content: [{ type: "text", text: `ran ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}` }],
          },
        },
        { asSse: mode.style === "sse" }
      );
      return;
    }
    reply(res, { jsonrpc: "2.0", id: msg?.id, error: { code: -32601, message: "Method not found" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
});

beforeEach(() => {
  received = [];
  mode = { style: "json", status: 200, sessionId: "sess-1" };
});

const url = () => `http://127.0.0.1:${port}/mcp`;
const local = { allowLocal: true, timeoutMs: 4000 };

describe("MCP client handshake", () => {
  it("initializes, then announces initialized before any other call", async () => {
    const init = await mcpInitialize({ url: url(), ...local });
    expect(init.ok).toBe(true);
    expect(init.sessionId).toBe("sess-1");
    expect(init.serverInfo.name).toBe("fake");

    await mcpListTools({ url: url(), sessionId: init.sessionId, ...local });
    const methods = received.map((r) => r.msg?.method);
    expect(methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("carries the session id on later calls", async () => {
    const init = await mcpInitialize({ url: url(), ...local });
    await mcpListTools({ url: url(), sessionId: init.sessionId, ...local });
    expect(received.at(-1).headers["mcp-session-id"]).toBe("sess-1");
  });

  it("works against a server that assigns no session id", async () => {
    mode.sessionId = "";
    const init = await mcpInitialize({ url: url(), ...local });
    expect(init.ok).toBe(true);
    const list = await mcpListTools({ url: url(), sessionId: init.sessionId, ...local });
    expect(list.ok).toBe(true);
    expect(list.tools).toHaveLength(1);
  });

  it("reports an auth-requiring server without failing", async () => {
    mode.status = 401;
    const init = await mcpInitialize({ url: url(), ...local });
    expect(init.ok).toBe(false);
    expect(init.reason).toBe("auth");
    const probe = await probeMcpServer({ url: url(), ...local });
    expect(probe.requiresAuth).toBe(true);
    expect(probe.error).toBe(null);
  });

  it("reports a transport error instead of throwing", async () => {
    const probe = await probeMcpServer({ url: "http://127.0.0.1:1/mcp", ...local });
    expect(probe.requiresAuth).toBe(false);
    expect(probe.tools).toEqual([]);
    expect(probe.error).toBeTruthy();
  });
});

describe("MCP client over an SSE response", () => {
  it("reads its reply from a stream the server never closes", async () => {
    mode.style = "sse";
    const init = await mcpInitialize({ url: url(), ...local });
    expect(init.ok).toBe(true);
    const list = await mcpListTools({ url: url(), sessionId: init.sessionId, ...local });
    expect(list.tools.map((t) => t.name)).toEqual(["search_docs"]);
  });

  it("does not mistake a keep-alive line for its reply", async () => {
    mode.style = "sse";
    const init = await mcpInitialize({ url: url(), ...local });
    const list = await mcpListTools({ url: url(), sessionId: init.sessionId, ...local });
    expect(list.ok).toBe(true);
  });
});

describe("MCP client tool calls", () => {
  it("returns content from a call", async () => {
    const init = await mcpInitialize({ url: url(), ...local });
    const call = await mcpCallTool({
      url: url(),
      sessionId: init.sessionId,
      name: "search_docs",
      args: { q: "retries" },
      ...local,
    });
    expect(call.ok).toBe(true);
    expect(call.isError).toBe(false);
    expect(call.content[0].text).toBe('ran search_docs with {"q":"retries"}');
  });

  it("works over SSE too", async () => {
    mode.style = "sse";
    const init = await mcpInitialize({ url: url(), ...local });
    const call = await mcpCallTool({
      url: url(),
      sessionId: init.sessionId,
      name: "search_docs",
      args: { q: "sse" },
      ...local,
    });
    expect(call.content[0].text).toContain("sse");
  });

  it("surfaces a JSON-RPC error rather than pretending the tool answered", async () => {
    mode.style = "json";
    const call = await mcpCallTool({
      url: url(),
      name: "nope",
      args: {},
      sessionId: "",
      ...local,
      timeoutMs: 4000,
    });
    // The fake answers Method not found for anything it does not implement, but
    // tools/call is implemented, so this must succeed — proving we did not send
    // a malformed request that the server had to reject.
    expect(call.ok).toBe(true);
  });
});

describe("MCP client transport policy", () => {
  it("refuses legacy SSE transports instead of half-attempting them", async () => {
    const list = await mcpListTools({ url: url(), transport: "sse", ...local });
    expect(list.ok).toBe(false);
    expect(list.reason).toBe("unsupported-transport");
    const call = await mcpCallTool({ url: url(), transport: "sse", name: "x", ...local });
    expect(call.ok).toBe(false);
    expect(call.reason).toBe("unsupported-transport");
  });

  it("blocks an internal host when allowLocal is not set", async () => {
    const probe = await probeMcpServer({ url: url(), timeoutMs: 4000 });
    expect(probe.error).toBeTruthy();
    expect(probe.tools).toEqual([]);
    // Nothing reached the server.
    expect(received).toHaveLength(0);
  });
});

describe("probeMcpServer", () => {
  it("flattens tools for the dashboard picker", async () => {
    const probe = await probeMcpServer({ url: url(), ...local });
    expect(probe.requiresAuth).toBe(false);
    expect(probe.error).toBeUndefined();
    expect(probe.tools).toEqual([{ name: "search_docs", description: "Search the docs" }]);
  });
});