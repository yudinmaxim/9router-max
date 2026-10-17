// Zed is no longer a supported provider.
//
// It is deliberately unsupported: the proxy callback called
// createProviderConnection on every sign-in without ever looking for an existing
// connection, so one Zed login repeated into a dozen duplicates in the
// connections list. These tests pin the refusal so the flow cannot come back
// through a stale UI or a direct call.
//
// RUN WITH AN ISOLATED DB:  DATA_DIR=$(mktemp -d) npx vitest run unit/zed-native-auth.test.js
import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";

describe("Zed is refused everywhere", () => {
  it("is absent from the OAuth provider registry", async () => {
    const { getProvider, getProviderNames } = await import("@/lib/oauth/providers/index.js");
    expect(getProviderNames()).not.toContain("zed");
    // getProvider throws rather than returning null, so ask for the throw.
    expect(() => getProvider("zed")).toThrow(/Unknown provider/);
  });

  it("cannot start an OAuth session", async () => {
    const { POST, GET } = await import("@/app/api/oauth/[provider]/[action]/route.js");
    const ctx = { params: Promise.resolve({ provider: "zed", action: "authorize" }) };

    const post = await POST(
      new NextRequest("http://localhost/api/oauth/zed/authorize", { method: "POST", body: "{}" }),
      ctx
    );
    expect(post.status).toBe(410);

    const get = await GET(
      new NextRequest("http://localhost/api/oauth/zed/register-session"),
      { params: Promise.resolve({ provider: "zed", action: "register-session" }) }
    );
    expect(get.status).toBe(410);
  });

  it("cannot be imported from the IDE", async () => {
    const { POST } = await import("@/app/api/oauth/zed/import/route.js");
    const res = await POST(
      new NextRequest("http://localhost/api/oauth/zed/import", {
        method: "POST",
        body: JSON.stringify({ accessToken: "tok", userId: "user-123" }),
      })
    );
    expect(res.status).toBe(410);
    expect((await res.json()).error).toMatch(/no longer supported/i);
  });

  it("is not offered as a browser proxy flow", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../src/shared/components/OAuthModal.js", import.meta.url),
      "utf8"
    );
    expect(src).not.toMatch(/PROXY_OAUTH_PROVIDERS\s*=\s*new Set\(\[[^\]]*"zed"/);
  });
});