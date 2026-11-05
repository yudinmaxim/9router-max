/**
 * In-memory cache of settings.disabledProviders.
 *
 * Sync reads so the (synchronous) engine can block a provider the user
 * turned off without awaiting a DB round-trip on every request.
 *
 * The Set must live on `globalThis`, not in module scope. Next compiles each
 * API route as its own bundle, and a module imported by two routes can be
 * duplicated per bundle — each copy then gets its own `disabled` set. Toggling
 * from the dashboard would update one copy while /v1/models kept reading an
 * empty one, and a restarted server would seed yet another copy in the
 * instrumentation bundle: the disable feature would silently stop filtering.
 * A well-known global key is shared by every copy in the same process.
 *
 * Global-key collision risk is the same one `process.env` carries: the key is
 * namespaced to 9router and only written by these exported functions.
 */

const STORE_KEY = "__9routerDisabledProviders";

/**
 * Return the process-wide disabled-provider set, creating it on first use.
 * Always call through this accessor — never capture the set in a variable.
 */
function store() {
  if (!(STORE_KEY in globalThis) || !(globalThis[STORE_KEY] instanceof Set)) {
    globalThis[STORE_KEY] = new Set();
  }
  return globalThis[STORE_KEY];
}

/**
 * Replace the cached set with a new list of provider ids.
 * Normalises to lower-case strings.
 */
export function setDisabledProviders(ids) {
  const next = (ids || []).map((id) => String(id).toLowerCase());
  store().clear();
  for (const id of next) store().add(id);
}

/**
 * Check whether a provider is disabled (sync).
 * Accepts a provider id or alias — callers should pass the canonical id.
 */
export function isProviderDisabled(providerId) {
  return store().has(String(providerId || "").toLowerCase());
}
