import { NextResponse } from "next/server";
import { exportDb, getSettings, importDb } from "@/lib/localDb";
import { buildTransfer, parseTransferFile, TRANSFER_MODES, IMPORT_STRATEGIES } from "@/lib/db/transfer";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";
import { verifyDashboardPassword } from "@/lib/auth/dashboardSession";
import { getAppVersion } from "@/lib/db/version.js";

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const PASSWORD_HEADER = "x-9r-password";

// CLI token requests are already trusted (local machine); skip password re-auth.
function isCliRequest(request) {
  return Boolean(request.headers.get(CLI_TOKEN_HEADER));
}

function boolParam(value, fallback = false) {
  if (value === null || value === undefined || value === "") return fallback;
  return value === "1" || value === "true" || value === true;
}

export async function GET(request) {
  try {
    if (!isCliRequest(request) && !(await verifyDashboardPassword(request.headers.get(PASSWORD_HEADER)))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }
    // Config-only by default. The old behaviour — every secret, no envelope —
    // is one `mode=full` away, but a download link in a browser address bar
    // should not be the thing that silently hands out credentials.
    const url = new URL(request.url);
    const mode = url.searchParams.get("mode") || "config";
    if (!TRANSFER_MODES.includes(mode)) {
      return NextResponse.json({ error: `Unknown mode: ${mode}` }, { status: 400 });
    }
    const raw = await exportDb();
    return NextResponse.json(
      buildTransfer(raw, {
        mode,
        includeRouterKeys: boolParam(url.searchParams.get("includeRouterKeys")),
        sourceVersion: getAppVersion(),
      })
    );
  } catch (error) {
    console.log("Error exporting database:", error);
    return NextResponse.json({ error: "Failed to export database" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const { password, strategy = "replace" } = body || {};
    if (!IMPORT_STRATEGIES.includes(strategy)) {
      return NextResponse.json({ error: `Unknown import strategy: ${strategy}` }, { status: 400 });
    }

    if (!isCliRequest(request) && !(await verifyDashboardPassword(password))) {
      return NextResponse.json({ error: "Invalid password" }, { status: 401 });
    }

    const { envelope, payload, legacy, warnings } = parseTransferFile(body.file ?? body, {
      sourceVersion: getAppVersion(),
    });

    await importDb(payload, { strategy, carriesSecrets: envelope.includesSecrets === true });

    // Ensure proxy settings take effect immediately after a DB import.
    try {
      const settings = await getSettings();
      applyOutboundProxyEnv(settings);
    } catch (err) {
      console.warn("[Settings][DatabaseImport] Failed to re-apply outbound proxy env:", err);
    }

    return NextResponse.json({
      success: true,
      strategy,
      legacy,
      mode: envelope.mode,
      warnings,
    });
  } catch (error) {
    console.log("Error importing database:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to import database" },
      { status: 400 }
    );
  }
}