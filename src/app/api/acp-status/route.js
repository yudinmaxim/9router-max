import { NextResponse } from "next/server";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";
import { probeAcpAgent, ACP_STATUS, clearAcpStatusCache, clearAcpVerdict } from "open-sse/executors/lib/acpStatus.js";
import { installAcpAdapter, getAdapterInstallInfo } from "open-sse/executors/lib/acpAdapter.js";
import { isProviderDisabled } from "@/lib/disabledProviders.js";

export const dynamic = "force-dynamic";
// npm install of an adapter is a real install, not a cache read.
export const maxDuration = 300;

// Every provider that runs a local agent process. Keyed off the executor's own
// spec rather than an id suffix: devin-cli speaks the same protocol but keeps
// its own executor, and a suffix check silently excluded it — which is how it
// ended up with a badge nothing ever updates.
const ACP_PROVIDERS = Object.keys(PROVIDERS).filter((id) => Boolean(specFor(id))).sort();

function specFor(id) {
  return getExecutor(id)?.acp;
}

/**
 * GET /api/acp-status         — cheap: is each agent installed?
 * GET /api/acp-status?probe=1 — deep: spawn each agent and complete the ACP
 *                                `initialize` handshake (cached briefly).
 */
export async function GET(request) {
  const deep = new URL(request.url).searchParams.get("probe") === "1";
  try {
    const providers = await Promise.all(
      ACP_PROVIDERS.map(async (id) => {
        const spec = specFor(id);
        if (!spec) {
          return {
            providerId: id,
            status: ACP_STATUS.VERIFYING,
            bin: null,
            resolvedPath: null,
            detail: "no ACP executor registered for this provider",
            checkedAt: Date.now(),
          };
        }
        return probeAcpAgent({ ...spec, providerId: id }, { deep });
      }),
    );

    return NextResponse.json({
      deep,
      checkedAt: Date.now(),
      providers,
    });
  } catch (error) {
    console.log("Error probing ACP agents:", error);
    return NextResponse.json({ error: "Failed to probe ACP agents" }, { status: 500 });
  }
}

/**
 * POST /api/acp-status  { provider }
 *
 * Installs the ACP adapter an agent needs — Codex ships no `acp` subcommand, so
 * a bridge package stands in for it — then re-probes. Idempotent: a provider
 * whose adapter is already present re-installs nothing harmful, so the dashboard
 * button is safe to press twice.
 */
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));
    const providerId = String(body.provider || "").trim();

    if (isProviderDisabled(providerId)) {
      return NextResponse.json({ error: `Provider ${providerId} is disabled` }, { status: 403 });
    }

    if (!ACP_PROVIDERS.includes(providerId)) {
      return NextResponse.json(
        { error: `Unknown ACP provider: ${providerId || "(missing)"}` },
        { status: 400 },
      );
    }

    const spec = specFor(providerId);
    if (!spec?.adapter) {
      return NextResponse.json(
        { error: `${providerId} runs its own ACP subcommand — nothing to install` },
        { status: 400 },
      );
    }

    const installed = await installAcpAdapter(spec.adapter);
    // A fresh answer beats a cached "missing" that would keep the badge amber.
    clearAcpStatusCache();
    // The verdict measured before the install describes a different binary, so
    // drop it too — otherwise the badge would report "Not working" for up to
    // the verdict TTL on an agent that now works.
    clearAcpVerdict(providerId);

    const status = await probeAcpAgent({ ...spec, providerId }, { deep: false });
    return NextResponse.json({
      installed,
      adapter: getAdapterInstallInfo(spec.adapter),
      status,
    });
  } catch (error) {
    console.log("Error installing ACP adapter:", error);
    return NextResponse.json({ error: "Failed to install the ACP adapter" }, { status: 500 });
  }
}