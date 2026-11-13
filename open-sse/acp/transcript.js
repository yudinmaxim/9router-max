/**
 * ShadowTranscript — linear log of a dialogue for replay and transfer.
 *
 * Copied from passing `session/update` notifications (agent_message_chunk,
 * agent_thought_chunk, tool_call, tool_result). Used for:
 * - M3: session/load replay after restart
 * - M4: cross-provider model switch (one-time transcript transfer)
 *
 * Transcript entries are plain objects, format matches ACP session/update shape.
 * We do NOT store env/headers from MCP (spec ACP §MCP Security).
 */

// The transcript is persisted to SQLite on every update and replayed on
// session/load, so it must stay bounded: agent_message_chunk arrives per
// token and tool_call_update can carry terminal_output_delta streams —
// unbounded growth is what OOM-killed the router under load.
const MAX_ENTRIES = 400;
const MAX_CHARS = 512 * 1024;

export function createShadowTranscript() {
  const entries = [];
  const sizes = [];
  let totalChars = 0;

  function add(entry) {
    const size = JSON.stringify(entry ?? null).length;
    entries.push({ ...entry });
    sizes.push(size);
    totalChars += size;
    // Never evict the entry just added — a single oversized update may
    // exceed the budget alone, but dropping the newest frame is worse.
    while (entries.length > 1 && (entries.length > MAX_ENTRIES || totalChars > MAX_CHARS)) {
      totalChars -= sizes.shift() || 0;
      entries.shift();
    }
  }

  function getAll() {
    return [...entries];
  }

  function clear() {
    entries.length = 0;
    sizes.length = 0;
    totalChars = 0;
  }

  function toJSON() {
    return JSON.stringify(entries);
  }

  function fromJSON(json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        clear();
        for (const entry of parsed) add(entry);
      }
    } catch {
      /* ignore invalid JSON */
    }
  }

  return { add, getAll, clear, toJSON, fromJSON };
}
