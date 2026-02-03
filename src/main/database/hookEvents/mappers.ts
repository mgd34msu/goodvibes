// ============================================================================
// HOOK EVENTS - Row to record mappers
// ============================================================================

import type {
  HookEventRow,
  HookEventRecord,
  ExtendedHookEventType,
  BudgetRow,
  BudgetRecord,
  ApprovalQueueRow,
  ApprovalQueueItem,
  ApprovalPolicyRow,
  ApprovalPolicy,
} from './types.js';

// ============================================================================
// HOOK EVENT MAPPER
// ============================================================================

export function mapRowToHookEvent(row: HookEventRow): HookEventRecord {
  return {
    id: row.id,
    eventType: row.event_type as ExtendedHookEventType,
    sessionId: row.session_id,
    projectPath: row.project_path,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolResult: row.tool_result,
    blocked: row.blocked === 1,
    blockReason: row.block_reason,
    durationMs: row.duration_ms,
    timestamp: row.timestamp,
  };
}

// ============================================================================
// BUDGET MAPPER
// ============================================================================

export function mapRowToBudget(row: BudgetRow): BudgetRecord {
  return {
    id: row.id,
    projectPath: row.project_path,
    sessionId: row.session_id,
    limitUsd: row.limit_usd,
    spentUsd: row.spent_usd,
    warningThreshold: row.warning_threshold,
    hardStopEnabled: row.hard_stop_enabled === 1,
    resetPeriod: row.reset_period,
    lastReset: row.last_reset,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// APPROVAL QUEUE MAPPER
// ============================================================================

export function mapRowToApprovalQueueItem(row: ApprovalQueueRow): ApprovalQueueItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    requestType: row.request_type,
    requestDetails: row.request_details,
    status: row.status,
    policyId: row.policy_id,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    createdAt: row.created_at,
  };
}

// ============================================================================
// APPROVAL POLICY MAPPER
// ============================================================================

export function mapRowToApprovalPolicy(row: ApprovalPolicyRow): ApprovalPolicy {
  return {
    id: row.id,
    name: row.name,
    matcher: row.matcher,
    action: row.action,
    priority: row.priority,
    conditions: row.conditions,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
