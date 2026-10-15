import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import { seal, open } from "@/lib/secretBox";

export const MCP_TRANSPORTS = ["http", "sse"];
export const MCP_AUTH_TYPES = ["none", "bearer", "header"];

function rowToServer(row, { withToken = false } = {}) {
  if (!row) return null;
  const extra = parseJson(row.data, {});
  const { authTokenEnc, ...rest } = extra;
  const server = {
    ...rest,
    id: row.id,
    isActive: row.isActive === 1 || row.isActive === true,
    testStatus: row.testStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    hasToken: Boolean(authTokenEnc),
  };
  // The sealed blob is never part of a serialized server. Callers that need it
  // opt in via withToken and still only get the ciphertext — decryption belongs
  // to resolveMcpServerForProxy, so an accidental JSON.stringify cannot leak a
  // usable credential.
  if (withToken) server.authTokenEnc = authTokenEnc || null;
  return server;
}

function serverToRow(s) {
  const { id, isActive, testStatus, createdAt, updatedAt, hasToken, authTokenEnc, ...rest } = s;
  return {
    id,
    isActive: isActive === false ? 0 : 1,
    testStatus: testStatus ?? null,
    data: stringifyJson(authTokenEnc ? { ...rest, authTokenEnc } : rest),
    createdAt,
    updatedAt,
  };
}

function upsert(db, s) {
  const r = serverToRow(s);
  db.run(
    `INSERT INTO mcpServers(id, isActive, testStatus, data, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       isActive=excluded.isActive, testStatus=excluded.testStatus,
       data=excluded.data, updatedAt=excluded.updatedAt`,
    [r.id, r.isActive, r.testStatus, r.data, r.createdAt, r.updatedAt]
  );
}

/** Always re-read after a write: rowToServer expects a database row, not a
 *  hand-built object, and returning the stored row keeps the caller's view
 *  identical to what a later read would produce. */
function readRow(db, id) {
  const row = db.get(`SELECT * FROM mcpServers WHERE id = ?`, [id]);
  return row ? rowToServer(row) : null;
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

/**
 * Whitelist the fields an operator may set. Anything absent here (notably
 * `authTokenEnc`) is dropped, so a request body cannot inject a sealed blob or
 * rewrite bookkeeping fields directly.
 */
export function normalizeMcpServerInput(body = {}, existing = null) {
  const transport = pickEnum(body.transport, MCP_TRANSPORTS, existing?.transport || "http");
  const authType = pickEnum(body.authType, MCP_AUTH_TYPES, existing?.authType || "none");
  const rawUrl = typeof body.url === "string" ? body.url.trim() : existing?.url || "";

  return {
    name: (typeof body.name === "string" ? body.name.trim() : existing?.name) || "",
    url: rawUrl,
    transport,
    authType,
    authHeader: authType === "header"
      ? ((typeof body.authHeader === "string" && body.authHeader.trim()) || existing?.authHeader || "Authorization")
      : null,
    // A blank token on update means "keep what is stored" — the dashboard sends
    // `hasToken` back and must not wipe the credential by rendering an empty field.
    authToken: typeof body.authToken === "string" && body.authToken.trim() !== ""
      ? body.authToken
      : (existing?.authToken ?? null),
    allowLocal: typeof body.allowLocal === "boolean" ? body.allowLocal : (existing?.allowLocal === true),
    isActive: typeof body.isActive === "boolean" ? body.isActive : existing?.isActive !== false,
  };
}

export function validateMcpServerInput(input) {
  const errors = [];
  if (!input.name) errors.push("name is required");
  if (!input.url) errors.push("url is required");
  else {
    let parsed;
    try {
      parsed = new URL(input.url);
    } catch {
      errors.push("url is not a valid URL");
    }
    if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      errors.push("url must use http or https");
    }
  }
  if (input.authType === "header" && !input.authHeader) {
    errors.push("authHeader is required when authType is header");
  }
  return errors;
}

