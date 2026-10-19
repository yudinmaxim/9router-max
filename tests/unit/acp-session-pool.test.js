import { describe, it, expect, afterEach } from "vitest";
import {
  acpSessionKey,
  getAcpSession,
  putAcpSession,
  dropAcpSession,
  acquireAcpSession,
  clearAcpSessions,
} from "../../open-sse/executors/lib/acpSessionPool.js";

afterEach(() => clearAcpSessions());

describe("ACP session pool", () => {
  it("keys provider, connection, cwd, and model", () => {
    expect(acpSessionKey({ provider: "cursor", connection: "a", cwd: "/x", model: "m" }))
      .not.toBe(acpSessionKey({ provider: "cursor", connection: "b", cwd: "/x", model: "m" }));
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
});
