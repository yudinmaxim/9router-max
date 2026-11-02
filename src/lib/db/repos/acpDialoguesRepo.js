import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

function rowToDialogue(row) {
  if (!row) return null;
  return {
    ...parseJson(row.data, {}),
    id: row.id,
    cwd: row.cwd,
    provider: row.provider,
    currentModel: row.currentModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getAcpDialogueById(id) {
  const db = await getAdapter();
  return rowToDialogue(db.get("SELECT * FROM acpDialogues WHERE id = ?", [id]));
}

export async function getAcpDialogues({ cwd } = {}) {
  const db = await getAdapter();
  const rows = cwd
    ? db.all("SELECT * FROM acpDialogues WHERE cwd = ? ORDER BY updatedAt DESC", [cwd])
    : db.all("SELECT * FROM acpDialogues ORDER BY updatedAt DESC");
  return rows.map(rowToDialogue);
}

export async function upsertAcpDialogue(dialogue) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const existing = db.get("SELECT createdAt FROM acpDialogues WHERE id = ?", [dialogue.id]);
  const row = {
    id: dialogue.id,
    cwd: dialogue.cwd || null,
    provider: dialogue.provider || null,
    currentModel: dialogue.currentModel || null,
    data: stringifyJson({ transcript: dialogue.transcript || [] }),
    createdAt: existing?.createdAt || dialogue.createdAt || now,
    updatedAt: now,
  };
  db.run(`INSERT INTO acpDialogues(id, cwd, provider, currentModel, data, createdAt, updatedAt)
    VALUES(?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET cwd=excluded.cwd, provider=excluded.provider,
    currentModel=excluded.currentModel, data=excluded.data, updatedAt=excluded.updatedAt`,
  [row.id, row.cwd, row.provider, row.currentModel, row.data, row.createdAt, row.updatedAt]);
  return rowToDialogue(db.get("SELECT * FROM acpDialogues WHERE id = ?", [row.id]));
}

export async function deleteAcpDialogue(id) {
  const db = await getAdapter();
  db.run("DELETE FROM acpDialogues WHERE id = ?", [id]);
}
