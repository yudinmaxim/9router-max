/**
 * Reading and editing the host-runner whitelist from inside the container.
 *
 * The whitelist itself is NOT reachable from here. It lives on the host at
 * `~/.9r-host-runner/tools.json`, outside every bind mount, because agents run
 * in this very container as the same uid as the API — anything this process can
 * write, an agent can write too. So the file is protected by being invisible,
 * and the only way to change it is a message the host daemon accepts.
 *
 * That message must be distinguishable from one an agent forges, and uid/paths
 * cannot distinguish them. It is distinguished by a MAC under a key derived
 * from the dashboard password with PBKDF2; the key itself exists only on the
 * host (`~/.9r-host-runner/auth.json`). The password typed here never leaves
 * the request, and the derived key never leaves this function.
 *
 * Read path: the daemon publishes `<out>/config.snapshot.json`, and `out` is
 * mounted read-only, so what the dashboard shows is what the daemon actually
 * loaded — not a copy that could silently diverge.
 */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const SNAPSHOT_NAME = "config.snapshot.json";
export const CONFIG_MESSAGE_SUFFIX = ".config.json";

/** Must match PBKDF2_ITERATIONS in host-runner/daemon.py exactly. */
export const PBKDF2_ITERATIONS = 600_000;

const DEFAULT_IN_DIR = "/var/lib/9r-runner/in";
const DEFAULT_OUT_DIR = "/var/lib/9r-runner/out";
const MAX_CONFIG_TEXT_BYTES = 4_000_000;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Ranges mirror daemon.py's clamping — a value outside them is a bug, not a preference. */
export const LIMITS = Object.freeze({
  maxConcurrent: { min: 1, max: 32 },
  maxPending: { min: 1, max: 1000 },
  maxOutputBytes: { min: 4096, max: 20_000_000 },
  maxTailBytes: { min: 256, max: 1_000_000 },
  defaultTimeoutMs: { min: 1_000, max: 3_600_000 },
  maxTimeoutMs: { min: 1_000, max: 3_600_000 },
  pollMs: { min: 50, max: 5_000 },
});

export class HostRunnerConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "HostRunnerConfigError";
  }
}

const fail = (message) => {
  throw new HostRunnerConfigError(message);
};

const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Tool names become part of an error message the agent sees; keep them tame. */
const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

function requireInt(value, fallback, { min, max, field }) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n)) fail(`${field} must be an integer`);
  if (n < min || n > max) fail(`${field} must be between ${min} and ${max}`);
  return n;
}

function requireString(value, { field, required = false, max = 4096 }) {
  if (value === undefined || value === null || value === "") {
    if (required) fail(`${field} is required`);
    return null;
  }
  if (typeof value !== "string") fail(`${field} must be a string`);
  if (value.includes("\0")) fail(`${field} must not contain NUL`);
  if (value.length > max) fail(`${field} must be at most ${max} characters`);
  return value;
}

function requirePathList(value, { field, required = false }) {
  if (value === undefined || value === null) {
    if (required) fail(`${field} is required`);
    return undefined;
  }
  if (!Array.isArray(value))
    fail(`${field} must be an array of absolute paths`);
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim())
      fail(`${field} entries must be non-empty strings`);
    const trimmed = entry.trim();
    if (!path.isAbsolute(trimmed))
      fail(`${field} entry "${trimmed}" must be an absolute path`);
    if (trimmed.includes("\0")) fail(`${field} must not contain NUL`);
    out.push(trimmed);
  }
  return out;
}

