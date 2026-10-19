/**
 * Readiness probe for ACP agents.
 *
 * The providers page used to print a green "Ready" for every `noAuth` provider,
 * which covers every ACP agent — the badge was decorative, not a measurement.
 * An agent whose CLI was never installed looked identical to one that had just
 * answered a request. This module produces the real answer instead, in two tiers:
 *
 *   cheap (default) — resolve the agent binary through the same lookup
 *     `AcpAgentExecutor` uses at request time. Answers "is it installed",
 *     costs a few `stat()` calls, safe to poll.
 *
 *   deep (`?probe=1`) — spawn the agent and complete the ACP `initialize`
 *     handshake. Answers "does it actually answer", which is what separates an
 *     installed-but-not-logged-in CLI from a working one. Costs a process
 *     spawn, so it stays opt-in and is cached briefly.
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
import { getAdapterInstallInfo, resolveAcpAdapterBin } from "./acpAdapter.js";

/** Cheap status is stable for a while (installs don't appear mid-poll). */
export const ACP_CHEAP_TTL_MS = 30000;
/** Deep status re-runs often enough that a login/logout shows up promptly. */
export const ACP_DEEP_TTL_MS = 30000;
/** An agent that hasn't answered `initialize` by then is not usable. */
export const ACP_HANDSHAKE_TIMEOUT_MS = 8000;

/** JSON-RPC request id for the probe handshake. Arbitrary, just unique. */
const PROBE_ID = 1;
const PROBE_CLIENT = { name: "9router", version: "probe" };

// key: `${providerId}:${deep ? "deep" : "cheap"}` → { at, value }
const cache = new Map();

/** Statuses: installed · ready · unreachable · missing · unknown */
export const ACP_STATUS = {
  READY: "ready",
  INSTALLED: "installed",
  UNREACHABLE: "unreachable",
  MISSING: "missing",
  UNKNOWN: "unknown",
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

  const resolved = resolveAgentBin(spec);
  try {
    if (fs.statSync(resolved).isFile()) return resolved;
  } catch {
    /* not a file — fall through to PATH */
  }
  return whichOnPath(resolved);
}

/**
 * Complete one ACP `initialize` handshake against a freshly spawned agent.
 *
 * Mirrors the handshake the executor performs (see acpBase.js) but stops right
 * after the response: enough to prove the agent starts and speaks ACP, without
 * creating a session or burning a model turn.
 */
function acpHandshake(bin, args, timeoutMs, extraEnv = {}) {
  return new Promise((resolve) => {
    let child = null;
    let settled = false;
    let stdout = "";
    let stderr = "";

    const done = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        /* already gone */
      }
      resolve(result);
    };

    const tail = () => stderr.trim().split("\n").slice(-2).join(" ").slice(0, 300) || null;

    const timer = setTimeout(() => {
      done({ ok: false, error: `no answer within ${timeoutMs}ms`, stderr: tail() });
    }, timeoutMs);

    try {
      // Same env the executor would give it — an adapter that reads CODEX_PATH
      // must be probed against the same codex it would actually drive.
      child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...extraEnv },
      });
    } catch (error) {
      done({ ok: false, error: error.message, stderr: null });
      return;
    }

    child.on("error", (error) => {
      done({
        ok: false,
        error: error.code === "ENOENT" ? `${bin} not found` : error.message,
        stderr: tail(),
      });
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // partial frame — keep buffering
        }
        if (msg.id !== PROBE_ID) continue;
        if (msg.error) {
          done({
            ok: false,
            error: msg.error.message || "handshake rejected",
            stderr: tail(),
          });
        } else {
          done({ ok: true, error: null, stderr: null });
        }
        return;
      }
    });

    child.stdin?.on("error", () => {
      /* agent closed stdin before answering — the exit/error handler reports it */
    });

    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: PROBE_ID,
        method: "initialize",
        params: {
          protocolVersion: 1,
          clientInfo: PROBE_CLIENT,
          capabilities: {},
        },
      })}\n`,
    );
  });
}

/**
 * Probe one agent.
 *
 * @param {object} spec           executor spec + `{ providerId }`
 * @param {object} [options]
 * @param {boolean} [options.deep]  spawn and handshake instead of only resolving
 * @returns {Promise<{providerId:string,status:string,bin:string,resolvedPath:string|null,detail:string|null,checkedAt:number}>}
 */
export async function probeAcpAgent(spec, { deep = false } = {}) {
  const providerId = spec.providerId;
  const key = `${providerId}:${deep ? "deep" : "cheap"}`;
  const cached = cache.get(key);
  const ttl = deep ? ACP_DEEP_TTL_MS : ACP_CHEAP_TTL_MS;
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
  let value;

  if (!bin) {
    value = {
      providerId,
      status: ACP_STATUS.MISSING,
      bin: spec.exe,
      resolvedPath: null,
      detail: spec.installHint || null,
      setup,
      checkedAt: Date.now(),
    };
  } else if (!deep) {
    value = {
      providerId,
      status: ACP_STATUS.INSTALLED,
      bin: spec.exe,
      resolvedPath: bin,
      detail: null,
      setup,
      checkedAt: Date.now(),
    };
  } else {
    // An adapter-backed agent is spawned bare (`args: []`) — the bridge itself
    // speaks ACP, there is no `acp` subcommand to append.
    const result = await acpHandshake(
      bin,
      spec.adapter ? [] : spec.args || ["acp"],
      ACP_HANDSHAKE_TIMEOUT_MS,
      typeof spec.env === "function" ? spec.env() : spec.env || {}
    );
    value = {
      providerId,
      status: result.ok ? ACP_STATUS.READY : ACP_STATUS.UNREACHABLE,
      bin: spec.exe,
      resolvedPath: bin,
      detail: result.ok ? null : [result.error, result.stderr].filter(Boolean).join(" — ") || null,
      setup,
      checkedAt: Date.now(),
    };
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Drop cached results — used after an install, so the next read is fresh. */
export function clearAcpStatusCache() {
  cache.clear();
}