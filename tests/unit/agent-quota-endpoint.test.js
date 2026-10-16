// Once the agent providers became visible on the usage page, their quota card
// fell through to the generic refusal: GET /api/usage/<id> answered
// {"message": "Usage not available for this connection"} for cursor-acp, which
// reads as a failure rather than as "there is no upstream quota here".
//
// An agent provider runs a CLI on the operator's own subscription, so the honest
// answer is an explained one — and it must stay distinguishable from the generic
// refusal, which still covers genuinely unqueryable connections.

import { describe, it, expect, beforeEach } from "vitest";

process.env.DATA_DIR = "/tmp/9r-agent-quota-test";

vi.mock("next/server", () => ({ NextResponse: { json: (b, i) => Response.json(b, i) } }));

const { createProviderConnection } = await import("@/models");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { rollUpTiers, computeTierShares } = await import("@/lib/quotaTiers");
const { getAdapter } = await import("@/lib/db/driver");
const { GET } = await import("@/app/api/usage/[connectionId]/route");
const { USAGE_APIKEY_PROVIDERS } = await import("@/shared/constants/providers");

// cursor-acp is excluded on purpose: it holds a real Cursor JWT and api2
// answers its spend, so it goes upstream first. It is covered separately below.
const AGENTS = ["opencode-acp", "omp-acp", "codex-acp", "devin-cli"];

async function seed(provider, extra = {}) {
  const c = await createProviderConnection({ provider, name: `${provider} account`, authType: "apikey", apiKey: "x", ...extra });
  return c.id;
}

const call = (id) => GET(new Request("http://x"), { params: Promise.resolve({ connectionId: id }) });

beforeEach(async () => {
  await runMigrationOnce(await getAdapter());
  (await getAdapter()).run("DELETE FROM providerConnections");
});

describe("agent provider quota", () => {
  it.each(AGENTS)("flags %s as own-subscription instead of refusing", async (provider) => {
    const id = await seed(provider);
    const res = await call(id);
    const body = await res.json();
    expect(body.unsupported).toBe("own-subscription");
    expect(body.quotas).toEqual([]);
  });

  it.each(AGENTS)("sends only machine fields for %s, no prose", async (provider) => {
    // The wording belongs to the dashboard, which is localized — an English
    // sentence from the API shows up untranslated in every other locale. The
    // reason code itself is fine; it is not text anyone reads.
    const body = await (await call(await seed(provider))).json();
    expect(body.message ?? null).toBeNull();
    // localUsage is numbers only — it must not smuggle in a user-facing string.
    expect(Object.keys(body).sort()).toEqual(["localUsage", "plan", "quotas", "unsupported"]);
    expect(Object.values(body.localUsage).every((v) => typeof v !== "string" || v === null || v.match(/^\d/))).toBe(true);
  });

  it("answers 200, so the card renders instead of erroring", async () => {
    const res = await call(await seed("cursor-acp"));
    expect(res.status).toBe(200);
  });

  it("still refuses a genuinely unqueryable connection the old way", async () => {
    // Not noAuth, not oauth, not in the api-key list — unchanged behaviour.
    const id = await seed("not-a-real-provider");
    const body = await (await call(id)).json();
    expect(body.unsupported).toBeUndefined();
    expect(body.message).toBe("Usage not available for this connection");
  });

  it("does not intercept an api-key provider that is queryable", async () => {
    const queryable = USAGE_APIKEY_PROVIDERS[0];
    const body = await (await call(await seed(queryable))).json();
    // These providers get a real upstream call; whatever it returns, it must not
    // be the agent explanation.
    expect(JSON.stringify(body)).not.toMatch(/own-subscription/);
    expect(body.unsupported).toBeUndefined();
  });

  it("404s for an unknown connection", async () => {
    expect((await call("nope")).status).toBe(404);
  });
});
describe("agent card shows the numbers the router already has", () => {
  it("returns our own totals alongside the unsupported flag", async () => {
    const { saveRequestUsage } = await import("@/lib/usageDb");
    await saveRequestUsage({
      timestamp: new Date().toISOString(),
      provider: "opencode-acp",
      model: "composer-2.5",
      connectionId: undefined,
      apiKey: "sk-test",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 1000, completion_tokens: 50 },
      status: "ok",
    });
    const body = await (await call(await seed("opencode-acp"))).json();
    expect(body.unsupported).toBe("own-subscription");
    // The quota upstream cannot answer for an agent, but the router's own
    // history can — returning prose alone read as "no data".
    expect(body.localUsage.requests).toBeGreaterThanOrEqual(1);
    expect(body.localUsage.promptTokens).toBeGreaterThanOrEqual(1000);
  });
});

