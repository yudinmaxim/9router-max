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
import { upsertAcpDialogue } from "../../src/lib/db/repos/acpDialoguesRepo.js";

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
function harness({ openChild, modelCatalog, clientInfo, dialogueDir } = {}) {
  const out = [];
  const server = createAcpServer({
    write: (frame) => out.push(frame),
    openChild: openChild ?? (async () => fakeChild()),
    modelCatalog: modelCatalog ?? (() => [{ modelId: "codex-acp/gpt-5.4", name: "GPT 5.4" }]),
    log: () => {},
    clientInfo,
    dialogueDir,
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
    expect(res.models.currentModelId).toBe("codex-acp/gpt-5.4");
    expect(res.models.availableModels).toEqual([
      { modelId: "codex-acp/gpt-5.4", name: "GPT 5.4" },
    ]);

    expect(server.dialogues.size).toBe(1);
    const [key, row] = [...server.dialogues.entries()][0];
    expect(key).toBe(res.sessionId);
    expect(row.provider).toBe("codex-acp");
    // The external id handed to Zed must never be the child's own id — that is
    // what keeps two dialogues from fusing when they share one child.
    expect(row.childSessionId).toBe("child-sess-1");
    expect(row.transcript).toBeDefined();
    expect(typeof row.transcript.getAll).toBe("function");
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
    expect(out[1].result.models.currentModelId).toBe("codex-acp/gpt-5.4");
  });

  it("serves the shared model option built from the shared catalog (not the child's own list)", async () => {
    const { server, out } = harness();
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    // The shared option is qualified so Zed's picker can resolve every provider.
    expect(out[1].result.configOptions).toEqual([
      {
        id: "model",
        category: "model",
        type: "select",
        name: "Model",
        currentValue: "codex-acp/gpt-5.4",
        options: [{ value: "codex-acp/gpt-5.4", name: "GPT 5.4" }],
      },
    ]);
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

describe("ACP server M4 — model configuration", () => {
  it("forwards model change to child and preserves dialogue transcript", async () => {
    let listener;
    let request;
    const child = fakeChild({
      sendRpc: (method, params) => { request = { method, params }; setTimeout(() => listener({ id: 44, result: { configOptions: [{ id: "model" }] } }), 0); return 44; },
      onMessage: (fn) => { listener = fn; },
    });
    const { server, out } = harness({ openChild: async () => child });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    const sessionId = out[1].result.sessionId;
    const row = server.dialogues.get(sessionId);
    row.transcript.add({ type: "agent_message_chunk", content: "keep" });
    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId, configId: "model", value: "codex-acp/gpt-5.4-mini" } });
    expect(request).toEqual({ method: "session/set_config_option", params: { sessionId: "child-sess-1", configId: "model", value: "gpt-5.4-mini" } });
    expect(out.at(-1)).toMatchObject({ id: 3, result: { configOptions: [{ id: "model" }] } });
    expect(row.currentModel).toBe("gpt-5.4-mini");
    expect(row.transcript.getAll()).toHaveLength(1);
  });
});

describe("ACP server M3 — persistence and replay", () => {
  it("persists transcript and replays it through session/load", async () => {
      const first = harness();
      await init(first.server);
      await first.server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
      const sessionId = first.out[1].result.sessionId;
      const dialogue = first.server.dialogues.get(sessionId);
      dialogue.transcript.add({ type: "agent_message_chunk", content: "saved" });
      dialogue.cwd = CWD;
      await upsertAcpDialogue({ id: sessionId, cwd: CWD, provider: dialogue.provider, currentModel: dialogue.currentModel, transcript: dialogue.transcript.getAll() });
      const second = harness();
      await second.server.handle({ jsonrpc: "2.0", id: 4, method: "session/load", params: { sessionId, cwd: CWD } });
      expect(second.out[0]).toEqual({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { type: "agent_message_chunk", content: "saved" } } });
      expect(second.out[1]).toMatchObject({ jsonrpc: "2.0", id: 4 });
      // session/load must return the picker payload (models + configOptions)
      // like session/new — Zed rebuilds the model selector from it.
      expect(second.out[1].result).toMatchObject({ sessionId, models: { availableModels: expect.any(Array) }, configOptions: expect.any(Array) });
      expect(second.server.dialogues.get(sessionId).transcript.getAll()).toHaveLength(1);
  });

  it("lists stored sessions by cwd and deletes them", async () => {
      const { server, out } = harness();
      await init(server);
      await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
      const sessionId = out[1].result.sessionId;
      const listed = [];
      const originalWrite = (frame) => listed.push(frame);
      const listedServer = createAcpServer({ write: originalWrite, openChild: async () => fakeChild() });
      await listedServer.handle({ jsonrpc: "2.0", id: 3, method: "session/list", params: { cwd: CWD } });
      expect(listed[0].result.sessions.map((s) => s.sessionId)).toContain(sessionId);
      await listedServer.handle({ jsonrpc: "2.0", id: 4, method: "session/delete", params: { sessionId } });
      expect(listed[1]).toMatchObject({ id: 4, result: {} });
      listed.length = 0;
      await listedServer.handle({ jsonrpc: "2.0", id: 5, method: "session/list", params: { cwd: CWD } });
      expect(listed[0].result.sessions.map((s) => s.sessionId)).not.toContain(sessionId);
  });
});

