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
export function createAcpServer({ write, openChild, modelCatalog, log = () => {}, clientInfo = {} }) {
  // zedSessionId → { provider, currentModel, childSessionId, child, transcript, cwd }
  const dialogues = new Map();

  async function persist(sessionId, dialogue) {
    await upsertAcpDialogue({
      id: sessionId,
      cwd: dialogue.cwd,
      provider: dialogue.provider,
      currentModel: dialogue.currentModel,
      transcript: dialogue.transcript.getAll(),
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
    reply(id, {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: AGENT_CAPABILITIES,
      authMethods: [],
      ...(clientInfo.name ? { agentInfo: clientInfo } : {}),
      models: { availableModels: (modelCatalog?.() || []).map(toModelEntry) },
    });
  }

  async function onSessionNew(id, params) {
    const cwd = typeof params?.cwd === "string" ? params.cwd : "";
    if (!cwd) return fail(id, INVALID_PARAMS, "session/new requires a cwd");
    const mcpServers = Array.isArray(params?.mcpServers) ? params.mcpServers : [];
    let child;
    try {
      child = await openChild({ cwd, mcpServers });
    } catch (err) {
      log("error", `session/new openChild failed: ${err?.message || err}`);
      return fail(id, INTERNAL_ERROR, `failed to open agent session: ${err?.message || err}`);
    }
    const zedSessionId = randomUUID();
    dialogues.set(zedSessionId, {
      provider: child.provider || "",
      currentModel: child.currentModel || "",
      childSessionId: child.sessionId,
      child,
      cwd,
      transcript: createShadowTranscript(),
    });
    await persist(zedSessionId, dialogues.get(zedSessionId));
    log("info", `session/new ${zedSessionId} → child ${child.provider}/${child.sessionId}`);
    reply(id, {
      sessionId: zedSessionId,
      models: buildModels(child.catalog, child.currentModel),
      ...(child.configOptions ? { configOptions: child.configOptions } : {}),
    });
  }

  async function onSessionPrompt(id, params) {
    const sessionId = params?.sessionId;
    const prompt = params?.prompt;
    if (!sessionId) return fail(id, INVALID_PARAMS, "session/prompt requires a sessionId");
    if (!Array.isArray(prompt)) return fail(id, INVALID_PARAMS, "session/prompt requires a prompt array");

    const dialogue = dialogues.get(sessionId);
    if (!dialogue) return fail(id, INVALID_PARAMS, "session not found");

    const { child, childSessionId, transcript } = dialogue;

    let promptResult = null;
    let stopReason = null;

    const onceResult = new Promise((resolve) => {
      const handler = (msg) => {
        if (msg.method === "session/update") {
          const update = msg.params?.update || msg.params;
          if (update) {
            transcript.add(update);
            persist(sessionId, dialogue).catch((err) => log("error", `dialogue persistence failed: ${err?.message || err}`));
            sendNotification("session/update", { sessionId, update });
          }
        } else if (msg.id === promptResult) {
          stopReason = msg.result?.stopReason || "stop";
          child.onMessage(() => {});
          resolve();
        }
      };
      child.onMessage(handler);
    });

    promptResult = child.sendRpc("session/prompt", { sessionId: childSessionId, prompt });

    if (!promptResult) {
      child.onMessage(() => {});
      return fail(id, INTERNAL_ERROR, "failed to send session/prompt to child");
    }

    await onceResult;

    reply(id, { stopReason });
  }

  async function onSessionLoad(id, params) {
    const sessionId = params?.sessionId;
    if (!sessionId) return fail(id, INVALID_PARAMS, "session/load requires a sessionId");
    const stored = await loadStored(sessionId);
    if (!stored) return fail(id, INVALID_PARAMS, "session not found");
    const transcript = createShadowTranscript();
    for (const update of stored.transcript || []) transcript.add(update);
    const dialogue = { ...stored, child: null, childSessionId: null, transcript };
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

    let responseId = null;
    const result = new Promise((resolve) => {
      dialogue.child.onMessage((msg) => {
        if (msg.id === responseId) resolve(msg);
      });
    });
    responseId = dialogue.child.sendRpc("session/set_config_option", {
      sessionId: dialogue.childSessionId,
      configId,
      value,
    });
    if (!responseId) return fail(id, INTERNAL_ERROR, "failed to send config option to child");
    const response = await result;
    if (response.error) return fail(id, response.error.code || INTERNAL_ERROR, response.error.message || "child rejected config option");
    if (configId === "model") {
      dialogue.currentModel = value;
      persist(sessionId, dialogue).catch((err) => log("error", `dialogue persistence failed: ${err?.message || err}`));
    }
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
    reply(id, {});
  }

  const handlers = {
    initialize: onInitialize,
    "session/new": onSessionNew,
    "session/prompt": onSessionPrompt,
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
    const isRequest = id !== undefined && id !== null;
    const handler = handlers[method];
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