function validateToolEntry(name, raw) {
  if (!isPlainObject(raw)) fail(`tool "${name}" must be an object`);

  const argv = raw.argv;
  if (!Array.isArray(argv) || argv.length === 0)
    fail(`tool "${name}" needs a non-empty argv array`);
  const cleanArgv = argv.map((part, i) => {
    if (typeof part !== "string")
      fail(`tool "${name}" argv[${i}] must be a string`);
    if (part.includes("\0"))
      fail(`tool "${name}" argv[${i}] must not contain NUL`);
    if (part.length > 8192) fail(`tool "${name}" argv[${i}] is too long`);
    if (!part.length) fail(`tool "${name}" argv[${i}] must not be empty`);
    return part;
  });

  const timeoutMs = requireInt(raw.timeoutMs, undefined, {
    min: 1_000,
    max: 3_600_000,
    field: `tool "${name}" timeoutMs`,
  });
  const maxTimeoutMs = requireInt(raw.maxTimeoutMs, undefined, {
    min: 1_000,
    max: 3_600_000,
    field: `tool "${name}" maxTimeoutMs`,
  });

  const argPattern = requireString(raw.argPattern, {
    field: `tool "${name}" argPattern`,
    max: 512,
  });
  if (argPattern) {
    try {
      new RegExp(argPattern);
    } catch (error) {
      fail(
        `tool "${name}" argPattern is not a valid regular expression: ${error.message}`,
      );
    }
  }

  const description = requireString(raw.description, {
    field: `tool "${name}" description`,
    max: 300,
  });
  const enabled = raw.enabled === undefined ? true : Boolean(raw.enabled);

  // Strict rather than Boolean(): `Boolean("false")` is true, and a tool that
  // was meant to reject arguments would silently start accepting them.
  let allowArgs = true;
  if (raw.allowArgs !== undefined && raw.allowArgs !== null) {
    if (typeof raw.allowArgs !== "boolean")
      fail(`tool "${name}" allowArgs must be a boolean`);
    allowArgs = raw.allowArgs;
  }

  const allowedCwd = requirePathList(raw.allowedCwd, {
    field: `tool "${name}" allowedCwd`,
  });

  let env;
  if (raw.env !== undefined && raw.env !== null) {
    if (!isPlainObject(raw.env)) fail(`tool "${name}" env must be an object`);
    env = {};
    for (const [key, value] of Object.entries(raw.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        fail(`tool "${name}" env key "${key}" is not a valid variable name`);
      }
      if (typeof value !== "string")
        fail(`tool "${name}" env.${key} must be a string`);
      if (value.includes("\0"))
        fail(`tool "${name}" env.${key} must not contain NUL`);
      env[key] = value;
    }
  }

  // Unknown keys are preserved verbatim: the daemon ignores them, and dropping
  // them here would silently delete fields an operator added by hand.
  return {
    ...raw,
    argv: cleanArgv,
    enabled,
    allowArgs,
    ...(description ? { description } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(maxTimeoutMs !== undefined ? { maxTimeoutMs } : {}),
    ...(argPattern ? { argPattern } : {}),
    ...(allowedCwd ? { allowedCwd } : {}),
    ...(env ? { env } : {}),
  };
}

/**
 * Validate a raw whitelist object.
 *
 * @param {unknown} input
 * @returns {object} normalised config (unknown top-level keys preserved)
 * @throws {HostRunnerConfigError} with a message safe to show in the UI
 */
export function validateHostRunnerConfig(input) {
  if (!isPlainObject(input)) fail("config must be a JSON object");

  const allowedRoots = requirePathList(input.allowedRoots, {
    field: "allowedRoots",
    required: true,
  });
  if (!allowedRoots?.length)
    fail("allowedRoots must contain at least one absolute path");

  const tools = input.tools;
  if (!isPlainObject(tools) || Object.keys(tools).length === 0) {
    fail(
      "tools must contain at least one command — the daemon refuses to start without one",
    );
  }
  const cleanTools = {};
  for (const [name, entry] of Object.entries(tools)) {
    if (!TOOL_NAME_RE.test(name)) {
      fail(`tool name "${name}" must match ${TOOL_NAME_RE.source}`);
    }
    cleanTools[name] = validateToolEntry(name, entry);
  }

  let envAllowlist;
  if (input.envAllowlist !== undefined && input.envAllowlist !== null) {
    if (!Array.isArray(input.envAllowlist))
      fail("envAllowlist must be an array of names");
    envAllowlist = input.envAllowlist.map((key, i) => {
      if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        fail(`envAllowlist[${i}] is not a valid variable name`);
      }
      return key;
    });
  }

  const auditFile = requireString(input.auditFile, {
    field: "auditFile",
    max: 4096,
  });

  const numeric = {};
  for (const [field, range] of Object.entries(LIMITS)) {
    const value = requireInt(input[field], undefined, { ...range, field });
    if (value !== undefined) numeric[field] = value;
  }

  return {
    ...input,
    allowedRoots,
    tools: cleanTools,
    ...(envAllowlist ? { envAllowlist } : {}),
    ...(auditFile ? { auditFile } : { auditFile: null }),
    ...numeric,
  };
}

