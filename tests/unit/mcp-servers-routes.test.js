import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer } from "node:http";

process.env.DATA_DIR = "/tmp/9r-mcp-routes-test";

const { POST, GET } = await import("@/app/api/mcp-servers/route");
const item = await import("@/app/api/mcp-servers/[id]/route");
const test = await import("@/app/api/mcp-servers/[id]/test/route");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");

let server;
let origin;

function makeRequest(url, { method = "GET", body, headers = {} } = {}) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function idParams(id) {
  return { params: Promise.resolve({ id }) };
}

// A real MCP server so the probe route is exercised over the wire rather than
// against a stubbed client.
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = raw ? JSON.parse(raw) : {};
    const reply = (body) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake-jira" } } });
    } else if (msg.method === "tools/list") {
      if (req.headers.authorization !== "Bearer good-token") {
        return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32001, message: "unauthorized" } });
      }
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "search_issues", description: "d", inputSchema: { type: "object" } }] } });
    } else {
      reply({ jsonrpc: "2.0", id: msg.id, result: {} });
    }
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
});

async function seed(overrides = {}) {
  const res = await POST(makeRequest(`${origin}/api/mcp-servers`, {
    method: "POST",
    body: { name: "Jira", url: `${origin}/mcp`, transport: "http", authType: "bearer", authToken: "good-token", allowLocal: true, ...overrides },
  }));
  const text = await res.text();
  const json = JSON.parse(text);
  return { res, json, text, id: json.mcpServer?.id };
}

describe("GET /api/mcp-servers", () => {
  it("returns an empty list initially", async () => {
    const res = await GET(makeRequest("http://x/api/mcp-servers"));
    expect(res.status).toBe(200);
    expect((await res.json()).mcpServers).toEqual([]);
  });

  it("lists what was registered", async () => {
    await seed();
    const res = await GET(makeRequest("http://x/api/mcp-servers"));
    expect((await res.json()).mcpServers).toHaveLength(1);
  });

  it("filters on isActive", async () => {
    await seed({ name: "On" });
    await seed({ name: "Off", isActive: false });
    const res = await GET(makeRequest("http://x/api/mcp-servers?isActive=true"));
    expect((await res.json()).mcpServers).toHaveLength(1);
    const both = await GET(makeRequest("http://x/api/mcp-servers"));
    expect((await both.json()).mcpServers).toHaveLength(2);
  });

  it("never leaks a token in the payload", async () => {
    await seed();
    const res = await GET(makeRequest("http://x/api/mcp-servers"));
    expect(await res.text()).not.toContain("good-token");
  });
});

describe("POST /api/mcp-servers", () => {
  it("creates and answers 201", async () => {
    const { res, json } = await seed();
    expect(res.status).toBe(201);
    expect(json.mcpServer.name).toBe("Jira");
    expect(json.mcpServer.hasToken).toBe(true);
  });

  it("does not echo the token back", async () => {
    const { text } = await seed();
    expect(text).not.toContain("good-token");
  });

  it("answers 400 with the reason for an invalid record", async () => {
    const res = await POST(makeRequest("http://x/api/mcp-servers", { method: "POST", body: { url: "https://x.example/mcp" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).errors).toContain("name is required");
  });

  it("answers 400 for a non-http url", async () => {
    const res = await POST(makeRequest("http://x/api/mcp-servers", { method: "POST", body: { name: "x", url: "ftp://h/p" } }));
    expect(res.status).toBe(400);
  });
});

describe("GET /api/mcp-servers/:id", () => {
  it("returns the record", async () => {
    const { id } = await seed();
    const res = await item.GET(makeRequest("http://x/api/mcp-servers/x"), idParams(id));
    expect(res.status).toBe(200);
    expect((await res.json()).mcpServer.name).toBe("Jira");
  });

  it("answers 404 for an unknown id", async () => {
    const res = await item.GET(makeRequest("http://x/api/mcp-servers/x"), idParams("nope"));
    expect(res.status).toBe(404);
  });
});

describe("PUT /api/mcp-servers/:id", () => {
  it("updates fields", async () => {
    const { id } = await seed();
    const res = await item.PUT(makeRequest("http://x/api/mcp-servers/x", { method: "PUT", body: { name: "Renamed" } }), idParams(id));
    expect(res.status).toBe(200);
    expect((await res.json()).mcpServer.name).toBe("Renamed");
  });

  it("keeps the token when the body omits it", async () => {
    const { id } = await seed();
    await item.PUT(makeRequest("http://x/api/mcp-servers/x", { method: "PUT", body: { name: "Renamed" } }), idParams(id));
    const probe = await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    expect((await probe.json()).status).toBe("ok");
  });

  it("answers 400 on invalid input and changes nothing", async () => {
    const { id } = await seed();
    const res = await item.PUT(makeRequest("http://x/api/mcp-servers/x", { method: "PUT", body: { url: "javascript:alert(1)" } }), idParams(id));
    expect(res.status).toBe(400);
    const after = await item.GET(makeRequest("http://x"), idParams(id));
    expect((await after.json()).mcpServer.url).toContain("127.0.0.1");
  });

  it("answers 404 for an unknown id", async () => {
    const res = await item.PUT(makeRequest("http://x", { method: "PUT", body: { name: "x" } }), idParams("nope"));
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/mcp-servers/:id", () => {
  it("removes the record", async () => {
    const { id } = await seed();
    const res = await item.DELETE(makeRequest("http://x", { method: "DELETE" }), idParams(id));
    expect(res.status).toBe(200);
    expect((await item.GET(makeRequest("http://x"), idParams(id))).status).toBe(404);
  });

  it("answers 404 for an unknown id", async () => {
    expect((await item.DELETE(makeRequest("http://x", { method: "DELETE" }), idParams("nope"))).status).toBe(404);
  });
});

describe("POST /api/mcp-servers/:id/test", () => {
  it("probes a live server and reports its tools", async () => {
    const { id } = await seed();
    const res = await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.tools.map((t) => t.name)).toEqual(["search_issues"]);
  });

  it("records the verdict on the record", async () => {
    const { id } = await seed();
    await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    const after = await item.GET(makeRequest("http://x"), idParams(id));
    expect((await after.json()).mcpServer.testStatus).toBe("ok");
  });

  it("fails when the token is wrong", async () => {
    const { id } = await seed({ authToken: "bad-token" });
    const res = await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    expect((await res.json()).status).toBe("error");
    const after = await item.GET(makeRequest("http://x"), idParams(id));
    expect((await after.json()).mcpServer.testStatus).toBe("error");
  });

  it("fails when the server is unreachable", async () => {
    const { id } = await seed({ url: "http://127.0.0.1:1/mcp" });
    const res = await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    expect((await res.json()).status).toBe("error");
  });

  it("answers 404 for an unknown id", async () => {
    expect((await test.POST(makeRequest("http://x", { method: "POST" }), idParams("nope"))).status).toBe(404);
  });

  it("answers 409 for a disabled server", async () => {
    const { id } = await seed({ isActive: false });
    expect((await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id))).status).toBe(409);
  });

  it("refuses a private URL unless allowLocal is set", async () => {
    const { id } = await seed({ allowLocal: false });
    const res = await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("URL not allowed");
  });

  it("keeps the token out of the probe response", async () => {
    const { id } = await seed();
    const res = await test.POST(makeRequest("http://x", { method: "POST" }), idParams(id));
    expect(await res.text()).not.toContain("good-token");
  });
});