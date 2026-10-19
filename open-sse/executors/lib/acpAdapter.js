/**
 * On-demand provisioning for ACP adapter processes.
 *
 * Most agents speak ACP from their own CLI (`opencode acp`, `cursor-agent acp`,
 * `omp acp`). Codex does not — it ships `app-server`, so `codex acp` is parsed
 * as a prompt for the interactive TUI and dies with "stdin is not a terminal".
 * ACP support for Codex comes from a bridge package instead, and requiring the
 * user to install it by hand is exactly the kind of manual setup this router
 * exists to remove.
 *
 * So the adapter is resolved, and installed if needed, the same way the tray and
 * the SQLite engine are: into <DATA_DIR>/acp-agents/<slug>, user-writable, so a
 * global `npm i -g 9router` never has to replace files under a locked install
 * directory.
 *
 * Resolution order:
 *   1. <ENV_VAR>            — explicit override, always wins
 *   2. ~/.local/bin         — a global install
 *   3. <DATA_DIR>/acp-agents/<slug>/node_modules/.bin — ours (installed here)
 *   4. PATH                 — last resort
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "@/lib/dataDir.js";
import {
  ACP_ADAPTERS,
  ACP_ADAPTER_INSTALL_TIMEOUT_MS,
  ACP_ADAPTER_RETRY_COOLDOWN_MS,
} from "../../config/runtimeConfig.js";

const AGENTS_DIR = path.join(DATA_DIR, "acp-agents");
const INSTALL_LOG = path.join(AGENTS_DIR, "install.log");

/** providerId → in-flight install promise, so concurrent requests install once. */
const installing = new Map();
/** providerId → epoch ms until which installs are skipped after a failure. */
const cooldownUntil = new Map();

function adapterDef(providerId) {
  return ACP_ADAPTERS[providerId] || null;
}

function adapterDir(providerId) {
  const def = adapterDef(providerId);
  return def ? path.join(AGENTS_DIR, def.slug) : null;
}

/**
 * Per-agent data dir: holds the adapter install and the discovery results that
 * sit next to it.
 */
export function acpAgentDir(providerId) {
  return adapterDir(providerId);
}

/**
 * Per-agent state dir for any ACP provider, adapter-backed or not.
 *
 * cursor / opencode / omp have no ACP_ADAPTERS entry, so their measured verdict
 * and model catalog need a home that does not depend on one. Registry ids are
 * already filesystem-safe; the sanitize is belt-and-braces.
 */
export function acpAgentStateDir(providerId) {
  const safe = String(providerId || "").replace(/[^a-z0-9._-]/gi, "_");
  return safe ? path.join(AGENTS_DIR, safe) : null;
}

function installedBin(providerId) {
  const def = adapterDef(providerId);
  const dir = adapterDir(providerId);
  if (!def || !dir) return null;
  const exe = process.platform === "win32" ? `${def.bin}.cmd` : def.bin;
  const candidate = path.join(dir, "node_modules", ".bin", exe);
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

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
 * Absolute path of the adapter binary, or null when it is not available yet.
 * Never installs — call ensureAcpAdapter() for that.
 */
export function resolveAcpAdapterBin(providerId) {
  const def = adapterDef(providerId);
  if (!def) return null;

  const envBin = process.env[def.envVar]?.trim();
  if (envBin) return envBin;

  return (
    installedBin(providerId) ||
    whichOnPath(process.platform === "win32" ? `${def.bin}.cmd` : def.bin)
  );
}

export function getAdapterInstallInfo(providerId) {
  const def = adapterDef(providerId);
  if (!def) return { supported: false, installed: false, path: null, version: null };
  const bin = resolveAcpAdapterBin(providerId);
  let version = null;
  if (bin && bin.includes("node_modules")) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(adapterDir(providerId), "node_modules", def.package, "package.json"), "utf8")
      );
      version = pkg.version || null;
    } catch {
      /* not ours, or unreadable */
    }
  }
  return {
    supported: true,
    installed: Boolean(bin),
    path: bin,
    version,
    dir: adapterDir(providerId),
    package: def.package,
    installing: installing.has(providerId),
    cooldownUntil: cooldownUntil.get(providerId) || 0,
  };
}

