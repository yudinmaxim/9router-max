// The router-side MCP bridge against a real HTTP MCP server.
//
// The registry is faked at `@/models` — that is the only seam, and it is the
// right one, because the point of these tests is what happens between the
// registry row and an actual JSON-RPC exchange. The server is real, and it
// deliberately answers `tools/list` over SSE with the stream left open, because
// that is the response shape that used to hang the old route-local client.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import http from "node:http";

vi.mock("@/models", () => ({
  getMcpServers: vi.fn(async () => []),
  resolveMcpServerForProxy: vi.fn(async () => null),
}));

const { getMcpServers, resolveMcpServerForProxy } = await import("@/models");
const { buildMcpToolBridge, flattenMcpContent, MCP_TOOL_PREFIX } = await import("@/lib/mcp/toolBridge.js");

let server;
let port;
/** Tool list the fake server returns; tests rewrite this. */
let offered = [
  { name: "search_docs", description: "Search the docs", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
];
let calls = [];
let listAsSse = false;

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : null); } catch { resolve(null); }
    });
  });
}

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const msg = await readBody(req);
    if (!msg || !msg.method) { res.writeHead(400).end(); return; }

    if (msg.method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "probe", version: "1" } } }));
      return;
    }
    if (msg.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }
    if (msg.method === "tools/list") {
      const payload = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { tools: offered } });
      if (!listAsSse) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(payload);
        return;
      }
      // Left open on purpose: `await response.text()` never returns on this.
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${payload}\n\n`);
      return;
    }
    if (msg.method === "tools/call") {
      calls.push({ name: msg.params?.name, args: msg.params?.arguments });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `ran:${msg.params?.name}` }] },
      }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function registerServer(overrides = {}) {
  const row = {
    id: "srv-1",
    name: "probe",
    transport: "http",
    authType: "none",
    allowLocal: true,
    isActive: true,
    url: `http://127.0.0.1:${port}/mcp`,
    updatedAt: "2026-10-17T00:00:00.000Z",
    ...overrides,
  };
  getMcpServers.mockResolvedValue([row]);
  resolveMcpServerForProxy.mockImplementation(async (id) => ({
    id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    allowLocal: row.allowLocal,
    headers: {},
    tokenError: null,
  }));
}

