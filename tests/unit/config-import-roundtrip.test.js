// Import behaviour against a real database.
//
// Two things here were missing and both cost something: there was no backup
// before the tables were wiped, so a failed import destroyed the configuration
// with no way back, and there was no merge, so moving a configuration to a
// second machine stacked a duplicate of every proxy pool onto it.
//
// RUN WITH AN ISOLATED DB: DATA_DIR=$(mktemp -d) npx vitest run unit/config-import-roundtrip.test.js

import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

process.env.DATA_DIR = "/tmp/9r-config-import-test";

const { createProviderConnection } = await import("@/models");
const { createProxyPool } = await import("@/models");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");
const { exportDb, importDb } = await import("@/lib/db/index");
const { buildTransfer } = await import("@/lib/db/transfer");

async function reset() {
  await runMigrationOnce(await getAdapter());
  const db = await getAdapter();
  for (const table of ["settings", "providerConnections", "providerNodes", "proxyPools", "apiKeys", "combos"]) {
    db.run(`DELETE FROM ${table}`);
  }
  db.run(`DELETE FROM kv`);
}

async function counts() {
  const db = await getAdapter();
  return {
    connections: db.all(`SELECT id FROM providerConnections`).length,
    pools: db.all(`SELECT id FROM proxyPools`).length,
    combos: db.all(`SELECT id FROM combos`).length,
  };
}

beforeEach(async () => {
  await reset();
});

describe("export then import", () => {
  it("round-trips a config into an empty database", async () => {
    const source = await createProviderConnection({ provider: "claude", name: "Work", authType: "oauth", accessToken: "tok-secret" });
    await createProxyPool({ name: "corp", proxyUrl: "http://proxy.example:8080", noProxy: "" });
    const envelope = buildTransfer(await exportDb(), { mode: "config" });

    await reset();
    expect((await counts()).connections).toBe(0);

    await importDb(envelope.payload, { strategy: "replace", carriesSecrets: envelope.includesSecrets });

    expect((await counts()).connections).toBe(1);
    expect((await counts()).pools).toBe(1);
    // The connection came back as a shape, without its authorization — which is
    // what makes the file shareable.
    const db = await getAdapter();
    const row = db.get(`SELECT data FROM providerConnections WHERE id = ?`, [source.id]);
    expect(JSON.parse(row.data).accessToken).toBeUndefined();
  });

  it("carries disabledModels across, which nothing used to do", async () => {
    const { disableModels } = await import("@/lib/db/index");
    await disableModels("ca", ["grok-4.7", "muse-spark-1.3-contributor-free"]);
    const envelope = buildTransfer(await exportDb(), { mode: "config" });
    expect(envelope.payload.disabledModels.ca).toEqual(["grok-4.7", "muse-spark-1.3-contributor-free"]);

    await reset();
    await importDb(envelope.payload, { strategy: "replace" });
    const after = await exportDb();
    expect(after.disabledModels.ca).toEqual(["grok-4.7", "muse-spark-1.3-contributor-free"]);
  });

  it("writes a backup before it touches anything", async () => {
    await createProviderConnection({ provider: "claude", name: "Doomed", authType: "oauth" });
    const backupsDir = path.join(process.env.DATA_DIR, "db", "backups");
    // Cleared first because the directory name has second resolution: two imports
    // in the same second reuse one directory, so counting would be timing-dependent.
    if (fs.existsSync(backupsDir)) {
      for (const entry of fs.readdirSync(backupsDir).filter((d) => d.startsWith("pre-import"))) {
        fs.rmSync(path.join(backupsDir, entry), { recursive: true, force: true });
      }
    }

    // A payload that fails partway through: the access blob is rejected.
    await expect(
      importDb({
        providerConnections: [{ id: "x", provider: "claude" }],
        apiKeys: [{ id: "k", key: "sk-1", access: { bogus: true } }],
      }, { strategy: "replace" })
    ).rejects.toThrow();

    const created = fs.readdirSync(backupsDir).filter((d) => d.startsWith("pre-import"));
    expect(created, "a pre-import backup was taken").toHaveLength(1);
    expect(fs.existsSync(path.join(backupsDir, created[0], "data.sqlite"))).toBe(true);
  });

  it("refuses a bad access blob without leaving the table half written", async () => {
    await createProviderConnection({ provider: "claude", name: "Keep me", authType: "oauth" });
    await expect(
      importDb({ apiKeys: [{ id: "k", key: "sk-1", access: { bogus: true } }] }, { strategy: "replace" })
    ).rejects.toThrow();
    // The transaction rolled back, so what was there is still there.
    expect((await counts()).connections).toBe(1);
  });
});

describe("merge", () => {
  it("adds without wiping, and does not duplicate a pool it already has", async () => {
    await createProviderConnection({ provider: "claude", name: "Local one", authType: "oauth" });
    await createProxyPool({ name: "corp", proxyUrl: "http://proxy.example:8080", noProxy: "" });

    const envelope = buildTransfer({
      ...(await exportDb()),
      providerConnections: [
        { id: "remote-1", provider: "gemini", authType: "oauth", name: "Remote one", isActive: true },
        { id: "remote-2", provider: "codex", authType: "oauth", name: "Remote two", isActive: true },
      ],
      proxyPools: [
        // Same pool, different row id — exactly what copying a file to a second
        // machine produces.
        { id: "remote-pool", name: "corp", proxyUrl: "http://proxy.example:8080", noProxy: "", isActive: true },
        { id: "remote-pool-2", name: "other", proxyUrl: "http://other.example:3128", noProxy: "", isActive: true },
      ],
    }, { mode: "config" });

    await importDb(envelope.payload, { strategy: "merge" });

    const c = await counts();
    expect(c.connections).toBe(3);
    expect(c.pools).toBe(2);
    const db = await getAdapter();
    const urls = db.all(`SELECT data FROM proxyPools`).map((r) => JSON.parse(r.data).proxyUrl).sort();
    expect(urls).toEqual(["http://other.example:3128", "http://proxy.example:8080"]);
  });

  it("replace keeps the old behaviour of wiping first", async () => {
    await createProviderConnection({ provider: "claude", name: "Old", authType: "oauth" });
    await importDb({
      providerConnections: [{ id: "new", provider: "gemini", authType: "oauth", name: "New", isActive: true }],
    }, { strategy: "replace" });
    const c = await counts();
    expect(c.connections).toBe(1);
    const db = await getAdapter();
    expect(db.get(`SELECT name FROM providerConnections WHERE id = 'new'`)?.name).toBe("New");
  });
});