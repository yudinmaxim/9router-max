#!/usr/bin/env node
// Export an ACP dialogue (acpDialogues row) to Markdown.
//
// Sources, in order of fidelity:
//   1. Provider-native session files — codex rollout JSONL under
//      ~/.codex/sessions/**/rollout-*<childSessionId>.jsonl contains the
//      full turn stream INCLUDING user messages.
//   2. The shadow transcript stored in acpDialogues.data — agent-side
//      session/update stream only (no user prompts).
//
// Usage:
//   node scripts/export-acp-dialogue.mjs --list
//   node scripts/export-acp-dialogue.mjs <dialogue-id> [--out file.md]
//   node scripts/export-acp-dialogue.mjs --id <id> --provider codex-acp

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const DB = process.env.ACP_DB || join(homenv(), ".9router", "db", "data.sqlite");
const CODEX_SESSIONS = join(homenv(), ".codex", "sessions");

function homenv() {
  return process.env.HOME || homedir();
}

function parseArgs(argv) {
  const args = { out: null, list: false, db: DB };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--db") args.db = argv[++i];
    else if (a === "--id") pos.push(argv[++i]);
    else if (!a.startsWith("--")) pos.push(a);
  }
  args.id = pos[0] || null;
  return args;
}

function openDb(path) {
  return new DatabaseSync(path, { readOnly: true });
}

function listDialogues(db) {
  const rows = db
    .prepare("SELECT id, cwd, provider, currentModel, updatedAt, createdAt, data FROM acpDialogues ORDER BY updatedAt DESC")
    .all();
  for (const r of rows) {
    let children = {};
    try {
      children = JSON.parse(r.data || "{}").childSessions || {};
    } catch {}
    const kids = Object.entries(children)
      .map(([p, c]) => `${p}:${c.currentModel || "?"}${c.childSessionId ? `#${String(c.childSessionId).slice(0, 8)}` : ""}`)
      .join(", ");
    console.log(`${r.id}  ${(r.updatedAt || "").slice(0, 16)}  ${r.provider || "-"}/${r.currentModel || "-"}  ${r.cwd}  [${kids}]`);
  }
}

function* walkJsonl(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkJsonl(p);
    else if (e.name.endsWith(".jsonl")) yield p;
  }
}

function findCodexRollout(childSessionId) {
  if (!childSessionId || !existsSync(CODEX_SESSIONS)) return null;
  for (const file of walkJsonl(CODEX_SESSIONS)) {
    if (file.includes(childSessionId)) return file;
  }
  return null;
}

const SKIP_USER_PREFIXES = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions",
  "<user_instructions",
];

function textOf(content) {
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((c) => (typeof c === "string" ? c : c?.text || ""))
    .join("");
}

function isInjectedUserMessage(text) {
  const t = text.trimStart();
  return SKIP_USER_PREFIXES.some((p) => t.startsWith(p));
}

function renderCodexRollout(path) {
  const lines = readFileSync(path, "utf8").trim().split("\n");
  const toolCalls = new Map(); // call_id -> {name, input}
  const toolOutputs = new Map(); // call_id -> text
  const out = [];

  const flushPendingTools = () => {
    // tool calls are emitted inline where they occur; outputs join by call_id
    // and are appended right after their call for readability.
  };

  for (const line of lines) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type !== "response_item") continue;
    const p = j.payload || {};

    if (p.type === "message") {
      const role = p.role;
      const text = textOf(p.content).trim();
      if (!text) continue;
      if (role === "user") {
        if (isInjectedUserMessage(text)) continue;
        out.push(`## User\n\n${text}\n`);
      } else if (role === "assistant") {
        out.push(`## Assistant\n\n${text}\n`);
      }
    } else if (p.type === "custom_tool_call" || p.type === "function_call") {
      const name = p.name || "tool";
      const input = typeof p.input === "string" ? p.input : JSON.stringify(p.arguments || p.input || "");
      toolCalls.set(p.call_id || p.id, { name, input });
      out.push(`\n<details><summary>⚙ ${name}</summary>\n\n\`\`\`\n${input.slice(0, 8000)}\n\`\`\`\n</details>\n`);
    } else if (p.type === "custom_tool_call_output" || p.type === "function_call_output") {
      const text = textOf(p.output).trim();
      toolOutputs.set(p.call_id, text);
    }
  }

  // Append truncated outputs note for calls whose output we didn't inline.
  // (Outputs are large; keep first 1500 chars under the matching details block
  // is complex post-hoc — instead emit a tools appendix.)
  if (toolOutputs.size) {
    out.push(`\n## Tool outputs (excerpt)\n`);
    for (const [callId, text] of toolOutputs) {
      const call = toolCalls.get(callId);
      out.push(`\n<details><summary>↳ ${call?.name || "tool"} output</summary>\n\n\`\`\`\n${text.slice(0, 3000)}\n\`\`\`\n</details>\n`);
    }
  }
  return out.join("\n");
}

