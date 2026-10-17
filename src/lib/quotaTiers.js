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
export function rollUpTiers(models, classify = classifyModelTier) {
  const tiers = { cursorModels: emptyTier(), otherModels: emptyTier() };
  for (const m of models || []) {
    const name = String(m.model || "");
    const bucket = tiers[classify(name)];
    bucket.requests += m.requests || 0;
    bucket.promptTokens += m.promptTokens || 0;
    bucket.completionTokens += m.completionTokens || 0;
    bucket.cost += m.cost || 0;
    bucket.models.push(name);
  }
  return tiers;
}

/**
 * Share of spend per tier, plus the basis the numbers are drawn on.
 *
 * Shares of the total, not of the largest tier: a share-of-max would print 100%
 * for somebody on every dataset, which is the one thing a percentage must not do.
 *
 * When no model carries a tariff every total is 0 and a percentage of 0 is
 * meaningless, so the basis falls back to tokens. `useCost` is returned so the
 * caller can say which basis it is showing rather than implying it is spend.
 */
export function computeTierShares(tiers) {
  const all = Object.values(tiers || {});
  const useCost = all.some((x) => (x?.cost || 0) > 0);
  const valueOf = (x) =>
    x ? (useCost ? x.cost || 0 : (x.promptTokens || 0) + (x.completionTokens || 0)) : 0;
  const total = all.reduce((sum, x) => sum + valueOf(x), 0);
  const shares = {};
  for (const [key, tier] of Object.entries(tiers || {})) {
    shares[key] = {
      pct: total > 0 ? Math.round((valueOf(tier) / total) * 100) : 0,
      hasTraffic: Boolean(tier && tier.requests > 0),
    };
  }
  return { shares, useCost };
}

/**
 * Classify against a model list the provider publishes itself.
 *
 * Cursor sends autoBucketModels — the exact set it bills as its own, composer-*
 * and vega-* and the whole grok-* family. A name pattern guesses at that and gets
 * it wrong in both directions: an unknown composer build lands under "other", and
 * a third-party model that merely contains "grok" lands under Cursor's. When the
 * list is present it decides; when it is missing the pattern is the fallback, so
 * a caller without the list still gets an answer rather than nothing.
 */
export function classifyByProviderList(ownedModels) {
  const owned = new Set((ownedModels || []).map((m) => String(m)));
  if (owned.size === 0) return classifyModelTier;
  return (model) => (owned.has(String(model)) ? "cursorModels" : "otherModels");
}
