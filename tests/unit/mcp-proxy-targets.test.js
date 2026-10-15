// The MCP servers the router hands to its ACP agents.
//
// `mcp-servers-repo.test.js` and `mcp-proxy-route.test.js` cover the registry
// and the proxy separately. This covers the hand-off: what `buildMcpProxyTargets`
// produces, and that the executor actually puts it in `session/new`.
//
// The fake agent below validates the `mcpServers` union the way the real
// cursor-agent does, because that is the failure mode this feature lives under:
// a wrong shape is rejected as `-32603 invalid_union` and the *entire* session
// dies, not just the one server. The stdio bridge already lost a round to this
// (env has to be an array of {name, value}, not an object).

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

process.env.DATA_DIR = "/tmp/9r-mcp-targets-test";
process.env.PORT = "21999";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: (...args) => spawnMock(...args) }));

const { buildMcpProxyTargets } = await import("@/lib/mcp/proxyTargets");
const { getMcpProxyKey, resetMcpProxyKey, MCP_PROXY_KEY_HEADER } = await import("@/lib/mcp/proxyKey");
const repo = await import("@/lib/db/repos/mcpServersRepo");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");
const { OpenCodeAcpExecutor } = await import("open-sse/executors/opencode-acp.js");

beforeAll(async () => {
  resetMcpProxyKey();
  await runMigrationOnce(await getAdapter());
});

beforeEach(async () => {
  const db = await getAdapter();
  db.run("DELETE FROM mcpServers");
});

/** Mirrors the union cursor-agent enforces, so a bad shape fails the test. */
function validateServers(servers) {
  if (!Array.isArray(servers)) return "mcpServers must be an array";
  const seen = new Set();
  for (const [i, s] of servers.entries()) {
    if (!s || typeof s !== "object") return `entry ${i} is not an object`;
    if (typeof s.name !== "string" || !s.name) return `entry ${i} has no name`;
    if (seen.has(s.name)) return `duplicate name ${s.name}`;
    seen.add(s.name);
    if (s.type === "http" || s.type === "sse") {
      if (typeof s.url !== "string" || !/^https?:\/\//.test(s.url)) return `entry ${i} needs an http(s) url`;
      if (s.headers !== undefined && (Array.isArray(s.headers) || typeof s.headers !== "object")) {
        return `entry ${i} headers must be an object`;
      }
    } else if (typeof s.command === "string") {
      // stdio: the live cursor-agent accepts it without an explicit `type`,
      // inferring it from `command`. env must be an array of {name, value}.
      if (s.env !== undefined && !Array.isArray(s.env)) return `entry ${i} stdio env must be an array`;
    } else {
      return `entry ${i} has unknown type ${JSON.stringify(s.type)}`;
    }
  }
  return null;
}

function makeFakeChild({ unionError = null } = {}) {
  const child = new EventEmitter();
  child.writes = [];
  child.sessionNewParams = null;
  child.unionError = null;
  child.stdin = new EventEmitter();
  child.stdin.destroyed = false;
  child.stdin.write = (data) => {
    child.writes.push(String(data));
    try { handle(JSON.parse(String(data).trim())); } catch { /* ignore */ }
    return true;
  };
  child.stdin.end = () => { child.stdin.destroyed = true; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; };

  const send = (obj) => child.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));

  function handle(msg) {
    if (msg.method === "initialize") {
      send({
        jsonrpc: "2.0", id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: false } },
        },
      });
    } else if (msg.method === "session/new") {
      child.sessionNewParams = msg.params;
      const problem = unionError || validateServers(msg.params?.mcpServers);
      if (problem) {
        child.unionError = problem;
        send({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `invalid_union: ${problem}` } });
        return;
      }
      send({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "fake-session", configOptions: [] } });
    } else if (msg.method === "session/set_config_option") {
      send({ jsonrpc: "2.0", id: msg.id, result: { configOptions: [] } });
    } else if (msg.method === "session/prompt") {
      send({
        jsonrpc: "2.0", method: "session/update",
        params: { sessionId: "fake-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } } },
      });
      send({ jsonrpc: "2.0", id: msg.id, result: { stopReason: "end_turn" } });
    }
  }

  return child;
}

