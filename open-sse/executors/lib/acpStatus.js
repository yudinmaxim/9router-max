/**
 * Working state for ACP agents.
 *
 * The providers page used to print a green "Ready" for every `noAuth` provider,
 * which covers every ACP agent — the badge was decorative, not a measurement.
 * An agent whose CLI was never installed looked identical to one that had just
 * answered a request.
 *
 * An ACP agent also has nothing to "connect": no credential row, no login
 * step. So the honest question is not "connected?" but "can it serve a
 * request?", and there are only three lasting answers:
 *
 *   working — it completed an ACP `initialize` handshake
 *   broken  — it is installed but does not answer (expired login, crash, ...)
 *   missing — the CLI itself is not on this machine
 *
 * "Installed" on its own is not one of them. It was the old resting state, and
 * it is indistinguishable from "broken" to anyone who has not clicked a check
 * button — which is exactly how cursor-agent looked fine while refusing every
 * request with "Authentication required". It survives only as `verifying`: a
 * transient shown while the measurement runs, never as an end state.
 *
 * The verdict is measured (spawn + handshake) and persisted per agent, so the
 * providers page is truthful on first paint and across restarts.
 *
 * Config-driven like the rest of the engine: the exe, env override, install
 * paths and install hint all come from the executor spec (see
 * `open-sse/executors/*-acp.js`). Nothing about a specific agent is hardcoded
 * here, so a new `-acp` provider is covered the moment it registers.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveAgentBin } from "./acpBase.js";
import { getAdapterInstallInfo, resolveAcpAdapterBin, acpAgentStateDir } from "./acpAdapter.js";
import { probeAcpCatalog } from "./acpCatalog.js";

/** Cheap status is stable for a while (installs don't appear mid-poll). */
export const ACP_CHEAP_TTL_MS = 30000;
/** A measured verdict stays true this long before it is re-measured. */
export const ACP_VERDICT_TTL_MS = 10 * 60 * 1000;
/** An explicit user-triggered check re-measures regardless of the TTL. */
export const ACP_DEEP_TTL_MS = 30000;
/** How long a "verifying" answer survives before the next poll re-reads. */
export const ACP_VERIFYING_TTL_MS = 2000;
/** An agent that can't start a session within this window is not usable. */
export const ACP_HANDSHAKE_TIMEOUT_MS = 15000;

/** JSON-RPC request id for the probe handshake. Arbitrary, just unique. */
const PROBE_ID = 1;
const PROBE_CLIENT = { name: "9router", version: "probe" };

// key: `${providerId}:${deep ? "deep" : "cheap"}` → { at, value }
const cache = new Map();
// key: providerId → in-flight measurement, so N pollers share one spawn
const inflight = new Map();

/** Statuses: working · broken · missing · verifying */
export const ACP_STATUS = {
  WORKING: "working",
  BROKEN: "broken",
  MISSING: "missing",
  VERIFYING: "verifying",
};

/**
 * Ask PATH directly. `resolveAgentBin` returns the bare exe name when none of
 * its candidates matched — which is still spawnable if PATH can find it, so the
 * bare name cannot be read as "missing" without checking.
 */
function whichOnPath(bin) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      if (fs.statSync(path.join(dir, bin)).isFile()) return path.join(dir, bin);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/**
 * Absolute path of the installed agent binary, or null when it isn't installed.
 *
 * @param {object} spec  executor spec: { exe, envVar, versionsDir, extraDirs, adapter }
 */
export function resolveInstalledBin(spec) {
  // An agent driven through an adapter has no binary of its own to find — the
  // adapter is what gets spawned, so that's what "installed" means for it.
  if (spec.adapter) return resolveAcpAdapterBin(spec.adapter);

  // An executor that resolves its own binary (devin installs to its own
  // layout) is the authority on where it lives — asking anything else would
  // report a binary the router cannot actually spawn.
  const resolved = spec.resolveBin ? spec.resolveBin() : resolveAgentBin(spec);
  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {
    /* not a file — fall through to PATH */
  }
  return whichOnPath(resolved);
}

/**
 * Last measured verdict, persisted next to the agent's adapter so it survives a
 * restart. A verdict older than the TTL is treated as absent — the caller then
 * re-measures instead of reporting a month-old "working".
 */
function readVerdict(providerId) {
  const dir = acpAgentStateDir(providerId);
  if (!dir) return null;
  try {
    const verdict = JSON.parse(fs.readFileSync(path.join(dir, "verdict.json"), "utf8"));
    // Old verdicts may come from probes that inherited router-only NODE_OPTIONS
    // and failed on alias-loader.mjs. Force one fresh probe after that fix.
    if (String(verdict.detail || "").includes("alias-loader.mjs")) return null;
    return Date.now() - (verdict.measuredAt || 0) <= ACP_VERDICT_TTL_MS ? verdict : null;
  } catch {
    return null;
  }
}

