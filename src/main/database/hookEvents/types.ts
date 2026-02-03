// ============================================================================
// HOOK EVENTS - Type definitions
// ============================================================================

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from hook_events table */
export interface HookEventRow {
  id: number;
  event_type: string;
  session_id: string | null;
  project_path: string | null;
  tool_name: string | null;
  tool_input: string | null;
  tool_result: string | null;
  blocked: number;
  block_reason: string | null;
  duration_ms: number;
  timestamp: string;
}

/** Raw row from budgets table */
export interface BudgetRow {
  id: number;
  project_path: string | null;
  session_id: string | null;
  limit_usd: number;
  spent_usd: number;
  warning_threshold: number;
  hard_stop_enabled: number;
  reset_period: 'session' | 'daily' | 'weekly' | 'monthly';
  last_reset: string;
  created_at: string;
  updated_at: string;
}

/** Raw row from approval_queue table */
export interface ApprovalQueueRow {
  id: number;
  session_id: string;
  request_type: string;
  request_details: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  policy_id: number | null;
  decided_at: string | null;
  decided_by: 'user' | 'policy' | null;
  created_at: string;
}

/** Raw row from approval_policies table */
export interface ApprovalPolicyRow {
  id: number;
  name: string;
  matcher: string;
  action: 'auto-approve' | 'auto-deny' | 'queue';
  priority: number;
  conditions: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Extended hook event types - all 12 Claude hook events
 */
export type ExtendedHookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Stop'
  | 'PermissionRequest'
  | 'UserPromptSubmit'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'Notification';

/**
 * Hook event record stored in the database
 */
export interface HookEventRecord {
  id: number;
  eventType: ExtendedHookEventType;
  sessionId: string | null;
  projectPath: string | null;
  toolName: string | null;
  toolInput: string | null;  // JSON string
  toolResult: string | null; // JSON string
  blocked: boolean;
  blockReason: string | null;
  durationMs: number;
  timestamp: string;
}

/**
 * Budget tracking record
 */
export interface BudgetRecord {
  id: number;
  projectPath: string | null;
  sessionId: string | null;
  limitUsd: number;
  spentUsd: number;
  warningThreshold: number;
  hardStopEnabled: boolean;
  resetPeriod: 'session' | 'daily' | 'weekly' | 'monthly';
  lastReset: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Approval queue item
 */
export interface ApprovalQueueItem {
  id: number;
  sessionId: string;
  requestType: string;
  requestDetails: string; // JSON string
  status: 'pending' | 'approved' | 'denied' | 'expired';
  policyId: number | null;
  decidedAt: string | null;
  decidedBy: 'user' | 'policy' | null;
  createdAt: string;
}

/**
 * Approval policy
 */
export interface ApprovalPolicy {
  id: number;
  name: string;
  matcher: string;
  action: 'auto-approve' | 'auto-deny' | 'queue';
  priority: number;
  conditions: string | null; // JSON string
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Hook event statistics
 */
export interface HookEventStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  blockedCount: number;
  avgDurationMs: number;
}
