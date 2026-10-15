"use server";

import { NextResponse } from "next/server";
import { isLocalRequest } from "@/dashboardGuard";
import { assertPublicUrl } from "@/shared/utils/ssrfGuard.js";
import { probeMcpServer } from "@/lib/mcp/client.js";

// Probe an MCP server: initialize → notifications/initialized → tools/list.
// The protocol itself lives in lib/mcp/client.js; this route only decides who
// is allowed to reach what.
//
// A local caller may probe anything, including MCP servers running on this
// machine — that is the self-hosted case and the reason the SSRF guard has a
// local escape at all. A remote caller is rejected up front by assertPublicUrl,
// so the refusal is a 400 and nothing is fetched at all (#3782); fetchPublic
// then adds DNS resolution and per-hop redirect re-validation on top, which the
// old code lacked because it fetched with bare `fetch` after a single literal
// check. A blocked target arriving as a late failure is still reported as 400,
// so the response does not depend on which layer caught it.
export async function POST(request) {
  try {
    const { url, transport } = await request.json();
    if (!url || typeof url !== "string") {
      return NextResponse.json({ error: "url required" }, { status: 400 });
    }

    const allowLocal = isLocalRequest(request);

    // Reject a malformed URL, and an internal one, before any fetch happens.
    if (!allowLocal) {
      try {
        assertPublicUrl(url);
      } catch {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
      }
    }

    const result = await probeMcpServer({
      url,
      transport: transport === "sse" ? "sse" : undefined,
      allowLocal,
    });

    // fetchPublic refused a target assertPublicUrl let through (a public
    // hostname resolving inward, or a redirect into the private range).
    if (result.blocked) {
      return NextResponse.json({ error: "URL not allowed" }, { status: 400 });
    }
    if (result.error === "no-response" || result.error === "rpc") {
      return NextResponse.json({ error: result.error, tools: [] }, { status: 502 });
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e.message, tools: [] }, { status: 500 });
  }
}