describe("agent widget reports where the money went", () => {
  it("splits by model and flags the ones with no tariff", async () => {
    const { saveRequestUsage } = await import("@/lib/usageDb");
    const ts = new Date().toISOString();
    // One priced model and one that has no tariff — the case the operator hit:
    // a provider total of $0.00 that meant "not priced", not "free".
    await saveRequestUsage({
      timestamp: ts, provider: "cursor-acp", model: "composer-2.5",
      connectionId: undefined, apiKey: "sk-test", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 5000, completion_tokens: 100 }, status: "ok",
    });
    const body = await (await call(await seed("cursor-acp"))).json();
    const u = body.localUsage;
    const unpriced = u.models.find((m) => m.model === "composer-2.5");
    expect(unpriced.priced).toBe(false);
    expect(unpriced.promptTokens).toBeGreaterThanOrEqual(5000);
    expect(u.fullyPriced).toBe(false);
  });
});

describe("cursor-acp asks Cursor before falling back", () => {
  it("is not short-circuited: it reaches the upstream reader", async () => {
    // Refusing it because it has no api key would hide real billing — the
    // connection carries a real Cursor JWT and getCursorUsage already reads
    // included/bonus/total spend from api2.cursor.sh.
    const body = await (await call(await seed("cursor-acp"))).json();
    expect(body.unsupported).not.toBe("own-subscription");
  });

  it("still shows the router's own numbers when the upstream is unreachable", async () => {
    const { saveRequestUsage } = await import("@/lib/usageDb");
    await saveRequestUsage({
      timestamp: new Date().toISOString(), provider: "cursor-acp", model: "composer-2.5",
      connectionId: undefined, apiKey: "sk-test", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 1200, completion_tokens: 30 }, status: "ok",
    });
    const body = await (await call(await seed("cursor-acp"))).json();
    // Losing a whole billing panel because Cursor's API blinked is the worse
    // failure — the local history is still true.
    expect(body.localUsage).toBeTruthy();
    expect(body.localUsage.promptTokens).toBeGreaterThanOrEqual(1200);
    expect(body.localUsage.tiers).toBeTruthy();
  });
});

describe("tier split behind the three bars", () => {
  beforeEach(async () => {
    const db = await getAdapter();
    db.run("DELETE FROM usageHistory");
    db.run("DELETE FROM usageDaily");
  });

  it("follows Cursor's split: Composer and Cursor Grok vs the rest", async () => {
    const { saveRequestUsage } = await import("@/lib/usageDb");
    const ts = new Date().toISOString();
    // cursor.com/dashboard/spending splits "Cursor Models" (Composer + Cursor
    // Grok) from "Other Models". This is an identity question, not a cost one:
    // gpt-5.3-codex ($1.75/M) is cheaper than claude-opus-5-5 ($4/M) yet both
    // are "other", and a price-based rule would have split them.
    await saveRequestUsage({
      timestamp: ts, provider: "cursor-acp", model: "gpt-5.3-codex",
      connectionId: undefined, apiKey: "sk-test", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 2000, completion_tokens: 50 }, status: "ok",
    });
    await saveRequestUsage({
      timestamp: ts, provider: "cursor-acp", model: "claude-opus-5-5",
      connectionId: undefined, apiKey: "sk-test", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 800, completion_tokens: 20 }, status: "ok",
    });
    const { tiers } = (await (await call(await seed("cursor-acp"))).json()).localUsage;
    expect(tiers.otherModels.requests).toBe(2);
    expect(tiers.cursorModels.requests).toBe(0);
  });

  it("counts composer under Cursor Models", async () => {
    const { saveRequestUsage } = await import("@/lib/usageDb");
    await saveRequestUsage({
      timestamp: new Date().toISOString(), provider: "cursor-acp", model: "composer-2.5",
      connectionId: undefined, apiKey: "sk-test", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 700, completion_tokens: 10 }, status: "ok",
    });
    const { tiers } = (await (await call(await seed("cursor-acp"))).json()).localUsage;
    expect(tiers.cursorModels.requests).toBe(1);
    expect(tiers.cursorModels.models).toContain("composer-2.5");
  });

  it("keeps Cursor Grok inside Cursor Models, not a bar of its own", async () => {
    const { saveRequestUsage } = await import("@/lib/usageDb");
    await saveRequestUsage({
      timestamp: new Date().toISOString(), provider: "cursor-acp", model: "grok-4.6",
      connectionId: undefined, apiKey: "sk-test", endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 300, completion_tokens: 10 }, status: "ok",
    });
    const { tiers } = (await (await call(await seed("cursor-acp"))).json()).localUsage;
    // Listed as part of Cursor Models upstream, and the weekly allowance is a
    // separate quota reported by the provider — not a usage tier.
    expect(tiers.cursorModels.requests).toBeGreaterThanOrEqual(1);
    expect(tiers.cursorModels.models).toContain("grok-4.6");
    expect(tiers.otherModels.requests).toBe(0);
    expect(Object.keys(tiers).sort()).toEqual(["cursorModels", "otherModels"]);
  });
});

