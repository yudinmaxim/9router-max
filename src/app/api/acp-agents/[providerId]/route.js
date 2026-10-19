import { NextResponse } from "next/server";
import { PROVIDERS } from "open-sse/config/providers.js";
import { getExecutor } from "open-sse/executors/index.js";
import { resolveInstalledBin } from "open-sse/executors/lib/acpStatus.js";
import { readCachedCatalog } from "open-sse/executors/lib/acpCatalog.js";
import {
  getAcpAgentSettings,
  saveAcpAgentSettings,
  sanitizeDefaults,
} from "@/lib/acpAgents";

export const dynamic = "force-dynamic";

function isAcpProvider(providerId) {
  // An executor that publishes a local-agent spec is the authority — devin-cli
  // qualifies without carrying the `-acp` suffix.
  return Boolean(PROVIDERS[providerId]) && Boolean(getExecutor(providerId)?.acp);
}

/** GET /api/acp-agents/<id> — current choices plus the catalog they refer to. */
export async function GET(request, { params }) {
  const { providerId } = await params;
  try {
    if (!isAcpProvider(providerId)) {
      return NextResponse.json({ error: `${providerId} is not an ACP agent` }, { status: 400 });
    }
    const saved = await getAcpAgentSettings(providerId);
    const spec = getExecutor(providerId)?.acp;
    return NextResponse.json({
      providerId,
      ...saved,
      catalog: readCachedCatalog(providerId),
      installed: Boolean(spec && resolveInstalledBin(spec)),
    });
  } catch (error) {
    console.log("Error reading ACP agent settings:", error);
    return NextResponse.json({ error: "Failed to read settings" }, { status: 500 });
  }
}

/**
 * PUT /api/acp-agents/<id>  { enabledModels?: string[], defaults?: object }
 *
 * `enabledModels` is the user's choice of what the agent offers to publish;
 * `null` restores the static registry list. `defaults` is pinned on every new
 * ACP session by the executor.
 */
export async function PUT(request, { params }) {
  const { providerId } = await params;
  try {
    if (!isAcpProvider(providerId)) {
      return NextResponse.json({ error: `${providerId} is not an ACP agent` }, { status: 400 });
    }

    const body = await request.json().catch(() => ({}));
    const patch = {};

    if (body.enabledModels !== undefined) {
      if (body.enabledModels === null) {
        patch.enabledModels = null;
      } else if (Array.isArray(body.enabledModels)) {
        const models = body.enabledModels.filter((m) => typeof m === "string" && m.trim());
        // Only publish ids the agent actually advertises — otherwise /v1/models
        // grows entries that fail at call time with a model-not-found.
        const known = new Set((readCachedCatalog(providerId)?.models || []).map((m) => m.id));
        patch.enabledModels = known.size
          ? models.filter((m) => known.has(m))
          : models;
      } else {
        return NextResponse.json({ error: "enabledModels must be an array or null" }, { status: 400 });
      }
    }

    if (body.defaults !== undefined) {
      patch.defaults = sanitizeDefaults(body.defaults);
    }

    if (!Object.keys(patch).length) {
      return NextResponse.json({ error: "nothing to save" }, { status: 400 });
    }

    const saved = await saveAcpAgentSettings(providerId, patch);
    return NextResponse.json({ providerId, ...saved });
  } catch (error) {
    console.log("Error saving ACP agent settings:", error);
    return NextResponse.json({ error: "Failed to save settings" }, { status: 500 });
  }
}