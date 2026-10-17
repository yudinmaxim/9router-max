// Server-side cache on GET /api/usage/[connectionId].
//
// Two callers already poll this route on their own timers — the quota page and
// the header chips — and Anthropic's quota endpoint answers 429 when asked too
// often, so a cache that does not actually cut upstream calls is a cosmetic
// change. The counts below are the point of the test: each `upstreamCalls` is a
// real trip to the provider.
//
// Also pinned here: a Response body can only be read once, so a cache that
// handed back the same Response object would break the second caller. Both
// concurrent callers below must get a readable body.

import { describe, it, expect, beforeEach, vi } from "vitest";

process.env.DATA_DIR = "/tmp/9r-usage-cache-test";

vi.mock("next/server", () => ({ NextResponse: { json: (b, i) => Response.json(b, i) } }));

const usageState = { calls: 0, fail: false, value: { quotas: [{ name: "Weekly", remainingPercentage: 55 }] } };

vi.mock("open-sse/services/usage.js", () => ({
  getUsageForProvider: vi.fn(async () => {
    usageState.calls += 1;
    if (usageState.fail) throw new Error("upstream down");
    return usageState.value;
  }),
}));

const { createProviderConnection } = await import("@/models");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");
const { GET } = await import("@/app/api/usage/[connectionId]/route");

const url = (id, force) => `http://x/api/usage/${id}${force ? "?force=1" : ""}`;
const call = (id, force = false) => GET(new Request(url(id, force)), { params: Promise.resolve({ connectionId: id }) });

async function seed(provider = "claude") {
  const c = await createProviderConnection({ provider, name: "cache test", authType: "oauth", accessToken: "tok" });
  return c.id;
}

beforeEach(async () => {
  await runMigrationOnce(await getAdapter());
  (await getAdapter()).run("DELETE FROM providerConnections");
  globalThis.__n9routerUsageCache?.clear();
  usageState.calls = 0;
  usageState.fail = false;
  usageState.value = { quotas: [{ name: "Weekly", remainingPercentage: 55 }] };
});

describe("the usage route cache", () => {
  it("calls the provider once for a repeat read inside the TTL", async () => {
    const id = await seed();

    const first = await (await call(id)).json();
    const second = await (await call(id)).json();

    expect(usageState.calls).toBe(1);
    expect(second).toEqual(first);
    expect(second.quotas[0].name).toBe("Weekly");
  });

  it("still gives every concurrent caller a body it can read", async () => {
    const id = await seed();

    // Both requests start before either finishes, so they share the in-flight
    // promise. If the cache returned one Response object to both, the second
    // `.json()` would throw "body already read".
    const [a, b] = await Promise.all([call(id), call(id)]);
    const [ja, jb] = await Promise.all([a.json(), b.json()]);

    expect(usageState.calls).toBe(1);
    expect(ja.quotas).toEqual(jb.quotas);
  });

  it("bypasses the cache for a forced refresh and refills it", async () => {
    const id = await seed();
    await (await call(id)).json();
    expect(usageState.calls).toBe(1);

    await (await call(id, true)).json();
    expect(usageState.calls).toBe(2);

    // The forced read replaced what the cache held, so the next ordinary read
    // is served from it rather than going upstream a third time.
    await (await call(id)).json();
    expect(usageState.calls).toBe(2);
  });

  it("does not pin a failure over a good read", async () => {
    const id = await seed();
    await (await call(id)).json();
    expect(usageState.calls).toBe(1);

    // TTL is a minute, so force is the only way in — and it must not poison the
    // cache for everyone else when the upstream blinks.
    usageState.fail = true;
    const forced = await call(id, true);
    expect(forced.status).toBe(500);
    expect(usageState.calls).toBe(2);

    usageState.fail = false;
    const after = await (await call(id)).json();
    expect(after.quotas[0].remainingPercentage).toBe(55);
    // Served from the restored entry, not by a third trip upstream.
    expect(usageState.calls).toBe(2);
  });

  it("does not cache a connection that does not exist", async () => {
    const res = await call("00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
    expect(usageState.calls).toBe(0);

    // A pinned 404 would make a connection that appears a minute later look
    // missing for the rest of the TTL.
    const res2 = await call("00000000-0000-0000-0000-000000000000");
    expect(res2.status).toBe(404);
    expect(usageState.calls).toBe(0);
  });

  it("reports a forced failure as a failure, not as stale numbers", async () => {
    // The operator asked to see something current; answering with a minute-old
    // body would look like the refresh worked.
    const id = await seed();
    await (await call(id)).json();
    usageState.fail = true;
    const res = await call(id, true);
    expect(res.status).toBe(500);
  });

  it("does not cache a failure when there is nothing good to fall back on", async () => {
    const id = await seed();
    usageState.fail = true;
    expect((await call(id)).status).toBe(500);
    expect(usageState.calls).toBe(1);

    // A pinned 500 would keep reporting the outage for a minute after it ended.
    usageState.fail = false;
    const recovered = await (await call(id)).json();
    expect(recovered.quotas[0].remainingPercentage).toBe(55);
    expect(usageState.calls).toBe(2);
  });
});