export function resolveHostRunnerDirs(env = process.env) {
  return {
    inDir: env.HOST_RUNNER_IN_DIR?.trim() || DEFAULT_IN_DIR,
    outDir: env.HOST_RUNNER_OUT_DIR?.trim() || DEFAULT_OUT_DIR,
  };
}

/**
 * The daemon's published view of the whitelist.
 *
 * @returns {Promise<object|null>} null when the daemon has never published one
 *   (not running) — a normal answer, not an error.
 * @throws {HostRunnerConfigError} when a snapshot exists but is unusable
 */
export async function readHostRunnerSnapshot(env = process.env) {
  const { outDir } = resolveHostRunnerDirs(env);
  let raw;
  try {
    raw = await fsp.readFile(path.join(outDir, SNAPSHOT_NAME), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new HostRunnerConfigError(
      `daemon snapshot is not valid JSON: ${error.message}`,
    );
  }
  if (!isPlainObject(parsed)) {
    throw new HostRunnerConfigError("daemon snapshot is malformed");
  }
  return parsed;
}

/**
 * Sign a whitelist edit with a key derived from the dashboard password.
 *
 * The MAC covers the exact `configText` bytes that are sent — never a
 * re-serialisation — so the Python side cannot disagree with this one about key
 * order, indentation or number formatting.
 *
 * @returns {{id: string, kind: string, ts: number, salt: string, mac: string, configText: string}}
 */
export function signConfigMessage({ config, password, salt }) {
  if (typeof password !== "string" || !password) {
    throw new HostRunnerConfigError("password is required");
  }
  if (typeof salt !== "string" || !salt) {
    throw new HostRunnerConfigError("the host has no key material yet");
  }
  const configText = `${JSON.stringify(config, null, 2)}\n`;
  if (Buffer.byteLength(configText, "utf8") > MAX_CONFIG_TEXT_BYTES) {
    throw new HostRunnerConfigError("config is too large to submit");
  }
  const ts = Math.floor(Date.now() / 1000);
  const key = crypto.pbkdf2Sync(
    password,
    salt,
    PBKDF2_ITERATIONS,
    32,
    "sha256",
  );
  const mac = crypto
    .createHmac("sha256", key)
    .update(`${ts}\n${configText}`, "utf8")
    .digest("hex");
  const id = `hr_cfg_${crypto.randomBytes(8).toString("hex")}`;
  if (!ID_RE.test(id))
    throw new HostRunnerConfigError("generated an invalid message id");
  return { id, kind: "config", ts, salt, mac, configText };
}

/**
 * Drop a signed edit into the queue and wait for the daemon's verdict.
 *
 * @returns {Promise<object|null>} the daemon's answer, or null on timeout
 * @throws {HostRunnerConfigError} when the queue is not mounted at all
 */
export async function submitConfigMessage(
  message,
  { env = process.env, waitMs = 10_000, pollMs = 100 } = {},
) {
  const { inDir, outDir } = resolveHostRunnerDirs(env);
  try {
    const stat = await fsp.stat(inDir);
    if (!stat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new HostRunnerConfigError(`queue directory ${inDir} is not mounted`);
  }

  const name = `${message.id}${CONFIG_MESSAGE_SUFFIX}`;
  const tmp = path.join(inDir, `.${name}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(message), { mode: 0o600 });
  await fsp.rename(tmp, path.join(inDir, name));

  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    try {
      const raw = await fsp.readFile(
        path.join(outDir, `${message.id}.json`),
        "utf8",
      );
      return JSON.parse(raw);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
