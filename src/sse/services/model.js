// Re-export from open-sse with localDb integration
import { getModelAliases, getComboByName, getProviderNodes } from "@/lib/localDb";
import { parseModel as parseModelCore, resolveModelAliasFromMap, getModelInfoCore } from "open-sse/services/model.js";
import REGISTRY from "open-sse/providers/registry/index.js";

// Local provider alias overrides (HMR-friendly, applied on top of open-sse map)
const LOCAL_PROVIDER_ALIASES = {
  xmtp: "xiaomi-tokenplan",
  "xiaomi-tokenplan": "xiaomi-tokenplan",
};

const RESERVED_PROVIDER_PREFIXES = new Set(Object.keys(LOCAL_PROVIDER_ALIASES));
// Provider ids match case-insensitively everywhere else in the router (key
// allow-lists are stored and compared lowercased), so this set is lowercased
// too. A case-sensitive check here silently dropped `OpenAI/gpt-5.5` from a
// restricted key's allow-list, which reads as "the model vanished".
const KNOWN_PROVIDER_IDS = new Set();
for (const entry of REGISTRY) {
  KNOWN_PROVIDER_IDS.add(String(entry.id).toLowerCase());
  RESERVED_PROVIDER_PREFIXES.add(entry.id);
  if (entry.alias) RESERVED_PROVIDER_PREFIXES.add(entry.alias);
  for (const alias of entry.aliases || []) RESERVED_PROVIDER_PREFIXES.add(alias);
}

export function parseModel(modelStr) {
  const parsed = parseModelCore(modelStr);
  if (parsed?.providerAlias && LOCAL_PROVIDER_ALIASES[parsed.providerAlias]) {
    return { ...parsed, provider: LOCAL_PROVIDER_ALIASES[parsed.providerAlias] };
  }
  return parsed;
}

/**
 * Resolve model alias from localDb
 */
export async function resolveModelAlias(alias) {
  const aliases = await getModelAliases();
  return resolveModelAliasFromMap(alias, aliases);
}

/**
 * Get full model info (parse or resolve)
 */
export async function getModelInfo(modelStr) {
  const parsed = parseModel(modelStr);

  if (!parsed.isAlias) {
    // Provider-node prefixes are user-defined. They must not override built-in
    // provider ids/aliases such as `cf`, `cloudflare-ai`, `openai`, or `hf`.
    //
    // The node lookups stay behind that guard on purpose: a reserved prefix can
    // never match a node, and fetching eagerly makes every caller depend on
    // getProviderNodes existing — which several partial localDb fixtures do not
    // provide, turning a valid request into a crash.
    let nodeLists = null;
    if (!RESERVED_PROVIDER_PREFIXES.has(parsed.providerAlias)) {
      nodeLists = await Promise.all([
        getProviderNodes({ type: "openai-compatible" }),
        getProviderNodes({ type: "anthropic-compatible" }),
        getProviderNodes({ type: "custom-embedding" }),
      ]);
      for (const nodes of nodeLists) {
        const matched = nodes.find((node) => node.prefix === parsed.providerAlias);
        if (matched) {
          return { provider: matched.id, model: parsed.model };
        }
      }
    }
    // Neither a registered provider nor a provider node. DefaultExecutor would
    // still take this id and silently borrow PROVIDERS.openai's config, so the
    // request would be dispatched to api.openai.com under the wrong provider
    // name and come back as a 401 about a missing key — which points at the
    // credentials instead of at the real problem. Report it here, where the
    // prefix is still known to be unknown. Returning null provider is the same
    // signal the combo path uses below; the caller distinguishes the two.
    //
    // A node is addressable by its id as well as by its prefix — callers do use
    // `openai-compatible-<node>/model` — so the ids count as known too.
    const providerKey = String(parsed.provider).toLowerCase();
    const isNodeId = nodeLists?.some((nodes) => nodes.some((node) => String(node.id).toLowerCase() === providerKey));
    if (!KNOWN_PROVIDER_IDS.has(providerKey) && !isNodeId) {
      return { provider: null, model: parsed.model, unknownProvider: parsed.providerAlias };
    }
    return {
      provider: parsed.provider,
      model: parsed.model
    };
  }

  // Check if this is a combo name before resolving as alias
  // This prevents combo names from being incorrectly routed to providers
  const combo = await getComboByName(parsed.model);
  if (combo) {
    // Return null provider to signal this should be handled as combo
    // The caller (handleChat) will detect this and handle it as combo
    return { provider: null, model: parsed.model };
  }

  return getModelInfoCore(modelStr, getModelAliases);
}

/**
 * Check if model is a combo and get models list
 * @returns {Promise<string[]|null>} Array of models or null if not a combo
 */
export async function getComboModels(modelStr) {
  // Only check if it's not in provider/model format
  if (modelStr.includes("/")) return null;

  const combo = await getComboByName(modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}
