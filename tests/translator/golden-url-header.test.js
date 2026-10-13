// P0 GOLDEN: lock buildUrl + buildHeaders cho mọi provider trên code CŨ.
// Sinh snapshot lần đầu (baseline) → sau refactor chạy lại phải khớp y hệt.
// Mock proxyFetch + uuid-heavy executors KHÔNG cần ở đây vì chỉ gọi buildUrl/buildHeaders (pure).
import { describe, it, expect } from "vitest";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getExecutor, hasSpecializedExecutor } from "../../open-sse/executors/index.js";

// Credentials mẫu cố định (deterministic) — KHÔNG dùng Date.now/random.
const API_KEY_CRED = { apiKey: "sk-test-APIKEY", providerSpecificData: {} };
const OAUTH_CRED = { accessToken: "tok-test-ACCESS", providerSpecificData: {} };
const SPECIAL_CRED = {
  apiKey: "sk-test-APIKEY",
  accessToken: "tok-test-ACCESS",
  providerSpecificData: { accountId: "ACC123", region: "sgp", baseUrl: "https://custom.example.com/v1", orgId: "ORG9" },
};

// Providers whose upstream URL / headers are NOT built by DefaultExecutor must
// be skipped here, because the snapshot would record a code path they never
// take. Those providers are locked separately in dedicated unit tests.
//
// This used to be a hand-written list, and it drifted: providers that gained a
// dedicated executor kept being snapshotted as default ones. So the list is
// now derived, with one explicit exception and a guard test that fails the
// moment a new executor makes the question non-empty again.

// (a) Mechanical: the executor overrides buildUrl or buildHeaders, so it builds
//     its own upstream URL and header set. Read off the prototype chain.
const overridesUrlOrHeaders = (providerId) => {
  const proto = Object.getPrototypeOf(getExecutor(providerId));
  const own = (k) => Object.prototype.hasOwnProperty.call(proto, k);
  return own("buildUrl") || own("buildHeaders");
};

// (b) The ACP executors cannot be detected this way. They inherit buildUrl and
//     buildHeaders from DefaultExecutor and never call either — they spawn the
//     CLI over stdio — so their snapshot entry reduced to "the registry
//     baseUrl string is unchanged", which asserts nothing about how they reach
//     the upstream. Listed here explicitly for that reason.
const BYPASSES_WITHOUT_OVERRIDE = new Set([
  "cursor-acp", "opencode-acp", "omp-acp", "codex-acp",
]);

const isSpecialized = (providerId) =>
  hasSpecializedExecutor(providerId) &&
  (overridesUrlOrHeaders(providerId) || BYPASSES_WITHOUT_OVERRIDE.has(providerId));

// Sanitize header: khử token + field thời gian động để snapshot ổn định.
// X-Mavis-Session-Id là UUID mới ở mỗi lần gọi buildHeaders() (open-sse/executors/default.js:51,
// randomUUID() không memoize, guard "nếu chưa có" là code chết vì không ai set trước).
// Anchor theo tên key chứ không regex UUID: regex sẽ che luôn một id không ổn định thật sự.
const VOLATILE_BY_KEY = {
  "X-Mavis-Session-Id": "<SESSION_ID>",
};

function sanitize(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string" && Object.hasOwn(VOLATILE_BY_KEY, k)) {
      out[k] = VOLATILE_BY_KEY[k];
    } else {
      out[k] = typeof v === "string"
        ? v.replace(/Bearer .+/, "Bearer <TOK>")
            .replace(/sk-test-APIKEY|tok-test-ACCESS/g, "<CRED>")
            .replace(/kimi-\d{10,}/g, "kimi-<TS>")
        : v;
    }
  }
  return out;
}

const providerIds = Object.keys(PROVIDERS).filter((p) => !isSpecialized(p)).sort();

describe("GOLDEN buildUrl (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → url (stream + non-stream)`, () => {
      const ex = new DefaultExecutor(pid);
      const cred = PROVIDERS[pid].noAuth ? {} : SPECIAL_CRED;
      const model = "test-model";
      const snap = {
        stream: safe(() => ex.buildUrl(model, true, 0, cred)),
        nonStream: safe(() => ex.buildUrl(model, false, 0, cred)),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

describe("GOLDEN buildHeaders (default executor providers)", () => {
  for (const pid of providerIds) {
    it(`${pid} → headers (apiKey / oauth)`, () => {
      const ex = new DefaultExecutor(pid);
      const snap = {
        apiKey: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, true))),
        oauth: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : OAUTH_CRED, true))),
        nonStream: safe(() => sanitize(ex.buildHeaders(PROVIDERS[pid].noAuth ? {} : API_KEY_CRED, false))),
      };
      expect(snap).toMatchSnapshot();
    });
  }
});

function safe(fn) {
  try { return fn(); } catch (e) { return `THROW: ${e.message}`; }
}

// Make the classification itself reviewable.
//
// The list used to be hand-written and drifted silently: a provider gained a
// dedicated executor and kept being snapshotted as a default one, recording an
// entry that asserted only "the registry baseUrl string is unchanged". Nothing
// failed, and nothing said so.
//
// Deriving it fixes the mechanism, but a change in coverage is still a change
// someone should see — especially a provider quietly dropping out of the
// golden because its executor started overriding buildUrl. Snapshotting the
// inventory puts that in the diff.
describe("GOLDEN classification", () => {
  it("records which providers bypass the generic URL/header contract", () => {
    const bypasses = [];
    const keeps = [];
    for (const pid of Object.keys(PROVIDERS)) {
      if (!hasSpecializedExecutor(pid)) continue;
      if (overridesUrlOrHeaders(pid)) bypasses.push(`${pid} (overrides)`);
      else if (BYPASSES_WITHOUT_OVERRIDE.has(pid)) bypasses.push(`${pid} (spawns CLI)`);
      else keeps.push(pid);
    }
    expect({ excluded: bypasses.sort(), kept: keeps.sort() }).toMatchSnapshot();
  });
});
