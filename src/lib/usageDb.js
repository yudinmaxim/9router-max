// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  backfillDailyAccounts,  getUsageTotalsForConnection,
 PROVIDER_ACCOUNT_PREFIX, isProviderAccountKey,
  appendRequestLog, getRecentLogs,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
} from "@/lib/db/index.js";
