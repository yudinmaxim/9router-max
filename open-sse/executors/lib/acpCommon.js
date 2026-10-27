/**
 * Shared helpers for Agent Client Protocol (ACP) executors — JSON-RPC 2.0 over
 * stdio, one subprocess per turn.
 *
 * Extracted from devin-cli.js so cursor-acp.js reuses the same prompt-building
 * and workspace-resolution logic verbatim. ACP agents (devin, cursor-agent, …)
 * take a single prompt per `session/prompt` and have no notion of a message
 * array, so every executor must flatten the client's conversation into one text
 * block — that flattening is what lives here.
 */

import path from "node:path";
import os from "node:os";
import fs from "node:fs";

// ─── ACP JSON-RPC ───────────────────────────────────────────────────────────

/** Serialize one JSON-RPC 2.0 frame. `id` omitted for notifications. */
export function rpc(method, params, id) {
  const msg = { jsonrpc: "2.0", method, params };
  if (id !== undefined) msg.id = id;
  return JSON.stringify(msg) + "\n";
}

// ─── Spawning agent binaries ────────────────────────────────────────────────

// Never let the shell interpret the command line. On POSIX `shell:false` already
// spawns the file directly, but the Windows branch used `shell:true`, which hands
// the whole command string to cmd.exe: a binary path or argument containing
// cmd.exe metacharacters ("&", "|", "^", "%") becomes command injection. The
// executable path is reachable from the environment (CLI_CURSOR_BIN and friends),
// so that input is not fully trusted.
//
// Windows .cmd/.bat shims cannot be executed directly, so they are routed
// through cmd.exe explicitly — with the path quoted and any embedded quote
// rejected, rather than trusting a shell to quote it for us.
export function agentSpawnCommand(bin, args) {
  const isCmdShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
  if (!isCmdShim) return { cmd: bin, args, shell: false };
  if (bin.includes('"')) {
    throw new Error(`refusing to spawn through cmd.exe: path contains a quote: ${bin}`);
  }
  const comSpec = process.env.ComSpec || "cmd.exe";
  return { cmd: comSpec, args: ["/d", "/s", "/c", `"${bin}"`, ...args], shell: false };
}

// ─── Workspace resolution ───────────────────────────────────────────────────

// Resolve workspace cwd from the client request (Codex/CLI env context, body
// fields). Prefer an absolute existing path so agent file tools hit the user's
// project instead of os.tmpdir() (which made relative create/delete
// inconsistent).
export function resolveWorkspaceCwd(body) {
  const candidates = [];
  const push = (v) => {
    if (typeof v === "string" && v.trim()) candidates.push(v.trim());
  };
  push(body?.cwd);
  push(body?.working_directory);
  push(body?.workdir);
  push(body?.workspace);
  push(body?.metadata?.cwd);
  push(body?.metadata?.working_directory);

  const scanText = (text) => {
    if (typeof text !== "string") return;
    for (const m of text.matchAll(/<cwd>\s*([^<]+?)\s*<\/cwd>/gi)) push(m[1]);
  };
  const scanMessages = (msgs) => {
    if (!Array.isArray(msgs)) return;
    for (const msg of msgs) {
      if (!msg) continue;
      if (typeof msg.content === "string") scanText(msg.content);
      else if (Array.isArray(msg.content)) {
        for (const p of msg.content) {
          if (typeof p === "string") scanText(p);
          else if (p && typeof p === "object") {
            scanText(p.text);
            scanText(p.input_text);
            scanText(p.content);
          }
        }
      }
      // Responses API input items
      if (typeof msg === "string") scanText(msg);
      if (msg.type === "message" && Array.isArray(msg.content)) {
        for (const p of msg.content) scanText(p?.text || p?.input_text);
      }
    }
  };
  scanMessages(body?.messages);
  scanMessages(body?.input);

  for (const c of candidates) {
    try {
      if (path.isAbsolute(c) && fs.existsSync(c) && fs.statSync(c).isDirectory()) {
        return c;
      }
    } catch {
      /* ignore */
    }
  }
  return os.tmpdir();
}

// ─── Multi-turn message → single prompt builder ─────────────────────────────

/**
 * Render one tool's parameter schema as a compact, typed signature line.
 *
 * Listing bare field names is not enough. Live, a free OpenCode model called
 * the caller's `read` with `{"offset":"1.0","limit":"90.0"}` — the names were
 * right, the types were not — and the caller rejected it:
 * "SchemaError(Expected number | undefined, got \"1.0\")". A model composing
 * arguments from plain text only gets the types right when they are spelled
 * out, so each field carries its declared JSON Schema type and `?` marks the
 * optional ones.
 */