describe("ACP server M1 — transport hygiene", () => {
  it("replies method-not-found to an unknown request instead of hanging the client", async () => {
    const { server, out } = harness();
    await server.handle({ jsonrpc: "2.0", id: 7, method: "session/unknown", params: { sessionId: "s" } });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 7, error: { code: -32601 } });
  });

  it("forwards session/cancel to the child as a notification without replying", async () => {
    // ACP spec: session/cancel is a notification — agents answer -32601 to
    // the request form, so the child must receive a raw frame with no id.
    const sent = [];
    const child = fakeChild({
      sendRpcRaw: (frame) => {
        sent.push(frame);
        return true;
      },
    });
    const { server, out } = harness({ openChild: async () => child });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    const sessionId = out[1].result.sessionId;
    await server.handle({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId } });
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      method: "session/cancel",
      params: { sessionId: child.sessionId },
    });
    expect(out).toHaveLength(2);
  });

  it("acknowledges a request-form session/cancel immediately", async () => {
    const child = fakeChild({ sendRpcRaw: () => true });
    const { server, out } = harness({ openChild: async () => child });
    await init(server);
    await server.handle({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: CWD } });
    const sessionId = out[1].result.sessionId;
    await server.handle({ jsonrpc: "2.0", id: 9, method: "session/cancel", params: { sessionId } });
    expect(out.at(-1)).toMatchObject({ id: 9, result: {} });
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

describe("ACP server M2 — session/prompt + streaming + ShadowTranscript", () => {
  it("forwards session/prompt to child and streams session/update back", async () => {
    let messageListener = null;
    const mockChild = fakeChild({
      sendRpc: (method, params) => {
        if (method === "session/prompt") {
          setTimeout(() => {
            messageListener({ method: "session/update", params: { update: { type: "agent_message_chunk", content: "Hello" } } });
            messageListener({ method: "session/update", params: { update: { type: "agent_message_chunk", content: " world" } } });
            messageListener({ id: 123, result: { stopReason: "stop" } });
          }, 10);
          return 123;
        }
        return null;
      },
      onMessage: (listener) => {
        messageListener = listener;
      },
    });

    const { server, out } = harness({ openChild: async () => mockChild });
    await init(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: CWD },
    });
    const sessionId = out[1].result.sessionId;

    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "hi" }] },
    });

    await new Promise(r => setTimeout(r, 50));

    expect(out.length).toBeGreaterThan(2);
    const updatesSent = out.slice(2).filter((f) => f.method === "session/update");
    expect(updatesSent.length).toBe(2);
    expect(updatesSent[0].params.sessionId).toBe(sessionId);
    expect(updatesSent[0].params.update.content).toBe("Hello");
    expect(updatesSent[1].params.update.content).toBe(" world");

    const response = out[out.length - 1];
    expect(response.id).toBe(3);
    // The child's stopReason is normalised against the ACP allowlist — a
    // non-spec value like "stop" surfaces to the client as end_turn.
    expect(response.result.stopReason).toBe("end_turn");
  });

  it("accumulates session/update in the dialogue transcript", async () => {
    let messageListener = null;
    const mockChild = fakeChild({
      sendRpc: (method, params) => {
        if (method === "session/prompt") {
          setTimeout(() => {
            messageListener({ method: "session/update", params: { update: { type: "agent_message_chunk", content: "A" } } });
            messageListener({ id: 123, result: { stopReason: "stop" } });
          }, 10);
          return 123;
        }
        return null;
      },
      onMessage: (listener) => {
        messageListener = listener;
      },
    });

    const { server } = harness({ openChild: async () => mockChild });
    await init(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: CWD },
    });
    const sessionId = server.dialogues.keys().next().value;

    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId, prompt: [{ type: "text", text: "test" }] },
    });

    await new Promise(r => setTimeout(r, 50));

    const dialogue = server.dialogues.get(sessionId);
    expect(dialogue.transcript.getAll()).toHaveLength(1);
    expect(dialogue.transcript.getAll()[0].content).toBe("A");
  });

  it("rejects session/prompt for unknown sessionId", async () => {
    const { server, out } = harness();
    await init(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "unknown", prompt: [{ type: "text", text: "hi" }] },
    });
    expect(out.length).toBe(2);
    expect(out[1].error.code).toBe(-32602);
    expect(out[1].error.message).toContain("session not found");
  });

  it("rejects session/prompt without sessionId", async () => {
    const { server, out } = harness();
    await init(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { prompt: [{ type: "text", text: "hi" }] },
    });
    expect(out.length).toBe(2);
    expect(out[1].error.code).toBe(-32602);
    expect(out[1].error.message).toContain("sessionId");
  });

  it("rejects session/prompt with non-array prompt", async () => {
    const { server, out } = harness();
    await init(server);
    await server.handle({
      jsonrpc: "2.0",
      id: 3,
      method: "session/prompt",
      params: { sessionId: "s", prompt: "not an array" },
    });
    expect(out.length).toBe(2);
    expect(out[1].error.code).toBe(-32602);
    expect(out[1].error.message).toContain("prompt array");
  });
});
