// The agent providers were absent from USAGE_SUPPORTED_PROVIDERS, so
// /api/providers/client filtered their connection out of the usage page:
// cursor-acp was serving traffic and had an active connection, yet the usage
// page showed nothing for it while Zed — which does declare features.usage —
// kept showing up. Two conditions had to be relaxed, not one:
//
//   1. the registry entries had no `features.usage` at all;
//   2. the eligibility test asked whether a provider can hold an api key, and
//      the agents are precisely the providers that need no credentials, so they
//      are in neither USAGE_APIKEY_PROVIDERS nor the oauth branch.

import { describe, it, expect, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

process.env.DATA_DIR = "/tmp/9r-usage-eligible-test";

vi.mock("next/server", () => ({
  NextResponse: { json: (b, i) => new Response(JSON.stringify(b), { status: i?.status ?? 200, headers: { "content-type": "application/json" } }) },
}));

const { USAGE_SUPPORTED_PROVIDERS, USAGE_APIKEY_PROVIDERS, FREE_PROVIDERS } =
  await import("@/shared/constants/providers");
const { createProviderConnection } = await import("@/models");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");
const { GET } = await import("@/app/api/providers/client/route");

const AGENTS = ["cursor-acp", "opencode-acp", "omp-acp", "codex-acp", "devin-cli"];

// searchParams.get() returns the first match, so a duplicate accountStatus in
// the query string would silently win over the override — build it once here.
const call = (accountStatus = "all") =>
  GET(new Request(`http://x/api/providers/client?page=1&pageSize=50&sort=priority&accountStatus=${accountStatus}`));

beforeEach(async () => {
  await runMigrationOnce(await getAdapter());
  const db = await getAdapter();
  db.run("DELETE FROM providerConnections");
});

describe("agent providers are usage-supported", () => {
  it("declares features.usage for every agent provider", () => {
    for (const id of AGENTS) {
      expect(USAGE_SUPPORTED_PROVIDERS, id).toContain(id);
    }
  });

  it("keeps them out of the api-key list — that is the point", () => {
    // If one of these ever lands in USAGE_APIKEY_PROVIDERS the second half of
    // the fix would go unnoticed while still working, so pin the shape.
    for (const id of AGENTS) {
      expect(USAGE_APIKEY_PROVIDERS, id).not.toContain(id);
      expect(FREE_PROVIDERS[id]?.noAuth, id).toBe(true);
    }
  });

  it("does not change eligibility for key-bearing providers", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("zed");
    expect(USAGE_APIKEY_PROVIDERS).toContain("kimi");
  });
});

describe("provider connections list", () => {
  it("includes an active agent connection", async () => {
    await createProviderConnection({ provider: "cursor-acp", name: "Cursor Agent (ACP)", authType: "apikey", apiKey: "x" });
    const json = await (await call()).json();
    expect(json.connections.map((c) => c.name)).toContain("Cursor Agent (ACP)");
    expect(json.providerOptions).toContain("cursor-acp");
  });

  it("filters an inactive agent connection out only when asked to", async () => {
    await createProviderConnection({ provider: "cursor-acp", name: "Cursor Agent (ACP)", authType: "apikey", apiKey: "x" });
    // createProviderConnection does not take isActive, so flip it directly —
    // the switch under test only makes sense against a row that is really off.
    (await getAdapter()).run(`UPDATE providerConnections SET isActive = 0`);
    // accountStatus=all is the default and includes inactive rows; eligibility
    // is about the provider, not the switch.
    expect((await (await call()).json()).connections.map((c) => c.name)).toContain("Cursor Agent (ACP)");
    const active = await (await call("active")).json();
    expect(active.connections).toHaveLength(0);
  });

  it("still excludes providers that are not usage-supported at all", async () => {
    await createProviderConnection({ provider: "some-unknown-provider", name: "Nope", authType: "apikey", apiKey: "x" });
    const json = await (await call()).json();
    expect(json.connections).toHaveLength(0);
  });

  it("keeps an oauth connection on its previous path", async () => {
    // "cursor" is no longer a usage provider (the api2 provider was removed in
    // 3.7), so the oauth branch is exercised with a provider that still is.
    const oauthProvider = USAGE_SUPPORTED_PROVIDERS.find(
      (id) => !FREE_PROVIDERS[id]?.noAuth && id !== "zed"
    );
    expect(oauthProvider, "expected a usage-supported, key-free provider").toBeTruthy();
    await createProviderConnection({ provider: oauthProvider, name: "OAuth account", authType: "oauth" });
    const json = await (await call()).json();
    expect(json.connections.map((c) => c.name)).toContain("OAuth account");
  });
});