async function runExecute({ targets, child: injected } = {}) {
  const child = injected || makeFakeChild();
  spawnMock.mockImplementation(() => child);
  const exec = new OpenCodeAcpExecutor();
  const { response } = await exec.execute({
    model: "space-bunny-free",
    body: { messages: [{ role: "user", content: "hello" }] },
    credentials: {},
    ...(targets === undefined ? {} : { mcpProxyTargets: targets }),
    log: { info() {}, debug() {} },
  });
  const reader = response.body.getReader();
  while (true) {
    const { done } = await reader.read();
    if (done) break;
  }
  return child;
}

describe("buildMcpProxyTargets", () => {
  it("returns an empty list when nothing is registered", async () => {
    expect(await buildMcpProxyTargets()).toEqual([]);
  });

  it("describes each enabled server as an http entry at the proxy", async () => {
    await repo.createMcpServer({ name: "Jira", url: "https://jira.example/mcp", authType: "bearer", authToken: "t" });
    const [target] = await buildMcpProxyTargets();
    expect(target.type).toBe("http");
    expect(target.name).toBe("Jira");
    expect(target.url).toMatch(/^http:\/\/127\.0\.0\.1:21999\/api\/mcp-proxy\//);
  });

  it("carries the proxy key and never the upstream credential", async () => {
    await repo.createMcpServer({ name: "Jira", url: "https://jira.example/mcp", authType: "bearer", authToken: "upstream-secret" });
    const [target] = await buildMcpProxyTargets();
    expect(target.headers[MCP_PROXY_KEY_HEADER]).toBe(getMcpProxyKey());
    expect(JSON.stringify(target)).not.toContain("upstream-secret");
  });

  it("skips a disabled server", async () => {
    await repo.createMcpServer({ name: "On", url: "https://a.example/mcp" });
    await repo.createMcpServer({ name: "Off", url: "https://b.example/mcp", isActive: false });
    expect((await buildMcpProxyTargets()).map((t) => t.name)).toEqual(["On"]);
  });

  it("always speaks http to the proxy, even for a legacy sse upstream", async () => {
    await repo.createMcpServer({ name: "Legacy", url: "https://c.example/mcp", transport: "sse" });
    expect((await buildMcpProxyTargets())[0].type).toBe("http");
  });

  it("produces entries the agent's mcpServers union accepts", async () => {
    await repo.createMcpServer({ name: "Jira", url: "https://a.example/mcp", authType: "bearer", authToken: "t" });
    await repo.createMcpServer({ name: "Sentry", url: "https://b.example/mcp" });
    expect(validateServers(await buildMcpProxyTargets())).toBeNull();
  });
});

// The chain above goes execute() → session/new. Nothing tested so far covers the
// hop before it: chatCore destructures its arguments by name and forwards them
// explicitly at two call sites (the first attempt and the post-refresh retry),
// so dropping the name in either place would silently hand every agent an empty
// list while acpBase stays perfectly correct.
const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));
vi.mock("open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

const { handleChatCore } = await import("open-sse/handlers/chatCore.js");

const TARGETS = [{ type: "http", name: "Jira", url: "http://127.0.0.1:21999/api/mcp-proxy/x", headers: {} }];

function stubExecutorResponse() {
  executeMock.mockResolvedValue({
    response: new Response(JSON.stringify({
      id: "chatcmpl-x",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop", index: 0 }],
    }), { status: 200, headers: { "content-type": "application/json" } }),
    url: "https://api.openai.com/v1/chat/completions",
    headers: {},
    transformedBody: null,
  });
}

async function runChatCore(overrides = {}) {
  stubExecutorResponse();
  const res = await handleChatCore({
    body: { model: "gpt-4", messages: [{ role: "user", content: "hi" }] },
    modelInfo: { provider: "openai", model: "gpt-4" },
    credentials: { apiKey: "sk-test" },
    log: { debug() {}, info() {}, warn() {} },
    ...overrides,
  });
  if (res?.body?.getReader) {
    const reader = res.body.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }
  }
  return executeMock.mock.calls.at(-1)?.[0];
}

