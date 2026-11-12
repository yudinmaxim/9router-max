// Dispatcher unit tests for open-sse/acp/providers.js — the piece shared by
// dev-server.js, cli.js and custom-server.js. The executors, child factory
// and catalog cache are mocked: what is pinned here is selector splitting,
// provider routing and the ACP_MODEL_ALLOW picker filter.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { executorCalls, factoryCalls, catalogs } = vi.hoisted(() => ({
  executorCalls: [],
  factoryCalls: [],
  catalogs: {},
}));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: (id) => {
    executorCalls.push(id);
    return id === "broken-acp" ? {} : { acp: { kind: "fake" } };
  },
}));

vi.mock("../../open-sse/acp/factory.js", () => ({
  createChildFactory: ({ providerId, spec }) => {
    factoryCalls.push(providerId);
    return {
      openChild: async ({ model }) => ({ provider: providerId, sessionId: `sess-${providerId}`, model }),
    };
  },
}));

vi.mock("../../open-sse/executors/lib/acpCatalog.js", () => ({
  readCachedCatalog: (providerId) => catalogs[providerId] || null,
}));

const { createAcpProviders, providerIdsFromEnv } = await import("../../open-sse/acp/providers.js");

beforeEach(() => {
  executorCalls.length = 0;
  factoryCalls.length = 0;
  for (const k of Object.keys(catalogs)) delete catalogs[k];
});

describe("providerIdsFromEnv", () => {
  it("defaults to codex-acp,opencode-acp and trims the list", () => {
    expect(providerIdsFromEnv({})).toEqual(["codex-acp", "opencode-acp"]);
    expect(providerIdsFromEnv({ ACP_PROVIDERS: " a-acp , b-acp " })).toEqual(["a-acp", "b-acp"]);
  });
});

describe("createAcpProviders", () => {
  it("skips providers whose executor has no ACP spec", () => {
    const { providerIds } = createAcpProviders({ providerIds: ["codex-acp", "broken-acp"], log: () => {} });
    expect(providerIds).toEqual(["codex-acp"]);
    expect(factoryCalls).toEqual(["codex-acp"]);
  });

  it("throws when no provider is usable", () => {
    expect(() => createAcpProviders({ providerIds: ["broken-acp"], log: () => {} })).toThrow(/no usable ACP providers/);
  });

  it("routes provider/model selectors and strips the prefix for the child", async () => {
    const { openChild } = createAcpProviders({ providerIds: ["codex-acp", "opencode-acp"], log: () => {} });
    const a = await openChild({ model: "codex-acp/gpt-6-luna" });
    expect(a.provider).toBe("codex-acp");
    expect(a.model).toBe("gpt-6-luna");
    const b = await openChild({ model: "opencode-acp/opencode/glm-free" });
    expect(b.provider).toBe("opencode-acp");
    // Only the FIRST separator is the provider prefix — the child's own
    // model id keeps its inner slash.
    expect(b.model).toBe("opencode/glm-free");
  });

  it("supports the :: separator and bare provider ids", async () => {
    const { openChild } = createAcpProviders({ providerIds: ["codex-acp", "opencode-acp"], log: () => {} });
    const a = await openChild({ model: "opencode-acp::opencode/x" });
    expect(a.provider).toBe("opencode-acp");
    expect(a.model).toBe("opencode/x");
    const b = await openChild({ model: "codex-acp" });
    expect(b.provider).toBe("codex-acp");
    expect(b.model).toBe("default");
  });

  it("falls back to the default provider for unknown or bare model ids", async () => {
    const { openChild } = createAcpProviders({ providerIds: ["codex-acp", "opencode-acp"], log: () => {} });
    const a = await openChild({ model: "gpt-6-luna" });
    expect(a.provider).toBe("codex-acp"); // first configured = default
    const b = await openChild({ model: "unknown-acp/x" });
    expect(b.provider).toBe("codex-acp");
    expect(b.model).toBe("unknown-acp/x"); // unqualified head is not stripped
  });
});

describe("modelCatalog", () => {
  it("qualifies catalog ids as provider/model and applies ACP_MODEL_ALLOW", () => {
    catalogs["codex-acp"] = { models: [{ id: "gpt-6-luna", name: "Luna" }] };
    catalogs["opencode-acp"] = {
      models: [
        { id: "opencode/free-1", name: "Free" },
        { id: "google/paid-1", name: "Paid" },
      ],
    };
    const prev = process.env.ACP_MODEL_ALLOW;
    process.env.ACP_MODEL_ALLOW = "codex-acp/*,opencode-acp/opencode/*";
    try {
      const { modelCatalog } = createAcpProviders({ providerIds: ["codex-acp", "opencode-acp"], log: () => {} });
      const ids = modelCatalog().map((e) => e.modelId);
      expect(ids).toEqual(["codex-acp/gpt-6-luna", "opencode-acp/opencode/free-1"]);
      expect(ids).not.toContain("opencode-acp/google/paid-1");
    } finally {
      if (prev === undefined) delete process.env.ACP_MODEL_ALLOW;
      else process.env.ACP_MODEL_ALLOW = prev;
    }
  });

  it("offers a provider default entry when its catalog is empty", () => {
    const { modelCatalog } = createAcpProviders({ providerIds: ["codex-acp"], log: () => {} });
    expect(modelCatalog()).toEqual([{ modelId: "codex-acp", name: "codex-acp (default model)" }]);
  });
});
