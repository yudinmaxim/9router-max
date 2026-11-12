/**
 * Multi-provider ACP dispatcher shared by the WebSocket dev server and the
 * stdio Zed entry (cli.js).
 *
 * Builds one child factory per configured provider, exposes each provider's
 * cached model catalog as slash-qualified `provider/model` ids, and routes
 * `provider/model` (or `provider::model`) selections to the matching factory,
 * stripping the prefix before talking to the child agent.
 */
import { getExecutor } from "../executors/index.js";
import { createChildFactory } from "./factory.js";
import { readCachedCatalog, getAcpCatalog, CATALOG_TTL_MS } from "../executors/lib/acpCatalog.js";
import { resolveInstalledBin } from "../executors/lib/acpStatus.js";

export const DEFAULT_ACP_PROVIDERS = "codex-acp,opencode-acp";

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ACP_MODEL_ALLOW: comma-separated glob patterns matched against the
// advertised `providerId/modelId` (e.g. "opencode-acp/opencode/*").
// Empty/unset → every catalog model is offered. Filtering only hides
// entries from the picker; an explicit model id still routes normally.
function modelAllowed(modelId, env = process.env) {
  const patterns = (env.ACP_MODEL_ALLOW || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!patterns.length) return true;
  return patterns.some((p) => {
    const re = new RegExp(`^${p.split("*").map(escapeRe).join(".*")}$`);
    return re.test(modelId);
  });
}

export function providerIdsFromEnv(env = process.env) {
  return (env.ACP_PROVIDERS || DEFAULT_ACP_PROVIDERS)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function createAcpProviders({ providerIds = providerIdsFromEnv(), log = () => {} } = {}) {
  const factories = new Map();
  const specs = new Map();
  for (const providerId of providerIds) {
    const executor = getExecutor(providerId);
    if (!executor?.acp) {
      log("warn", `skip ${providerId}: executor has no ACP spec`);
      continue;
    }
    specs.set(providerId, executor.acp);
    factories.set(providerId, createChildFactory({ providerId, spec: executor.acp, log }));
  }
  if (!factories.size) throw new Error("no usable ACP providers configured");

  // Stale-while-revalidate: the picker always serves the on-disk cache
  // (even ancient — a missing catalog is worse than an outdated one), and
  // entries older than CATALOG_TTL_MS trigger a background probe that
  // rewrites the cache for the next read. One probe per provider at a time.
  const refreshing = new Set();
  function maybeRefreshCatalog(providerId) {
    if (refreshing.has(providerId)) return;
    const spec = specs.get(providerId);
    const bin = spec && resolveInstalledBin(spec);
    if (!bin) return;
    refreshing.add(providerId);
    const extraEnv = typeof spec.env === "function" ? spec.env() : spec.env || {};
    getAcpCatalog(providerId, spec, bin, extraEnv)
      .catch((err) => log("warn", `catalog refresh ${providerId} failed: ${err?.message || err}`))
      .finally(() => refreshing.delete(providerId));
  }

  const defaultProvider = providerIds.find((id) => factories.has(id));

  function splitModelSelector(model) {
    if (!model || model === "default") return { providerId: null, childModel: "default" };
    const sep = model.includes("::") ? "::" : model.includes("/") ? "/" : null;
    if (!sep) {
      return factories.has(model)
        ? { providerId: model, childModel: "default" }
        : { providerId: null, childModel: model };
    }
    const head = model.slice(0, model.indexOf(sep));
    if (!factories.has(head)) return { providerId: null, childModel: model };
    return { providerId: head, childModel: model.slice(head.length + sep.length) || "default" };
  }

  async function openChild({ cwd, mcpServers, model = "default", resumeSessionId = null }) {
    const { providerId, childModel } = splitModelSelector(model);
    const target = providerId || defaultProvider;
    const factory = factories.get(target);
    if (!factory) throw new Error(`no ACP factory for provider ${target}`);
    const child = await factory.openChild({ cwd, mcpServers, model: childModel, resumeSessionId });
    log("info", `openChild routed ${model || "default"} → ${target} childModel=${childModel} session=${child?.sessionId || "?"} resumed=${!!child?.resumed}`);
    return child;
  }

  function modelCatalog() {
    const out = [];
    for (const providerId of factories.keys()) {
      const cached = readCachedCatalog(providerId);
      if (!cached || Date.now() - (cached.fetchedAt || 0) > CATALOG_TTL_MS) {
        maybeRefreshCatalog(providerId);
      }
      const models = cached?.models || [];
      const before = out.length;
      if (models.length) {
        for (const m of models) {
          const modelId = `${providerId}/${m.id}`;
          if (!modelAllowed(modelId)) continue;
          out.push({ modelId, name: `${providerId}: ${m.name || m.id}` });
        }
      }
      if (out.length === before) {
        out.push({ modelId: providerId, name: `${providerId} (default model)` });
      }
    }
    return out;
  }

  return { openChild, modelCatalog, providerIds: [...factories.keys()] };
}
