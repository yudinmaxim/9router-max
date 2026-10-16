// Tiers for the quota bars, following Cursor's own spending split
// (cursor.com/dashboard/spending):
//
//   Cursor Models — Cursor's own: Composer and Cursor Grok
//   Other Models  — every other model served through the same connection
//   Grok, weekly  — a quota the provider reports, not a price
//
// The first two are an identity question, not a cost one: Cursor classifies by
// which models are its own, so we do too. An earlier version split by price and
// filed composer-2.5 under "simple" while gpt-5.3-codex went to "complex" —
// which is a plausible-looking answer that matches no dashboard anyone reconciles
// against. Grok is a third bar rather than a fourth tier because its weekly
// allowance is not spend.

/** Cursor's own models: Composer and Cursor Grok. */
const CURSOR_MODEL = /^(composer|grok)/i;

export function classifyModelTier(model) {
  return CURSOR_MODEL.test(String(model || "")) ? "cursorModels" : "otherModels";
}

export function emptyTier() {
  return { requests: 0, promptTokens: 0, completionTokens: 0, cost: 0, models: [] };
}

/**
 * Roll a per-model split into the two spending tiers. Grok usage lands in
 * Cursor Models by definition — it is listed there explicitly upstream — and the
 * weekly allowance is reported separately by the provider.
 */
export function rollUpTiers(models) {
  const tiers = { cursorModels: emptyTier(), otherModels: emptyTier() };
  for (const m of models || []) {
    const name = String(m.model || "");
    const bucket = tiers[classifyModelTier(name)];
    bucket.requests += m.requests || 0;
    bucket.promptTokens += m.promptTokens || 0;
    bucket.completionTokens += m.completionTokens || 0;
    bucket.cost += m.cost || 0;
    bucket.models.push(name);
  }
  return tiers;
}
