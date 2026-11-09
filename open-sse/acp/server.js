/**
 * AcpAgentServer — the ACP *agent* (server) side of 9router.
 *
 * Zed spawns 9router as an External Agent and speaks ACP v1 over stdio: it
 * sends `initialize`, `session/new`, `session/prompt` … and we answer. Each
 * incoming dialogue is routed into an internal ACP child agent (codex-acp and
 * friends) through `openChild`, so 9router is a transparent proxy — the
 * live-session state that kills the REST history-resend problem lives on the
 * child, held open by Zed driving only deltas.
 *
 * Isolation (spec §6): the primary key is the *external* sessionId Zed gives
 * us — immutable and restart-surviving — never (cwd,model,provider) and never
 * the child process (ACP multiplexes several sessions on one child, which
 * would fuse dialogues). Two Zed tabs in one project get two registry rows.
 *
 * This module is transport-agnostic and side-effect free: it takes an inbound
 * JSON-RPC message and writes outbound frames through `write`. stdio framing,
 * child spawning and the model catalog are injected, which is what makes the
 * whole external contract testable against a fake child.
 */
import { randomUUID } from "node:crypto";
import { createShadowTranscript } from "./transcript.js";
import { getAcpDialogueById, getAcpDialogues, upsertAcpDialogue, deleteAcpDialogue } from "../../src/lib/db/repos/acpDialoguesRepo.js";
import { trackPendingRequest, saveRequestUsage } from "../../src/lib/usageDb.js";

// Agent capabilities we can honestly advertise. loadSession is guaranteed by
// our own ShadowTranscript (M3), not by the child, so it is always safe to
// claim. authMethods:[] means "already authorized" (Q5) — 9router is
// operator-run and children authorize through it.
const AGENT_CAPABILITIES = {
  loadSession: true,
  sessionCapabilities: { resume: {}, close: {} },
  promptCapabilities: { image: true, embeddedContext: true },
  mcpCapabilities: { http: true },
};

const PROTOCOL_VERSION = 1;

const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// How many parked provider children one dialogue may keep in the provider
// cache before the oldest (excluding the active one) is disposed. Each parked
// child keeps its live agent context, which is the cheapest and most faithful
// "restore" when the dialogue hops back to it (M4 provider switching).
const MAX_CACHED_CHILDREN = 3;

// Cross-provider context replay (M4): a freshly opened child starts with an
// empty agent context, so the dialogue's user/assistant turns are injected
// as one synthetic prompt. Bounds keep the replay affordable on long chats.
const HISTORY_MAX_ENTRIES = 200;
const REPLAY_MAX_ENTRIES = 40;
const REPLAY_MAX_CHARS = 24000;
const ASSISTANT_ENTRY_MAX_CHARS = 8000;

function pushHistory(dialogue, entry) {
  if (!dialogue.history) dialogue.history = [];
  dialogue.history.push(entry);
  if (dialogue.history.length > HISTORY_MAX_ENTRIES) {
    dialogue.history.splice(0, dialogue.history.length - HISTORY_MAX_ENTRIES);
  }
}

function extractPromptText(prompt) {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function buildHistoryText(entries, intro, outro) {
  const tail = (entries || []).slice(-REPLAY_MAX_ENTRIES);
  const lines = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i];
    const line = `${entry.role === "user" ? "User" : "Assistant"}: ${entry.text}`;
    if (used + line.length > REPLAY_MAX_CHARS) break;
    lines.unshift(line);
    used += line.length;
  }
  if (!lines.length) return "";
  return [intro, ...lines, outro].join("\n");
}

function buildReplayText(history) {
  return buildHistoryText(
    history,
    "[Context restore] This dialogue continues an earlier conversation. The transcript below is history for context only — do not answer it, just remember it.",
    "[End of history]",
  );
}

function buildDeltaText(entries) {
  return buildHistoryText(
    entries,
    "[Context update] While you were inactive, the conversation continued. The transcript below is history for context only — do not answer it, just remember it.",
    "[End of update]",
  );
}

