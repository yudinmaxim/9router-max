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
import { readCachedCatalog } from "../executors/lib/acpCatalog.js";

export const DEFAULT_ACP_PROVIDERS = "codex-acp,opencode-acp";

export function providerIdsFromEnv(env = process.env) {
  return (env.ACP_PROVIDERS || DEFAULT_ACP_PROVIDERS)
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function createAcpProviders({ providerIds = providerIdsFromEnv(), log = () => {} } = {}) {
  const factories = new Map();
  for (const providerId of providerIds) {
    const executor = getExecutor(providerId);
    if (!executor?.acp) {
      log("warn", `skip ${providerId}: executor has no ACP spec`);
      continue;
    }
    factories.set(providerId, createChildFactory({ providerId, spec: executor.acp, log }));
  }
  if (!factories.size) throw new Error("no usable ACP providers configured");

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
      const models = cached?.models || [];
      if (models.length) {
        for (const m of models) {
          out.push({ modelId: `${providerId}/${m.id}`, name: `${providerId}: ${m.name || m.id}` });
        }
      } else {
        out.push({ modelId: providerId, name: `${providerId} (default model)` });
      }
    }
    return out;
  }

  return { openChild, modelCatalog, providerIds: [...factories.keys()] };
}
