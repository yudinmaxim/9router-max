// Model tiers for the quota bars.
//
// "Simple vs complex" has no meaning in the codebase — no provider names its
// models that way — so the split is derived from the price we already hold for
// each model rather than guessed from its name. A name-based rule would put
// gemini-flash next to gpt-mini by spelling and misplace every future model.
//
// The threshold is the only judgement call here: $1 per million input tokens.
// Models at or below it are "simple", above it "complex". It is a constant and
// not a heuristic so changing the cut is one edit, visible in the diff.
//
// Grok is a third bar rather than a fourth tier: its weekly allowance is a quota
// the provider reports, not a price, so it cannot be folded into the other two.

export const SIMPLE_MAX_INPUT_PRICE = 1.0;

/** @returns {"simple"|"complex"|"unknown"} */
export function classifyByPrice(pricing) {
  if (!pricing || typeof pricing.input !== "number") return "unknown";
  return pricing.input <= SIMPLE_MAX_INPUT_PRICE ? "simple" : "complex";
}

export function emptyTier() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, models: [] };
}

/**
 * Roll a per-model split into the three bars.
 *
 * `grok` is recognised by name because it is not a price tier — it is a separate
 * weekly allowance — so it has to be pulled out by identity instead of by cost.
 */
export function rollUpTiers(models) {
  const tiers = { simple: emptyTier(), complex: emptyTier(), grok: emptyTier() };
  for (const m of models || []) {
    const name = String(m.model || "");
    // Grok is pulled out by name first: it has a price like any other model, so
    // classifying by cost would bury it in the "complex" bar and leave the weekly
    // allowance permanently empty.
    let key = /grok/i.test(name) ? "grok" : m.tier;
    if (!key || key === "unknown") key = "simple";
    const bucket = tiers[key] || tiers.simple;
    bucket.requests += m.requests || 0;
    bucket.promptTokens += m.promptTokens || 0;
    bucket.completionTokens += m.completionTokens || 0;
    bucket.cost += m.cost || 0;
    bucket.models.push(name);
  }
  return tiers;
}