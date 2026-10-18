// Server-side MCP tool loop: the pure parts, kept out of chatCore so they can be
// reasoned about (and tested) without an executor, a network or a database.
//
// The loop exists because a model cannot reach an MCP server on its own. The
// router owns the credentials (they are sealed in its database), so the router
// has to declare the tools, run the call and hand the result back — the client
// never sees an `mcp9r__*` call.
//
// Streaming is out of scope for this stage, deliberately: a call can only be
// answered before the response starts, and this path is the non-streaming one.

/** Accumulate an OpenAI streamed message from its deltas. */
export function messageFromDeltas(deltas) {
  let content = "";
  const calls = [];
  for (const delta of deltas) {
    if (!delta) continue;
    if (typeof delta.content === "string") content += delta.content;
    for (const call of delta.tool_calls || []) {
      const i = Number.isInteger(call?.index) ? call.index : calls.length;
      while (calls.length <= i) calls.push({ id: null, type: "function", function: { name: "", arguments: "" } });
      const slot = calls[i];
      if (call.id) slot.id = call.id;
      if (call.type) slot.type = call.type;
      if (call.function?.name) slot.function.name += call.function.name;
      if (call.function?.arguments) slot.function.arguments += call.function.arguments;
    }
  }
  return {
    role: "assistant",
    content: content || null,
    tool_calls: calls.length ? calls.map((c, i) => ({ ...c, id: c.id || `call_${i}` })) : undefined,
  };
}

/**
 * The tool calls in a message that belong to us, i.e. that the model asked us
 * to run. Anything else — a client tool, another provider's namespace — is left
 * untouched so the call still reaches whoever owns it.
 */
export function pickOwnedToolCalls(message, isOwned) {
  const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  return calls.filter((c) => c?.id && typeof c?.function?.name === "string" && isOwned(c.function.name));
}

/** Arguments arrive as a JSON string, and a model can and does emit broken JSON. */
export function parseToolArguments(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : { value: parsed };
  } catch {
    return { _raw: text };
  }
}

/**
 * Fold an assistant turn and its results into the message list.
 *
 * Every call gets a result even when it failed: a `tool_calls` message followed
 * by a missing `tool` result is an orphaned call that most providers reject
 * outright, so an error has to arrive as content, not as absence.
 */
export function appendToolResults(messages, assistantMessage, calls, results) {
  const base = Array.isArray(messages) ? messages : [];
  const assistant = {
    role: "assistant",
    content: assistantMessage?.content ?? null,
    tool_calls: calls.map((c) => ({
      id: c.id,
      type: c.type || "function",
      function: { name: c.function.name, arguments: c.function.arguments || "{}" },
    })),
  };
  const turns = calls.map((c, i) => ({
    role: "tool",
    tool_call_id: c.id,
    content: results[i]?.text ?? "(no result)",
  }));
  return [...base, assistant, ...turns];
}

/** A provider response body, as a message the loop can inspect. */
export async function readResponseMessage(response) {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  if (!text) return { message: null, usage: null, text, wasSse: false };
  if (contentType.includes("text/event-stream")) {
    const deltas = [];
    let usage = null;
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let frame;
      try { frame = JSON.parse(payload); } catch { continue; }
      // Streamable responses carry usage on a trailing frame, often the very
      // last one before [DONE], so keep overwriting rather than first-wins.
      if (frame?.usage) usage = frame.usage;
      const choice = frame?.choices?.[0];
      if (choice?.delta) deltas.push(choice.delta);
      else if (choice?.message) deltas.push(choice.message);
    }
    return { message: messageFromDeltas(deltas), usage, text, wasSse: true };
  }
  try {
    const parsed = JSON.parse(text);
    return {
      message: parsed?.choices?.[0]?.message ?? null,
      usage: parsed?.usage ?? null,
      text,
      wasSse: false,
    };
  } catch {
    return { message: null, usage: null, text, wasSse: false };
  }
}

const USAGE_FIELDS = ["prompt_tokens", "completion_tokens", "total_tokens", "cached_tokens", "cache_creation_input_tokens", "reasoning_tokens"];

/** Add one round's usage to a running total, ignoring fields it does not carry. */
export function addUsage(total, usage) {
  if (!usage || typeof usage !== "object") return total;
  const out = total || {};
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (Number.isFinite(value)) out[field] = (out[field] || 0) + value;
  }
  return Object.keys(out).length > 0 ? out : total;
}

/**
 * Fold the usage of rounds that were discarded back into the body the client
 * will be handed.
 *
 * The loop makes one upstream call per round but the client asked for one
 * answer, so only the last round's response survives to be turned into a
 * statistics row. Without this, the router's own spend is under-reported by
 * exactly the rounds nobody sees: three of four calls vanished from the usage
 * table in a live check, and nothing on the page hinted at it.
 *
 * Returns the text unchanged when it is not JSON or carries no usage — a body
 * the loop cannot account for is better left alone than rewritten blind.
 */
export function patchUsageInBody(text, extra) {
  if (!extra || typeof text !== "string" || !text) return text;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
  parsed.usage = addUsage(extra, parsed.usage);
  return JSON.stringify(parsed);
}

/**
 * Put a consumed body back on a Response.
 *
 * Reading the provider's body is what lets the loop see the tool calls, and a
 * Response body can only be read once — so the response the rest of the handler
 * receives has to be rebuilt from the text we already hold. Status and headers
 * are copied because the handlers downstream still branch on them.
 */
export function rebuildResponse(original, text, wasSse) {
  if (!original) return original;
  const headers = new Headers(original.headers);
  if (wasSse && !headers.has("content-type")) {
    headers.set("content-type", "text/event-stream");
  }
  return new Response(text, {
    status: original.status,
    statusText: original.statusText,
    headers,
  });
}
