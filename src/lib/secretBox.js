import crypto from "node:crypto";
import { getRawMachineId } from "@/shared/utils/machineId";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;
const SALT = "9router-secretbox-v1";
const PREFIX = "v1";

let cachedKey = null;

/**
 * Derive the sealing key from the persisted machine id.
 *
 * `getRawMachineId` reads `DATA_DIR/machine-id` (mode 0600) rather than calling
 * `machineIdSync()` directly, because the latter can return different values
 * across runtimes — the dashboard, the CLI and the middleware must agree or a
 * value sealed by one could not be opened by another.
 *
 * The consequence is deliberate and worth knowing: the key is machine-bound. A
 * database copied to a different host yields `open() === null`, not garbage, so
 * the caller can report "this token needs re-entering" instead of silently
 * calling an upstream with a wrong secret.
 */
async function deriveKey() {
  if (cachedKey) return cachedKey;
  const raw = await getRawMachineId();
  cachedKey = crypto.createHash("sha256").update(`${raw}:${SALT}`).digest();
  return cachedKey;
}

/** Test seam: drop the memoised key so a different DATA_DIR takes effect. */
export function resetSecretBoxKey() {
  cachedKey = null;
}

/**
 * @param {string} plaintext
 * @returns {Promise<string|null>} `v1:iv:tag:ciphertext`, or null if unsealable
 */
export async function seal(plaintext) {
  if (typeof plaintext !== "string" || plaintext === "") return null;
  try {
    const key = await deriveKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${PREFIX}:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${body.toString("hex")}`;
  } catch {
    return null;
  }
}

/**
 * @param {string} sealed
 * @returns {Promise<string|null>} plaintext, or null when absent/tampered/unreadable
 */
export async function open(sealed) {
  if (typeof sealed !== "string" || sealed === "") return null;
  const parts = sealed.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) return null;
  try {
    const key = await deriveKey();
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivHex, "hex"));
    decipher.setAuthTag(Buffer.from(tagHex, "hex"));
    return decipher.update(Buffer.from(dataHex, "hex")) + decipher.final("utf8");
  } catch {
    return null;
  }
}

/**
 * Cheap shape check used before paying for a decrypt — lets a caller tell an
 * unsealed legacy value from a sealed one it simply cannot read.
 */
export function looksSealed(value) {
  return typeof value === "string" && /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/.test(value);
}