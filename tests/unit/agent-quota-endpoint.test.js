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
const { getAdapter } = await import("@/lib/db/driver");
const { GET } = await import("@/app/api/usage/[connectionId]/route");
const { USAGE_APIKEY_PROVIDERS } = await import("@/shared/constants/providers");

const AGENTS = ["cursor-acp", "opencode-acp", "omp-acp", "codex-acp", "devin-cli"];

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
      provider: "cursor-acp",
      model: "composer-2.5",
      connectionId: undefined,
      apiKey: "sk-test",
      endpoint: "/v1/chat/completions",
      tokens: { prompt_tokens: 1000, completion_tokens: 50 },
      status: "ok",
    });
    const body = await (await call(await seed("cursor-acp"))).json();
    expect(body.unsupported).toBe("own-subscription");
    // The quota upstream cannot answer for an agent, but the router's own
    // history can — returning prose alone read as "no data".
    expect(body.localUsage.requests).toBeGreaterThanOrEqual(1);
    expect(body.localUsage.promptTokens).toBeGreaterThanOrEqual(1000);
  });
});
