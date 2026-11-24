#!/usr/bin/env node
/**
 * hostrunner — stdio MCP server exposed to ACP agents by 9router.
 *
 * It never executes anything itself. A tool call is written as a JSON request
 * into HOST_RUNNER_IN_DIR; the host-side daemon (host-runner/daemon.py) claims
 * it, runs only whitelisted argv, and writes the result into
 * HOST_RUNNER_OUT_DIR. The container mounts `out` read-only, so an agent cannot
 * forge a successful result.
 *
 * Wire format is newline-delimited JSON-RPC 2.0, matching the client-tool
 * bridge in open-sse/executors/lib/acpClientTools.js.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_IN_DIR = "/var/lib/9r-runner/in";
const DEFAULT_OUT_DIR = "/var/lib/9r-runner/out";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WAIT_MS = 3_600_000;
const MAX_TAIL_CHARS = 64_000;

export const TOOL_NAMES = Object.freeze({
  run: "hostrunner_run",
  status: "hostrunner_status",
  cancel: "hostrunner_cancel",
  tail: "hostrunner_tail",
});

const runSchema = {
  type: "object",
  properties: {
    tool: {
      type: "string",
      description: "Whitelisted host tool name (e2e_playwright, php_test, php_lint, …).",
    },
    cwd: {
      type: "string",
      description: "Absolute project directory. Must stay inside the daemon's allowedRoots.",
    },
    args: {
      type: "array",
      items: { type: "string" },
      default: [],
      description: "Extra argv appended after the tool's fixed command.",
    },
    timeoutMs: {
      type: "integer",
      minimum: 1_000,
      maximum: MAX_WAIT_MS,
      description: "Hard timeout for the host process. The daemon may cap it lower.",
    },
    waitMs: {
      type: "integer",
      minimum: 0,
      maximum: MAX_WAIT_MS,
      default: 600_000,
      description: "How long to wait for the result. 0 returns the job id immediately.",
    },
    requester: {
      type: "string",
      description: "Optional free-form label written to the host audit log.",
    },
  },
  required: ["tool", "cwd"],
};

const idSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Job id returned by hostrunner_run." },
  },
  required: ["id"],
};

export const TOOLS = Object.freeze([
  {
    name: TOOL_NAMES.run,
    description:
      "Run a whitelisted test/build command on the HOST machine. Use for E2E/Chrome and PHP tests that cannot run inside the container. Never use a bare shell.",
    inputSchema: runSchema,
  },
  {
    name: TOOL_NAMES.status,
    description: "Get the current state or final result of a hostrunner job.",
    inputSchema: idSchema,
  },
  {
    name: TOOL_NAMES.cancel,
    description: "Ask the host daemon to terminate a running hostrunner job.",
    inputSchema: idSchema,
  },
  {
    name: TOOL_NAMES.tail,
    description: "Read the last lines of a hostrunner job log while it is running.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        lines: { type: "integer", minimum: 1, maximum: 1000, default: 80 },
      },
      required: ["id"],
    },
  },
]);

export function dirs(env = process.env) {
  return {
    inDir: env.HOST_RUNNER_IN_DIR || DEFAULT_IN_DIR,
    outDir: env.HOST_RUNNER_OUT_DIR || DEFAULT_OUT_DIR,
  };
}

/**
 * codex-acp wraps MCP arguments in {server, tool, arguments}; opencode-acp
 * sends them clean. Accept both, plus the prefixes agents add to tool names.
 */
export function unwrapToolArgs(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (
    typeof value.server === "string" &&
    typeof value.tool === "string" &&
    value.arguments &&
    typeof value.arguments === "object" &&
    !Array.isArray(value.arguments)
  ) {
    return value.arguments;
  }
  return value;
}

