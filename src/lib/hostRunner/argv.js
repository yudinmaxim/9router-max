/**
 * Command-line string ⇄ argv helpers for the host-runner whitelist.
 *
 * Pure (no fs) so both the API route and the dashboard client can use the
 * same parser — the UI must not be able to write an `argv` shape the daemon
 * would reject later.
 */

/**
 * Split a command line into argv, honouring single and double quotes.
 *
 * Quotes are stripped (`php -l "my file.php"` → ["php", "-l", "my file.php"]).
 * An unterminated quote or a backslash at the very end is a syntax error
 * rather than a silently truncated command — a half-parsed whitelist entry is
 * exactly the kind of surprise that must not reach the daemon.
 *
 * @param {string} input
 * @returns {string[]}
 */
export function parseCommandLine(input) {
  const text = String(input ?? "").trim();
  if (!text) return [];

  const argv = [];
  let current = "";
  let quote = null;
  let started = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        current += text[++i];
      } else {
        current += ch;
      }
      started = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === "\\") {
      if (i + 1 >= text.length) throw new Error("trailing backslash in command");
      current += text[++i];
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) {
        argv.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }

  if (quote) throw new Error(`unterminated ${quote === '"' ? "double" : "single"} quote`);
  if (started) argv.push(current);
  return argv;
}

/** Inverse of {@link parseCommandLine}; re-quotes anything with a space. */
export function formatArgv(argv) {
  return (Array.isArray(argv) ? argv : [])
    .map((part) => (/[\s"'\\]/.test(String(part)) ? JSON.stringify(String(part)) : String(part)))
    .join(" ");
}
