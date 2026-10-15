import { NextResponse } from "next/server";
import { resolveMcpServerForProxy, setMcpServerTestStatus } from "@/models";
import { probeMcpServer } from "@/lib/mcp/client.js";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function verdict(result) {
  if (result.blocked) return { status: "error", error: "URL not allowed" };
  if (result.requiresAuth) return { status: "error", error: "server requires authentication — check the token" };
  if (result.error === "no-response") return { status: "error", error: "no response from server" };
  if (result.error === "unsupported-transport") return { status: "error", error: "unsupported transport" };
  if (result.error) return { status: "error", error: result.error };
  return { status: "ok", error: null };
}

// POST /api/mcp-servers/:id/test — initialize → notifications/initialized → tools/list
// against the stored URL and credential, so the operator can tell a wrong token
// from a wrong URL before any agent ever sees the server.
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const target = await resolveMcpServerForProxy(id);
    if (!target) {
      return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    }
    if (target.disabled) {
      return NextResponse.json({ error: "MCP server is disabled" }, { status: 409 });
    }
    if (target.tokenError) {
      await setMcpServerTestStatus(id, "error", target.tokenError);
      return NextResponse.json({ error: target.tokenError, tools: [] }, { status: 400 });
    }

    // Self-hosted Jira/Confluence live on the operator's own network, which is
    // exactly what the guard blocks — hence the per-server allowLocal flag
    // instead of a blanket exemption.
    if (!target.allowLocal) {
      try {
        assertPublicUrl(target.url);
      } catch {
        await setMcpServerTestStatus(id, "error", "URL not allowed");
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }

    const result = await probeMcpServer({
      url: target.url,
      headers: target.headers,
      transport: target.transport,
      allowLocal: target.allowLocal,
    });

    const { status, error } = verdict(result);
    await setMcpServerTestStatus(id, status, error);
    return NextResponse.json({ ...result, status, error: error || result.error || null });
  } catch (e) {
    return NextResponse.json({ error: e.message, tools: [] }, { status: 500 });
  }
}