describe("chatCore forwards the targets to the executor", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("passes mcpProxyTargets through untouched", async () => {
    const args = await runChatCore({ mcpProxyTargets: TARGETS });
    expect(args.mcpProxyTargets).toEqual(TARGETS);
  });

  it("leaves it undefined when the caller sends none", async () => {
    const args = await runChatCore();
    expect(args.mcpProxyTargets).toBeUndefined();
  });

  it("keeps acpPermissions working alongside it", async () => {
    const perms = { read: { inside: "always", outside: "deny" } };
    const args = await runChatCore({ acpPermissions: perms, mcpProxyTargets: TARGETS });
    expect(args.acpPermissions).toEqual(perms);
    expect(args.mcpProxyTargets).toEqual(TARGETS);
  });
});

describe("acpBase hands the targets to the agent", () => {
  it("sends an empty list when the registry is empty", async () => {
    const child = await runExecute({ targets: [] });
    expect(child.unionError).toBeNull();
    expect(child.sessionNewParams.mcpServers).toEqual([]);
  });

  it("sends nothing that breaks the union when targets are absent entirely", async () => {
    const child = await runExecute();
    expect(child.unionError).toBeNull();
    expect(child.sessionNewParams.mcpServers).toEqual([]);
  });

  it("puts the registry servers into session/new", async () => {
    await repo.createMcpServer({ name: "Jira", url: "https://a.example/mcp", authType: "bearer", authToken: "t" });
    await repo.createMcpServer({ name: "Sentry", url: "https://b.example/mcp" });
    const child = await runExecute({ targets: await buildMcpProxyTargets() });
    expect(child.unionError).toBeNull();
    // Registry order is updatedAt-descending, and two servers created inside the
    // same millisecond tie — so compare as a set, not by position.
    const names = child.sessionNewParams.mcpServers.map((s) => s.name).sort();
    expect(names).toEqual(["Jira", "Sentry"]);
  });

  it("keeps the client-tool bridge ahead of the registry servers", async () => {
    const READ = {
      type: "function",
      function: { name: "read_file", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } },
    };
    const child = makeFakeChild();
    spawnMock.mockImplementation(() => child);
    const exec = new OpenCodeAcpExecutor();
    const { response } = await exec.execute({
      model: "space-bunny-free",
      body: { messages: [{ role: "user", content: "hi" }], tools: [READ] },
      credentials: {},
      mcpProxyTargets: [{ type: "http", name: "Jira", url: "http://127.0.0.1:21999/api/mcp-proxy/x", headers: {} }],
      log: { info() {}, debug() {} },
    });
    const reader = response.body.getReader();
    while (true) { const { done } = await reader.read(); if (done) break; }

    const names = child.sessionNewParams.mcpServers.map((s) => s.name);
    expect(child.unionError).toBeNull();
    expect(names[0]).toBe("clientTools");
    expect(names).toContain("Jira");
  });

  it("ignores a malformed targets argument rather than dropping the session", async () => {
    const child = await runExecute({ targets: "not-an-array" });
    expect(child.unionError).toBeNull();
    expect(child.sessionNewParams.mcpServers).toEqual([]);
  });

  it("surfaces a union rejection from the agent instead of starting anyway", async () => {
    const child = makeFakeChild({ unionError: "entry 0 has no name" });
    await runExecute({ targets: [{ type: "http", url: "http://127.0.0.1:21999/api/mcp-proxy/x" }], child });
    expect(child.unionError).toBe("entry 0 has no name");
  });
});