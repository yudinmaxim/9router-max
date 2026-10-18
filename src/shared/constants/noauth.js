/**
 * The synthetic connection id used for no-auth providers.
 *
 * A no-auth provider — every ACP agent, and devin-cli — has no row in
 * `providerConnections`, so the engine is handed a made-up account instead. The id
 * lives here rather than in `sse/services/auth.js` because the usage tracker also
 * needs to recognise it: it is the key its per-account map is written under, and
 * the one value that must never reach the database as a real connection.
 */
export const NOAUTH_CONNECTION_ID = "noauth";

/** What that account is called when something shows it to a human. */
export const NOAUTH_ACCOUNT_NAME = "Local agent";