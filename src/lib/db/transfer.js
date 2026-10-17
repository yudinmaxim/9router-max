// Config transfer: what leaves the machine, and what comes back.
//
// `exportDb()` used to hand over every secret it had, unconditionally, with no
// envelope to say what the file was or which schema it followed. Two problems
// followed from that: there was no way to share a configuration without sharing
// authorizations, and there was no way for an import to recognise anything but
// its own output.
//
// Two modes, chosen by the operator rather than guessed:
//
//   "config" (default) — connections without credentials, settings, aliases,
//     customModels, disabledModels, combos, MCP servers, proxy pools without
//     their login. For moving a setup between people.
//   "full" — additionally every token, and the router's own `sk-…` keys if the
//     operator asked for them too. For moving to your own second machine. This
//     file is a secret and is named like one.
//
// Tokens live in clear text in this database — there is no encryption at rest
// anywhere except one `mitmSudoEncrypted` field. "Full" is therefore called a
// secret file rather than a backup, because that is what it is.
//
// The provider-specific blob is filtered by an allow list, never a deny list.
// That blob holds both kinds of field at once: things the router needs to keep
// working (`kimi.deviceId`, `trae.tenant`, `cursor.machineId`) and things that
// are credentials (`grok-cli.idToken`, `copilotToken`, `mimoPassToken`,
// `sessionToken`, `accessKeyId`). A deny list has to name every secret that
// exists today and is silent about the one added next month; an allow list
// fails closed instead. The cost is honest — a new non-secret field needs adding
// here, and until then it simply does not travel, which costs one re-entry.

import { parseJson, stringifyJson } from "./helpers/jsonCol.js";

export const TRANSFER_FORMAT_VERSION = 2;
export const TRANSFER_MODES = ["config", "full"];
export const IMPORT_STRATEGIES = ["replace", "merge"];

/** Always dropped, in both modes. `mitmSudoEncrypted` is keyed by
 *  `machineIdSync()`, so on another machine `decryptPassword` returns null and
 *  the operator retypes the sudo password anyway — carrying the ciphertext only
 *  makes the file look restorable when it is not. */
const ALWAYS_DROPPED_SETTINGS = ["password", "oidcClientSecret", "mitmSudoEncrypted"];

const SECRET_CONNECTION_FIELDS = ["accessToken", "refreshToken", "idToken", "apiKey", "password"];

/** Non-secret provider-specific fields. Anything not listed here is dropped from
 *  a "config" export — see the note above for why. */
export const CONFIG_SAFE_PSD_FIELDS = new Set([
  // routing / endpoints
  "baseUrl", "azureEndpoint", "deployment", "apiVersion", "region", "resourceUrl",
  "accountId", "projectId", "proxyPoolId",
  "connectionProxyEnabled", "connectionProxyUrl", "connectionNoProxy",
  "profileArn", "githubLogin", "githubName", "githubEmail", "githubUserId",
  "username", "firstName", "lastName",
  // provider identity that is not itself a credential
  "authMethod", "authKind", "chatgptAccountId", "chatgptPlanType",
  "organizationId", "orgId", "organization", "deviceId", "machineId",
  "tenant", "webId", "scope", "scopes",
  "enabledModels", "enabledTools", "defaultModel", "projectPath", "workspaceRoot",
  "clientId", "client_id", "tokenEndpoint", "token_endpoint",
  "vercelRelayUrl", "mimoCUserId", "mimoUserId",
  "enabled", "isEnabled", "label", "region2", "accountLabel",
]);

/** Credentials that live *inside* a proxy URL, e.g. http://user:pass@host:port.
 *  Stripping them keeps the pool usable for a host the operator can reach while
 *  removing the part that authenticates. */