function writeVerdict(providerId, verdict) {
  const dir = acpAgentStateDir(providerId);
  if (!dir) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "verdict.json"), JSON.stringify(verdict));
  } catch {
    /* a missing verdict only means the next read measures again */
  }
}

/**
 * Probe one agent.
 *
 * `deep` measures now (spawn + handshake) and stores the verdict. Without it,
 * the stored verdict answers, and an agent that has never been measured is
 * reported as `verifying` while a measurement runs in the background — the
 * caller never waits on a spawn it did not ask for.
 *
 * @param {object} spec           executor spec + `{ providerId }`
 * @param {object} [options]
 * @param {boolean} [options.deep]  measure now instead of reading the verdict
 */
export async function probeAcpAgent(spec, { deep = false } = {}) {
  const providerId = spec.providerId;
  const key = `${providerId}:${deep ? "deep" : "cheap"}`;
  const cached = cache.get(key);
  // A cached "verifying" gets a much shorter life than a settled answer: the
  // measurement it kicked off finishes in seconds, and the next poll has to be
  // able to see that. Caching it for the full cheap TTL left the badge stuck
  // on "Checking…" for 30 seconds after the truth was already known.
  const ttl = deep
    ? ACP_DEEP_TTL_MS
    : cached?.value?.status === ACP_STATUS.VERIFYING
      ? ACP_VERIFYING_TTL_MS
      : ACP_CHEAP_TTL_MS;
  if (cached && Date.now() - cached.at < ttl) return cached.value;

  const bin = resolveInstalledBin(spec);
  // An agent that runs through an adapter has something the user can fix with
  // one click, so the badge says so instead of leaving "Not installed" with no
  // way forward.
  const adapter = spec.adapter ? getAdapterInstallInfo(spec.adapter) : null;
  const setup = adapter?.supported
    ? {
        needed: !adapter.installed,
        providerId,
        package: adapter.package,
        version: adapter.version,
        installing: adapter.installing,
      }
    : null;
  const base = {
    providerId,
    bin: spec.exe,
    resolvedPath: bin,
    setup,
  };
  let value;

  if (!bin) {
    value = {
      ...base,
      status: ACP_STATUS.MISSING,
      detail: spec.installHint || null,
      checkedAt: Date.now(),
    };
  } else if (deep) {
    // An adapter-backed agent is spawned bare (`args: []`) — the bridge itself
    // speaks ACP, there is no `acp` subcommand to append.
    // "Working" must mean the agent can actually start a session, not merely that
    // it speaks the handshake. Those are different: cursor-agent answers
    // `initialize` happily and then refuses `session/new` with "Authentication
    // required", so a handshake-only check reported a broken agent as working.
    // This walks initialize → session/new, which is the same path a real
    // request takes, and it refreshes the model catalog as a side effect.
    const result = await probeAcpCatalog(bin, spec, typeof spec.env === "function" ? spec.env() : spec.env || {}, ACP_HANDSHAKE_TIMEOUT_MS).then(
      (catalog) => ({ ok: true, catalog }),
      (error) => ({ ok: false, error: error.message })
    );
    const verdict = {
      working: result.ok,
      detail: result.ok ? null : result.error,
      measuredAt: Date.now(),
    };
    writeVerdict(providerId, verdict);
    value = {
      ...base,
      status: verdict.working ? ACP_STATUS.WORKING : ACP_STATUS.BROKEN,
      detail: verdict.detail,
      checkedAt: verdict.measuredAt,
    };
    // Refresh the cheap entry as well. A measurement that disagrees with it
    // would otherwise keep being served for the rest of the cheap TTL, and the
    // badge would contradict the check the user just ran.
    cache.set(`${providerId}:cheap`, { at: Date.now(), value });
  } else {
    const verdict = readVerdict(providerId);
    if (verdict) {
      value = {
        ...base,
        status: verdict.working ? ACP_STATUS.WORKING : ACP_STATUS.BROKEN,
        detail: verdict.detail,
        checkedAt: verdict.measuredAt,
      };
    } else {
      // Never measured: say so, and measure in the background so the next poll
      // has the truth. The spawn is shared across pollers.
      value = {
        ...base,
        status: ACP_STATUS.VERIFYING,
        detail: "not checked yet",
        checkedAt: Date.now(),
      };
      if (!inflight.has(providerId)) {
        const p = probeAcpAgent(spec, { deep: true }).finally(() => inflight.delete(providerId));
        inflight.set(providerId, p);
        p.catch(() => {});
      }
    }
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop cached results — used after an install, so the next read is fresh. */
export function clearAcpStatusCache() {
  cache.clear();
}

/**
 * Drop the stored verdict as well. An install changes what gets spawned, so a
 * verdict measured before it is no evidence about what happens after.
 */
export function clearAcpVerdict(providerId) {
  const dir = acpAgentStateDir(providerId);
  if (!dir) return;
  try {
    fs.rmSync(path.join(dir, "verdict.json"), { force: true });
  } catch {
    /* nothing to clear */
  }
}