import { describe, it, expect, afterEach, vi } from "vitest";
import {
  acpSessionKey,
  getAcpSession,
  peekAcpSession,
  putAcpSession,
  dropAcpSession,
  acquireAcpSession,
  clearAcpSessions,
  markAcpSessionDead,
} from "../../open-sse/executors/lib/acpSessionPool.js";

afterEach(() => clearAcpSessions());

describe("ACP session pool", () => {
  it("keys provider, connection, cwd, and model", () => {
    expect(acpSessionKey({ provider: "cursor", connection: "a", cwd: "/x", model: "m" }))
      .not.toBe(acpSessionKey({ provider: "cursor", connection: "b", cwd: "/x", model: "m" }));
  });

  it("separates pools by proxy, since a session must not outlive its route", () => {
    const base = { provider: "codex-acp", connection: "a", cwd: "/x", model: "m" };
    const direct = acpSessionKey(base);
    expect(acpSessionKey({ ...base, proxy: "http://127.0.0.1:12334" })).not.toBe(direct);
    expect(acpSessionKey({ ...base, proxy: "http://127.0.0.1:10001" }))
      .not.toBe(acpSessionKey({ ...base, proxy: "http://127.0.0.1:12334" }));
    // noProxy is part of the same route identity — a different bypass list
    // changes where the child's traffic actually goes.
    expect(acpSessionKey({ ...base, proxy: "http://127.0.0.1:12334", noProxy: "localhost" }))
      .not.toBe(acpSessionKey({ ...base, proxy: "http://127.0.0.1:12334" }));
  });

  it("reuses live entries and expires them", () => {
    const key = "k";
    putAcpSession(key, { child: 1 }, { ttl: 10, now: 100 });
    expect(getAcpSession(key, 109).child).toBe(1);
    expect(getAcpSession(key, 1000)).toBeNull();
  });

  it("drops crashed entries", () => {
    putAcpSession("k", { child: 1 });
    dropAcpSession("k");
    expect(getAcpSession("k")).toBeNull();
  });

  it("serializes acquisitions", async () => {
    const first = await acquireAcpSession("k");
    let secondReady = false;
    const second = acquireAcpSession("k").then(() => { secondReady = true; });
    await Promise.resolve();
    expect(secondReady).toBe(false);
    first.release();
    await second;
    expect(secondReady).toBe(true);
  });

  it("never hands out a session marked dead, and kills its child", () => {
    // The `close` handler demotes an entry whose child exited. Both readers
    // must agree the entry is gone — a stale live-looking entry is what made
    // later turns reuse a closed transport and hang behind the pool TTL.
    const child = { kill: vi.fn() };
    putAcpSession("k", { child, sessionId: "s" });
    markAcpSessionDead("k");
    expect(getAcpSession("k")).toBeNull();
    expect(peekAcpSession("k")).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });
});
