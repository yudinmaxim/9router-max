// Small keyed ACP lifetime manager. Transport code owns child/session details;
// this module owns reuse, serialization, and expiry.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

// Transport entries intentionally stay opaque to callers. `acpBase` owns the
// child process; this module only keeps its lifetime and prompt queue.
//
// The one thing entries do own is whatever the transport attached for
// teardown — the per-session client-tool state dir (sink + results file).
// Every path that drops an entry runs its `onDispose` hook, exactly once: too
// early and a live bridge writes into a deleted directory, never and the dir
// leaks for the lifetime of /tmp.
function disposeAcpSession(entry) {
  if (!entry || entry.disposed) return;
  entry.disposed = true;
  try { entry.onDispose?.(); } catch { /* best effort; the OS reaps tmpdir */ }
}

export function peekAcpSession(key) {
  const entry = sessions.get(key);
  if (!entry || entry.expiresAt <= Date.now() || entry.dead) {
    if (entry) {
      entry.dead = true;
      try { entry.child?.kill?.(); } catch { /* already dead */ }
      sessions.delete(key);
      disposeAcpSession(entry);
    }
    return null;
  }
  return entry;
}

export function acpSessionKey({ provider, connection, cwd, model, proxy = "", noProxy = "" }) {
  return JSON.stringify([provider || "", connection || "", cwd || "", model || "", proxy || "", noProxy || ""]);
}

export function findAcpSession({ provider, connection, cwd, model }, now = Date.now()) {
  for (const [key, entry] of sessions) {
    if (entry.expiresAt <= now || entry.dead) continue;
    let parts;
    try { parts = JSON.parse(key); } catch { continue; }
    if (parts[0] === (provider || "") && parts[1] === (connection || "") &&
        parts[2] === (cwd || "") && parts[3] === (model || "")) return entry;
  }
  return null;
}

export function getAcpSession(key, now = Date.now()) {
  const entry = sessions.get(key);
  if (!entry || entry.expiresAt <= now || entry.dead) {
    if (entry) {
      sessions.delete(key);
      disposeAcpSession(entry);
    }
    return null;
  }
  entry.expiresAt = now + entry.ttl;
  return entry;
}

export function acquireAcpSession(key, options = {}) {
  let entry = sessions.get(key);
  if (!entry || entry.expiresAt <= Date.now() || entry.dead) {
    entry = putAcpSession(key, {}, options);
  }
  const previous = entry.tail;
  let release;
  entry.tail = new Promise((resolve) => { release = resolve; });
  return previous.then(() => ({ entry, release }));
}

export function putAcpSession(key, value, { ttl = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  // Replacing an entry abandons it — whatever it attached (state dir, and any
  // caller-side cleanup behind `onDispose`) must not outlive it here.
  const previous = sessions.get(key);
  if (previous) disposeAcpSession(previous);
  const entry = { ...value, ttl, expiresAt: now + ttl, dead: false, tail: Promise.resolve() };
  sessions.set(key, entry);
  return entry;
}

export function dropAcpSession(key) {
  const entry = sessions.get(key);
  if (entry) entry.dead = true;
  sessions.delete(key);
  if (entry) disposeAcpSession(entry);
}

export function clearAcpSessions() {
  const entries = [...sessions.values()];
  for (const entry of entries) entry.dead = true;
  sessions.clear();
  for (const entry of entries) disposeAcpSession(entry);
}

export function cleanupAcpSessions(now = Date.now()) {
  for (const [key, entry] of sessions) {
    if (entry.expiresAt <= now || entry.dead) {
      try { entry.child?.kill?.(); } catch { /* already dead */ }
      sessions.delete(key);
      disposeAcpSession(entry);
    }
  }
}

export function markAcpSessionDead(key) {
  const entry = sessions.get(key);
  if (!entry) return;
  entry.dead = true;
  try { entry.child?.kill?.(); } catch { /* already dead */ }
  sessions.delete(key);
  disposeAcpSession(entry);
}

export const ACP_SESSION_TTL_MS = DEFAULT_TTL_MS;
