/**
 * AcpClientCore — the ACP *client* machinery, shared by the REST executor
 * (acpBase.js) and the ACP server façade (open-sse/acp/server.js).
 *
 * Owns the protocol plumbing and nothing else: spawning the child, the
 * newline-delimited JSON-RPC transport, request sequencing (one id counter,
 * never reused), answering agent-initiated requests under the id the agent
 * chose, and child teardown. Protocol *decisions* — permission policy,
 * session pooling, SSE emission, model pinning — stay with the caller.
 *
 * Why this module exists: the REST path and the server path speak the exact
 * same protocol to the same agents. Duplicating the machinery is how the two
 * behaviours diverge, so both go through here.
 */
import { spawn } from "node:child_process";
import { createAcpTransport } from "./acpTransport.js";

/**
 * Spawn an ACP agent with the stdio shape the protocol requires.
 * The parent environment is inherited as given — the agent reads its own
 * stored credentials, so injecting anything here would override them.
 */
export function spawnAcpChild({ cmd, args, env, cwd, shell }) {
  return spawn(cmd, args, {
    env,
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    shell,
  });
}

/**
 * @param {object} options
 * @param {import("node:child_process").ChildProcess} [options.child]      existing child (pooled reuse)
 * @param {ReturnType<typeof createAcpTransport>} [options.transport]      existing transport (pooled reuse)
 * @param {(event: string, data: object) => void} [options.trace]          lifecycle sink; failures here must never affect the request
 */
export function createAcpClientCore({ child = null, transport = null, trace = null } = {}) {
  const activeChild = child;
  const activeTransport = transport ?? (activeChild ? createAcpTransport(activeChild) : null);

  let idCounter = 1;
  let stdinClosed = false;

  const record = (event, data = {}) => {
    try {
      trace?.(event, data);
    } catch {
      /* a tracing failure must never affect the request */
    }
  };

  /**
   * Send a request and return its id, or null when the write failed.
   *
   * `prepare` runs before the bytes leave: an agent may answer synchronously
   * inside `stdin.write` (a test double does, a fast local agent can), so
   * anything the caller needs to know about this id must be registered first.
   * `onSendFail` lets the caller undo that registration when nothing was sent.
   */
  const sendRpc = (method, params, prepare = null, onSendFail = null) => {
    const id = idCounter++;
    if (prepare) prepare(id);
    const ok = activeTransport.send(method, params, id);
    record("rpc-send", { id, method, ok: Boolean(ok), pid: activeChild?.pid });
    if (!ok && onSendFail) onSendFail(id);
    return ok ? id : null;
  };

  /**
   * Write a raw message — the only way to answer an agent-initiated request,
   * which must go out under the id the agent chose. Must not touch idCounter:
   * that counter tracks requests we made, and reusing its values would collide
   * with their in-flight responses.
   */
  const sendRpcRaw = (obj) => activeTransport.sendRaw(obj);

  const onMessage = (listener) => activeTransport.onMessage(listener);

  /** A message the agent sent us as a request (it blocks until answered). */
  const isClientRequest = (msg) =>
    Boolean(msg && msg.method && msg.id !== undefined && msg.id !== null);

  const respondTo = (id, result) => sendRpcRaw({ jsonrpc: "2.0", id, result });

  const failTo = (id, error) => sendRpcRaw({ jsonrpc: "2.0", id, error });

  const initialize = (params) => sendRpc("initialize", params);

  /** Close stdin once; returns true when this call actually closed it. */
  const endStdin = () => {
    if (stdinClosed) return false;
    stdinClosed = true;
    record("stdin-end", { pid: activeChild?.pid });
    try {
      activeChild?.stdin?.end();
    } catch {
      /* ignore */
    }
    return true;
  };

  const killNow = (signal = "SIGTERM") => {
    if (activeChild && !activeChild.killed) activeChild.kill(signal);
  };

  /** Give the child a moment to exit cleanly, then make sure it does. */
  const scheduleKill = (graceMs = 2000) => {
    const timer = setTimeout(() => {
      record("sigkill-timer", { pid: activeChild?.pid, killed: activeChild?.killed });
      killNow("SIGKILL");
    }, graceMs);
    timer.unref?.();
    return timer;
  };

  const dispose = () => {
    try {
      activeTransport?.close?.();
    } catch {
      /* already gone */
    }
  };

  return {
    child: activeChild,
    transport: activeTransport,
    sendRpc,
    sendRpcRaw,
    onMessage,
    isClientRequest,
    respondTo,
    failTo,
    initialize,
    endStdin,
    killNow,
    scheduleKill,
    dispose,
  };
}
