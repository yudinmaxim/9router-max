/**
 * ACP agent permissions.
 *
 * An ACP agent blocks its turn on `session/request_permission` until the client
 * answers. 9router has nobody to prompt, so it answers from policy. Two facts,
 * both established by probing `opencode acp` rather than assumed:
 *
 *   - The request itself is useless for classification. Both a read and a write
 *     arrive as `toolCall.kind === "other"`, so the field that looks like the
 *     answer is a constant.
 *   - The truthful kind arrives in the preceding `session/update` notification
 *     (`read`, `edit`, ...), correlated to the request by `toolCallId`. That is
 *     what `classifyAction` reads, via the map the executor fills while it
 *     streams updates.
 *
 * Refusing is safe, not fatal: the agent marks the tool `failed` and finishes
 * the turn with `stopReason: end_turn`, without retrying through another route.
 * Reading a file and writing one are both gated, so refusing everything is a
 * valid (if useless) policy.
 */

import path from "node:path";
import fs from "node:fs";
import {
  ACP_PERMISSION_ACTIONS,
  ACP_PERMISSION_VALUES,
  DEFAULT_ACP_PERMISSIONS,
} from "../../config/runtimeConfig.js";

const VALID_ACTIONS = new Set(ACP_PERMISSION_ACTIONS);
const VALID_VALUES = new Set(ACP_PERMISSION_VALUES);

// ACP tool kinds mapped onto the actions the policy is keyed by. Anything not
// listed lands on `other`, which is denied unless configured otherwise.
const KIND_TO_ACTION = {
  read: "read",
  search: "search",
  edit: "edit",
  move: "move",
  delete: "delete",
  execute: "execute",
  fetch: "fetch",
  think: "other",
  other: "other",
};

/**
 * Decide what kind of action a tool call is.
 *
 * Primary source is the map of `toolCallId → kind` built from `tool_call`
 * notifications. `rawInput` is the fallback for a request that arrives before
 * its notification, and is read conservatively: a payload carrying content is
 * a write, a bare path is a read.
 */
export function classifyAction(toolCall, seenKinds = new Map()) {
  const id = toolCall?.toolCallId;
  const seen = id ? seenKinds.get(id) : undefined;

  if (seen) return KIND_TO_ACTION[seen] || "other";

  const raw = toolCall?.rawInput;
  if (raw && typeof raw === "object") {
    const keys = Object.keys(raw);
    if (keys.includes("content") || keys.includes("newText") || keys.includes("edits")) return "edit";
    if (keys.includes("command") || keys.includes("cmd") || keys.includes("script")) return "execute";
    if (keys.includes("path") || keys.includes("filePath") || keys.includes("filepath")) return "read";
  }

  // No usable signal: treat as the most privileged unknown rather than assuming
  // it is a harmless read.
  return "other";
}

/** Record the kind from a `tool_call` / `tool_call_update` notification. */
export function rememberToolKind(seenKinds, update) {
  const id = update?.toolCallId;
  const kind = update?.kind;
  if (!id || !kind) return;
  if (kind === "other") return; // The uninformative value; keep any earlier, better one.
  seenKinds.set(id, kind);
}

/**
 * Every path the tool call wants to touch.
 *
 * `locations[].path` is the declared set; `rawInput` carries the same paths
 * under the agent's own field names. Both are collected because agents differ
 * in which they populate.
 */
