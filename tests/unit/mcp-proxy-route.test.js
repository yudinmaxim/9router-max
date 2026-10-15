import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";

process.env.DATA_DIR = "/tmp/9r-mcp-proxy-test";

const { POST: createRoute } = await import("@/app/api/mcp-servers/route");
const proxy = await import("@/app/api/mcp-proxy/[id]/route");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");
const { getMcpProxyKey, resetMcpProxyKey, MCP_PROXY_KEY_HEADER } = await import("@/lib/mcp/proxyKey");

let server;
let origin;
const seen = [];

beforeAll(async () => {
  resetMcpProxyKey();
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, headers: { ...req.headers }, body: raw });

    if (req.url === "/sse-endpoint") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "mcp-session-id": "sess-42" });
      res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n');
      res.end();
      return;
    }
    if (req.url === "/teardown") {
      res.writeHead(204);
      res.end();
      return;
    }

    const msg = raw ? JSON.parse(raw) : {};
    if (req.headers.authorization !== "Bearer good-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "unauthorized" } }));
      return;
    }
    if (req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "mcp-session-id": "sess-7" });
      res.write('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"streamed":true}}\n\n');
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/json",
      "mcp-session-id": "sess-1",
      "x-request-id": "abc123",
    });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  const db = await getAdapter();
  db.run("DELETE FROM mcpServers");
});

beforeEach(async () => {
  await runMigrationOnce(await getAdapter());
  const db = await getAdapter();
  db.run("DELETE FROM mcpServers");
  seen.length = 0;
});

async function seed(overrides = {}) {
  const res = await createRoute(new Request("http://x/api/mcp-servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Jira", url: `${origin}/mcp`, transport: "http",
      authType: "bearer", authToken: "good-token", allowLocal: true, ...overrides,
    }),
  }));
  return (await res.json()).mcpServer.id;
}

function call(method, id, { headers = {}, body } = {}) {
  const init = { method, headers: { [MCP_PROXY_KEY_HEADER]: getMcpProxyKey(), ...headers } };
  if (body !== undefined) init.body = body;
  return proxy[method](new Request("http://x", init), { params: Promise.resolve({ id }) });
}

const RPC = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" });

describe("mcp proxy — authorization", () => {
  it("rejects a missing key", async () => {
    const id = await seed();
    const res = await proxy.POST(new Request("http://x", { method: "POST", body: RPC }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    const id = await seed();
    expect((await call("POST", id, { headers: { [MCP_PROXY_KEY_HEADER]: "nope" }, body: RPC })).status).toBe(401);
  });

  it("never forwarded anything on a rejected request", async () => {
    const id = await seed();
    await call("POST", id, { headers: { [MCP_PROXY_KEY_HEADER]: "nope" }, body: RPC });
    expect(seen).toHaveLength(0);
  });

  it("answers 404 for an unknown server id", async () => {
    expect((await call("POST", "nope", { body: RPC })).status).toBe(404);
  });

  it("answers 409 for a disabled server", async () => {
    const id = await seed({ isActive: false });
    expect((await call("POST", id, { body: RPC })).status).toBe(409);
  });
});

describe("mcp proxy — pass-through", () => {
  it("forwards the JSON-RPC body and returns the upstream JSON", async () => {
    const id = await seed();
    const res = await call("POST", id, { body: RPC });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect((await res.json()).result.protocolVersion).toBe("2025-06-18");
    expect(seen[0].body).toBe(RPC);
  });

  it("injects the stored credential without the caller supplying one", async () => {
    const id = await seed();
    await call("POST", id, { body: RPC });
    expect(seen[0].headers.authorization).toBe("Bearer good-token");
  });

  it("forwards mcp-session-id upstream and back", async () => {
    const id = await seed();
    const res = await call("POST", id, { headers: { "mcp-session-id": "sess-7" }, body: RPC });
    expect(seen[0].headers["mcp-session-id"]).toBe("sess-7");
    expect(res.headers.get("mcp-session-id")).toBe("sess-1");
  });

  it("keeps upstream response headers other than hop-by-hop ones", async () => {
    const id = await seed();
    expect((await call("POST", id, { body: RPC })).headers.get("x-request-id")).toBe("abc123");
  });

  it("asks for both response shapes so a streamable server may choose", async () => {
    const id = await seed();
    await call("POST", id, { body: RPC });
    expect(seen[0].headers.accept).toContain("application/json");
    expect(seen[0].headers.accept).toContain("text/event-stream");
  });

  it("relays the upstream status instead of flattening it to 200", async () => {
    const id = await seed({ authToken: "bad-token" });
    expect((await call("POST", id, { body: RPC })).status).toBe(401);
  });

  it("forwards an SSE response as a stream, not as text", async () => {
    const id = await seed({ url: `${origin}/stream` });
    const res = await call("POST", id, { body: RPC });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
    const text = await res.text();
    expect(text).toContain('"streamed":true');
    expect(text).toContain("event: message");
  });

  it("forwards a GET stream request", async () => {
    const id = await seed({ url: `${origin}/sse-endpoint` });
    const res = await call("GET", id);
    expect(res.status).toBe(200);
    expect(seen[0].method).toBe("GET");
    expect(await res.text()).toContain('"ok":true');
  });

  it("forwards a DELETE teardown", async () => {
    const id = await seed({ url: `${origin}/teardown` });
    expect((await call("DELETE", id)).status).toBe(204);
    expect(seen[0].method).toBe("DELETE");
  });

  it("reports an unreachable upstream as 502, not as a crash", async () => {
    const id = await seed({ url: "http://127.0.0.1:1/mcp" });
    const res = await call("POST", id, { body: RPC });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("upstream unreachable");
  });
});

describe("mcp proxy — SSRF guard", () => {
  it("blocks a private upstream when allowLocal is off", async () => {
    const id = await seed({ allowLocal: false });
    const res = await call("POST", id, { body: RPC });
    expect(res.status).toBe(502);
    expect(seen).toHaveLength(0);
  });

  it("allows a private upstream when allowLocal is on", async () => {
    const id = await seed({ allowLocal: true });
    expect((await call("POST", id, { body: RPC })).status).toBe(200);
  });
});