beforeEach(() => {
  calls = [];
  offered = [
    { name: "search_docs", description: "Search the docs", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
  ];
  listAsSse = false;
});

describe("building the bridge", () => {
  it("is null when nothing is registered", async () => {
    getMcpServers.mockResolvedValue([]);
    expect(await buildMcpToolBridge()).toBeNull();
  });

  it("is null when every registered server speaks the unsupported transport", async () => {
    registerServer({ transport: "sse" });
    expect(await buildMcpToolBridge()).toBeNull();
  });

  it("survives a registry read that throws", async () => {
    getMcpServers.mockRejectedValue(new Error("db gone"));
    expect(await buildMcpToolBridge()).toBeNull();
  });
});

describe("declaring tools to the model", () => {
  it("renames server.tool into an OpenAI-legal name", async () => {
    registerServer({ name: "jira", updatedAt: "t1" });
    offered = [
      { name: "search_issues", description: "Search issues", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ];
    const bridge = await buildMcpToolBridge();
    const tools = await bridge.list();
    expect(tools).toHaveLength(1);
    expect(tools[0].type).toBe("function");
    // The dot MCP uses on the wire is not a legal OpenAI function name.
    expect(tools[0].function.name).toBe(`${MCP_TOOL_PREFIX}jira__search_issues`);
    expect(tools[0].function.name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(tools[0].function.name.length).toBeLessThanOrEqual(64);
    expect(tools[0].function.parameters).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(bridge.has()).toBe(true);
  });

  it("reads a tools/list that arrives as an open SSE stream", async () => {
    registerServer({ name: "sseprobe", updatedAt: "t2" });
    listAsSse = true;
    try {
      const bridge = await buildMcpToolBridge();
      const tools = await bridge.list();
      expect(tools.map((t) => t.function.name)).toEqual([`${MCP_TOOL_PREFIX}sseprobe__search_docs`]);
    } finally {
      listAsSse = false;
    }
  });

  it("lets the first server keep a name the second would claim", async () => {
    getMcpServers.mockResolvedValue([
      { id: "a", name: "jira", transport: "http", allowLocal: true, isActive: true, url: `http://127.0.0.1:${port}/mcp`, updatedAt: "ta" },
      { id: "b", name: "jira", transport: "http", allowLocal: true, isActive: true, url: `http://127.0.0.1:${port}/mcp`, updatedAt: "tb" },
    ]);
    resolveMcpServerForProxy.mockImplementation(async (id) => ({
      id, name: "jira", url: `http://127.0.0.1:${port}/mcp`, transport: "http", allowLocal: true, headers: {}, tokenError: null,
    }));
    offered = [{ name: "same_tool", description: "", inputSchema: { type: "object", properties: {} } }];
    const bridge = await buildMcpToolBridge();
    const tools = await bridge.list();
    expect(tools).toHaveLength(1);
  });
});

describe("running a tool the model asked for", () => {
  it("reaches the real server and returns its text", async () => {
    registerServer({ name: "probe", updatedAt: "t3" });
    offered = [{ name: "search_docs", description: "", inputSchema: { type: "object", properties: {} } }];
    const bridge = await buildMcpToolBridge();
    await bridge.list();
    calls = [];
    const result = await bridge.call(`${MCP_TOOL_PREFIX}probe__search_docs`, { q: "flaky test" });
    expect(result).toEqual({ ok: true, text: "ran:search_docs", isError: false });
    expect(calls).toEqual([{ name: "search_docs", args: { q: "flaky test" } }]);
  });

  it("refuses a name it never declared", async () => {
    registerServer({ name: "probe", updatedAt: "t4" });
    const bridge = await buildMcpToolBridge();
    await bridge.list();
    const result = await bridge.call("some_client_tool", {});
    expect(result.ok).toBe(false);
    expect(result.isError).toBe(true);
  });

  it("does not declare the tools of a server whose token cannot be decrypted", async () => {
    // Offering a tool we cannot authenticate for is worse than offering
    // nothing: the model would pick it, the call would fail, and the turn would
    // be spent for a result nobody can produce.
    registerServer({ name: "probe", updatedAt: "t5" });
    resolveMcpServerForProxy.mockImplementation(async (id) => ({
      id, name: "probe", url: `http://127.0.0.1:${port}/mcp`, transport: "http",
      allowLocal: true, headers: {}, tokenError: "token could not be decrypted on this machine — re-enter it",
    }));
    const bridge = await buildMcpToolBridge();
    expect(await bridge.list()).toEqual([]);
    expect(bridge.has()).toBe(false);
  });

  it("reports the token failure when it breaks between listing and calling", async () => {
    registerServer({ name: "probe", updatedAt: "t6" });
    const bridge = await buildMcpToolBridge();
    await bridge.list();
    // The database moved to another host between the two calls.
    resolveMcpServerForProxy.mockImplementation(async (id) => ({
      id, name: "probe", url: `http://127.0.0.1:${port}/mcp`, transport: "http",
      allowLocal: true, headers: {}, tokenError: "token could not be decrypted on this machine — re-enter it",
    }));
    const result = await bridge.call(`${MCP_TOOL_PREFIX}probe__search_docs`, {});
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/re-enter it/);
  });
});

describe("flattening MCP content", () => {
  it("joins text blocks and appends structured content", () => {
    expect(flattenMcpContent({
      content: [{ type: "text", text: "one" }, { type: "text", text: "two" }],
      structuredContent: { count: 2 },
    })).toBe('one\ntwo\n{"count":2}');
  });

  it("truncates rather than dropping an oversized result", () => {
    const big = "x".repeat(20_000);
    const out = flattenMcpContent({ content: [{ type: "text", text: big }] });
    expect(out.length).toBeLessThan(big.length);
    expect(out).toMatch(/…\(truncated\)$/);
  });

  it("says something for an empty result instead of returning nothing", () => {
    expect(flattenMcpContent({ content: [] })).toBe("");
  });
});