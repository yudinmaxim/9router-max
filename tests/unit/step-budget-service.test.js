import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

// The key the request presents, as the DB would answer.
let keyRecord = { id: "key-1", name: "zed", access: { restricted: false, allow: [] } };
// The model the request names, as routing would resolve it.
let modelInfo = { provider: "ca", model: "composer-2.5" };

vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({
  getApiKeyByKey: vi.fn(async () => keyRecord),
}));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: vi.fn(async () => modelInfo),
  getComboModels: vi.fn(async () => null),
}));

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let service;
let repo;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-step-budget-svc-"));
  process.env.DATA_DIR = tempDir;
  const db = await import("@/lib/db/index.js");
  await db.initDb();
  repo = await import("@/lib/db/repos/stepBudgetsRepo.js");
  service = await import("@/sse/services/stepBudget.js");
});

beforeEach(async () => {
  const adapter = await import("@/lib/db/driver.js");
  const handle = await adapter.getAdapter();
  handle.run("DELETE FROM stepBudgets");
  keyRecord = { id: "key-1", name: "zed", access: { restricted: false, allow: [] } };
  modelInfo = { provider: "ca", model: "composer-2.5" };
});

afterAll(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch { /* already closed */ }
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const request = { headers: { get: (h) => (h.toLowerCase() === "authorization" ? "Bearer sk-test" : null) } };

describe("step budget scope resolution", () => {
  it("scopes an UNRESTRICTED key to itself — a key is an identity either way", async () => {
    // The gap this covers: getKeyAccessContext() returns null for an
    // unrestricted key, so reading the id from there would leave every
    // ordinary key without a scope of its own.
    await repo.upsertStepBudget("key:key-1", { limitSteps: 1, windowMs: 3600000 });
    const scope = await service.resolveRequestScope({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(scope).toBe("key:key-1");
  });

  it("prefers the key scope over the provider scope", async () => {
    await repo.upsertStepBudget("key:key-1", { limitSteps: 1, windowMs: 3600000 });
    await repo.upsertStepBudget("provider:ca", { limitSteps: 1, windowMs: 3600000 });
    const scope = await service.resolveRequestScope({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(scope).toBe("key:key-1");
  });

  it("falls back to the provider scope when the key has no budget of its own", async () => {
    await repo.upsertStepBudget("provider:ca", { limitSteps: 1, windowMs: 3600000 });
    const scope = await service.resolveRequestScope({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(scope).toBe("provider:ca");
  });

  it("gives a keyless agent the provider scope, so the no-key fleet is not unbounded", async () => {
    keyRecord = null; // no key at all
    await repo.upsertStepBudget("provider:ca", { limitSteps: 1, windowMs: 3600000 });
    const scope = await service.resolveRequestScope({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(scope).toBe("provider:ca");
  });

  it("returns no scope when nothing is declared, so behaviour is unchanged", async () => {
    const scope = await service.resolveRequestScope({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(scope).toBeNull();
  });

  it("falls back to global for a combo, which has no provider of its own", async () => {
    modelInfo = { provider: null, model: null };
    await repo.upsertStepBudget("global", { limitSteps: 1, windowMs: 3600000 });
    const scope = await service.resolveRequestScope({ request, keyAccess: null, modelStr: "MyCombo" });
    expect(scope).toBe("global");
  });

  it("spends one step per request and refuses with 429 and Retry-After", async () => {
    await repo.upsertStepBudget("key:key-1", { limitSteps: 2, windowMs: 3600000 });
    expect(await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" })).toBeNull();
    expect(await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" })).toBeNull();

    const denied = await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(denied).not.toBeNull();
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toMatch(/^\d+$/);
  });

  it("tells the agent the step did not happen, and not to keep trying", async () => {
    await repo.upsertStepBudget("key:key-1", { limitSteps: 1, windowMs: 3600000 });
    await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    const denied = await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    const body = JSON.parse(await denied.text());
    expect(body.error.message).toMatch(/not taken/i);
    expect(body.error.message).toMatch(/not counted/i);
  });

  it("lets everything through when no budget is declared", async () => {
    expect(await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" })).toBeNull();
  });
});

describe("setStepBudget", () => {
  it("rejects a malformed scope instead of guessing", async () => {
    const r = await service.setStepBudget({ scope: "nonsense", limitSteps: 5 });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
  });

  it("rejects a malformed limit instead of clamping it", async () => {
    const r = await service.setStepBudget({ scope: "global", limitSteps: -3 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/non-negative/);
  });

  it("treats a zero limit as removal, not as a budget of zero", async () => {
    await service.setStepBudget({ scope: "global", limitSteps: 5 });
    await service.setStepBudget({ scope: "global", limitSteps: 0 });
    expect(await repo.getStepBudget("global")).toBeNull();
  });

  it("applies a changed limit on the next request", async () => {
    await service.setStepBudget({ scope: "key:key-1", limitSteps: 1, windowMs: 3600000 });
    await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    await service.setStepBudget({ scope: "key:key-1", limitSteps: 5, windowMs: 3600000 });
    const denied = await service.enforceStepBudget({ request, keyAccess: null, modelStr: "ca/composer-2.5" });
    expect(denied).toBeNull();
  });
});