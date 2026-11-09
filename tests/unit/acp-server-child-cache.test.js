// M4 gate — per-provider child cache for provider switching (spec §model switch).
//
// Before: switching providers disposed the outgoing child, killing its live
// agent context; returning to the previous provider spawned it fresh and
// empty. Now each dialogue parks outgoing children in a provider-keyed cache,
// reuses them on return (context preserved), evicts the oldest beyond the
// cap, and persists a childSessions snapshot for future resume passes.
//
// Everything runs against injected fake children — no binaries, no I/O.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createAcpServer } from "../../open-sse/acp/server.js";
import { getAcpDialogueById } from "../../src/lib/db/repos/acpDialoguesRepo.js";

const CWD = "/home/maxim/some-project";

function fakeChild(provider, session) {
  const state = { requests: [], listener: null };
  const child = {
    provider,
    sessionId: `${provider}-sess-${session}`,
    catalog: [`${provider}/m1`],
    currentModel: "m1",
    sendRpc: (method, params) => {
      state.requests.push({ method, params });
      const id = state.requests.length;
      setTimeout(() => child.state?.listener?.({ id, result: {} }), 0);
      return id;
    },
    onMessage: (fn) => {
      state.listener = fn;
      return () => {
        if (state.listener === fn) state.listener = null;
      };
    },
    dispose: () => {
      child.disposed = true;
    },
  };
  child.state = state;
  return child;
}

function harness() {
  const out = [];
  const opened = [];
  const children = new Map();
  const openChild = async ({ model } = {}) => {
    const provider = String(model || "codex-acp/default").split(/::|\//)[0];
    if (!children.has(provider)) children.set(provider, fakeChild(provider, children.size + 1));
    const child = children.get(provider);
    opened.push({ provider, model });
    return child;
  };
  const server = createAcpServer({
    write: (frame) => out.push(frame),
    openChild,
    modelCatalog: () => ["codex-acp/gpt", "cursor-acp/composer", "other-acp/x", "fourth-acp/y"],
    log: () => {},
  });
  return { server, out, opened, children };
}

async function init(server) {
  await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
}

async function newSession(server, id = 2) {
  await server.handle({ jsonrpc: "2.0", id, method: "session/new", params: { cwd: CWD } });
}

// Convenience: the dialogue created by the last session/new.
function lastDialogue(server) {
  return [...server.dialogues.entries()].at(-1)[1];
}

describe("ACP server M4 — provider switch child cache", () => {
  it("parks the outgoing child and reuses it when the dialogue hops back", async () => {
    const { server, opened, children } = harness();
    await init(server);
    await newSession(server);
    const dialogue = lastDialogue(server);
    const codexChild = children.get("codex-acp");
    codexChild.disposed = false;

    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId: [...server.dialogues.keys()].at(-1), configId: "model", value: "cursor-acp/composer" } });
    expect(dialogue.provider).toBe("cursor-acp");
    expect(children.get("codex-acp").disposed).toBeFalsy(); // parked, not disposed

    await server.handle({ jsonrpc: "2.0", id: 4, method: "session/set_config_option", params: { sessionId: [...server.dialogues.keys()].at(-1), configId: "model", value: "codex-acp/gpt" } });
    expect(dialogue.provider).toBe("codex-acp");
    expect(dialogue.child).toBe(codexChild); // same live child — context preserved
    // openChild: session/new (codex) + first switch (cursor) only; the hop back
    // reused the cached child without reopening.
    expect(opened.map((o) => o.provider)).toEqual(["codex-acp", "cursor-acp"]);
  });

  it("re-pins the model of a reused child via set_config_option", async () => {
    const { server, children } = harness();
    await init(server);
    await newSession(server);
    const dialogue = lastDialogue(server);
    const sessionId = [...server.dialogues.keys()].at(-1);

    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId, configId: "model", value: "cursor-acp/composer" } });
    await server.handle({ jsonrpc: "2.0", id: 4, method: "session/set_config_option", params: { sessionId, configId: "model", value: "cursor-acp/other-model" } });
    // Same provider, different model: same-provider path → forwarded to child.
    expect(dialogue.currentModel).toBe("other-model");

    await server.handle({ jsonrpc: "2.0", id: 5, method: "session/set_config_option", params: { sessionId, configId: "model", value: "codex-acp/other-codex-model" } });
    const codexChild = children.get("codex-acp");
    const pin = codexChild.state.requests.find((r) => r.method === "session/set_config_option");
    expect(pin).toBeTruthy();
    expect(pin.params.value).toBe("other-codex-model");
    expect(dialogue.currentModel).toBe("other-codex-model");
  });

  it("evicts the oldest parked child beyond the cap and disposes it", async () => {
    const { server, children } = harness();
    await init(server);
    await newSession(server); // active: codex-acp
    const sessionId = [...server.dialogues.keys()].at(-1);

    const hops = ["cursor-acp/composer", "other-acp/x", "fourth-acp/y"];
    for (const [i, value] of hops.entries()) {
      await server.handle({ jsonrpc: "2.0", id: 10 + i, method: "session/set_config_option", params: { sessionId, configId: "model", value } });
    }
    // cache: codex, cursor, other parked + fourth active = 4 > cap 3 → codex evicted.
    expect(children.get("codex-acp").disposed).toBe(true);
    expect(children.get("cursor-acp").disposed).toBeFalsy();
    expect(children.get("other-acp").disposed).toBeFalsy();
  });

  it("persists a childSessions snapshot with the dialogue", async () => {
    const { server } = harness();
    await init(server);
    await newSession(server);
    const sessionId = [...server.dialogues.keys()].at(-1);

    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId, configId: "model", value: "cursor-acp/composer" } });
    const stored = await getAcpDialogueById(sessionId);
    expect(stored.childSessions).toBeTruthy();
    expect(stored.childSessions["codex-acp"]).toMatchObject({ active: false, childSessionId: "codex-acp-sess-1" });
    expect(stored.childSessions["cursor-acp"]).toMatchObject({ active: true, childSessionId: "cursor-acp-sess-2" });
  });

  it("reopens a fresh child for a dialogue restored by session/load without touching the external sessionId", async () => {
    const { server, opened, children } = harness();
    await init(server);
    await newSession(server);
    const sessionId = [...server.dialogues.keys()].at(-1);
    server.dialogues.get(sessionId).child = null; // simulate restart-driven unload

    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "hi" }] } });
    // Prompt on a dialogue without a child reopens one for the same provider.
    expect(opened.at(-1).provider).toBe("codex-acp");
    expect(server.dialogues.get(sessionId).provider).toBe("codex-acp");
    expect(children.get("codex-acp")).toBeTruthy();
  });

  it("keeps the whole family of children disposed on session/delete", async () => {
    const { server, children } = harness();
    await init(server);
    await newSession(server);
    const sessionId = [...server.dialogues.keys()].at(-1);
    await server.handle({ jsonrpc: "2.0", id: 3, method: "session/set_config_option", params: { sessionId, configId: "model", value: "cursor-acp/composer" } });

    await server.handle({ jsonrpc: "2.0", id: 4, method: "session/delete", params: { sessionId } });
    expect(children.get("codex-acp").disposed).toBe(true);
    expect(children.get("cursor-acp").disposed).toBe(true);
  });
});
