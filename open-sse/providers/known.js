// Single source of truth for "is this a provider the router actually knows".
//
// Both providers.js-style lookup paths used to end in a fallback:
// `PROVIDERS[provider] || PROVIDERS.openai`. An unrecognised id therefore kept
// its name and inherited OpenAI's config, so the request went to
// api.openai.com under someone else's name and came back as a 401 about a
// missing API key — which points at the credentials rather than at the real
// problem. Nothing in the engine said the id was unknown, so every entry point
// that skipped the request-level check inherited the silent behaviour.

import REGISTRY from "./registry/index.js";

export const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
export const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";

/** Canonical registry ids, lowercased. Provider ids compare case-insensitively. */
export const KNOWN_PROVIDER_IDS = new Set();

/**
 * Ids plus every alias (including `aliases: []` extras). Callers that reach the
 * engine without going through parseModel — the translator routes, the usage
 * refresh — pass whatever the client sent, so aliases have to be accepted too.
 */
export const KNOWN_PROVIDER_KEYS = new Set();

for (const entry of REGISTRY) {
  const id = String(entry.id).toLowerCase();
  KNOWN_PROVIDER_IDS.add(id);
  KNOWN_PROVIDER_KEYS.add(id);
  if (entry.alias) KNOWN_PROVIDER_KEYS.add(String(entry.alias).toLowerCase());
  for (const alias of entry.aliases || []) KNOWN_PROVIDER_KEYS.add(String(alias).toLowerCase());
}

/**
 * Provider nodes (`openai-compatible-chat-n1`, …) are user-defined and are not
 * in the registry. They legitimately have no PROVIDERS entry: BaseExecutor
 * builds their URL from the node's own baseUrl. Rejecting them would break
 * every custom node, so they are recognised by prefix, matching the branches
 * in services/provider.js.
 */
export function isCompatibleNodeProvider(provider) {
  return (
    typeof provider === "string" &&
    (provider.startsWith(OPENAI_COMPATIBLE_PREFIX) || provider.startsWith(ANTHROPIC_COMPATIBLE_PREFIX))
  );
}

export function isKnownProviderId(provider) {
  return KNOWN_PROVIDER_IDS.has(String(provider || "").toLowerCase());
}

/** Accepts ids, aliases and provider-node ids — everything the engine can route. */
export function isKnownProviderKey(provider) {
  if (isCompatibleNodeProvider(provider)) return true;
  return KNOWN_PROVIDER_KEYS.has(String(provider || "").toLowerCase());
}

export class UnknownProviderError extends Error {
  constructor(provider) {
    super(`Unknown provider: ${provider}`);
    this.name = "UnknownProviderError";
    this.code = "UNKNOWN_PROVIDER";
    this.provider = provider;
  }
}

/**
 * Guard for the two config lookups that used to fall back to OpenAI. Throws
 * rather than substituting another provider's config, so an unrecognised id
 * surfaces at the point where it is still just a string.
 */
export function assertKnownProvider(provider) {
  if (!isKnownProviderKey(provider)) throw new UnknownProviderError(provider);
}