export async function getMcpServers(filter = {}) {
  const db = await getAdapter();
  const where = [];
  const params = [];
  if (filter.isActive !== undefined) { where.push("isActive = ?"); params.push(filter.isActive ? 1 : 0); }
  if (filter.testStatus) { where.push("testStatus = ?"); params.push(filter.testStatus); }
  const sql = `SELECT * FROM mcpServers${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
  const list = db.all(sql, params).map((row) => rowToServer(row));
  list.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));
  return list;
}

export async function getMcpServerById(id) {
  const db = await getAdapter();
  return rowToServer(db.get(`SELECT * FROM mcpServers WHERE id = ?`, [id]));
}

export async function createMcpServer(body) {
  const input = normalizeMcpServerInput(body);
  const errors = validateMcpServerInput(input);
  if (errors.length) return { ok: false, errors };

  const db = await getAdapter();
  const now = new Date().toISOString();
  const sealedToken = input.authToken ? await seal(input.authToken) : null;
  const server = {
    id: uuidv4(),
    ...input,
    authToken: undefined,
    authTokenEnc: sealedToken,
    testStatus: "unknown",
    createdAt: now,
    updatedAt: now,
  };
  upsert(db, server);
  return { ok: true, server: readRow(db, server.id) };
}

export async function updateMcpServer(id, body) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM mcpServers WHERE id = ?`, [id]);
  if (!row) return null;

  const existing = rowToServer(row, { withToken: true });
  const input = normalizeMcpServerInput(body, existing);
  const errors = validateMcpServerInput(input);
  if (errors.length) return { ok: false, errors };

  // Sealing is async, so it cannot live inside db.transaction — its callback is
  // synchronous. The single upsert below is atomic on its own, so nothing is lost.
  const sealedToken = input.authToken ? await seal(input.authToken) : existing.authTokenEnc || null;
  const merged = {
    ...existing,
    ...input,
    authToken: undefined,
    authTokenEnc: sealedToken,
    updatedAt: new Date().toISOString(),
  };
  upsert(db, merged);
  return { ok: true, server: readRow(db, id) };
}

export async function deleteMcpServer(id) {
  const db = await getAdapter();
  let removed = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM mcpServers WHERE id = ?`, [id]);
    if (!row) return;
    removed = rowToServer(row);
    db.run(`DELETE FROM mcpServers WHERE id = ?`, [id]);
  });
  return removed;
}

export async function setMcpServerTestStatus(id, testStatus, lastError = null) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM mcpServers WHERE id = ?`, [id]);
  if (!row) return null;
  const merged = {
    ...rowToServer(row, { withToken: true }),
    testStatus,
    lastError,
    lastTestedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.run(`UPDATE mcpServers SET testStatus = ?, data = ?, updatedAt = ? WHERE id = ?`, [
    testStatus,
    serverToRow(merged).data,
    merged.updatedAt,
    id,
  ]);
  return readRow(db, id);
}

/**
 * Everything the proxy needs to reach the upstream, token decrypted.
 *
 * Only the proxy route calls this. If the sealed token cannot be opened — a
 * database moved to another host, where the sealing key is machine-bound — the
 * result carries `tokenError` so the caller can say the token must be re-entered
 * instead of silently calling the upstream without credentials.
 */
export async function resolveMcpServerForProxy(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM mcpServers WHERE id = ?`, [id]);
  if (!row) return null;
  const server = rowToServer(row, { withToken: true });
  if (!server.isActive) return { disabled: true, id };

  const headers = {};
  let tokenError = null;
  if (server.authTokenEnc) {
    const token = await open(server.authTokenEnc);
    if (token) {
      const name = server.authType === "bearer" ? "Authorization" : server.authHeader || "Authorization";
      headers[name] = server.authType === "bearer" ? `Bearer ${token}` : token;
    } else {
      tokenError = "token could not be decrypted on this machine — re-enter it";
    }
  }

  return {
    id: server.id,
    name: server.name,
    url: server.url,
    transport: server.transport,
    allowLocal: server.allowLocal === true,
    headers,
    tokenError,
  };
}