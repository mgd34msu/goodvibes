// ============================================================================
// HOOK EVENTS DATABASE - Main exports
// ============================================================================
//
// This module provides database operations for storing and querying hook events.
// Hook events are received from Claude hook scripts via the HTTP server and
// stored for real-time display and historical analysis.
//
// ============================================================================

// Re-export types
export type {
  HookEventRow,
  BudgetRow,
  ApprovalQueueRow,
  ApprovalPolicyRow,
  ExtendedHookEventType,
  HookEventRecord,
  BudgetRecord,
  ApprovalQueueItem,
  ApprovalPolicy,
  HookEventStats,
} from './types.js';

// Re-export schema creation
export { createHookEventsTables } from './schema.js';

// Re-export mappers
export {
  mapRowToHookEvent,
  mapRowToBudget,
  mapRowToApprovalQueueItem,
  mapRowToApprovalPolicy,
} from './mappers.js';

// Re-export read operations (queries)
export {
  getHookEventsBySession,
  getRecentHookEvents,
  getHookEventsByType,
  getBudget,
  getBudgetForScope,
  getAllBudgets,
  getApprovalQueueItem,
  getPendingApprovals,
  getApprovalPolicy,
  getEnabledApprovalPolicies,
  getAllApprovalPolicies,
} from './queries.js';

// Re-export write operations (mutations)
export {
  recordHookEvent,
  cleanupOldHookEvents,
  upsertBudget,
  updateBudgetSpent,
  addToApprovalQueue,
  updateApprovalStatus,
  createApprovalPolicy,
  updateApprovalPolicy,
  deleteApprovalPolicy,
} from './mutations.js';

// Re-export analytics operations
// Note: Only getHookEventStats is currently used by IPC handlers.
// Other analytics functions (getHookEventsByHour, getBlockedEventsSummary,
// getToolUsageFromHooks, getSessionActivitySummary) are available for
// future dashboard features but are not re-exported from the barrel
// to reduce bundle size. Import directly from './analytics.js' if needed.
export { getHookEventStats } from './analytics.js';
