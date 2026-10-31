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

export function createShadowTranscript() {
  const entries = [];

  function add(entry) {
    entries.push({ ...entry });
  }

  function getAll() {
    return [...entries];
  }

  function clear() {
    entries.length = 0;
  }

  function toJSON() {
    return JSON.stringify(entries);
  }

  function fromJSON(json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) {
        entries.length = 0;
        entries.push(...parsed);
      }
    } catch {
      /* ignore invalid JSON */
    }
  }

  return { add, getAll, clear, toJSON, fromJSON };
}
