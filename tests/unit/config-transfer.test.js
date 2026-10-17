// Config transfer: what a file may and may not contain.
//
// The acceptance criterion is blunt — a secret-free file contains no token —
// and the way to hold that is to build a payload carrying secrets of every kind
// this codebase knows about, export it in both modes, and walk the result
// looking for the values rather than for the field names. A deny list would pass
// that test and still leak the field added next month; these tests are written
// the other way round on purpose.

import { describe, it, expect } from "vitest";
import {
  buildTransfer,
  parseTransferFile,
  sanitizeConnection,
  scrubTokenFreshness,
  poolIdentity,
  stripProxyUrlCredentials,
  TRANSFER_FORMAT_VERSION,
} from "@/lib/db/transfer";

/** Every kind of credential this database can be holding. */
const SECRETS = {
  accessToken: "ACCESS-TOKEN-aaaaaaaaaaaaaaaaaaaa",
  refreshToken: "REFRESH-TOKEN-bbbbbbbbbbbbbbbbbbb",
  idToken: "ID-TOKEN-cccccccccccccccccccc",
  apiKey: "API-KEY-dddddddddddddddddddd",
  password: "DASHBOARD-PASSWORD-eeeeeeeeeeee",
  oidcClientSecret: "OIDC-SECRET-ffffffffffffffff",
  mitmSudoEncrypted: "iv:tag:ciphertext-SUDO-gggggggg",
  copilotToken: "COPILOT-TOKEN-hhhhhhhhhhhhhhhh",
  mimoPassToken: "MIMO-PASS-TOKEN-iiiiiiiiiiiii",
  sessionToken: "SESSION-TOKEN-jjjjjjjjjjjjjjjj",
  accessKeyId: "ACCESS-KEY-ID-kkkkkkkkkkkkk",
  routerKey: "sk-router-key-lllllllllllllll",
};

function rawPayload() {
  return {
    settings: {
      stickyRoundRobinLimit: 3,
      password: SECRETS.password,
      oidcClientSecret: SECRETS.oidcClientSecret,
      mitmSudoEncrypted: SECRETS.mitmSudoEncrypted,
      providerOverrides: {
        claude: { headers: { "x-secret": "HEADER-SECRET-mmmmmmmmmm" }, timeoutMs: 5000 },
      },
    },
    providerConnections: [
      {
        id: "c1",
        provider: "claude",
        authType: "oauth",
        name: "Work",
        isActive: true,
        accessToken: SECRETS.accessToken,
        refreshToken: SECRETS.refreshToken,
        idToken: SECRETS.idToken,
        apiKey: SECRETS.apiKey,
        expiresAt: "2026-11-01T00:00:00Z",
        lastRefreshAt: "2026-10-01T00:00:00Z",
        providerSpecificData: {
          profileArn: "arn:aws:iam::1:user/x", // not a secret — must survive
          accountId: "acct-1",                  // not a secret — must survive
          copilotToken: SECRETS.copilotToken,
          mimoPassToken: SECRETS.mimoPassToken,
          sessionToken: SECRETS.sessionToken,
          accessKeyId: SECRETS.accessKeyId,
        },
      },
    ],
    providerNodes: [{ id: "n1", type: "openai-compatible", name: "local", baseUrl: "http://127.0.0.1:1/v1" }],
    proxyPools: [{ id: "p1", name: "corp", proxyUrl: "http://user:PROXY-PASS-nnnnnnnnn@proxy.example:8080", noProxy: "" }],
    apiKeys: [{ id: "k1", key: SECRETS.routerKey, name: "laptop", isActive: true }],
    combos: [{ id: "cb1", name: "fast", models: ["ca/composer-2.5"] }],
    modelAliases: { ca: "cursor-acp" },
    customModels: [{ providerAlias: "fixup", id: "m1", type: "llm" }],
    mitmAlias: {},
    pricing: {},
    disabledModels: { ca: ["grok-4.7"] },
  };
}

/** Every secret value, for a value-level scan. */
function secretValues() {
  const values = new Set(Object.values(SECRETS));
  values.add("HEADER-SECRET-mmmmmmmmmm");
  values.add("PROXY-PASS-nnnnnnnnn");
  return [...values];
}

