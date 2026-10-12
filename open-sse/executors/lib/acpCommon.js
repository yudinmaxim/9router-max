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

// Inline the whole conversation so the model has full context, including
// prior tool_calls / tool_results so it can continue after a client round-trip.
export function buildPromptText(messages) {
  const lines = [];
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
        else if (p.type === "tool_use") {
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