// The permission policy decides whether a local agent may run commands on the
// user's machine, so the API gate is the part that must not be permissive by
// accident. These cover the trust boundary directly, without HTTP auth.

import { describe, it, expect, vi, beforeEach } from "vitest";

const { getSettings, updateSettings } = vi.hoisted(() => ({
  getSettings: vi.fn(async () => ({})),
  updateSettings: vi.fn(async () => {}),
}));

vi.mock("@/lib/localDb", () => ({ getSettings, updateSettings }));

const { GET, PUT } = await import("@/app/api/acp-permissions/route.js");

const req = (body, url = "http://x/api/acp-permissions") => ({
  json: async () => body,
  url,
});

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue({});
  updateSettings.mockReset().mockResolvedValue(undefined);
});

describe("GET /api/acp-permissions", () => {
  it("returns the defaults, the per-provider map and the vocabulary", async () => {
    getSettings.mockResolvedValue({
      acpPermissions: { execute: { inside: "deny" } },
      acpPermissionsByProvider: { "opencode-acp": { read: { outside: "deny" } } },
    });
    const res = await GET(req({}, "http://x/api/acp-permissions"));
    const body = await res.json();
    expect(body.defaults).toEqual({ execute: { inside: "deny" } });
    expect(body.providers).toEqual(["opencode-acp"]);
    expect(body.values).toEqual(["always", "once", "deny"]);
  });

  it("returns one provider's override, or null when it inherits", async () => {
    getSettings.mockResolvedValue({
      acpPermissions: { read: { inside: "once", outside: "once" } },
      acpPermissionsByProvider: { "opencode-acp": { read: { outside: "deny" } } },
    });
    const withOverride = await (await GET(req({}, "http://x/api/acp-permissions?provider=opencode-acp"))).json();
    expect(withOverride.policy).toEqual({ read: { outside: "deny" } });

    const inherited = await (await GET(req({}, "http://x/api/acp-permissions?provider=cursor-acp"))).json();
    expect(inherited.policy).toBeNull();
  });
});

describe("PUT /api/acp-permissions", () => {
  it("stores a router-wide default when no provider is given", async () => {
    const res = await PUT(req({ policy: { execute: { inside: "deny", outside: "deny" } } }));
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      acpPermissions: { execute: { inside: "deny", outside: "deny" } },
    });
  });

  it("stores an override under the canonical provider id", async () => {
    getSettings.mockResolvedValue({ acpPermissionsByProvider: { "cursor-acp": { read: { inside: "deny" } } } });
    const res = await PUT(req({ policy: { read: { inside: "deny" } }, provider: "opencode-acp" }));
    expect(res.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({
      acpPermissionsByProvider: {
        "cursor-acp": { read: { inside: "deny" } },
        "opencode-acp": { read: { inside: "deny" } },
      },
    });
  });

  it("clears an override when the policy is null", async () => {
    getSettings.mockResolvedValue({ acpPermissionsByProvider: { "opencode-acp": { read: { inside: "deny" } } } });
    await PUT(req({ policy: null, provider: "opencode-acp" }));
    expect(updateSettings).toHaveBeenCalledWith({ acpPermissionsByProvider: {} });
  });

  it("rejects an unknown action instead of silently dropping it", async () => {
    const res = await PUT(req({ policy: { rmDashRf: { inside: "always" } } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown action/);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an unknown value rather than coercing it to permissive", async () => {
    const res = await PUT(req({ policy: { execute: { inside: "definitely-yes" } } }));
    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("rejects an unknown scope", async () => {
    const res = await PUT(req({ policy: { read: { everywhere: "always" } } }));
    expect(res.status).toBe(400);
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("rejects a non-object policy", async () => {
    for (const policy of ["allow", 42, [], true]) {
      const res = await PUT(req({ policy }));
      expect(res.status).toBe(400);
    }
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("keeps a single scope without inventing the other", async () => {
    await PUT(req({ policy: { read: { outside: "deny" } } }));
    expect(updateSettings).toHaveBeenCalledWith({ acpPermissions: { read: { outside: "deny" } } });
  });
});