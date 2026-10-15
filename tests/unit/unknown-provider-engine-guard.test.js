// Engine-level guard against the silent OpenAI fallback.
//
// The request-level check in src/sse/services/model.js only covers the chat
// route. Every other caller reaches getExecutor / getProviderConfig directly —
// the translator routes, the usage refresh, the image and embedding cores — and
// those used to end in `PROVIDERS[provider] || PROVIDERS.openai`. An
// unrecognised id therefore kept its name, inherited OpenAI's transport and
// went to api.openai.com, answering with a 401 about a missing API key.
//
// The guard must be narrow in exactly one direction: rejecting provider nodes
// would break every custom node, because those have no registry entry by design
// and take OpenAI's transport as their default config.
import { describe, it, expect } from "vitest";
import {
  assertKnownProvider,
  isCompatibleNodeProvider,
  isKnownProviderId,
  isKnownProviderKey,
  KNOWN_PROVIDER_IDS,
  KNOWN_PROVIDER_KEYS,
  UnknownProviderError,
} from "../../open-sse/providers/known.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { getTargetFormat } from "../../open-sse/services/provider.js";

describe("provider guard — what is accepted", () => {
  it("accepts every registry id", () => {
    for (const id of KNOWN_PROVIDER_IDS) {
      expect(() => assertKnownProvider(id)).not.toThrow();
    }
  });

  it("accepts aliases, which callers may pass un-resolved", () => {
    for (const key of KNOWN_PROVIDER_KEYS) {
      expect(() => assertKnownProvider(key)).not.toThrow();
    }
    expect(isKnownProviderKey("ca")).toBe(true);
    expect(isKnownProviderKey("oacp")).toBe(true);
    expect(isKnownProviderKey("dv")).toBe(true);
  });

  it("matches ids case-insensitively, like the rest of the router", () => {
    expect(isKnownProviderId("OpenAI")).toBe(true);
    expect(isKnownProviderKey("OpenAI")).toBe(true);
    expect(() => assertKnownProvider("OPENAI")).not.toThrow();
  });

  it("accepts provider nodes by prefix and gives them a working config", () => {
    for (const nodeId of ["openai-compatible-chat-n1", "anthropic-compatible-official"]) {
      expect(isCompatibleNodeProvider(nodeId)).toBe(true);
      expect(isKnownProviderId(nodeId)).toBe(false);
      const executor = new DefaultExecutor(nodeId);
      expect(executor.config).toBeDefined();
      expect(executor.provider).toBe(nodeId);
    }
  });

  it("is case-sensitive about node prefixes, matching the branches they feed", () => {
    expect(isCompatibleNodeProvider("OpenAI-Compatible-x")).toBe(false);
  });
});

describe("provider guard — what is rejected", () => {
  const unknown = [
    ["opencode", "removed in 3.7 — its requests used to reach api.openai.com"],
    ["cursor", "removed in 3.7"],
    ["выдуманный", "never existed"],
    ["", "empty id"],
    [null, "null id"],
  ];

  for (const [id, why] of unknown) {
    it(`rejects ${JSON.stringify(id)} (${why})`, () => {
      expect(() => assertKnownProvider(id)).toThrow(UnknownProviderError);
      try {
        assertKnownProvider(id);
      } catch (err) {
        expect(err.code).toBe("UNKNOWN_PROVIDER");
        expect(err.message).toMatch(/Unknown provider/);
      }
    });
  }

  it("stops DefaultExecutor from building a client for an unknown id", () => {
    expect(() => new DefaultExecutor("opencode")).toThrow(UnknownProviderError);
    expect(() => new DefaultExecutor("opencode")).toThrow(/Unknown provider: opencode/);
  });

  it("stops getProviderConfig from handing out OpenAI's config", () => {
    // getTargetFormat reaches getProviderConfig, which used to end in the
    // fallback. The translator routes call it with a raw client-supplied id.
    expect(() => getTargetFormat("opencode")).toThrow(UnknownProviderError);
    expect(() => getTargetFormat("выдуманный")).toThrow(UnknownProviderError);
  });

  it("still resolves a real provider and a node through getTargetFormat", () => {
    expect(getTargetFormat("openai")).toBe("openai");
    expect(getTargetFormat("anthropic-compatible-official")).toBe("claude");
    expect(getTargetFormat("openai-compatible-chat-n1")).toBe("openai");
  });
});