/**
 * @param {object} deps
 * @param {(frame: object) => void} deps.write            emit one outbound JSON-RPC frame (object, not a line)
 * @param {(opts: { cwd: string, mcpServers: Array }) => Promise<object>} deps.openChild
 *        open a live child session; resolves to a ChildHandle:
 *        { provider, sessionId, catalog, currentModel, configOptions?, sendRpc, onMessage, dispose }
 * @param {() => Array<{ modelId: string, name?: string, provider?: string }>} [deps.modelCatalog]
 *        catalog offered at initialize (spec Q3: every provider's models)
 * @param {(level: string, msg: string) => void} [deps.log] server-side logging (must go to stderr)
 * @param {object} [deps.clientInfo]            name/version echoed into initialize
 */
export function createAcpServer({ write, openChild, modelCatalog, modelOptions, extraOptions: extraOptionsBuilder, log = () => {}, clientInfo = {} }) {
  // zedSessionId → { provider, currentModel, childSessionId, child, transcript, cwd }
  const dialogues = new Map();
  const childRequests = new Map();

  async function persist(sessionId, dialogue) {
    dialogue.childSessions = collectChildSessions(dialogue);
    await upsertAcpDialogue({
      id: sessionId,
      cwd: dialogue.cwd,
      provider: dialogue.provider,
      currentModel: dialogue.currentModel,
      transcript: dialogue.transcript.getAll(),
      childSessions: dialogue.childSessions,
      history: dialogue.history || [],
    });
  }

  async function loadStored(sessionId) {
    return getAcpDialogueById(sessionId);
  }
  let clientCapabilities = {};

  function sendNotification(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  const send = (obj) => write(obj);
  const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
  const respondToChild = (dialogue, id, result) => dialogue.child?.sendRpcRaw?.({ jsonrpc: "2.0", id, result });

  // ─── Per-provider child cache (M4 provider switching) ─────────────
  //
  // A provider switch used to dispose the outgoing child, killing its live
  // agent context outright. Instead each dialogue keeps a small provider →
  // child cache: the outgoing child is parked there and reused when the
  // dialogue hops back, so no context is lost in either direction.

  // Park a child under its provider key. Replaces any parked child of the
  // same provider that is not this very child (should not happen, but a
  // duplicate must not leak).
  function cacheChild(dialogue, entry) {
    if (!dialogue.children) dialogue.children = new Map();
    if (!entry?.provider || !entry.child) return;
    const previous = dialogue.children.get(entry.provider);
    if (previous?.child && previous.child !== entry.child) {
      try { previous.child.dispose?.(); } catch { /* already dead */ }
    }
    // awareness = how many dialogue.history entries this child has already
    // seen (natively while active, or via an injected delta). Frozen at park
    // time; on reactivation only the missing tail is delivered.
    dialogue.children.set(entry.provider, { ...entry, awareness: entry.awareness ?? (dialogue.history?.length || 0), lastUsedAt: Date.now() });
  }

  // Look up a live parked child for a provider and mark it recently used.
  function pickChild(dialogue, provider) {
    const entry = dialogue.children?.get(provider);
    if (!entry?.child) return null;
    entry.lastUsedAt = Date.now();
    return entry;
  }

  // Dispose parked children beyond the cap, oldest first, never the active one.
  function evictChildren(dialogue, activeProvider) {
    const map = dialogue.children;
    if (!map || map.size <= MAX_CACHED_CHILDREN) return;
    const overflow = map.size - MAX_CACHED_CHILDREN;
    const candidates = [...map.entries()]
      .filter(([id]) => id !== activeProvider)
      .sort((a, b) => (a[1].lastUsedAt || 0) - (b[1].lastUsedAt || 0));
    for (let i = 0; i < Math.min(overflow, candidates.length); i++) {
      const [id, entry] = candidates[i];
      try { entry.child?.dispose?.(); } catch { /* already dead */ }
      map.delete(id);
      log("info", `evicted parked child ${id}`);
    }
  }

  // Serializable snapshot of live/parked child sessions, persisted with the
  // dialogue so a future resume pass (M5) can reconnect to them by id.
  function collectChildSessions(dialogue) {
    const out = {};
    if (dialogue.child && dialogue.provider) {
      out[dialogue.provider] = {
        childSessionId: dialogue.childSessionId,
        currentModel: dialogue.currentModel,
        active: true,
        awareness: dialogue.history?.length || 0,
        lastUsedAt: new Date().toISOString(),
      };
    }
    for (const [id, entry] of dialogue.children || []) {
      if (!entry.child || out[id]) continue;
      out[id] = {
        childSessionId: entry.childSessionId,
        currentModel: entry.currentModel,
        active: false,
        awareness: entry.awareness ?? 0,
        lastUsedAt: new Date(entry.lastUsedAt || 0).toISOString(),
      };
    }
    return out;
  }

  // Send one synthetic session/prompt carrying reconstructed history and
  // wait for the child to finish it. Fail-open: a failed injection must not
  // block the real prompt — the child simply stays colder.
  async function sendHistoryPrompt(dialogue, text) {
    if (!text || !dialogue.child?.sendRpc) return false;
    try {
      const responseId = dialogue.child.sendRpc("session/prompt", {
        sessionId: dialogue.childSessionId,
        prompt: [{ type: "text", text }],
      });
      if (!responseId) return false;
      await new Promise((resolve) => {
        const off = dialogue.child.onMessage((msg) => {
          // Agent→client requests during injection (permissions, fs, …) must
          // be answered or the child hangs mid-prompt. Permissions are
          // cancelled — the injection is context-only, tools are not needed.
          if (msg.method && msg.id !== undefined && msg.id !== null) {
            const result = msg.method === "session/request_permission"
              ? { outcome: { outcome: "cancelled" } }
              : null;
            dialogue.child.sendRpcRaw?.(result
              ? { jsonrpc: "2.0", id: msg.id, result }
              : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported during history injection" } });
            return;
          }
          if (msg.id !== responseId) return;
          off?.();
          resolve(msg);
        });
      });
      return true;
    } catch (err) {
      log("warn", `history injection into ${dialogue.provider} failed: ${err?.message || err}`);
      return false;
    }
  }

  // Full-history replay for a child that opened completely fresh.
  async function replayHistoryIntoChild(dialogue) {
    const ok = await sendHistoryPrompt(dialogue, buildReplayText(dialogue.history));
    if (ok) log("info", `replayed ${dialogue.history?.length || 0} history entries into fresh child ${dialogue.provider}`);
    return ok;
  }

  // Deliver only the history tail a (re)activated child has not seen yet —
  // the delta accumulated while another provider owned the dialogue.
  async function deliverHistoryDelta(dialogue, seen) {
    const history = dialogue.history || [];
    const from = Math.max(0, Math.min(Number(seen) || 0, history.length));
    if (from >= history.length) return true;
    const ok = await sendHistoryPrompt(dialogue, buildDeltaText(history.slice(from)));
    if (ok) log("info", `delivered ${history.length - from} history delta entries into ${dialogue.provider}`);
    return ok;
  }

  // Bring a reused/parked or natively-resumed child up to date with the
  // unified dialogue history, then mark how much it has seen.
  async function syncChildAwareness(dialogue, entry) {
    const ok = await deliverHistoryDelta(dialogue, entry?.awareness ?? 0);
    if (ok && entry) entry.awareness = dialogue.history?.length || 0;
    return ok;
  }

  // Re-point a reused child at the dialogue's current model. Fail-open: a
  // rejected model must not abort the switch — the child keeps its old model.
  async function pinChildModel(entry, childModel) {
    if (!entry.child || !childModel || childModel === entry.currentModel) return false;
    try {
      const responseId = entry.child.sendRpc("session/set_config_option", {
        sessionId: entry.childSessionId,
        configId: "model",
        value: childModel,
      });
      if (!responseId) return false;
      const response = await new Promise((resolve) => {
        const unsubscribe = entry.child.onMessage((message) => {
          if (message.id !== responseId) return;
          unsubscribe?.();
          resolve(message);
        });
      });
      if (response?.error) {
        log("warn", `child ${entry.provider} rejected model ${childModel}: ${response.error.message || "unknown"}`);
        return false;
      }
      log("info", `parked child ${entry.provider} re-pinned to model ${childModel}`);
      return true;
    } catch (err) {
      log("warn", `model re-pin failed for ${entry.provider}: ${err?.message || err}`);
      return false;
    }
  }

  // (Re)attach a live child to a dialogue that has none — after session/load
  // restored it from the DB, or when the active child died. The external
  // sessionId never changes; only the internal child is (re)opened.
  async function ensureActiveChild(dialogue) {
    if (dialogue.child) return;
    if (!dialogue.provider) throw new Error("dialogue has no provider");
    const pending = dialogue.transcript.getAll().length;
    const cached = pickChild(dialogue, dialogue.provider);
    if (cached) {
      dialogue.child = cached.child;
      dialogue.childSessionId = cached.childSessionId;
      dialogue.currentModel = cached.currentModel;
      log("info", `re-attached child from provider cache: ${dialogue.provider}/${dialogue.childSessionId}`);
      await syncChildAwareness(dialogue, cached);
      return;
    }
    const model = dialogue.currentModel ? `${dialogue.provider}/${dialogue.currentModel}` : "default";
    // Prefer native resume: the persisted childSessions snapshot carries the
    // agent-side session id, and ACP agents with loadSession (codex-acp)
    // restore full context from it. Unsupported agents fall back to
    // session/new inside the factory.
    const resumeSessionId = dialogue.childSessions?.[dialogue.provider]?.childSessionId || null;
    const child = await openChild({ cwd: dialogue.cwd, mcpServers: [], model, resumeSessionId });
    if (!child?.sessionId) throw new Error(`target ACP provider ${dialogue.provider} failed to create session`);
    dialogue.child = child;
    dialogue.provider = child.provider || dialogue.provider;
    dialogue.childSessionId = child.sessionId;
    if (child.currentModel) dialogue.currentModel = child.currentModel;
    cacheChild(dialogue, {
      provider: dialogue.provider,
      child: dialogue.child,
      childSessionId: dialogue.childSessionId,
      currentModel: dialogue.currentModel,
    });
    if (child.resumed) {
      // Native resume restored the child's own past, but not the turns other
      // providers exchanged meanwhile — deliver just that delta.
      const seen = Number(dialogue.childSessions?.[dialogue.provider]?.awareness) || 0;
      const ok = await deliverHistoryDelta(dialogue, seen);
      if (!ok) {
        const entry = dialogue.children?.get(dialogue.provider);
        if (entry) entry.awareness = seen;
      }
    } else if (pending > 0) {
      const replayed = await replayHistoryIntoChild(dialogue);
      if (!replayed) log("warn", `child ${dialogue.provider} opened fresh after restore; ${pending} transcript entries not replayed`);
    }
  }

  // Render a child catalog into the ACP `models` shape so Zed can show a
  // picker. currentModelId must be one of availableModels or Zed shows an
  // empty selection.
  function buildModels(catalog, currentModel) {
    const ids = Array.isArray(catalog) ? catalog : [];
    const availableModels = ids.map((id) =>
      typeof id === "string" ? { modelId: id, name: id } : { modelId: id.modelId ?? id.id, name: id.name ?? id.modelId ?? id.id }
    );
    return {
      availableModels,
      currentModelId: currentModel || availableModels[0]?.modelId || null,
    };
  }

  async function onInitialize(id, params) {
    clientCapabilities = params?.clientCapabilities || {};
    const catalog = modelCatalog ? await modelCatalog() : [];
    log("info", `initialize catalog models=${catalog.length} ids=${catalog.map((entry) => entry.modelId ?? entry.id).join(",")}`);
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      authMethods: [],
      ...(clientInfo.name ? { agentInfo: clientInfo } : {}),
      models: { availableModels: catalog.map(toModelEntry) },
      configOptions: [modelOptions ? modelOptions([], catalog) : { id: "model", category: "model", type: "select", name: "Model", currentValue: catalog[0]?.modelId || "", options: catalog.map((entry) => ({ value: entry.modelId ?? entry.id, name: entry.name ?? entry.modelId ?? entry.id })) }],
    });
  }

  async function onSessionNew(id, params) {
    const cwd = typeof params?.cwd === "string" ? params.cwd : "";
    if (!cwd) return fail(id, INVALID_PARAMS, "session/new requires a cwd");
    const mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
    const requestedModel = typeof params?.model === "string" ? params.model : undefined;
    let child;
    try {
      child = await openChild({ cwd, mcpServers, model: requestedModel });
    } catch (err) {
      log("error", `session/new openChild failed: ${err?.message || err}`);
      return fail(id, INTERNAL_ERROR, `failed to open agent session: ${err?.message || err}`);
    }
    const zedSessionId = randomUUID();
    dialogues.set(zedSessionId, {
      provider: child.provider || "",
      connectionId: child.connectionId || null,
      currentModel: child.currentModel || "",
      childSessionId: child.sessionId,
      child,
      cwd,
      transcript: createShadowTranscript(),
      promptInFlight: false,
      configOptions: [],
      children: new Map(),
      childSessions: {},
      history: [],
    });
    await persist(zedSessionId, dialogues.get(zedSessionId));
    log("info", `session/new ${zedSessionId} → child ${child.provider}/${child.sessionId}`);
    const sharedCatalog = modelCatalog ? await modelCatalog() : child.catalog;
    // ACP model IDs must use slash-qualified provider/model form for Zed picker compatibility.
    log("info", `session/new catalog models=${sharedCatalog.length} ids=${sharedCatalog.map((entry) => entry.modelId ?? entry.id).join(",")}`);
    log("info", `session/new catalog models=${Array.isArray(sharedCatalog) ? sharedCatalog.length : 0}`);
    const rawModelOptions = modelOptions ? modelOptions(child.configOptions || [], sharedCatalog) : { id: "model", category: "model", type: "select", name: "Model", currentValue: sharedCatalog[0]?.modelId || "", options: sharedCatalog.map((entry) => ({ value: entry.modelId ?? entry.id, name: entry.name ?? entry.modelId ?? entry.id })) };
    const sharedModelOptions = Array.isArray(rawModelOptions) ? rawModelOptions[0] : rawModelOptions;
    const extraOptions = extraOptionsBuilder ? extraOptionsBuilder(child.configOptions || [], sharedCatalog, child.provider || "") : [];
    log("info", `session/new config model options=${sharedModelOptions?.options?.length || 0} extras=${extraOptions.length} ids=${(sharedModelOptions?.options || []).slice(0, 3).map((option) => option.value).join(",")}`);
    reply(id, {
      sessionId: zedSessionId,
      models: buildModels(sharedCatalog, sharedCatalog[0]?.modelId || sharedCatalog[0]?.id || null),
      // Do not forward child configOptions: Codex child options contain its
      // private model list and make Zed render only Codex models.
      configOptions: [sharedModelOptions, ...extraOptions],
      _meta: { modelCatalogSource: "9router-shared" },
    });
    dialogues.get(zedSessionId).configOptions = [sharedModelOptions, ...extraOptions];
  }

  async function onSessionPrompt(id, params) {
    const sessionId = params?.sessionId;
    const prompt = params?.prompt;
    if (!sessionId) return fail(id, INVALID_PARAMS, "session/prompt requires a sessionId");
    if (!Array.isArray(prompt)) return fail(id, INVALID_PARAMS, "session/prompt requires a prompt array");

    const dialogue = dialogues.get(sessionId);
    if (!dialogue) return fail(id, INVALID_PARAMS, "session not found");

    try {
      await ensureActiveChild(dialogue);
    } catch (err) {
      return fail(id, INTERNAL_ERROR, `failed to (re)open child session: ${err?.message || err}`);
    }

    const { child, childSessionId, transcript } = dialogue;
    if (dialogue.promptInFlight) return fail(id, INVALID_PARAMS, "session/prompt already in progress");
    dialogue.promptInFlight = true;
    const userText = extractPromptText(prompt);
    if (userText) pushHistory(dialogue, { role: "user", text: userText.slice(0, ASSISTANT_ENTRY_MAX_CHARS) });
    let assistantText = "";
    const accountingModel = dialogue.currentModel || dialogue.provider || "default";
    trackPendingRequest(accountingModel, dialogue.provider, dialogue.connectionId, true);
    let promptResult = null;
    let stopReason = null;

    let unsubscribePrompt = null;
    const onceResult = new Promise((resolve) => {
      const handler = (msg) => {
        log("debug", `child message provider=${dialogue.provider} ${JSON.stringify(msg).slice(0, 2000)}`);
        if (msg.method && msg.id !== undefined && msg.id !== null) {
          childRequests.set(msg.id, dialogue);
          const paramsOut = { ...(msg.params || {}), sessionId };
          if (msg.method === "session/request_permission" && paramsOut.toolCall?.rawInput?.command) {
            paramsOut.toolCall = {
              ...paramsOut.toolCall,
              title: paramsOut.toolCall.rawInput.command,
            };
          }
          send({ jsonrpc: "2.0", id: msg.id, method: msg.method, params: paramsOut });
          return;
        }
        if (msg.method === "session/update") {
          const update = msg.params?.update || msg.params;
          log("debug", `child session/update provider=${dialogue.provider} update=${JSON.stringify(update).slice(0, 1000)}`);
          if (update) {
            if (update.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") {
              assistantText += update.content.text;
            }
            const output = update._meta?.terminal_output_delta;
            const rawInput = update.rawInput;
            const rawContent = rawInput
              ? [{ type: "content", content: { type: "text", text: `Raw input:\n${JSON.stringify(rawInput, null, 2)}` } }]
              : [];
            const content = output
              ? [{ type: "terminal", terminalId: output.terminal_id }]
              : rawInput
                ? [...(Array.isArray(update.content) ? update.content : []), ...rawContent]
                : update.content;
            const normalized = content && content !== update.content ? { ...update, content } : update;
            transcript.add(normalized);
            persist(sessionId, dialogue).catch((err) => log("error", `dialogue persistence failed: ${err?.message || err}`));
            sendNotification("session/update", { sessionId, update: normalized });
          }
        } else if (msg.id === promptResult) {
          stopReason = ["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"].includes(msg.result?.stopReason)
            ? msg.result.stopReason
            : "end_turn";
          unsubscribePrompt?.();
          resolve();
        }
      };
      unsubscribePrompt = child.onMessage(handler);
    });

    promptResult = child.sendRpc("session/prompt", { sessionId: childSessionId, prompt });

    if (!promptResult) {
      unsubscribePrompt?.();
      dialogue.promptInFlight = false;
      return fail(id, INTERNAL_ERROR, "failed to send session/prompt to child");
    }

    try {
      await onceResult;
      const assistantReply = assistantText.trim();
      if (assistantReply) pushHistory(dialogue, { role: "assistant", text: assistantReply.slice(0, ASSISTANT_ENTRY_MAX_CHARS) });
      persist(sessionId, dialogue).catch((err) => log("error", `dialogue persistence failed: ${err?.message || err}`));
      reply(id, { stopReason });
    } finally {
      const status = stopReason === "end_turn" ? "200 OK" : "FAILED 502";
      trackPendingRequest(accountingModel, dialogue.provider, dialogue.connectionId, false, status !== "200 OK");
      saveRequestUsage({
        provider: dialogue.provider,
        model: accountingModel,
        connectionId: dialogue.connectionId,
        tokens: {},
        status,
        endpoint: "acp",
      }).catch((err) => log("error", `ACP usage persistence failed: ${err?.message || err}`));
      dialogue.promptInFlight = false;
    }
  }

  async function onSessionLoad(id, params) {
    const sessionId = params?.sessionId;
    if (!sessionId) return fail(id, INVALID_PARAMS, "session/load requires a sessionId");
    const stored = await loadStored(sessionId);
    if (!stored) return fail(id, INVALID_PARAMS, "session not found");
    const transcript = createShadowTranscript();
    for (const update of stored.transcript || []) transcript.add(update);
    const dialogue = { ...stored, child: null, childSessionId: null, transcript, promptInFlight: false, children: new Map(), childSessions: stored.childSessions || {} };
    dialogues.set(sessionId, dialogue);
    for (const update of transcript.getAll()) sendNotification("session/update", { sessionId, update });
    reply(id, {});
  }

  async function onSessionSetConfigOption(id, params) {
    const sessionId = params?.sessionId;
    const configId = params?.configId;
    const value = params?.value;
    if (!sessionId || !configId || value === undefined) {
      return fail(id, INVALID_PARAMS, "session/set_config_option requires sessionId, configId and value");
    }
    const dialogue = dialogues.get(sessionId);
    if (!dialogue) return fail(id, INVALID_PARAMS, "session not found");
    if (!dialogue.child) return fail(id, INTERNAL_ERROR, "child session unavailable");

    if (configId === "model" && typeof value === "string") {
      const separator = value.includes("::") ? "::" : "/";
      const provider = separator === "::" ? value.split("::", 1)[0] : value.split("/", 1)[0];
      const childModel = value.slice(provider.length + separator.length);
      if (provider && provider !== dialogue.provider) {
        try {
          // Park the outgoing child instead of disposing it: its live agent
          // context is preserved for a later hop back to this provider.
          if (dialogue.child) {
            cacheChild(dialogue, {
              provider: dialogue.provider,
              child: dialogue.child,
              childSessionId: dialogue.childSessionId,
              currentModel: dialogue.currentModel,
            });
          }
          const cached = pickChild(dialogue, provider);
          if (cached) {
            // Live child of the target provider is still around — reuse it and
            // re-point it at the requested model (fail-open).
            if (childModel) {
              const pinned = await pinChildModel(cached, childModel);
              if (pinned) cached.currentModel = childModel;
            }
            dialogue.child = cached.child;
            dialogue.childSessionId = cached.childSessionId;
            dialogue.provider = provider;
            dialogue.currentModel = cached.currentModel;
            await syncChildAwareness(dialogue, cached);
            log("info", `switch reuses live child ${provider}/${dialogue.childSessionId} (context preserved)`);
          } else {
            const resumeSessionId = dialogue.childSessions?.[provider]?.childSessionId || null;
            const nextChild = await openChild({ cwd: dialogue.cwd, mcpServers: [], model: value, resumeSessionId });
            if (!nextChild?.sessionId) throw new Error(`target ACP provider ${provider} failed to create session`);
            dialogue.child = nextChild;
            dialogue.provider = nextChild.provider || provider;
            dialogue.childSessionId = nextChild.sessionId;
            dialogue.currentModel = childModel;
            cacheChild(dialogue, {
              provider: dialogue.provider,
              child: nextChild,
              childSessionId: nextChild.sessionId,
              currentModel: childModel,
            });
            if (nextChild.resumed) {
              const seen = Number(dialogue.childSessions?.[dialogue.provider]?.awareness) || 0;
              const ok = await deliverHistoryDelta(dialogue, seen);
              if (!ok) {
                const entry = dialogue.children?.get(dialogue.provider);
                if (entry) entry.awareness = seen;
              }
            } else {
              const pending = dialogue.transcript.getAll().length;
              if (pending > 0) {
                const replayed = await replayHistoryIntoChild(dialogue);
                if (!replayed) log("warn", `child ${dialogue.provider} opened fresh on switch; ${pending} transcript entries not replayed`);
              }
            }
          }
          evictChildren(dialogue, dialogue.provider);
          await persist(sessionId, dialogue);
          const modelOption = (dialogue.configOptions || []).find((option) => option.id === "model" || option.category === "model");
          dialogue.configOptions = [
            { ...(modelOption || { id: "model", category: "model", type: "select", name: "Model", options: [] }), currentValue: value },
            ...(dialogue.configOptions || []).filter((option) => option !== modelOption),
          ];
          return reply(id, { configOptions: dialogue.configOptions });
        } catch (error) {
          return fail(id, INTERNAL_ERROR, `failed to switch ACP provider: ${error?.message || error}`);
        }
      }
    }

    const childValue = configId === "model" && typeof value === "string"
      ? (value.includes("::") ? value.split("::").slice(1).join("::") : value.includes("/") ? value.split("/").slice(1).join("/") : value)
      : value;
    let responseId = null;
    const result = new Promise((resolve) => {
      dialogue.child.onMessage((msg) => {
        if (msg.id === responseId) resolve(msg);
      });
    });
    responseId = dialogue.child.sendRpc("session/set_config_option", {
      sessionId: dialogue.childSessionId,
      configId,
      value: childValue,
    });
    if (!responseId) return fail(id, INTERNAL_ERROR, "failed to send config option to child");
    const response = await result;
    if (response.error) {
      log("error", `set_config_option rejected provider=${dialogue.provider} configId=${configId} value=${String(value)} error=${response.error.message || "unknown"}`);
      return fail(id, response.error.code || INTERNAL_ERROR, response.error.message || "child rejected config option");
    }
    if (configId === "model") {
      dialogue.currentModel = childValue;
      dialogue.configOptions = (dialogue.configOptions || []).map((option) => option.id === "model" || option.category === "model"
        ? { ...option, currentValue: value }
        : option);
      persist(sessionId, dialogue).catch((err) => log("error", `dialogue persistence failed: ${err?.message || err}`));
    }
    reply(id, { ...(response.result || {}), configOptions: dialogue.configOptions || [] });
  }

  async function onSessionCancel(id, params) {
    const sessionId = params?.sessionId;
    const dialogue = dialogues.get(sessionId);
    if (!dialogue?.child) {
      if (id !== undefined && id !== null) fail(id, INVALID_PARAMS, "session not found");
      return;
    }
    let requestId = null;
    let unsubscribe = null;
    const result = new Promise((resolve) => {
      unsubscribe = dialogue.child.onMessage((msg) => {
        if (msg.id !== requestId) return;
        unsubscribe?.();
        resolve(msg);
      });
    });
    requestId = dialogue.child.sendRpc("session/cancel", { sessionId: dialogue.childSessionId });
    log("info", `session/cancel ${sessionId} → child ${dialogue.childSessionId} request=${requestId ?? "failed"}`);
    if (!requestId) {
      unsubscribe?.();
      if (id !== undefined && id !== null) return fail(id, INTERNAL_ERROR, "failed to send session/cancel to child");
      return;
    }
    if (id === undefined || id === null) {
      unsubscribe?.();
      dialogue.promptInFlight = false;
      return;
    }
    const response = await result;
    log("info", `session/cancel child response ${sessionId} request=${requestId}`);
    dialogue.promptInFlight = false;
    if (response.error) return fail(id, response.error.code || INTERNAL_ERROR, response.error.message || "child rejected session/cancel");
    reply(id, response.result || {});
  }

  async function onSessionResume(id, params) {
    const sessionId = params?.sessionId;
    if (!sessionId || (!dialogues.has(sessionId) && !(await loadStored(sessionId)))) {
      return fail(id, INVALID_PARAMS, "session not found");
    }
    reply(id, {});
  }

  async function onSessionList(id, params) {
    const stored = await getAcpDialogues({ cwd: params?.cwd });
    const sessions = stored.map(({ id: sessionId, cwd, currentModel, provider }) => ({
      sessionId, cwd, title: `${provider}/${currentModel}`,
    }));
    reply(id, { sessions });
  }

  async function onSessionDelete(id, params) {
    const sessionId = params?.sessionId;
    if (!sessionId) return fail(id, INVALID_PARAMS, "session/delete requires a sessionId");
    const dialogue = dialogues.get(sessionId);
    await deleteAcpDialogue(sessionId);
    dialogues.delete(sessionId);
    dialogue?.child?.dispose?.();
    for (const [, entry] of dialogue?.children || []) {
      try { entry.child?.dispose?.(); } catch { /* already dead */ }
    }
    reply(id, {});
  }

  const handlers = {
    initialize: onInitialize,
    "session/new": onSessionNew,
    "session/prompt": onSessionPrompt,
    "session/cancel": onSessionCancel,
    "session/load": onSessionLoad,
    "session/resume": onSessionResume,
    "session/set_config_option": onSessionSetConfigOption,
    "session/list": onSessionList,
    "session/delete": onSessionDelete,
  };

  /**
   * Handle one inbound message. Notifications (no id) get no reply; unknown
   * requests get an explicit method-not-found so a client is never left
   * hanging on a request we will not service.
   */
  async function handle(message) {
    const { id, method, params } = message || {};
    if (!method && id !== undefined && id !== null) {
      const dialogue = childRequests.get(id);
      if (dialogue) {
        childRequests.delete(id);
        dialogue.child?.sendRpcRaw?.({ ...message, id });
      }
      return;
    }
    const isRequest = id !== undefined && id !== null;
    const handler = handlers[method];
    if (!isRequest && method !== "session/cancel") return;
    if (!handler) {
      if (isRequest) fail(id, METHOD_NOT_FOUND, `method not found: ${method}`);
      return;
    }
    try {
      await handler(id, params);
    } catch (err) {
      log("error", `${method} threw: ${err?.stack || err}`);
      if (isRequest) fail(id, INTERNAL_ERROR, `${method} failed: ${err?.message || err}`);
    }
  }

  return {
    handle,
    dialogues,
    clientCapabilities: () => clientCapabilities,
  };
}

function toModelEntry(entry) {
  if (typeof entry === "string") return { modelId: entry, name: entry };
  return { modelId: entry.modelId ?? entry.id, name: entry.name ?? entry.modelId ?? entry.id };
}
