import { NextResponse } from "next/server";
import { getInstallLogTail } from "@/lib/pxpipe/install.js";

export const dynamic = "force-dynamic";

// Installation log only. This route used to also return the per-request
// compression events, which were a per-request file write feeding a savings
// panel whose numbers were estimates of estimates — removed with the rest of
// that reporting.
export async function GET() {
  try {
    return NextResponse.json({ installLog: getInstallLogTail() });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}