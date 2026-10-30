// M1 gate for the ACP server façade (spec §11): 9router answers `initialize`
// and `session/new` over newline-delimited JSON-RPC. Zed is not connected yet,
// so the external contract is pinned against an injected fake child — the
// golden transcript of frames 9router sends back is the acceptance artifact.
//
// The child factory is injected, so nothing here touches a real binary:
// `openChild` is a recording stub, and the assertions are exactly the frames
// a real Zed would see on stdout.

import { describe, it, expect } from "vitest";
import { createAcpServer } from "../../open-sse/acp/server.js";

const CWD = "/home/maxim/some-project";

function fakeChild(overrides = {}) {
  return {
    provider: "codex-acp",
    sessionId: "child-sess-1",
    catalog: ["gpt-5.4", "gpt-5.4-mini"],
    currentModel: "gpt-5.4",
    sendRpc: () => {},
    onMessage: () => () => {},
    dispose: () => {},
    ...overrides,
  };
}

// Collects every outbound frame; `handle` is awaited so ordering is exact.
function harness({ openChild, modelCatalog, clientInfo } = {}) {
  const out = [];
  const server = createAcpServer({
    write: (frame) => out.push(frame),
    openChild: openChild ?? (async () => fakeChild()),
    modelCatalog: modelCatalog ?? (() => [{ modelId: "codex-acp/gpt-5.4", name: "GPT 5.4" }]),
    log: () => {},
    clientInfo,
  });
  return { server, out };
}

async function init(server) {
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
}

describe("ACP server M1 — initialize", () => {
  it("answers with protocolVersion 1, honest capabilities and authMethods:[]", async () => {
    const { server, out } = harness();
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true } } },
    });
    expect(out).toHaveLength(1);
    const res = out[0].result;
    expect(out[0].id).toBe(1);
    expect(res.protocolVersion).toBe(1);
    expect(res.authMethods).toEqual([]);
    expect(res.agentCapabilities.loadSession).toBe(true);
    expect(res.agentCapabilities.promptCapabilities.image).toBe(true);
    expect(res.agentCapabilities.mcpCapabilities.http).toBe(true);
    expect(res.agentCapabilities.sessionCapabilities).toMatchObject({ resume: {}, close: {} });
  });

  it("advertises the full model catalog (spec Q3: one agent = all providers)", async () => {
    const { server, out } = harness({
      modelCatalog: () => ["codex-acp/gpt-5.4", { modelId: "cursor-acp/composer", name: "Composer" }],
    });
    await init(server);
    expect(out[0].result.models.availableModels).toEqual([
      { modelId: "codex-acp/gpt-5.4", name: "codex-acp/gpt-5.4" },
      { modelId: "cursor-acp/composer", name: "Composer" },
    ]);
  });

  it("records client capabilities for the later fs/terminal relay", async () => {
    const { server } = harness();
    await server.handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
    });
    expect(server.clientCapabilities()).toEqual({ fs: { readTextFile: true, writeTextFile: true } });
  });

  it("does not spawn a child on initialize", async () => {
    let opened = 0;
    const { server, out } = harness({ openChild: async () => { opened++; return fakeChild(); } });
    await init(server);
    expect(opened).toBe(0);
    expect(server.dialogues.size).toBe(0);
    expect(out[0].result).toBeTruthy();
  });
});