export function normalizeToolName(name) {
  let value = String(name || "");
  const prefixes = [
    "mcp9r__hostrunner__",
    "mcp__hostrunner__",
    "hostrunner__",
    "hostrunner_",
  ];
  for (const prefix of prefixes) {
    if (value.startsWith(prefix)) {
      value = value.slice(prefix.length);
      break;
    }
  }
  const short = {
    run: TOOL_NAMES.run,
    status: TOOL_NAMES.status,
    cancel: TOOL_NAMES.cancel,
    tail: TOOL_NAMES.tail,
  };
  if (short[value]) return short[value];
  return Object.values(TOOL_NAMES).includes(value) ? value : null;
}

export function makeId() {
  return `hr_${Date.now().toString(36)}_${crypto.randomBytes(6).toString("hex")}`;
}

async function writeJsonAtomic(directory, basename, payload) {
  await fsp.mkdir(directory, { recursive: true });
  const tmp = path.join(directory, `.${basename}.${process.pid}.tmp`);
  await fsp.writeFile(tmp, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
  await fsp.rename(tmp, path.join(directory, basename));
}

function clampInt(value, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`expected an integer, got ${JSON.stringify(value)}`);
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function buildRequest(args, env = process.env) {
  const tool = String(args.tool || "").trim();
  const cwd = String(args.cwd || "").trim();
  if (!tool) throw new Error("tool is required");
  if (!cwd) throw new Error("cwd is required");
  if (!path.isAbsolute(cwd)) throw new Error("cwd must be an absolute path");
  const extraArgs = args.args === undefined ? [] : args.args;
  if (!Array.isArray(extraArgs) || extraArgs.some((a) => typeof a !== "string" || a.includes("\0"))) {
    throw new Error("args must be an array of strings");
  }
  const id = args.id || makeId();
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  const { inDir } = dirs(env);
  return {
    request: {
      id,
      tool,
      cwd,
      args: extraArgs,
      timeoutMs: clampInt(args.timeoutMs, 900_000, 1_000, MAX_WAIT_MS),
      requester: typeof args.requester === "string" ? args.requester.slice(0, 200) : "acp-agent",
    },
    inDir,
    waitMs: clampInt(args.waitMs, 600_000, 0, MAX_WAIT_MS),
  };
}

export async function readResult(id, { env = process.env } = {}) {
  const { outDir } = dirs(env);
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  try {
    const raw = await fsp.readFile(path.join(outDir, `${id}.json`), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Live (`queued` / `running`) marker the daemon publishes before the terminal
 * result exists. Separate file on purpose: a status reader must never confuse
 * it with the finished answer.
 */
export async function readState(id, { env = process.env } = {}) {
  const { outDir } = dirs(env);
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  try {
    const raw = await fsp.readFile(path.join(outDir, `${id}.state.json`), "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function waitForResult(id, { env = process.env, waitMs = 600_000, pollMs = 100 } = {}) {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const result = await readResult(id, { env });
    if (result) return result;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function submitRequest(args, deps = {}) {
  const env = deps.env || process.env;
  const { request, inDir, waitMs } = buildRequest(args, env);
  await writeJsonAtomic(inDir, `${request.id}.request.json`, {
    ...request,
    submittedAt: new Date().toISOString(),
  });
  const result = await waitForResult(request.id, {
    env,
    waitMs,
    pollMs: deps.pollMs ?? 100,
  });
  return result || { id: request.id, status: waitMs === 0 ? "queued" : "running" };
}

async function logExists(id, { env = process.env } = {}) {
  const { outDir } = dirs(env);
  try {
    await fsp.access(path.join(outDir, `${id}.log`));
    return true;
  } catch {
    return false;
  }
}

export async function jobStatus(id, deps = {}) {
  const env = deps.env || process.env;
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  const result = await readResult(id, { env });
  if (result) return result;

  const state = await readState(id, { env });
  if (state) return { ...state, logAvailable: await logExists(id, { env }) };

  const { inDir } = dirs(env);
  const candidates = [
    // The daemon renames the request into `.processing/` keeping its original
    // name — checking for `<id>.json` here reported "unknown" for every job
    // that was actually running.
    [path.join(inDir, ".processing", `${id}.request.json`), "running"],
    [path.join(inDir, ".processing", `${id}.json`), "running"],
    [path.join(inDir, `${id}.request.json`), "queued"],
  ];
  for (const [file, status] of candidates) {
    try {
      await fsp.access(file);
      return { id, status, logAvailable: await logExists(id, { env }) };
    } catch { /* keep looking */ }
  }
  return { id, status: "unknown", logAvailable: await logExists(id, { env }) };
}

export async function cancelJob(id, deps = {}) {
  const env = deps.env || process.env;
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  const { inDir } = dirs(env);
  await writeJsonAtomic(inDir, `${id}.cancel.json`, {
    id,
    requestedAt: new Date().toISOString(),
  });
  return { id, status: "cancel_requested" };
}

export async function tailLog(id, deps = {}) {
  const env = deps.env || process.env;
  if (!ID_RE.test(id)) throw new Error("invalid job id");
  const { outDir } = dirs(env);
  const lines = clampInt(deps.lines, 80, 1, 1000);
  let raw;
  try {
    raw = await fsp.readFile(path.join(outDir, `${id}.log`), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      const state = await readState(id, { env });
      return {
        id,
        log: "",
        note: state ? `no output yet (status: ${state.status})` : "no log yet",
      };
    }
    throw error;
  }
  const selected = raw.split("\n").slice(-lines).join("\n");
  return {
    id,
    log: selected.length > MAX_TAIL_CHARS ? selected.slice(-MAX_TAIL_CHARS) : selected,
  };
}

function textResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

export async function callTool(name, args, deps = {}) {
  switch (name) {
    case TOOL_NAMES.run:
      return submitRequest(args, deps);
    case TOOL_NAMES.status:
      return jobStatus(String(args.id || ""), deps);
    case TOOL_NAMES.cancel:
      return cancelJob(String(args.id || ""), deps);
    case TOOL_NAMES.tail:
      return tailLog(String(args.id || ""), { ...deps, lines: args.lines });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function handleRpc(message, deps = {}) {
  if (!message || typeof message !== "object") return null;
  const id = message.id;
  // MCP notifications have no id and must not be answered.
  if (id === undefined || id === null) return null;
  try {
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hostrunner", version: "1.0.0" },
      };
    } else if (message.method === "tools/list") {
      result = { tools: TOOLS };
    } else if (message.method === "tools/call") {
      const name = normalizeToolName(message.params?.name);
      if (!name) throw new Error(`unknown tool: ${message.params?.name}`);
      const args = unwrapToolArgs(message.params?.arguments);
      const payload = await callTool(name, args, deps);
      const failed =
        payload.status === "failed" ||
        payload.status === "rejected" ||
        payload.status === "timeout" ||
        payload.status === "spawn_failed" ||
        payload.error;
      return { jsonrpc: "2.0", id, result: textResult(payload, Boolean(failed)) };
    } else {
      throw new Error(`method not found: ${message.method}`);
    }
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: String(error?.message || error) },
    };
  }
}

export function startStdio(deps = {}) {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    Promise.resolve(handleRpc(message, deps))
      .then((response) => {
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      })
      .catch((error) => {
        process.stderr.write(`[hostrunner] ${String(error?.stack || error)}\n`);
      });
  });
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  // Fail loudly if the queue is not wired: a silent no-op runner is worse than
  // an agent seeing a tool that errors on first use.
  const { inDir, outDir } = dirs();
  if (!fs.existsSync(inDir) || !fs.existsSync(outDir)) {
    process.stderr.write(
      `[hostrunner] queue directories missing: ${inDir} / ${outDir}. ` +
        "Mount both volumes and start the host daemon (see host-runner/README.md).\n"
    );
  }
  startStdio();
}
