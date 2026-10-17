// Ensure proxyFetch is loaded to patch globalThis.fetch
import "open-sse/index.js";

import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { getUsageForProvider } from "open-sse/services/usage.js";
import { isUnrecoverableRefreshError } from "open-sse/services/tokenRefresh.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveConnectionProxyConfig } from "@/lib/network/connectionProxy";
import { FREE_PROVIDERS, USAGE_APIKEY_PROVIDERS } from "@/shared/constants/providers";

// Detect auth-expired messages returned by usage providers instead of throwing
const AUTH_EXPIRED_PATTERNS = ["expired", "authentication", "unauthorized", "401", "re-authorize"];
function isAuthExpiredMessage(usage) {
  if (!usage?.message) return false;
  const msg = usage.message.toLowerCase();
  return AUTH_EXPIRED_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Refresh credentials using executor and update database
 * @param {boolean} force - Skip needsRefresh check and always attempt refresh
 * @returns Promise<{ connection, refreshed: boolean }>
 */
export async function refreshAndUpdateCredentials(connection, force = false, proxyOptions = null) {
  // Re-read latest tokens: OpenAI rotates the refresh token on every refresh, and
  // refreshing with a stale snapshot (reuse) revokes the whole session → account logout.
  const latest = connection.id ? await getProviderConnectionById(connection.id) : null;
  if (latest) connection = latest;

  const executor = getExecutor(connection.provider);

  // Build credentials object from connection
  const credentials = {
    accessToken: connection.accessToken,
    refreshToken: connection.refreshToken,
    idToken: connection.idToken,
    expiresAt: connection.expiresAt || connection.tokenExpiresAt,
    lastRefreshAt: connection.lastRefreshAt,
    connectionId: connection.id,
    providerSpecificData: connection.providerSpecificData,
    // For GitHub
    copilotToken: connection.providerSpecificData?.copilotToken,
    copilotTokenExpiresAt: connection.providerSpecificData?.copilotTokenExpiresAt,
  };

  // Check if refresh is needed (skip when force=true)
  const needsRefresh = force || executor.needsRefresh(credentials);

  if (!needsRefresh) {
    return { connection, refreshed: false };
  }

  // Use executor's refreshCredentials method (with optional proxy)
  const refreshResult = await executor.refreshCredentials(credentials, console, proxyOptions);

  // Refresh token reused/invalidated — token family is revoked; do not continue with the dead token.
  if (refreshResult && isUnrecoverableRefreshError(refreshResult)) {
    throw new Error("Refresh token invalid or reused. Please re-authorize the connection.");
  }

  if (!refreshResult) {
    // Refresh failed but we still have an accessToken — try with existing token
    if (connection.accessToken) {
      return { connection, refreshed: false };
    }
    throw new Error("Failed to refresh credentials. Please re-authorize the connection.");
  }

  // Build update object
  const now = new Date().toISOString();
  const updateData = {
    updatedAt: now,
  };

  // Update accessToken if present
  if (refreshResult.accessToken) {
    updateData.accessToken = refreshResult.accessToken;
  }

  // Update refreshToken if present
  if (refreshResult.refreshToken) {
    updateData.refreshToken = refreshResult.refreshToken;
  }

  if (refreshResult.idToken) {
    updateData.idToken = refreshResult.idToken;
  }

  if (refreshResult.lastRefreshAt) {
    updateData.lastRefreshAt = refreshResult.lastRefreshAt;
  }

  // Update token expiry
  if (refreshResult.expiresIn) {
    updateData.expiresAt = new Date(Date.now() + refreshResult.expiresIn * 1000).toISOString();
    updateData.expiresIn = refreshResult.expiresIn;
  } else if (refreshResult.expiresAt) {
    updateData.expiresAt = refreshResult.expiresAt;
  }

  // Handle provider-specific data (copilotToken for GitHub, etc.)
  const providerSpecificUpdates = {
    ...(refreshResult.providerSpecificData || {}),
    ...(refreshResult.copilotToken ? { copilotToken: refreshResult.copilotToken } : {}),
    ...(refreshResult.copilotTokenExpiresAt ? { copilotTokenExpiresAt: refreshResult.copilotTokenExpiresAt } : {}),
  };
  if (Object.keys(providerSpecificUpdates).length > 0) {
    updateData.providerSpecificData = {
      ...(connection.providerSpecificData || {}),
      ...providerSpecificUpdates,
    };
  }

  // Update database
  await updateProviderConnection(connection.id, updateData);

  // Return updated connection
  const updatedConnection = {
    ...connection,
    ...updateData,
    providerSpecificData: updateData.providerSpecificData || connection.providerSpecificData,
  };

  return {
    connection: updatedConnection,
    refreshed: true,
  };
}

/**
 * GET /api/usage/[connectionId] - Get usage data for a specific connection
 */
// Server-side quota cache: dedup + short TTL per connection.
//
// The dashboard polls this route on its own interval, and the header chips poll
// it on a second one; without a cache each poll became a round trip to the
// provider. Anthropic's quota endpoint answers 429 when asked too often, so the
// saving is not cosmetic. The shape follows the usage cache in
// open-sse/services/usage/claude.js, and lives on globalThis so a dev reload
// does not start from an empty map mid-flight.
//
// What is cached is the parsed body, never a Response: a Response body can be
// read once, so handing the same object to two callers would break the second.
const USAGE_CACHE_TTL_MS = 60_000;
const usageCache = (globalThis.__n9routerUsageCache ??= new Map());

export async function GET(request, { params }) {
  const { connectionId } = await params;
  const force = new URL(request.url).searchParams.get("force") === "1";

  if (!force && connectionId) {
    const hit = usageCache.get(connectionId);
    // A cached Response would be unreadable for everyone but the first caller.
    if (hit?.body && hit.expiresAt > Date.now()) return Response.json(hit.body);
    if (hit?.promise) return reply(await hit.promise);
  }

  // The last good read, kept for a soft failure — an upstream that blinks should
  // not empty a card that had real numbers a minute ago. Read regardless of
  // `force`: a forced refresh that fails must not also throw away the entry the
  // next ordinary reader would have been served from.
  const previous = (connectionId && usageCache.get(connectionId)?.body) || null;

  const promise = (async () => {
    const res = await resolveUsage(connectionId, force);
    const text = await res.text().catch(() => "");
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON — pass through */ }
    if (connectionId && res.ok && body && !body.error) {
      usageCache.set(connectionId, { body, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
      return { body, status: res.status };
    }
    if (previous) {
      // Put the good read back. Leaving `{ promise }` here instead would pin the
      // resolved error for the whole TTL and every later reader would get it.
      usageCache.set(connectionId, { body: previous, expiresAt: Date.now() + USAGE_CACHE_TTL_MS });
      // A forced refresh reports the failure rather than quietly serving old
      // numbers: the operator asked to see something current.
      if (force) return { raw: text, status: res.status };
      return { body: previous, status: 200 };
    }
    usageCache.delete(connectionId);
    return { raw: text, status: res.status };
  })();

  if (connectionId) usageCache.set(connectionId, { promise });
  return reply(await promise);
}

function reply(out) {
  if (out.body) return Response.json(out.body, { status: out.status });
  return new Response(out.raw || "", { status: out.status, headers: { "Content-Type": "application/json" } });
}

async function resolveUsage(connectionId, force) {
  let connection;
  try {
    // noAuth providers that still have a real usage reader upstream. cursor-acp
// authenticates to Cursor with the account JWT and its quota — plan spend,
// bonus spend, utilization — comes from api2.cursor.sh like any other.
const NOAUTH_USAGE_READERS = ["cursor-acp"];

// Get connection from database
    connection = await getProviderConnectionById(connectionId);
    if (!connection) {
      return Response.json({ error: "Connection not found" }, { status: 404 });
    }

    // The agent providers (cursor-acp, opencode-acp, omp-acp, codex-acp,
    // devin-cli) drive a CLI that runs on the operator's own subscription, so
    // there is no upstream quota to poll — they are neither OAuth nor in the
    // api-key list and used to land in the generic refusal below, which read as
    // a failure rather than as "nothing to report".
    //
    // Only a reason code is returned: the wording belongs to the dashboard, which
    // is localized. An English sentence from here would show up untranslated in
    // every other locale.
    // NoAuth providers normally have nothing to ask upstream — but cursor-acp
    // does: its token is a real Cursor JWT and getCursorUsage already reads
    // included/bonus/total spend from api2.cursor.sh. Short-circuiting here was
    // hiding real billing behind local numbers, so the upstream is tried first
    // and these figures are the fallback, not the answer.
    const isNoAuth = Boolean(FREE_PROVIDERS[connection.provider]?.noAuth);
    const localUsageOf = async (conn) => {
      const { getUsageTotalsForConnection } = await import("@/lib/localDb");
      return {
        ...(await getUsageTotalsForConnection(conn.id, conn.provider)),
        grokWeekly: null,
      };
    };
    const withLocalUsage = async (extra) => {
      return Response.json({
        ...extra,
        quotas: extra.quotas || [],
        plan: extra.plan ?? null,
        localUsage: await localUsageOf(connection, extra.cursorOwnedModels),
      });
    };
    if (isNoAuth && !NOAUTH_USAGE_READERS.includes(connection.provider)) {
      return withLocalUsage({ unsupported: "own-subscription" });
    }

    // Allow OAuth connections, plus whitelisted apikey providers (glm/minimax/kiro/...)
    // Kiro's headless api-key flow persists authType "api_key" (underscore) while
    // generic apikey providers persist "apikey" — accept both spellings here.
    const isOAuth = connection.authType === "oauth";
    const isApikeyAuth =
      connection.authType === "apikey" || connection.authType === "api_key";
    const isApikeyEligible =
      isApikeyAuth && USAGE_APIKEY_PROVIDERS.includes(connection.provider);
    // Same reasoning as the noAuth block further down: cursor-acp holds a real
    // Cursor JWT and api2.cursor.sh serves its spend, so refusing it here on the
    // grounds that it has no api key would hide actual billing.
    const hasNoAuthReader = NOAUTH_USAGE_READERS.includes(connection.provider);

    if (!isOAuth && !isApikeyEligible && !hasNoAuthReader) {
      return Response.json({ message: "Usage not available for this connection" });
    }

    // Resolve connection proxy config; force strictProxy=false so quota/refresh fall back to direct on failure
    const proxyConfig = await resolveConnectionProxyConfig(connection.providerSpecificData);
    const proxyOptions = {
      connectionProxyEnabled: proxyConfig.connectionProxyEnabled === true,
      connectionProxyUrl: proxyConfig.connectionProxyUrl || "",
      connectionNoProxy: proxyConfig.connectionNoProxy || "",
      vercelRelayUrl: proxyConfig.vercelRelayUrl || "",
      strictProxy: false,
    };

    // Refresh credentials only for OAuth connections (apikey has no token refresh)
    if (isOAuth) {
      try {
        const result = await refreshAndUpdateCredentials(connection, false, proxyOptions);
        connection = result.connection;
      } catch (refreshError) {
        console.error("[Usage API] Credential refresh failed:", refreshError);
        return Response.json({
          error: `Credential refresh failed: ${refreshError.message}`
        }, { status: 401 });
      }
    }

    // Fetch usage from provider API
    let usage = await getUsageForProvider(connection, proxyOptions, { force });

    // If provider returned an auth-expired message instead of throwing,
    // force-refresh token and retry once (OAuth only)
    if (isOAuth && isAuthExpiredMessage(usage) && connection.refreshToken) {
      try {
        const retryResult = await refreshAndUpdateCredentials(connection, true, proxyOptions);
        connection = retryResult.connection;
        usage = await getUsageForProvider(connection, proxyOptions, { force });
      } catch (retryError) {
        console.warn(`[Usage] ${connection.provider}: force refresh failed: ${retryError.message}`);
      }
    }

    // When the upstream answered with nothing but a message, the numbers the
    // router recorded are still worth showing — that is the whole point of the
    // card for an agent provider.
    if (isNoAuth && (!usage?.quotas?.length) && usage?.message) {
      return withLocalUsage({
        unsupported: usage.message.includes("not implemented") ? "own-subscription" : "upstream-unavailable",
        upstreamMessage: usage.message,
      });
    }

    return Response.json({
      ...usage,
      localUsage: await localUsageOf(connection, usage.cursorOwnedModels),
    });
  } catch (error) {
    const provider = connection?.provider ?? "unknown";
    console.warn(`[Usage] ${provider}: ${error.message}`);

    // A dead upstream must not empty the card. For an agent provider the
    // router's own history is still true and still useful — throwing away a
    // whole billing panel because Cursor's API blinked is the worse failure.
    if (typeof isNoAuth !== "undefined" && isNoAuth && connection?.id) {
      return Response.json({
        unsupported: "upstream-unavailable",
        upstreamMessage: error.message,
        quotas: [],
        plan: null,
        localUsage: await localUsageOf(connection),
      });
    }

    return Response.json({ error: error.message }, { status: 500 });
  }
}
