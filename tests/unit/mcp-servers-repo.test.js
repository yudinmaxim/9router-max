import { describe, it, expect, beforeEach, afterAll } from "vitest";

process.env.DATA_DIR = "/tmp/9r-mcp-repo-test";

const repo = await import("@/lib/db/repos/mcpServersRepo");
const { runMigrationOnce } = await import("@/lib/db/migrate");
const { getAdapter } = await import("@/lib/db/driver");

const TABLE = "mcpServers";

async function clear() {
  const db = await getAdapter();
  db.run(`DELETE FROM ${TABLE}`);
}

beforeEach(async () => {
  await runMigrationOnce(await getAdapter());
  await clear();
});

afterAll(async () => {
  await clear();
});

const VALID = {
  name: "Jira",
  url: "https://jira.example.com/mcp",
  transport: "http",
  authType: "bearer",
  authToken: "pat-secret-1",
};

describe("mcpServersRepo — schema", () => {
  it("has the columns and indexes the migration promises", async () => {
    const db = await getAdapter();
    expect(db.all(`PRAGMA table_info(${TABLE})`).map((c) => c.name))
      .toEqual(["id", "isActive", "testStatus", "data", "createdAt", "updatedAt"]);
    const idx = db.all(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?`, [TABLE]).map((i) => i.name);
    expect(idx).toContain("idx_ms_active");
    expect(idx).toContain("idx_ms_status");
  });
});

describe("mcpServersRepo — create", () => {
  it("stores a server and reports that a token exists", async () => {
    const { ok, server } = await repo.createMcpServer(VALID);
    expect(ok).toBe(true);
    expect(server.name).toBe("Jira");
    expect(server.hasToken).toBe(true);
    expect(server.isActive).toBe(true);
    expect(server.testStatus).toBe("unknown");
  });

  it("never returns the token itself", async () => {
    const { server } = await repo.createMcpServer(VALID);
    expect(server.authToken).toBeUndefined();
    expect(JSON.stringify(server)).not.toContain("pat-secret-1");
  });

  it("does not leave the token in clear in the stored row", async () => {
    const { server } = await repo.createMcpServer(VALID);
    const db = await getAdapter();
    const raw = db.get(`SELECT data FROM ${TABLE} WHERE id = ?`, [server.id]).data;
    expect(raw).not.toContain("pat-secret-1");
    expect(JSON.parse(raw).authTokenEnc).toMatch(/^v1:/);
  });

  it("accepts a tokenless server", async () => {
    const { ok, server } = await repo.createMcpServer({
      name: "Local", url: "http://127.0.0.1:9/mcp", authType: "none",
    });
    expect(ok).toBe(true);
    expect(server.hasToken).toBe(false);
  });

  it("rejects a missing name or url", async () => {
    expect((await repo.createMcpServer({ url: "https://x.example/mcp" })).errors).toContain("name is required");
    expect((await repo.createMcpServer({ name: "x" })).errors).toContain("url is required");
  });

  it("rejects a malformed or non-http url", async () => {
    expect((await repo.createMcpServer({ name: "x", url: "not a url" })).errors)
      .toContain("url is not a valid URL");
    expect((await repo.createMcpServer({ name: "x", url: "file:///etc/passwd" })).errors)
      .toContain("url must use http or https");
  });

  it("falls back to a known enum value instead of storing garbage", async () => {
    const { server } = await repo.createMcpServer({ ...VALID, transport: "gopher", authType: "oauth" });
    expect(server.transport).toBe("http");
    expect(server.authType).toBe("none");
  });

  it("keeps a stored enum when an update omits the field", async () => {
    const { server } = await repo.createMcpServer({ ...VALID, authType: "header", authHeader: "X-Api-Key" });
    await repo.updateMcpServer(server.id, { name: "Renamed" });
    const after = await repo.getMcpServerById(server.id);
    expect(after.authType).toBe("header");
    expect(after.authHeader).toBe("X-Api-Key");
  });

  it("ignores an attempt to inject a pre-sealed blob", async () => {
    const { server } = await repo.createMcpServer({ ...VALID, authTokenEnc: "v1:attacker" });
    const db = await getAdapter();
    const stored = JSON.parse(db.get(`SELECT data FROM ${TABLE} WHERE id = ?`, [server.id]).data);
    expect(stored.authTokenEnc).not.toBe("v1:attacker");
    expect(stored.authTokenEnc).toMatch(/^v1:[0-9a-f]{24}/);
  });
});

describe("mcpServersRepo — read", () => {
  it("lists servers newest-updated first", async () => {
    const a = await repo.createMcpServer({ ...VALID, name: "A" });
    await new Promise((r) => setTimeout(r, 2));
    await repo.createMcpServer({ ...VALID, name: "B" });
    const list = await repo.getMcpServers();
    expect(list.map((s) => s.name)).toEqual(["B", "A"]);
    expect(list).toHaveLength(2);
    expect(a.ok).toBe(true);
  });

  it("filters by isActive", async () => {
    await repo.createMcpServer(VALID);
    await repo.createMcpServer({ ...VALID, name: "Off", isActive: false });
    expect(await repo.getMcpServers({ isActive: true })).toHaveLength(1);
    expect(await repo.getMcpServers({ isActive: false })).toHaveLength(1);
    expect(await repo.getMcpServers()).toHaveLength(2);
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.getMcpServerById("nope")).toBeNull();
  });
});

describe("mcpServersRepo — update", () => {
  it("keeps the stored token when the body sends an empty one", async () => {
    const { server } = await repo.createMcpServer(VALID);
    const res = await repo.updateMcpServer(server.id, { name: "Renamed", authToken: "" });
    expect(res.ok).toBe(true);
    const resolved = await repo.resolveMcpServerForProxy(server.id);
    expect(resolved.headers.Authorization).toBe("Bearer pat-secret-1");
  });

  it("keeps the stored token when authToken is absent entirely", async () => {
    const { server } = await repo.createMcpServer(VALID);
    await repo.updateMcpServer(server.id, { name: "Renamed" });
    const resolved = await repo.resolveMcpServerForProxy(server.id);
    expect(resolved.headers.Authorization).toBe("Bearer pat-secret-1");
  });

  it("replaces the token when a new one is given", async () => {
    const { server } = await repo.createMcpServer(VALID);
    await repo.updateMcpServer(server.id, { authToken: "pat-secret-2" });
    const resolved = await repo.resolveMcpServerForProxy(server.id);
    expect(resolved.headers.Authorization).toBe("Bearer pat-secret-2");
  });

  it("merges fields without dropping the ones the body omits", async () => {
    const { server } = await repo.createMcpServer(VALID);
    await repo.updateMcpServer(server.id, { name: "Renamed" });
    const after = await repo.getMcpServerById(server.id);
    expect(after.url).toBe(VALID.url);
    expect(after.transport).toBe("http");
    expect(after.hasToken).toBe(true);
  });

  it("reports validation errors and leaves the row untouched", async () => {
    const { server } = await repo.createMcpServer(VALID);
    const res = await repo.updateMcpServer(server.id, { url: "nonsense" });
    expect(res.ok).toBe(false);
    expect(res.errors).toContain("url is not a valid URL");
    const after = await repo.getMcpServerById(server.id);
    expect(after.url).toBe(VALID.url);
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.updateMcpServer("nope", { name: "x" })).toBeNull();
  });
});

describe("mcpServersRepo — delete", () => {
  it("removes the row and returns what was there", async () => {
    const { server } = await repo.createMcpServer(VALID);
    const removed = await repo.deleteMcpServer(server.id);
    expect(removed.id).toBe(server.id);
    expect(await repo.getMcpServerById(server.id)).toBeNull();
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.deleteMcpServer("nope")).toBeNull();
  });
});

describe("mcpServersRepo — test status", () => {
  it("records the outcome and the timestamp", async () => {
    const { server } = await repo.createMcpServer(VALID);
    const updated = await repo.setMcpServerTestStatus(server.id, "ok");
    expect(updated.testStatus).toBe("ok");
    expect(updated.lastTestedAt).toBeTruthy();
    const after = await repo.getMcpServerById(server.id);
    expect(after.testStatus).toBe("ok");
  });

  it("records a failure reason", async () => {
    const { server } = await repo.createMcpServer(VALID);
    await repo.setMcpServerTestStatus(server.id, "error", "connect ECONNREFUSED");
    const after = await repo.getMcpServerById(server.id);
    expect(after.testStatus).toBe("error");
    expect(after.lastError).toBe("connect ECONNREFUSED");
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.setMcpServerTestStatus("nope", "ok")).toBeNull();
  });
});

describe("mcpServersRepo — proxy resolution", () => {
  it("decrypts a bearer token into an Authorization header", async () => {
    const { server } = await repo.createMcpServer(VALID);
    const resolved = await repo.resolveMcpServerForProxy(server.id);
    expect(resolved.url).toBe(VALID.url);
    expect(resolved.transport).toBe("http");
    expect(resolved.allowLocal).toBe(false);
    expect(resolved.headers).toEqual({ Authorization: "Bearer pat-secret-1" });
    expect(resolved.tokenError).toBeNull();
  });

  it("uses a custom header name when authType is header", async () => {
    const { server } = await repo.createMcpServer({
      ...VALID, authType: "header", authHeader: "X-Api-Key", authToken: "glpat-1",
    });
    const resolved = await repo.resolveMcpServerForProxy(server.id);
    expect(resolved.headers).toEqual({ "X-Api-Key": "glpat-1" });
    expect(resolved.headers.Authorization).toBeUndefined();
  });

  it("sends no headers when authType is none", async () => {
    const { server } = await repo.createMcpServer({ name: "Local", url: "https://x.example/mcp" });
    const resolved = await repo.resolveMcpServerForProxy(server.id);
    expect(resolved.headers).toEqual({});
  });

  it("refuses a disabled server", async () => {
    const { server } = await repo.createMcpServer({ ...VALID, isActive: false });
    expect(await repo.resolveMcpServerForProxy(server.id)).toEqual({ disabled: true, id: server.id });
  });

  it("returns null for an unknown id", async () => {
    expect(await repo.resolveMcpServerForProxy("nope")).toBeNull();
  });

  it("carries allowLocal through for self-hosted servers", async () => {
    const { server } = await repo.createMcpServer({
      name: "Confluence", url: "http://192.168.1.10:8090/rest/mcp", allowLocal: true,
    });
    expect((await repo.resolveMcpServerForProxy(server.id)).allowLocal).toBe(true);
  });
});