describe("bar percentages", () => {
  it("split the total the way Cursor's dashboard does", () => {
    // The arithmetic the card depends on: shares of the total, not of the
    // largest bar — which would print 100% for somebody no matter what.
    const tiers = rollUpTiers([
      { model: "composer-2.5", requests: 10, promptTokens: 900, completionTokens: 100, cost: 0 },
      { model: "gpt-5.3-codex", requests: 2, promptTokens: 100, completionTokens: 10, cost: 1.0 },
      { model: "claude-opus-5-5", requests: 1, promptTokens: 50, completionTokens: 5, cost: 1.0 },
    ]);
    const total = tiers.cursorModels.cost + tiers.otherModels.cost;
    expect(total).toBeCloseTo(2.0);
    expect(Math.round((tiers.otherModels.cost / total) * 100)).toBe(100);
    expect(Math.round((tiers.cursorModels.cost / total) * 100)).toBe(0);
    // Composer traffic is real even though it carries no money yet.
    expect(tiers.cursorModels.requests).toBe(10);
  });

  it("reads as 50/50 when spend is even, like the 14%/14% example", () => {
    const tiers = rollUpTiers([
      { model: "composer-2.5", requests: 1, promptTokens: 1, completionTokens: 1, cost: 0.5 },
      { model: "gpt-5.3-codex", requests: 1, promptTokens: 1, completionTokens: 1, cost: 0.5 },
    ]);
    const { shares } = computeTierShares(tiers);
    expect(shares.cursorModels.pct).toBe(50);
    expect(shares.otherModels.pct).toBe(50);
  });

  it("never prints 100% for somebody — shares are of the total", () => {
    // The distinguishing case is three tiers: a share-of-largest would also give
    // 100/0 for two, but three must sum to 100 and the middle one to 50.
    const { shares } = computeTierShares({
      a: { requests: 5, promptTokens: 500, completionTokens: 0, cost: 0.25 },
      b: { requests: 3, promptTokens: 300, completionTokens: 0, cost: 0.5 },
      c: { requests: 2, promptTokens: 200, completionTokens: 0, cost: 0.25 },
    });
    expect(shares.a.pct + shares.b.pct + shares.c.pct).toBe(100);
    expect(shares.b.pct).toBe(50);
  });

  it("falls back to tokens when nothing has a tariff, and says so", () => {
    const { shares, useCost } = computeTierShares({
      a: { requests: 5, promptTokens: 900, completionTokens: 100, cost: 0 },
      b: { requests: 5, promptTokens: 100, completionTokens: 0, cost: 0 },
    });
    expect(useCost).toBe(false);
    // 1000 of 1100 tokens — prompt and completion both count.
    expect(shares.a.pct).toBe(91);
    expect(shares.b.pct).toBe(9);
  });

  it("marks a tier with traffic even at 0%", () => {
    const { shares } = computeTierShares({
      a: { requests: 5, promptTokens: 900, completionTokens: 0, cost: 0 },
      b: { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0 },
    });
    // Composer traffic is real while it carries no money; an empty bar would
    // read as "not used" and hide the only tier that has volume.
    expect(shares.a.pct).toBe(100);
    expect(shares.a.hasTraffic).toBe(true);
    expect(shares.b.hasTraffic).toBe(false);
  });
});
