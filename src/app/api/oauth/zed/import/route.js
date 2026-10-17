import { NextResponse } from "next/server";

/**
 * POST /api/oauth/zed/import
 *
 * Zed is not supported. Every import created another connection for the same
 * account — nothing here looked for an existing one before calling
 * createProviderConnection — so repeatedly importing from the IDE filled the
 * connections list with duplicates of a single Zed login.
 *
 * Answer Gone rather than 404: the route still exists, and a stale UI should be
 * told the truth about why it stopped working. Connections already in the
 * database are left alone; they are removed deliberately, not by re-importing.
 */
export async function POST() {
  return NextResponse.json(
    { error: "Zed connections are no longer supported." },
    { status: 410 }
  );
}