describe("a config export", () => {
  const envelope = buildTransfer(rawPayload(), { mode: "config", sourceVersion: "0.5.99" });
  const serialized = JSON.stringify(envelope);

  it("contains no credential value anywhere in the file", () => {
    for (const value of secretValues()) {
      expect(serialized, `config export leaked ${value.slice(0, 24)}…`).not.toContain(value);
    }
  });

  it("carries no router key", () => {
    expect(envelope.payload.apiKeys).toEqual([]);
    expect(serialized).not.toContain(SECRETS.routerKey);
  });

  it("keeps the fields that are not credentials", () => {
    // A config export that strips the account id along with the token gives the
    // operator a connection they cannot sign in with and cannot repair.
    const conn = envelope.payload.providerConnections[0];
    expect(conn.name).toBe("Work");
    expect(conn.provider).toBe("claude");
    expect(conn.providerSpecificData.profileArn).toBe("arn:aws:iam::1:user/x");
    expect(conn.providerSpecificData.accountId).toBe("acct-1");
  });

  it("blanks header values but keeps their names, so the shape survives", () => {
    const overrides = envelope.payload.settings.providerOverrides;
    expect(overrides.claude.headers["x-secret"]).toBe("");
    expect(overrides.claude.timeoutMs).toBe(5000);
    expect(envelope.payload.settings.stickyRoundRobinLimit).toBe(3);
  });

  it("strips credentials out of a proxy URL without losing the host", () => {
    const pool = envelope.payload.proxyPools[0];
    expect(pool.proxyUrl).not.toContain("PROXY-PASS");
    expect(pool.proxyUrl).toContain("proxy.example");
    expect(pool.proxyUrl).toContain("8080");
  });

  it("says on its face that it holds no secrets", () => {
    expect(envelope.mode).toBe("config");
    expect(envelope.includesSecrets).toBe(false);
    expect(envelope.formatVersion).toBe(TRANSFER_FORMAT_VERSION);
    expect(envelope.sourceVersion).toBe("0.5.99");
    expect(typeof envelope.exportedAt).toBe("string");
  });

  it("still drops the dashboard password and sudo ciphertext in full mode too", () => {
    // The sudo blob is keyed by this machine's id, so it cannot be decrypted
    // anywhere else — carrying it only makes the file look restorable.
    const full = buildTransfer(rawPayload(), { mode: "full", includeRouterKeys: true });
    expect(full.payload.settings.password).toBeUndefined();
    expect(full.payload.settings.mitmSudoEncrypted).toBeUndefined();
    expect(full.payload.providerConnections[0].accessToken).toBe(SECRETS.accessToken);
    expect(full.payload.apiKeys[0].key).toBe(SECRETS.routerKey);
    expect(full.includesSecrets).toBe(true);
  });

  it("omits router keys from a full export unless they were asked for", () => {
    const full = buildTransfer(rawPayload(), { mode: "full", includeRouterKeys: false });
    expect(full.payload.apiKeys).toHaveLength(1);
    expect(full.payload.apiKeys[0].key).toBeUndefined();
    expect(full.includesRouterKeys).toBe(false);
  });

  it("refuses a mode it does not know", () => {
    expect(() => buildTransfer(rawPayload(), { mode: "everything" })).toThrow(/Unknown transfer mode/);
  });
});

describe("the provider-specific allow list", () => {
  it("drops a field nobody listed, even when it looks harmless", () => {
    // The point of an allow list: unknown means out. A deny list would have let
    // this through and said nothing about the next field to be added.
    const out = sanitizeConnection({
      providerSpecificData: { accountId: "a", somethingNew: "value" },
    }, false);
    expect(out.providerSpecificData.accountId).toBe("a");
    expect(out.providerSpecificData.somethingNew).toBeUndefined();
  });

  it("keeps the whole blob in full mode", () => {
    const out = sanitizeConnection({ providerSpecificData: { sessionToken: "t" } }, true);
    expect(out.providerSpecificData.sessionToken).toBe("t");
  });
});

describe("reading an uploaded file", () => {
  it("accepts its own envelope", () => {
    const envelope = buildTransfer(rawPayload(), { mode: "config" });
    const read = parseTransferFile(JSON.stringify(envelope));
    expect(read.legacy).toBe(false);
    expect(read.payload.providerConnections).toHaveLength(1);
    expect(read.envelope.includesSecrets).toBe(false);
  });

  it("reads a file with no envelope as a FULL transfer, never as a config one", () => {
    // Older exports always carried every secret. Reading one as secret-free is
    // the worst possible reading: the operator would believe it is safe to share.
    const read = parseTransferFile(JSON.stringify(rawPayload()));
    expect(read.legacy).toBe(true);
    expect(read.envelope.mode).toBe("full");
    expect(read.envelope.includesSecrets).toBe(true);
    expect(read.warnings.join(" ")).toMatch(/credentials/i);
  });

  it("warns rather than refusing when the file is from a newer build", () => {
    const envelope = { ...buildTransfer(rawPayload(), { mode: "config" }), formatVersion: 99 };
    const read = parseTransferFile(JSON.stringify(envelope));
    expect(read.warnings.join(" ")).toMatch(/newer version/i);
    expect(read.payload.providerConnections).toHaveLength(1);
  });

  it("says something useful when the file is not a configuration", () => {
    expect(() => parseTransferFile("not json")).toThrow(/not valid JSON/);
    expect(() => parseTransferFile("[]")).toThrow(/configuration object/);
  });
});

describe("token freshness", () => {
  it("drops the timestamps that must not travel with a single-use token", () => {
    // refreshToken rotates on every refresh; presenting a stale one as "needs
    // refreshing" on a machine where it was already spent burns it.
    const out = scrubTokenFreshness({
      refreshToken: "r", expiresAt: "2026-11-01T00:00:00Z", lastRefreshAt: "2026-10-01T00:00:00Z", tokenExpiresAt: "2026-11-01T00:00:00Z",
    });
    expect(out.refreshToken).toBe("r");
    expect(out.expiresAt).toBeUndefined();
    expect(out.tokenExpiresAt).toBeUndefined();
    expect(out.lastRefreshAt).toBeUndefined();
  });
});

describe("pool identity for merge", () => {
  it("treats the same URL and no-proxy list as one pool", () => {
    expect(poolIdentity({ proxyUrl: "http://p:1", noProxy: "" })).toBe(poolIdentity({ proxyUrl: "HTTP://P:1", noProxy: "" }));
  });

  it("keeps different pools apart", () => {
    expect(poolIdentity({ proxyUrl: "http://p:1", noProxy: "" })).not.toBe(poolIdentity({ proxyUrl: "http://q:1", noProxy: "" }));
  });

  it("leaves an unparseable proxy URL alone rather than rewriting it", () => {
    // Better to show the operator what they typed than to silently turn it into
    // a different address.
    expect(stripProxyUrlCredentials("not a url at all")).toBe("not a url at all");
  });
});