function renderToolSignature(name, description, schema) {
  const props = (schema && typeof schema.properties === "object" && schema.properties) || null;
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  const head = `- ${name}${description ? `: ${description}` : ""}`;
  if (!props || !Object.keys(props).length) return head;
  const fields = Object.entries(props).map(([field, spec]) => {
    const type = [spec?.type].flat().filter(Boolean).join("|") || "any";
    return `${field}${required.has(field) ? "" : "?"}: ${type}`;
  });
  return `${head}\n  args: { ${fields.join(", ")} }  (numbers unquoted)`;
}

// Inline the whole conversation so the model has full context, including
// prior tool_calls / tool_results so it can continue after a client round-trip.
/**
 * Build a text prompt for ACP agents from an OpenAI-shaped message array.
 *
 * @param {Array} messages       the messages array
 * @param {Array} [toolDefs]     optional tool definitions from `body.tools`
 *   — their JSON schemas are prepended so the model knows which fields each
 *   tool expects and of what type (e.g. `read` needs `filePath: string` and an
 *   integer `offset`). Without this the model guesses and often produces empty
 *   objects or numbers quoted as strings.
 */
export function buildPromptText(messages, toolDefs = []) {
  const lines = [];

  // ── Tool definitions (prepended so the model sees them first) ──────────
  if (toolDefs.length) {
    const rendered = toolDefs
      .map((t) => {
        const f = t?.function || t;
        if (!f?.name) return null;
        return renderToolSignature(
          f.name,
          f.description || "",
          f.parameters || f.input_schema || f.inputSchema
        );
      })
      .filter(Boolean);
    if (rendered.length) lines.push(`[Tool definitions]\n${rendered.join("\n")}`);
  }

  for (const m of messages) {
    const role = String(m.role || "user");
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (!p || typeof p !== "object") continue;
        if (p.type === "text") text += String(p.text || "");
        else if (p.type === "input_text") text += String(p.text || "");
        else if (p.type === "image_url" || p.type === "input_image") {
          // The bytes go out as native ACP image blocks (see extractImageUrls);
          // the placeholder only keeps the transcript readable.
          text += "\n[image]\n";
        } else if (p.type === "tool_use") {
          text += `\n[Tool call ${p.name} id=${p.id}]\n${JSON.stringify(p.input ?? {})}\n`;
        } else if (p.type === "tool_result") {
          const c =
            typeof p.content === "string" ? p.content : JSON.stringify(p.content ?? "");
          text += `\n[Tool result id=${p.tool_use_id}]\n${c}\n`;
        }
      }
    }
    // OpenAI tool_calls on assistant messages
    if (role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const parts = m.tool_calls.map((tc) => {
        const name = tc.function?.name || tc.name || "tool";
        const args = tc.function?.arguments ?? tc.arguments ?? {};
        const argStr = typeof args === "string" ? args : JSON.stringify(args);
        return `[Tool call ${name} id=${tc.id}]\n${argStr}`;
      });
      text = [text, ...parts].filter(Boolean).join("\n\n");
    }
    // OpenAI role=tool messages
    if (role === "tool") {
      const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      text = `[Tool result id=${m.tool_call_id || ""}]\n${c}`;
    }
    if (!text.trim()) continue;
    if (role === "system") {
      lines.push(`[System]\n${text}`);
    } else if (role === "assistant") {
      lines.push(`[Assistant]\n${text}`);
    } else if (role === "tool") {
      lines.push(`[Tool]\n${text}`);
    } else {
      lines.push(`[User]\n${text}`);
    }
  }
  return lines.join("\n\n") || "(empty)";
}

// Clients like Zed paste clipboard images as OpenAI `image_url` parts (data:
// URLs) or Responses-API `input_image` items. ACP carries them natively as
// `image` content blocks, and the adapters translate those into whatever the
// agent's model expects — but only if the executor puts them into the prompt.
// Flattening everything to text (the old behaviour) silently dropped them, so
// agents behind the bridge never saw a pasted picture.
/** Collect image URLs (data:/http[s]:) from an OpenAI-shaped messages array. */
export function extractImageUrls(messages) {
  const urls = [];
  const push = (u) => {
    if (typeof u === "string" && /^(https?:|data:image\/)/i.test(u.trim())) urls.push(u.trim());
  };
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || typeof m !== "object") continue;
    const parts = [m.content, m.parts, m.input].find(Array.isArray);
    if (!parts) continue;
    for (const p of parts) {
      if (!p || typeof p !== "object") continue;
      if (p.type === "image_url" || p.type === "input_image") {
        push(typeof p.image_url === "string" ? p.image_url : (p.image_url?.url || p.url));
      } else if (p.type === "image" && typeof p.uri === "string") {
        push(p.uri);
      }
    }
  }
  return urls;
}

/** Pull the `messages`/`input` array out of an OpenAI-shaped request body. */
export function extractMessages(body) {
  return Array.isArray(body?.messages)
    ? body.messages
    : Array.isArray(body?.input)
      ? body.input
      : [];
}

/** Rough token estimate for usage reporting — ACP exposes no token counts. */
export function estimateTokens(text) {
  return Math.ceil((text || "").length / 4);
}