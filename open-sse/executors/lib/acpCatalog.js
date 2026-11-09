/**
 * Model / option catalog discovery for ACP agents.
 *
 * Every ACP agent advertises what it can do in the `configOptions` of its
 * `session/new` response — the model list, and usually a few knobs the agent
 * itself exposes (Codex: access mode, collaboration mode, reasoning level).
 * That is the only honest source: a static list in the registry goes stale the
 * next time the CLI updates, and an empty list makes the provider invisible to
 * clients that only read `/v1/models`.
 *
 * Probing costs a process spawn, so the result is cached on disk under the
 * agent's data dir and re-read by the model catalog. The dashboard's "Sync"
 * button forces a refresh; the hot path never spawns anything.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { acpAgentStateDir } from "./acpAdapter.js";
import { isSelfRouted } from "./acpBase.js";

const PROBE_TIMEOUT_MS = 20000;
const PROBE_ID_INIT = 1;
const PROBE_ID_SESSION = 2;
const PROBE_CLIENT = { name: "9router", version: "catalog-probe" };

/** Catalog older than this is re-probed when someone asks for a live read. */
export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

function catalogPath(providerId) {
  const dir = acpAgentStateDir(providerId);
  return dir ? path.join(dir, "catalog.json") : null;
}

/**
 * Cached catalog, or null when there is none / it is unreadable / stale.
 * Never throws: discovery must degrade to "no catalog", not to a 500.
 */
export function readCachedCatalog(providerId, { maxAgeMs = Infinity } = {}) {
  const file = catalogPath(providerId);
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw?.fetchedAt || Date.now() - raw.fetchedAt > maxAgeMs) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeCachedCatalog(providerId, catalog) {
  const file = catalogPath(providerId);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...catalog, fetchedAt: Date.now() }, null, 2));
  } catch {
    /* a missing cache only means the next read probes again */
  }
}

/**
 * Normalize one `configOptions` entry.
 *
 * Agents disagree on shape: opencode reports the model as the option whose
 * `id === "model"`, Codex nests mode/collaboration alongside it, cursor
 * returns a flat `availableModels` list. Both are folded into the same
 * `{ id, category, currentValue, options[] }` record.
 */
function normalizeOption(opt) {
  const contextWindow = Number(opt.contextWindow ?? opt.context_window ?? opt.limits?.contextWindow ?? opt.limits?.context_window);
  return {
    id: opt.id,
    category: opt.category || opt.id,
    name: opt.name || opt.id,
    description: opt.description || null,
    currentValue: opt.currentValue ?? null,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
    options: (opt.options || []).map((o) => {
      if (typeof o === "string") return { value: o, name: o, description: null };
      const optionContextWindow = Number(o.contextWindow ?? o.context_window ?? o.limits?.contextWindow ?? o.limits?.context_window);
      return {
        value: o.value,
        name: o.name || o.value,
        description: o.description || null,
        ...(Number.isFinite(optionContextWindow) && optionContextWindow > 0 ? { contextWindow: optionContextWindow } : {}),
      };
    }),
  };
}

/**
 * Spawn the agent, complete `initialize` + `session/new`, and read back what it
 * offers. Mirrors what the executor does on a real request, minus the prompt.
 *
 * @returns {Promise<{models: object[], options: object[], sessionId: string|null}>}
 */
export function probeAcpCatalog(bin, spec, extraEnv = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  const args = spec.adapter ? [] : spec.args || ["acp"];

  return new Promise((resolve, reject) => {
    let child = null;
    let settled = false;
    let stdout = "";
    let stderr = "";

    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      fn(value);
    };

    const timer = setTimeout(() => {
      done(reject, new Error(`agent did not answer within ${timeoutMs}ms${stderr.trim() ? `: ${stderr.trim().slice(-200)}` : ""}`));
    }, timeoutMs);

    const send = (id, method, params) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);

    try {
      const childEnv = { ...process.env, ...extraEnv };
      // Router NODE_OPTIONS may point at alias-loader.mjs in project root.
      // Standalone ACP adapter must not inherit that loader.
      delete childEnv.NODE_OPTIONS;
      child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: childEnv,
        cwd: process.env.HOME || process.cwd(),
      });
    } catch (error) {
      done(reject, error);
      return;
    }

    child.on("error", (error) => done(reject, error));
    child.stderr.on("data", (c) => {
      stderr += c.toString();
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // partial frame
        }
        if (msg.id === PROBE_ID_INIT) {
          if (msg.error) {
            done(reject, new Error(msg.error.message || "initialize rejected"));
            return;
          }
          send(PROBE_ID_SESSION, "session/new", { cwd: process.env.HOME || process.cwd(), mcpServers: [] });
          continue;
        }
        if (msg.id === PROBE_ID_SESSION) {
          if (msg.error) {
            done(reject, new Error(msg.error.message || "session/new rejected"));
            return;
          }
          const result = msg.result || {};
          const options = (result.configOptions || []).map(normalizeOption).filter((o) => o.options.length);
          // Screen out ids that route back into this gateway — users do
          // configure their CLIs that way (omp's `nine-router/...` entries),
          // and publishing them would loop agent → router → agent.
          for (const opt of options) {
            if (opt.category === "model" || opt.id === "model") {
              opt.options = opt.options.filter((o) => !isSelfRouted(o.value));
            }
          }
          const modelOption = options.find((o) => o.category === "model" || o.id === "model");
          // The model list is the model option's values. An agent that instead
          // returns a flat `availableModels` (cursor) lands here too.
          const models = (modelOption?.options || (result.models || result.availableModels || []).map((m) =>
            typeof m === "string" ? { value: m, name: m } : {
        value: m.modelId || m.id,
        name: m.name || m.modelId || m.id,
        ...(Number.isFinite(Number(m.contextWindow ?? m.context_window ?? m.limits?.contextWindow ?? m.limits?.context_window))
          ? { contextWindow: Number(m.contextWindow ?? m.context_window ?? m.limits?.contextWindow ?? m.limits?.context_window) }
          : {}),
      }
          )).map((m) => ({
            id: m.value,
            name: m.name || m.value,
            description: m.description || null,
            current: m.value === modelOption?.currentValue,
          })).filter((m) => !isSelfRouted(m.id));
          done(resolve, { models, options, sessionId: result.sessionId || null });
          return;
        }
      }
    });

    child.stdin.on("error", () => {
      /* the close/error handler reports it */
    });

    send(PROBE_ID_INIT, "initialize", { protocolVersion: 1, clientInfo: PROBE_CLIENT, capabilities: {} });
  });
}

/**
 * Cached catalog when fresh enough, otherwise a live probe.
 * `force: true` always probes (the dashboard's Sync button).
 */
export async function getAcpCatalog(providerId, spec, bin, extraEnv = {}, { force = false, maxAgeMs = CATALOG_TTL_MS } = {}) {
  if (!force) {
    const cached = readCachedCatalog(providerId, { maxAgeMs });
    if (cached) return { ...cached, source: "cache" };
  }
  const catalog = await probeAcpCatalog(bin, spec, extraEnv);
  writeCachedCatalog(providerId, catalog);
  return { ...catalog, fetchedAt: Date.now(), source: "probe" };
}

/** Drop the cached catalog — after an agent update, or when it stops working. */
export function clearAcpCatalog(providerId) {
  const file = catalogPath(providerId);
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    /* nothing to clear */
  }
}