import { NextResponse } from "next/server";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveInstalledBin } from "open-sse/executors/lib/acpStatus.js";
import { getAcpCatalog } from "open-sse/executors/lib/acpCatalog.js";
import { isProviderDisabled } from "@/lib/disabledProviders.js";

export const dynamic = "force-dynamic";
// A cold probe spawns the agent and walks its handshake.
export const maxDuration = 60;

function isAcpProvider(providerId) {
  // An executor that publishes a local-agent spec is the authority — devin-cli
  // qualifies without carrying the `-acp` suffix.
  return Boolean(PROVIDERS[providerId]) && Boolean(getExecutor(providerId)?.acp);
}

/**
 * GET /api/acp-agents/<id>/catalog         — cached catalog, probing only when stale/missing
 * GET /api/acp-agents/<id>/catalog?sync=1  — force a live probe (the Sync button)
 *
 * The catalog is what the agent itself advertises in `session/new`, so it is
 * reported as-is: `models` plus the knobs the agent exposes. Which models get
 * published to /v1/models is the user's call — see PUT /api/acp-agents/<id>.
 */
export async function GET(request, { params }) {
  const { providerId } = await params;
  try {
    if (!isAcpProvider(providerId)) {
      return NextResponse.json({ error: `${providerId} is not an ACP agent` }, { status: 400 });
    }

    if (isProviderDisabled(providerId)) {
      return NextResponse.json({ error: `Provider ${providerId} is disabled` }, { status: 403 });
    }

    const spec = getExecutor(providerId)?.acp;
    if (!spec) {
      return NextResponse.json({ error: `No ACP executor registered for ${providerId}` }, { status: 404 });
    }

    const sync = new URL(request.url).searchParams.get("sync") === "1";
    const bin = resolveInstalledBin(spec);
    if (!bin) {
      return NextResponse.json(
        { error: `${spec.exe} is not installed on this machine`, detail: spec.installHint || null },
        { status: 409 },
      );
    }

    const extraEnv = typeof spec.env === "function" ? spec.env() : spec.env || {};
    const catalog = await getAcpCatalog(providerId, spec, bin, extraEnv, { force: sync });
    return NextResponse.json(catalog);
  } catch (error) {
    console.log("Error reading ACP catalog:", error);
    return NextResponse.json({ error: error.message || "Failed to read the agent catalog" }, { status: 502 });
  }
}