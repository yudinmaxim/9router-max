// M4 cross-provider context merge: when a dialogue hops between ACP
// providers, the incoming child has not seen the earlier turns. Instead of
// a separate injection turn, onSessionPrompt prepends a "[Context update]"
// prefix built from the history tail the child's `awareness` watermark has
// not covered — zero extra model turns, and switching back re-sends only
// what the returning child actually missed.
//
// Pinned behaviour:
//   prov-a prompt 1 → no prefix (empty history)
//   switch → prov-b prompt 2 → prefix carries prov-a's exchange
//   switch back → prov-a prompt 3 → prefix carries ONLY prov-b's exchange
//     (prov-a saw its own turns natively; awareness survived the park)

import { describe, it, expect } from "vitest";
import { createAcpServer } from "../../open-sse/acp/server.js";

const CWD = "/tmp/acp-merge-test";

function fakeChild(provider, sessionId) {
  const prompts = [];
  let listener = null;
  let nextId = 1;
  return {
    provider,
    sessionId,
    catalog: [],
    currentModel: "model-x",
    prompts,
    sendRpc(method, params) {
      const id = nextId++;
      if (method === "session/prompt") {
        prompts.push(params.prompt);
        setTimeout(() => {
          listener?.({
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `reply-${provider}` },
              },
            },
          });
          listener?.({ id, result: { stopReason: "end_turn" } });
        }, 5);
      } else {
        setTimeout(() => listener?.({ id, result: {} }), 5);
      }
      return id;
    },
    onMessage(fn) {
      listener = fn;
      return () => { listener = null; };
    },
    dispose() {},
  };
}

function harness(openChild) {
  const out = [];
  const children = new Map();
  const server = createAcpServer({
    write: (frame) => out.push(frame),
    openChild: openChild ?? (async ({ model }) => {
      const provider = String(model || "prov-a").split(/[/:]/)[0];
      if (!children.has(provider)) children.set(provider, fakeChild(provider, `sess-${provider}`));
      return children.get(provider);
    }),
    modelCatalog: () => [
      { modelId: "prov-a/model-a", name: "A" },
      { modelId: "prov-b/model-b", name: "B" },
    ],
    log: () => {},
    clientInfo: { name: "test", version: "0" },
  });
  return { server, out, children };
}

const text = (prompt) => prompt.map((b) => (b?.type === "text" ? b.text : "")).join("\n");
const userPrompt = [{ type: "text", text: "USER_TEXT" }];

async function prompt(server, sessionId, textValue, id) {
  await server.handle({
    jsonrpc: "2.0",
    id,
    method: "session/prompt",
    params: { sessionId, prompt: [{ type: "text", text: textValue }] },
  });
}

describe("ACP server — cross-provider history merge", () => {
  it("prefixes only the history the incoming child has not seen", async () => {
    const { server, out, children } = harness();
    await server.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await server.handle({
      jsonrpc: "2.0",
      id: 2,
      method: "session/new",
      params: { cwd: CWD, model: "prov-a/model-a" },
    });
    const sessionId = out[1].result.sessionId;
    const childA = children.get("prov-a");

    // Turn 1 on prov-a: history is empty → prompt goes through untouched.
    await prompt(server, sessionId, "first question", 3);
    expect(childA.prompts).toHaveLength(1);
    expect(childA.prompts[0]).toEqual([{ type: "text", text: "first question" }]);

    // Park prov-a, open prov-b.
    await server.handle({
      jsonrpc: "2.0",
      id: 4,
      method: "session/set_config_option",
      params: { sessionId, configId: "model", value: "prov-b/model-b" },
    });
    expect(out.at(-1).id).toBe(4);
    expect(out.at(-1).error).toBeUndefined();
    const childB = children.get("prov-b");
    expect(childB).toBeTruthy();

    // Turn 2 on prov-b: it never saw turn 1 → merged context prefix.
    await prompt(server, sessionId, "second question", 5);
    expect(childB.prompts).toHaveLength(1);
    const bPrompt = childB.prompts[0];
    expect(bPrompt).toHaveLength(2);
    const prefix = bPrompt[0].text;
    expect(prefix).toContain("[Context update]");
    expect(prefix).toContain("User: first question");
    expect(prefix).toContain("Assistant: reply-prov-a");
    expect(prefix).toContain("[End of update]");
    expect(bPrompt[1]).toEqual({ type: "text", text: "second question" });

    // Switch back to prov-a: the parked child is reused (no new openChild),
    // re-pinned, and only prov-b's exchange is news to it.
    await server.handle({
      jsonrpc: "2.0",
      id: 6,
      method: "session/set_config_option",
      params: { sessionId, configId: "model", value: "prov-a/model-a" },
    });
    expect(out.at(-1).error).toBeUndefined();
    await prompt(server, sessionId, "third question", 7);
    expect(childA.prompts).toHaveLength(2);
    const aPrefix = childA.prompts[1][0].text;
    expect(aPrefix).toContain("[Context update]");
    expect(aPrefix).toContain("User: second question");
    expect(aPrefix).toContain("Assistant: reply-prov-b");
    // prov-a saw its own exchange natively — it must NOT be replayed.
    expect(aPrefix).not.toContain("first question");
    expect(childA.prompts[1].at(-1)).toEqual({ type: "text", text: "third question" });
  });
});
