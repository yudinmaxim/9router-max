"use client";

/**
 * QuotaWidget — picks the card body that belongs to the provider in question.
 *
 * The providers page used to have one chain of conditions, and the agent-cost
 * branch sat above the upstream-quota branch. Since the usage endpoint returns
 * the router's own history for every connection, that one branch swallowed
 * everybody: Codex, Claude and Gemini all got the agent card, and the quota
 * windows they actually came for — Codex's 5h/weekly, review and spark
 * windows — were never rendered.
 *
 * So the choice is made from what the provider actually has:
 *
 *   spendBars          → Cursor's own widget (money, per-model bars, Grok pool)
 *   upstream quotas    → the stock quota table, one row per window
 *   no upstream quota  → the agent-cost widget (the router's own history)
 *   an upstream notice → the notice
 *
 * Each provider keeps its own; nothing falls through to a card that was built
 * for a different kind of thing.
 */

import PropTypes from "prop-types";
import QuotaTable from "./QuotaTable";
import CursorQuotaWidget from "./CursorQuotaWidget";
import AgentCostWidget from "./AgentCostWidget";

const AGENT_QUOTA_UNSUPPORTED =
  "Runs on your own subscription — the router has no upstream quota to report.";

export default function QuotaWidget({
  provider,
  quota,
  visibleQuotas,
  onHideQuota,
  quotaSortMode,
  translate,
}) {
  if (!quota) return null;

  // Cursor's billing API answers with its own bars; nothing else sends them.
  if (quota.spendBars) {
    return <CursorQuotaWidget spendBars={quota.spendBars} planLimits={quota.planLimits} translate={translate} />;
  }

  // A provider with real upstream quotas gets its own windows. This is the
  // branch Codex, Claude and Gemini need — the agent card below must not
  // shadow it.
  if (visibleQuotas.length > 0) {
    return (
      <QuotaTable
        quotas={visibleQuotas}
        compact
        sortMode="default"
        showSortLabel={provider === "codex" && quotaSortMode !== "default"}
        onHideQuota={onHideQuota}
      />
    );
  }

  // An agent runs a CLI on the operator's own subscription: there is no
  // upstream remainder to report, and the router's own history is the answer.
  if (quota.localUsage) {
    return <AgentCostWidget localUsage={quota.localUsage} translate={translate} />;
  }

  if (quota.message || quota.unsupported) {
    return (
      <div className="text-center py-5">
        <p className="text-xs text-text-muted">
          {quota.unsupported === "own-subscription" ? translate(AGENT_QUOTA_UNSUPPORTED) : quota.message}
        </p>
      </div>
    );
  }

  return (
    <QuotaTable
      quotas={visibleQuotas}
      compact
      sortMode="default"
      showSortLabel={provider === "codex" && quotaSortMode !== "default"}
      onHideQuota={onHideQuota}
    />
  );
}

QuotaWidget.propTypes = {
  provider: PropTypes.string,
  quota: PropTypes.object,
  visibleQuotas: PropTypes.array,
  onHideQuota: PropTypes.func,
  quotaSortMode: PropTypes.string,
  translate: PropTypes.func.isRequired,
};