function findNpm() {
  for (const [cmd, args] of [
    ["npm", []],
    ["npm.cmd", []],
  ]) {
    const found = whichOnPath(cmd);
    if (found) return { cmd: found, args };
  }
  return null;
}

function appendLog(line) {
  try {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    fs.appendFileSync(INSTALL_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break setup */
  }
}

function runInstall(providerId) {
  const def = adapterDef(providerId);
  const dir = adapterDir(providerId);
  const npm = findNpm();
  if (!def || !npm) return Promise.resolve(false);

  fs.mkdirSync(dir, { recursive: true });
  const pkgPath = path.join(dir, "package.json");
  if (!fs.existsSync(pkgPath)) {
    // Minimal manifest so npm treats the dir as a project root, exactly like
    // the runtime dir the tray and SQLite engine use.
    fs.writeFileSync(
      pkgPath,
      JSON.stringify(
        { name: `9router-acp-agent-${def.slug}`, version: "1.0.0", private: true },
        null,
        2
      )
    );
  }

  appendLog(`installing ${def.package} into ${dir}`);
  console.log(`⏳ Installing ACP adapter ${def.package} (first run)...`);

  return new Promise((resolve) => {
    const child = spawn(npm.cmd, [...npm.args, "install", "--no-save", "--no-audit", "--no-fund", def.package], {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      // Packaged/launchd environments often miss the Node bin dirs.
      env: { ...process.env, PATH: `${path.dirname(npm.cmd)}${path.delimiter}${process.env.PATH || ""}` },
    });

    let stderr = "";
    child.stderr?.on("data", (c) => {
      stderr += c.toString();
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already dead */
      }
      appendLog(`install timeout for ${def.package}`);
      resolve(false);
    }, ACP_ADAPTER_INSTALL_TIMEOUT_MS);

    child.on("error", (error) => {
      clearTimeout(timer);
      appendLog(`install spawn error: ${error.message}`);
      resolve(false);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && Boolean(installedBin(providerId));
      appendLog(`${ok ? "installed" : "failed"} ${def.package} (exit ${code})`);
      if (!ok) {
        console.warn(`⚠️  ACP adapter install failed: ${stderr.trim().split("\n").slice(-2).join(" ")}`);
        cooldownUntil.set(providerId, Date.now() + ACP_ADAPTER_RETRY_COOLDOWN_MS);
      }
      resolve(ok);
    });
  });
}

/**
 * Resolve the adapter, installing it on first use.
 *
 * Concurrent callers share one install. A recent failure parks further attempts
 * behind a cooldown, so an offline machine doesn't pay the npm timeout on every
 * request that touches this provider.
 *
 * @returns {Promise<string|null>} adapter binary path, or null when unavailable
 */
export async function ensureAcpAdapter(providerId) {
  const def = adapterDef(providerId);
  if (!def) return null;

  const existing = resolveAcpAdapterBin(providerId);
  if (existing) return existing;

  if ((cooldownUntil.get(providerId) || 0) > Date.now()) return null;

  if (!installing.has(providerId)) {
    const p = runInstall(providerId).finally(() => installing.delete(providerId));
    installing.set(providerId, p);
  }

  const ok = await installing.get(providerId);
  return ok ? resolveAcpAdapterBin(providerId) : null;
}

/** Explicit repair path for the dashboard's "Set up" button. Bypasses cooldown. */
export function installAcpAdapter(providerId) {
  const def = adapterDef(providerId);
  if (!def) return Promise.resolve(false);
  cooldownUntil.delete(providerId);
  if (!installing.has(providerId)) {
    const p = runInstall(providerId).finally(() => installing.delete(providerId));
    installing.set(providerId, p);
  }
  return installing.get(providerId);
}

/** Test seam — drops failure cooldowns so a retry can be attempted again. */
export function __resetAcpAdapterState() {
  installing.clear();
  cooldownUntil.clear();
}