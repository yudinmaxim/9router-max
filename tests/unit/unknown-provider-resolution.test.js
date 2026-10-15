// An unknown provider prefix must be reported as unknown, not dispatched.
//
// DefaultExecutor borrows PROVIDERS.openai's config for any provider id it
// cannot find, so `opencode/space-bunny-free` — a prefix left over after the
// provider was removed — was sent to api.openai.com under the name "opencode"
// and came back as a 401 about an undefined key. That points at credentials
// instead of at the real cause, and 9router even scheduled a retry against an
// endpoint that could never succeed.
import { describe, it, expect, vi } from "vitest";

const fx = vi.hoisted(() => ({
  nodes: [
    { id: "openai-compatible-chat-n1", type: "openai-compatible", prefix: "mock" },
    { id: "custom-embed-n1", type: "custom-embedding", prefix: "emb" },
  ],
  combos: [],
}));

vi.mock("@/lib/localDb", () => ({
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async (filter = {}) =>
    fx.nodes.filter((n) => !filter.type || n.type === filter.type),
}));

const { getModelInfo } = await import("../../src/sse/services/model.js");

describe("unknown provider prefixes", () => {
  it("flags a prefix that is neither a registered provider nor a node", async () => {
    const info = await getModelInfo("opencode/space-bunny-free");
    expect(info.provider).toBeNull();
    expect(info.unknownProvider).toBe("opencode");
  });

  it("flags an invented prefix, not just a removed one", async () => {
    const info = await getModelInfo("выдуманный/x");
    expect(info.unknownProvider).toBe("выдуманный");
  });

  it("still resolves a registered provider", async () => {
    const info = await getModelInfo("openai/gpt-5.5");
    expect(info.provider).toBe("openai");
    expect(info.model).toBe("gpt-5.5");
    expect(info.unknownProvider).toBeUndefined();
  });

  // Restricted-key allow-lists are stored and compared lowercased, so a
  // case-sensitive check here dropped `OpenAI/gpt-5.5` from the allow-list and
  // the model disappeared from the catalog for that key.
  it("matches a registered provider regardless of case", async () => {
    const info = await getModelInfo("OpenAI/GPT-5.5");
    expect(info.provider).toBe("OpenAI");
    expect(info.unknownProvider).toBeUndefined();
  });

  it("still resolves a node by its prefix", async () => {
    const info = await getModelInfo("mock/glm-4");
    expect(info.provider).toBe("openai-compatible-chat-n1");
  });

  // Nodes are addressable by id as well as by prefix; a check that only knew
  // the registry rejected `openai-compatible-chat-n1/glm-4`.
  it("still resolves a node by its id", async () => {
    const info = await getModelInfo("openai-compatible-chat-n1/glm-4");
    expect(info.provider).toBe("openai-compatible-chat-n1");
    expect(info.unknownProvider).toBeUndefined();
  });

  it("does not confuse a combo name with an unknown provider", async () => {
    // Both report provider === null; only the flag tells them apart.
    fx.combos = [{ id: "c1", name: "Main", models: ["openai/model-a"] }];
    const info = await getModelInfo("Main");
    expect(info.provider).toBeNull();
    expect(info.unknownProvider).toBeUndefined();
  });
});