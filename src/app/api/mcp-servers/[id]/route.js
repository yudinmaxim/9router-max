import { NextResponse } from "next/server";
import { deleteMcpServer, getMcpServerById, updateMcpServer } from "@/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/mcp-servers/:id
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const mcpServer = await getMcpServerById(id);
    if (!mcpServer) {
      return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    }
    return NextResponse.json({ mcpServer });
  } catch (error) {
    console.log("Error loading mcp server:", error);
    return NextResponse.json({ error: "Failed to load MCP server" }, { status: 500 });
  }
}

// PUT /api/mcp-servers/:id - an absent or blank authToken keeps the stored one
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const body = await request.json();
    const result = await updateMcpServer(id, body);
    if (result === null) {
      return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    }
    if (!result.ok) {
      return NextResponse.json({ error: result.errors.join(", "), errors: result.errors }, { status: 400 });
    }
    return NextResponse.json({ mcpServer: result.server });
  } catch (error) {
    console.log("Error updating mcp server:", error);
    return NextResponse.json({ error: "Failed to update MCP server" }, { status: 500 });
  }
}

// DELETE /api/mcp-servers/:id
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const removed = await deleteMcpServer(id);
    if (!removed) {
      return NextResponse.json({ error: "MCP server not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, mcpServer: removed });
  } catch (error) {
    console.log("Error deleting mcp server:", error);
    return NextResponse.json({ error: "Failed to delete MCP server" }, { status: 500 });
  }
}