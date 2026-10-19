// Step budget gate: spends one step per client request, before the router talks
// to any provider.
//
// Position matters. It runs after `enforceKeyAccess` and before combo
// expansion, bypass handling and any credential lookup, so a refused request
// touches neither a provider account nor provider quota — the whole point of
// refusing early is that it costs nothing downstream.
//
// Scope precedence: key → provider → global. The key is the external agent's
// identity, the provider is our own agent (which is what an ACP agent with no
// key at all resolves to), and global is the router. The scope is never taken
// from a header: User-Agent is spoofable, and a limit that a header change
// defeats is not a limit.
import { getModelInfo } from "./model.js";
import { getClientKeyId } from "./keyAccess.js";
import { resolveStepScope } from "@/shared/utils/stepBudget.js";
import { stepBudgetDeniedLog, stepBudgetDeniedMessage } from "@/shared/constants/stepBudget.js";
import { consumeStep, declaredStepScopes, deleteStepBudget, describeStepBudgets, listStepBudgets, upsertStepBudget } from "@/lib/db/repos/stepBudgetsRepo.js";
import { normalizeStepBudget, parseStepScope } from "@/shared/utils/stepBudget.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

/**
 * The scope a request counts against, or null when no budget is declared for
 * this caller at any level — the "behaviour unchanged" case.
 */
export async function resolveRequestScope({ request, keyAccess, modelStr }) {
  const declared = await declaredStepScopes();
  if (declared.size === 0) return null;

  // The caller's identity is the key, if it sent one. The key id is resolved
  // separately from the access context: an unrestricted key has no access
  // context, but it is still the one calling, and a budget scoped to "who" must
  // see it. Fall back to the access context's id when the lookup gave nothing.
  let keyId = null;
  try {
    keyId = await getClientKeyId(request);
  } catch {
    keyId = null;
  }
  if (!keyId) keyId = keyAccess?.keyId || null;

  let providerId = null;
  try {
    // A combo routes nowhere on its own, so it has no provider and falls
    // through to the caller's key or global budget. One combo request is one
    // step however many members it expands to.
    const info = await getModelInfo(modelStr);
    providerId = info?.provider || null;
  } catch {
    providerId = null;
  }

  return resolveStepScope({
    keyId,
    providerId,
    has: (scope) => declared.has(scope),
  });
}

/**
 * Gate for the chat endpoints. Call once per client request, before the
 * provider conversation.
 * @returns {Promise<Response|null>} a 429 Response, or null when allowed.
 */
export async function enforceStepBudget({ request, keyAccess, modelStr }) {
  const scope = await resolveRequestScope({ request, keyAccess, modelStr });
  if (!scope) return null;

  const decision = await consumeStep(scope);
  if (decision.allowed) return null;

  log.warn("AUTH", stepBudgetDeniedLog(scope, decision.limitSteps, decision.windowMs));
  const retryAfter = decision.retryAfterSeconds;
  const headers = retryAfter > 0 ? { "Retry-After": String(retryAfter) } : null;
  return errorResponse(HTTP_STATUS.RATE_LIMITED, stepBudgetDeniedMessage(retryAfter), headers);
}

/* ── Management surface used by the API route and the dashboard ─────────── */

export async function getStepBudgets() {
  return describeStepBudgets();
}

/**
 * Declare or change a budget. Rejects a malformed declaration instead of
 * clamping it, so a typo cannot silently become a different limit.
 * @returns {Promise<{ok: true, budget: object} | {ok: false, error: string, status: number}>}
 */
export async function setStepBudget({ scope, limitSteps, windowMs }) {
  const parsedScope = parseStepScope(scope);
  if (!parsedScope) {
    return { ok: false, error: "scope must be 'global', 'key:<id>' or 'provider:<id>'", status: 400 };
  }
  const normalized = normalizeStepBudget({ limitSteps, windowMs });
  if (normalized?.error) return { ok: false, error: normalized.error, status: 400 };
  if (normalized === null) {
    // limitSteps 0 means "no limit" — that is a removal, not a zero budget.
    await deleteStepBudget(parsedScope.kind === "global" ? "global" : scope.toLowerCase());
    return { ok: true, budget: null };
  }
  const canonical = parsedScope.kind === "global" ? "global" : `${parsedScope.kind}:${parsedScope.id}`;
  const budget = await upsertStepBudget(canonical, normalized);
  return { ok: true, budget };
}

export async function removeStepBudget(scope) {
  const parsedScope = parseStepScope(scope);
  if (!parsedScope) return { ok: false, error: "unknown scope", status: 400 };
  await deleteStepBudget(parsedScope.kind === "global" ? "global" : scope.toLowerCase());
  return { ok: true };
}

export { listStepBudgets };