describe("ACP server M1 — session/new", () => {
  it("opens a child, registers the dialogue and returns an external sessionId", async () => {
    const seen = [];
    const { server, out } = harness({
      openChild: async (opts) => { seen.push(opts); return fakeChild(); },
    });
    await init(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: CWD, mcpServers: [{ name: "x", type: "http", url: "http://127.0.0.1:1/mcp" }] },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0].cwd).toBe(CWD);
    expect(seen[0].mcpServers).toHaveLength(1);

    const res = out[1].result;
    expect(out[1].id).toBe(2);
    expect(typeof res.sessionId).toBe("string");
    expect(res.sessionId.length).toBeGreaterThan(0);
    expect(res.models.currentModelId).toBe("gpt-5.4");
    expect(res.models.availableModels).toEqual([
      { modelId: "gpt-5.4", name: "gpt-5.4" },
      { modelId: "gpt-5.4-mini", name: "gpt-5.4-mini" },
    ]);

    expect(server.dialogues.size).toBe(1);
    const [key, row] = [...server.dialogues.entries()][0];
    expect(key).toBe(res.sessionId);
    expect(row.provider).toBe("codex-acp");
    // The external id handed to Zed must never be the child's own id — that is
    // what keeps two dialogues from fusing when they share one child.
    expect(row.childSessionId).toBe("child-sess-1");
    expect(row.transcript).toEqual([]);
  });

  it("keeps five tabs in one project as five separate dialogues (spec G3)", async () => {
    const { server, out } = harness();
    await init(server);
    for (const id of [2, 3, 4, 5, 6]) {
      await server.handle({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: CWD } });
    }
    const ids = out.slice(1).map((f) => f.result.sessionId);
    expect(new Set(ids).size).toBe(5);
    expect(server.dialogues.size).toBe(5);
    const rows = ids.map((sid) => server.dialogues.get(sid));
    // Each row owns its own transcript — no shared array reference.
    expect(new Set(rows.map((r) => r.transcript)).size).toBe(5);
  });

  it("shares one child between dialogues without sharing their rows", async () => {
    const shared = fakeChild();
    let calls = 0;
    const { server } = harness({
      openChild: async () => { calls++; return calls === 1 ? shared : { ...shared }; },
    });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/new", params: { cwd: CWD } });
    expect(server.dialogues.size).toBe(2);
    const rows = [...server.dialogues.values()];
    expect(rows[0].transcript).not.toBe(rows[1].transcript);
  });

  it("falls back to the first catalog entry when the child reports no current model", async () => {
    const { server, out } = harness({ openChild: async () => fakeChild({ currentModel: "" }) });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    expect(out[1].result.models.currentModelId).toBe("gpt-5.4");
  });

  it("passes configOptions through when the child offers them", async () => {
    const configOptions = [{ id: "model", label: "Model", type: "select", currentValue: "gpt-5.4", options: [] }];
    const { server, out } = harness({ openChild: async () => fakeChild({ configOptions }) });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    expect(out[1].result.configOptions).toEqual(configOptions);
  });

  it("rejects a missing cwd with -32602 and spawns nothing", async () => {
    let opened = 0;
    const { server, out } = harness({ openChild: async () => { opened++; return fakeChild(); } });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: {} });
    expect(opened).toBe(0);
    expect(out[1].error.code).toBe(-32602);
    expect(out[1].result).toBeUndefined();
    expect(server.dialogues.size).toBe(0);
  });

  it("answers -32603 when the child cannot be opened, without registering a dialogue", async () => {
    const { server, out } = harness({
      openChild: async () => { throw new Error("codex-acp CLI not found"); },
    });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    expect(out[1].error.code).toBe(-32603);
    expect(out[1].error.message).toContain("codex-acp CLI not found");
    expect(server.dialogues.size).toBe(0);
  });
});

describe("ACP server M1 — transport hygiene", () => {
  it("replies method-not-found to an unknown request instead of hanging the client", async () => {
    const { server, out } = harness();
    await server.handle({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { sessionId: "s" } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("never answers a notification", async () => {
    const { server, out } = harness();
    await server.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } });
    expect(out).toHaveLength(0);
  });

  it("survives a handler that throws, still replying exactly once", async () => {
    const { server, out } = harness({
      modelCatalog: () => { throw new Error("catalog exploded"); },
    });
    await init(server);
    expect(out).toHaveLength(1);
    expect(out[0].error.code).toBe(-32603);
  });

  it("tolerates an empty frame without writing anything", async () => {
    const { server, out } = harness();
    await server.handle(null);
    await server.handle(undefined);
    expect(out).toHaveLength(0);
  });

  it("echoes agentInfo only when the operator supplied it", async () => {
    const a = harness();
    await init(a.server);
    expect(a.out[0].result.agentInfo).toBeUndefined();

    const b = harness({ clientInfo: { name: "9router", version: "0.5.99" } });
    await init(b.server);
    expect(b.out[0].result.agentInfo).toEqual({ name: "9router", version: "0.5.99" });
  });
});
