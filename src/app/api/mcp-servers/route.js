import { NextResponse } from "next/server";
import { createMcpServer, getMcpServers } from "@/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toBoolean(value) {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

// GET /api/mcp-servers - list every registered MCP server
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const isActive = toBoolean(searchParams.get("isActive"));
    const filter = {};
    if (isActive !== undefined) filter.isActive = isActive;

    const mcpServers = await getMcpServers(filter);
    return NextResponse.json({ mcpServers });
  } catch (error) {
    console.log("Error listing mcp servers:", error);
    return NextResponse.json({ error: "Failed to list MCP servers" }, { status: 500 });
  }
}

// POST /api/mcp-servers - register a server
export async function POST(request) {
  try {
    const body = await request.json();
    const result = await createMcpServer(body);
    if (!result.ok) {
      return NextResponse.json({ error: result.errors.join(", "), errors: result.errors }, { status: 400 });
    }
    return NextResponse.json({ mcpServer: result.server }, { status: 201 });
  } catch (error) {
    console.log("Error creating mcp server:", error);
    return NextResponse.json({ error: "Failed to create MCP server" }, { status: 500 });
  }
}