export function targetPaths(toolCall) {
  const out = [];
  const seen = new Set();
  const push = (v) => {
    if (typeof v !== "string") return;
    const trimmed = v.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  for (const loc of Array.isArray(toolCall?.locations) ? toolCall.locations : []) push(loc?.path);
  const raw = toolCall?.rawInput;
  if (raw && typeof raw === "object") {
    push(raw.path);
    push(raw.filePath);
    push(raw.filepath);
    push(raw.file_path);
    push(raw.target_file);
  }
  return out;
}

/**
 * Is every target path inside `cwd`?
 *
 * Resolves `..` and follows symlinks before comparing, otherwise "stay inside
 * the workspace" is one `../` away from being a no-op. A path that cannot be
 * resolved counts as outside: an unresolvable path is not one we can vouch for.
 */
export function insideWorkspace(paths, cwd) {
  const list = Array.isArray(paths) ? paths : [paths];
  if (!list.length) return false;
  if (!cwd) return false;

  let root;
  try {
    root = fs.realpathSync(cwd);
  } catch {
    return false;
  }

  return list.every((p) => {
    if (typeof p !== "string" || !p.trim()) return false;
    const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
    let resolved;
    try {
      resolved = fs.realpathSync(abs);
    } catch {
      // Target may not exist yet (a file about to be created). Resolve the
      // nearest existing ancestor and keep the remainder, so creation is judged
      // by where it would land rather than rejected for not existing yet.
      resolved = resolveThroughExistingAncestor(abs);
      if (!resolved) return false;
    }
    return resolved === root || resolved.startsWith(root + path.sep);
  });
}

function resolveThroughExistingAncestor(abs) {
  let dir = path.dirname(abs);
  const tail = [];
  while (dir && dir !== path.dirname(dir)) {
    try {
      const realDir = fs.realpathSync(dir);
      return tail.length ? path.join(realDir, ...tail) : realDir;
    } catch {
      tail.unshift(path.basename(abs));
      abs = dir;
      dir = path.dirname(dir);
    }
  }
  return null;
}

/**
 * Accept only known actions and values. Anything else is dropped rather than
 * passed through — this value reaches a decision about whether the agent may
 * run a command, so an unrecognised one must not be treated as permissive.
 */
export function normalizePolicy(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;

  for (const action of ACP_PERMISSION_ACTIONS) {
    const raw = input[action];
    if (!raw || typeof raw !== "object") continue;
    const scope = (value) => (VALID_VALUES.has(value) ? value : null);
    const inside = scope(raw.inside);
    const outside = scope(raw.outside);
    if (!inside && !outside) continue;
    out[action] = {};
    if (inside) out[action].inside = inside;
    if (outside) out[action].outside = outside;
  }
  return out;
}

/** Parse the compact request syntax: `"execute=deny,read=once"` or `"read"`. */
export function parsePolicyInput(input) {
  if (!input || typeof input !== "string") return null;
  const text = input.trim();
  if (!text) return null;

  // Bare action names mean "allow once".
  const out = {};
  for (const chunk of text.split(",")) {
    const part = chunk.trim();
    if (!part) continue;
    const [rawAction, rawValue] = part.split("=").map((s) => s.trim());
    const action = rawAction.toLowerCase();
    if (!VALID_ACTIONS.has(action)) continue;
    const value = (rawValue || "once").toLowerCase();
    if (!VALID_VALUES.has(value)) continue;
    out[action] = { inside: value, outside: value };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Merge policy layers, later overriding earlier.
 *
 * `request` wins so a client can loosen or tighten for the duration of one
 * call without persisting anything. Each layer is normalised first, so a layer
 * carrying junk contributes nothing rather than erasing what is below it.
 */
export function mergePolicies(...layers) {
  const merged = {};
  for (const action of ACP_PERMISSION_ACTIONS) {
    merged[action] = { ...DEFAULT_ACP_PERMISSIONS[action] };
  }
  for (const layer of layers) {
    const norm = normalizePolicy(layer);
    for (const action of Object.keys(norm)) {
      merged[action] = { ...merged[action], ...norm[action] };
    }
  }
  return merged;
}

/**
 * Pick the option to answer with.
 *
 * Returns the decision plus which of the agent's own options to select — the
 * agent offers `once`/`always`/`reject`, and answering with `always` is what
 * makes it stop asking for the rest of the session.
 */
export function decidePermission({ action, paths, policy, workspaceCwd, log } = {}) {
  const entry = policy?.[action] || DEFAULT_ACP_PERMISSIONS[action];
  const inside = insideWorkspace(paths, workspaceCwd);
  const decision = inside ? entry.inside : entry.outside;
  const value = VALID_VALUES.has(decision) ? decision : "deny";

  const reason = inside ? "inside working directory" : "outside working directory";
  log?.debug?.(
    "acp",
    `permission ${action} (${value}) — ${reason}${Array.isArray(paths) && paths.length ? `: ${paths.join(", ")}` : ""}`
  );

  return { value, action, inside, reason, paths: Array.isArray(paths) ? paths : [] };
}

/** Select one of the agent's offered options, preferring a specific value. */
export function chooseOption(options, value) {
  const list = Array.isArray(options) ? options : [];
  if (!list.length) return null;
  const wanted =
    value === "always"
      ? /allow_?always/i
      : value === "once"
        ? /allow_?once|^once$/i
        : /reject/i;
  return list.find((o) => wanted.test(String(o?.kind || ""))) || list.find((o) => wanted.test(String(o?.optionId || ""))) || null;
}