function renderTranscript(dialogue) {
  // Group agent_message_chunk by messageId → one assistant block per turn.
  const transcript = dialogue.transcript || [];
  const turns = [];
  let cur = null;
  const tools = [];

  for (const u of transcript) {
    const kind = u.sessionUpdate;
    if (kind === "agent_message_chunk") {
      const mid = u.messageId || "__default";
      if (!cur || cur.mid !== mid) {
        cur = { mid, text: "" };
        turns.push(cur);
      }
      cur.text += u.content?.text || "";
    } else if (kind === "agent_thought_chunk") {
      // fold reasoning into the current turn as a details block at the end
    } else if (kind === "tool_call") {
      tools.push({ id: u.toolCallId, name: u.name || u.title || "tool", title: u.title, status: u.status });
    }
  }

  const out = [];
  const history = dialogue.history || [];
  // history alternates user/assistant; emit user prompts we do have.
  for (const h of history) {
    if (h.role === "user") out.push(`## User\n\n${h.text}\n`);
  }
  if (tools.length) {
    out.push(`\n## Tool calls (${tools.length})\n`);
    for (const t of tools.slice(0, 100)) {
      out.push(`- \`${t.name}\` — ${t.title || ""} _(${t.status || ""})_`);
    }
    if (tools.length > 100) out.push(`- … and ${tools.length - 100} more`);
  }
  out.push(`\n## Assistant transcript (agent-side stream, no user prompts)\n`);
  for (const t of turns) {
    const text = t.text.trim();
    if (text) out.push(`### turn ${t.mid.slice(0, 12)}\n\n${text}\n`);
  }
  return out.join("\n");
}

function exportDialogue(db, id, outPath) {
  const row = db.prepare("SELECT * FROM acpDialogues WHERE id = ?").get(id);
  if (!row) {
    console.error(`dialogue ${id} not found`);
    process.exit(1);
  }
  const data = JSON.parse(row.data || "{}");
  const children = data.childSessions || {};

  const md = [];
  md.push(`# ACP dialogue ${id}`);
  md.push(``);
  md.push(`- cwd: \`${row.cwd}\``);
  md.push(`- provider: ${row.provider || "-"} / model: ${row.currentModel || "-"}`);
  md.push(`- created: ${row.createdAt}  updated: ${row.updatedAt}`);
  md.push(`- children: ${Object.keys(children).join(", ") || "none"}`);
  md.push(``);

  let usedNative = false;
  for (const [provider, child] of Object.entries(children)) {
    const sessionId = child.childSessionId;
    md.push(`---`);
    md.push(``);
    md.push(`## Child session: ${provider} (${child.currentModel || "?"})`);
    md.push(``);
    md.push(`session id: \`${sessionId || "?"}\` — active: ${child.active ? "yes" : "no"}, awareness: ${child.awareness ?? "-"}`);
    md.push(``);

    if (provider === "codex-acp" && sessionId) {
      const rollout = findCodexRollout(sessionId);
      if (rollout) {
        usedNative = true;
        md.push(`_source: codex rollout \`${rollout}\`_`);
        md.push(``);
        md.push(renderCodexRollout(rollout));
        continue;
      }
      md.push(`_rollout file not found — falling back to shadow transcript_`);
      md.push(``);
    }
    md.push(renderTranscript(data));
  }
  if (!Object.keys(children).length) {
    md.push(`_no child sessions recorded — transcript fallback_`);
    md.push(``);
    md.push(renderTranscript(data));
  }

  const text = md.join("\n");
  if (outPath) {
    mkdirSync(resolve(outPath, ".."), { recursive: true });
    writeFileSync(outPath, text);
    console.log(`wrote ${outPath} (${text.length} chars)`);
  } else {
    process.stdout.write(text + "\n");
  }
  if (!usedNative) {
    console.error("note: no provider-native session file found; export contains transcript only (user prompts may be missing)");
  }
}

const args = parseArgs(process.argv.slice(2));
const db = openDb(args.db);
if (args.list) {
  listDialogues(db);
} else if (args.id) {
  exportDialogue(db, args.id, args.out);
} else {
  console.error("usage: export-acp-dialogue.mjs --list | <id> [--out file.md] [--db path]");
  process.exit(2);
}
