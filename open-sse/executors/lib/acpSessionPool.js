// Small keyed ACP lifetime manager. Transport code owns child/session details;
// this module owns reuse, serialization, and expiry.
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const sessions = new Map();

// Transport entries intentionally stay opaque to callers. `acpBase` owns the
// child process; this module only keeps its lifetime and prompt queue.
export function peekAcpSession(key) {
  const entry = sessions.get(key);
  if (!entry || entry.expiresAt <= Date.now() || entry.dead) {
    if (entry) {
      entry.dead = true;
      try { entry.child?.kill?.(); } catch { /* already dead */ }
      sessions.delete(key);
    }
    return null;
  }
  return entry;
}

export function acpSessionKey({ provider, connection, cwd, model, proxy = "", noProxy = "" }) {
  return JSON.stringify([provider || "", connection || "", cwd || "", model || "", proxy || "", noProxy || ""]);
}

export function getAcpSession(key, now = Date.now()) {
  const entry = sessions.get(key);
  if (!entry || entry.expiresAt <= now || entry.dead) {
    if (entry) sessions.delete(key);
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
  const entry = { ...value, ttl, expiresAt: now + ttl, dead: false, tail: Promise.resolve() };
  sessions.set(key, entry);
  return entry;
}

export function dropAcpSession(key) {
  const entry = sessions.get(key);
  if (entry) entry.dead = true;
  sessions.delete(key);
}

export function clearAcpSessions() {
  for (const entry of sessions.values()) entry.dead = true;
  sessions.clear();
}

export function cleanupAcpSessions(now = Date.now()) {
  for (const [key, entry] of sessions) {
    if (entry.expiresAt <= now || entry.dead) {
      try { entry.child?.kill?.(); } catch { /* already dead */ }
      sessions.delete(key);
    }
  }
}

export function markAcpSessionDead(key) {
  const entry = sessions.get(key);
  if (!entry) return;
  entry.dead = true;
  try { entry.child?.kill?.(); } catch { /* already dead */ }
  sessions.delete(key);
}

export const ACP_SESSION_TTL_MS = DEFAULT_TTL_MS;
