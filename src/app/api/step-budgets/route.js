import { NextResponse } from "next/server";
import { getStepBudgets, removeStepBudget, setStepBudget } from "@/sse/services/stepBudget.js";

export const dynamic = "force-dynamic";

// Declared step budgets and their live counters. A budget is inert until
// declared here: with nothing declared the gate spends nothing and every request
// behaves exactly as it did before the feature existed.

// GET /api/step-budgets - declared budgets with usage and reset time
export async function GET() {
  try {
    const budgets = await getStepBudgets();
    return NextResponse.json({ budgets });
  } catch (error) {
    console.error("Error fetching step budgets:", error);
    return NextResponse.json({ error: "Failed to fetch step budgets" }, { status: 500 });
  }
}

// POST /api/step-budgets - declare or change a budget
//   { scope: "key:<id>" | "provider:<id>" | "global", limitSteps, windowMs? }
// limitSteps 0 removes the budget, which is the honest way to express "no
// limit": a stored ceiling of zero would refuse every step, not none.
export async function POST(request) {
  try {
    const body = await request.json();
    const { scope, limitSteps, windowMs } = body;

    if (!scope) {
      return NextResponse.json({ error: "scope is required" }, { status: 400 });
    }
    if (limitSteps === undefined || limitSteps === null) {
      return NextResponse.json({ error: "limitSteps is required" }, { status: 400 });
    }

    const result = await setStepBudget({ scope, limitSteps, windowMs });
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status || 400 });
    }
    return NextResponse.json({ budget: result.budget });
  } catch (error) {
    console.error("Error setting step budget:", error);
    return NextResponse.json({ error: "Failed to set step budget" }, { status: 500 });
  }
}

// DELETE /api/step-budgets?scope=global — remove a budget
export async function DELETE(request) {
  try {
    const scope = new URL(request.url).searchParams.get("scope");
    if (!scope) {
      return NextResponse.json({ error: "scope is required" }, { status: 400 });
    }
    const result = await removeStepBudget(scope);
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status || 400 });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("Error removing step budget:", error);
    return NextResponse.json({ error: "Failed to remove step budget" }, { status: 500 });
  }
}