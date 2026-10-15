import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DATA_DIR } from "@/lib/dataDir";

const KEY_FILE = path.join(DATA_DIR, "mcp-proxy-key");
const HEADER = "x-9r-mcp-key";

let cached = null;

/**
 * Shared secret for the MCP proxy.
 *
 * The agents we spawn are local processes running as this user, so the key is
 * not a defence against them — they could read the database directly. It exists
 * because the proxy must not become an unauthenticated open relay: without it,
 * anything able to reach this port could borrow the operator's Jira credential.
 * The same reasoning as the CLI token in @/shared/utils/machineId.
 *
 * Persisted at mode 0600 on first use, so a restart does not invalidate the
 * URLs already handed to live agent sessions.
 */
export function getMcpProxyKey() {
  if (cached) return cached;
  try {
    const fromFile = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (fromFile) {
      cached = fromFile;
      return cached;
    }
  } catch {}
  cached = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEY_FILE, cached, { mode: 0o600 });
  } catch {}
  return cached;
}

/**
 * Constant-time compare: a timing oracle on this key would be a local-only
 * leak, but the comparison is free and there is no reason to be sloppy about it.
 */
export function isMcpProxyKeyValid(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const expected = getMcpProxyKey();
  const a = Buffer.from(candidate);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export { HEADER as MCP_PROXY_KEY_HEADER };

/** Test seam: forget the memoised key so a new DATA_DIR takes effect. */
export function resetMcpProxyKey() {
  cached = null;
}