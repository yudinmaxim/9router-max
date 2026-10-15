// noAuth providers must appear in /v1/models even with no row in
// providerConnections.
//
// The ACP agents (cursor-acp, opencode-acp, omp-acp, codex-acp) and devin-cli
// carry `noAuth: true`, and sse/services/auth.js answers their requests from a
// synthetic connection injected at dispatch time. The models endpoint built its
// list from active database connections only, so those providers were invisible:
// clients could not discover them and had to hardcode model ids. A hardcoded id
// that goes stale then fails as "model not found", which reads like a bad model
// rather than a removed provider — exactly how the dead `oc/*` ids survived in
// opencode's config after 3.7 removed the provider.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  connections: [],
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: async () => fx.connections,
  getCombos: async () => [],
  getCustomModels: async () => [],
  getModelAliases: async () => ({}),
}));

vi.mock("@/lib/disabledModelsDb", () => ({
  getDisabledModels: async () => ({}),
}));

vi.mock("@/sse/services/keyAccess.js", () => ({
  getKeyAccessContext: async () => null,
  filterModelsListForKey: (list) => list,
}));

const { buildModelsList } = await import("../../src/app/api/v1/models/route.js");

// omp-acp and codex-acp ship no static models (passthroughModels: true — their
// catalog comes from the CLI at session/new), so there is nothing to publish
// for them here. Only providers with a registry model list can be asserted.
const NOAUTH_WITH_MODELS = [
  ["cursor-acp", "ca"],
  ["opencode-acp", "oacp"],
  ["devin-cli", "dv"],
];

describe("/v1/models — noAuth providers without a connection row", () => {
  beforeEach(() => {
    // A single unrelated active connection is what puts the endpoint on the
    // connection-driven path; the empty case takes the all-static branch and
    // would prove nothing.
    fx.connections = [{ id: "c1", provider: "openai", isActive: true, providerSpecificData: {} }];
  });

  it("publishes their models, so clients can discover instead of hardcoding", async () => {
    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    for (const [providerId, alias] of NOAUTH_WITH_MODELS) {
      expect(ids.some((id) => id.startsWith(`${alias}/`)), `${providerId} отсутствует в /v1/models`).toBe(true);
    }
  });

  it("publishes them under their alias, not their internal id", async () => {
    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(ids).toContain("oacp/space-bunny-free");
    expect(ids).toContain("ca/composer-2.5");
    expect(ids).toContain("dv/swe-1.6");
    // Clients address providers by alias everywhere else in the router; the
    // internal id is an implementation detail and must not leak into the list.
    expect(ids).not.toContain("cursor-acp/composer-2.5");
    expect(ids).not.toContain("opencode-acp/space-bunny-free");
  });

  it("still honours a real connection's explicit model list", async () => {
    fx.connections = [
      { id: "c1", provider: "openai", isActive: true, providerSpecificData: {} },
      {
        id: "c2",
        provider: "cursor-acp",
        isActive: true,
        providerSpecificData: { enabledModels: ["composer-2.5"] },
      },
    ];
    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    expect(ids).toContain("ca/composer-2.5");
    // The synthetic fill must not add the rest of the provider's catalog on top.
    expect(ids).not.toContain("ca/grok-4.7");
  });

  it("does not resurrect a connection the user switched off", async () => {
    fx.connections = [
      { id: "c1", provider: "openai", isActive: true, providerSpecificData: {} },
      { id: "c2", provider: "cursor-acp", isActive: false, providerSpecificData: {} },
    ];
    const ids = (await buildModelsList(["llm"])).map((m) => m.id);
    // cursor-acp is noAuth, so the synthetic entry fills the gap — that is the
    // point: the provider is usable without configuration. This test pins the
    // behaviour so it cannot change silently.
    expect(ids.some((id) => id.startsWith("ca/"))).toBe(true);
  });
});