export function stripProxyUrlCredentials(url) {
  if (typeof url !== "string" || !url.includes("://")) return url;
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    // Not parseable as a URL — do not guess. Leave it: a caller who typed
    // something exotic should see it in the file rather than have it silently
    // rewritten into a different address.
    return url;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Strip one connection's credentials.
 * @param {object} connection
 * @param {boolean} keepSecrets  true only in "full" mode
 */
export function sanitizeConnection(connection, keepSecrets) {
  const out = { ...connection };
  if (!keepSecrets) for (const field of SECRET_CONNECTION_FIELDS) delete out[field];

  if (isPlainObject(out.providerSpecificData)) {
    if (keepSecrets) {
      out.providerSpecificData = { ...out.providerSpecificData };
    } else {
      const psd = {};
      for (const [key, value] of Object.entries(out.providerSpecificData)) {
        if (CONFIG_SAFE_PSD_FIELDS.has(key)) psd[key] = value;
      }
      out.providerSpecificData = psd;
    }
  }
  return out;
}

function sanitizeSettings(settings, keepSecrets) {
  const out = isPlainObject(settings) ? { ...settings } : {};
  for (const key of ALWAYS_DROPPED_SETTINGS) delete out[key];
  if (!keepSecrets) {
    // User-supplied request headers are a place to put a token, so a config
    // export keeps the shape and drops the values.
    if (isPlainObject(out.providerOverrides)) {
      const overrides = {};
      for (const [provider, entry] of Object.entries(out.providerOverrides)) {
        if (!isPlainObject(entry)) continue;
        const headers = isPlainObject(entry.headers) ? Object.fromEntries(
          Object.keys(entry.headers).map((h) => [h, ""])
        ) : undefined;
        overrides[provider] = headers ? { ...entry, headers } : { ...entry };
      }
      out.providerOverrides = overrides;
    }
  }
  return out;
}

/**
 * Wrap an `exportDb()` payload in an envelope and apply the chosen mode.
 *
 * @param {object} raw          the payload from exportDb()
 * @param {object} [options]
 * @param {"config"|"full"} [options.mode]
 * @param {boolean} [options.includeRouterKeys]  full mode only; see 7.10
 * @param {string} [options.sourceVersion]
 */
export function buildTransfer(raw, { mode = "config", includeRouterKeys = false, sourceVersion = "" } = {}) {
  if (!TRANSFER_MODES.includes(mode)) throw new Error(`Unknown transfer mode: ${mode}`);
  const keepSecrets = mode === "full";

  const payload = {
    ...raw,
    settings: sanitizeSettings(raw.settings, keepSecrets),
    providerConnections: (raw.providerConnections || []).map((c) => sanitizeConnection(c, keepSecrets)),
  };

  if (!keepSecrets) {
    payload.proxyPools = (raw.proxyPools || []).map((pool) => ({
      ...pool,
      proxyUrl: stripProxyUrlCredentials(pool.proxyUrl),
    }));
    // A router key is validated by a plain string comparison, so a file carrying
    // one is a complete key to the gateway. Off unless explicitly asked for.
    payload.apiKeys = [];
  } else if (!includeRouterKeys) {
    payload.apiKeys = (raw.apiKeys || []).map(({ id, name, machineId, isActive, createdAt, access }) => ({
      id, name, machineId, isActive, createdAt, access,
    }));
  }

  return {
    formatVersion: TRANSFER_FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    sourceVersion,
    mode,
    includesSecrets: keepSecrets,
    includesRouterKeys: keepSecrets && includeRouterKeys,
    payload,
  };
}

/**
 * Read an uploaded file.
 *
 * A file without an envelope is an older export, and older exports always
 * contained every secret — so it is treated as "full", never as "config".
 * Reading one as secret-free would be the worst possible reading of it: the
 * operator would believe the file is safe to share.
 *
 * @returns {{envelope: object, payload: object, legacy: boolean, warnings: string[]}}
 */
export function parseTransferFile(rawJson, { sourceVersion = "" } = {}) {
  let parsed;
  try {
    parsed = typeof rawJson === "string" ? JSON.parse(rawJson) : rawJson;
  } catch {
    throw new Error("File is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("File does not contain a configuration object");

  const warnings = [];

  if (!isPlainObject(parsed.payload) || typeof parsed.formatVersion !== "number") {
    return {
      legacy: true,
      warnings: [
        "This file has no format header — it was written by an older version.",
        "It is read as a full transfer, because older exports always contained credentials. Do not share it.",
      ],
      payload: parsed,
      envelope: {
        formatVersion: 0,
        exportedAt: null,
        sourceVersion,
        mode: "full",
        includesSecrets: true,
        includesRouterKeys: true,
        payload: parsed,
      },
    };
  }

  if (parsed.formatVersion > TRANSFER_FORMAT_VERSION) {
    warnings.push(
      `File was written by a newer version (format ${parsed.formatVersion}, this build understands ${TRANSFER_FORMAT_VERSION}). Unknown fields will be ignored.`
    );
  }
  if (parsed.mode && !TRANSFER_MODES.includes(parsed.mode)) {
    throw new Error(`Unknown mode in file: ${parsed.mode}`);
  }

  return {
    legacy: false,
    warnings,
    payload: parsed.payload,
    envelope: { ...parsed, sourceVersion: parsed.sourceVersion || sourceVersion },
  };
}

/**
 * Freshness fields that must not travel with a refresh token.
 *
 * `refreshToken` is single-use: OpenAI rotates it on every refresh, and reusing
 * an already-consumed one gets the whole session revoked (see the note in
 * src/sse/services/tokenRefresh.js). A file that carried a timestamp would, on a
 * machine where that token has since been rotated, present itself as needing a
 * refresh and burn a token that was already spent.
 */
export function scrubTokenFreshness(connection) {
  const out = { ...connection };
  delete out.expiresAt;
  delete out.tokenExpiresAt;
  delete out.lastRefreshAt;
  return out;
}

/** Identity for deciding whether an incoming pool duplicates an existing one. */
export function poolIdentity(pool) {
  const strip = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
  return `${strip(pool.proxyUrl)}|${strip(pool.noProxy)}`;
}

/** A short, non-identifying description of what a payload holds, for the UI. */
export function describeTransfer(envelope) {
  const p = envelope.payload || {};
  const parts = [
    `${(p.providerConnections || []).length} connection(s)`,
    `${(p.combos || []).length} combo(s)`,
    `${Object.keys(p.modelAliases || {}).length} alias(es)`,
  ];
  return {
    secrets: Boolean(envelope.includesSecrets),
    routerKeys: Boolean(envelope.includesRouterKeys),
    summary: parts.join(", "),
  };
}

export { stringifyJson, parseJson };