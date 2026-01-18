// ============================================================================
// HOOK EVENTS - Write operations (create*, update*, delete*, mark*)
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import type {
  HookEventRecord,
  BudgetRecord,
  ApprovalQueueItem,
  ApprovalPolicy,
} from './types.js';
import { getBudget, getApprovalQueueItem, getApprovalPolicy } from './queries.js';

const logger = new Logger('HookEventsMutations');

// ============================================================================
// HOOK EVENT MUTATIONS
// ============================================================================

/**
 * Record a new hook event
 */
export function recordHookEvent(event: Omit<HookEventRecord, 'id'>): HookEventRecord {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO hook_events (
      event_type, session_id, project_path, tool_name,
      tool_input, tool_result, blocked, block_reason, duration_ms, timestamp
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.eventType,
    event.sessionId,
    event.projectPath,
    event.toolName,
    event.toolInput,
    event.toolResult,
    event.blocked ? 1 : 0,
    event.blockReason,
    event.durationMs,
    event.timestamp ?? formatTimestamp()
  );

  return {
    ...event,
    id: result.lastInsertRowid as number,
  };
}

/**
 * Clean up old hook events
 */
export function cleanupOldHookEvents(maxAgeHours = 24): number {
  const db = getDatabase();
  const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM hook_events
    WHERE timestamp < ?
  `).run(threshold);

  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} old hook events`);
  }

  return result.changes;
}

// ============================================================================
// BUDGET MUTATIONS
// ============================================================================

/**
 * Create or update a budget
 */
export function upsertBudget(budget: Omit<BudgetRecord, 'id' | 'createdAt' | 'updatedAt'>): BudgetRecord {
  const db = getDatabase();

  // Check if budget exists for this project/session
  const existing = db.prepare(`
    SELECT id FROM budgets
    WHERE (project_path = ? OR (project_path IS NULL AND ? IS NULL))
    AND (session_id = ? OR (session_id IS NULL AND ? IS NULL))
  `).get(
    budget.projectPath, budget.projectPath,
    budget.sessionId, budget.sessionId
  ) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE budgets SET
        limit_usd = ?,
        spent_usd = ?,
        warning_threshold = ?,
        hard_stop_enabled = ?,
        reset_period = ?,
        last_reset = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      budget.limitUsd,
      budget.spentUsd,
      budget.warningThreshold,
      budget.hardStopEnabled ? 1 : 0,
      budget.resetPeriod,
      budget.lastReset,
      existing.id
    );

    const updated = getBudget(existing.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated budget with id ${existing.id}`);
    }
    return updated;
  } else {
    const result = db.prepare(`
      INSERT INTO budgets (
        project_path, session_id, limit_usd, spent_usd,
        warning_threshold, hard_stop_enabled, reset_period, last_reset
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      budget.projectPath,
      budget.sessionId,
      budget.limitUsd,
      budget.spentUsd,
      budget.warningThreshold,
      budget.hardStopEnabled ? 1 : 0,
      budget.resetPeriod,
      budget.lastReset
    );

    const inserted = getBudget(result.lastInsertRowid as number);
    if (!inserted) {
      throw new Error(`Failed to retrieve inserted budget with id ${result.lastInsertRowid}`);
    }
    return inserted;
  }
}

/**
 * Update spent amount
 */
export function updateBudgetSpent(id: number, additionalCost: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE budgets SET
      spent_usd = spent_usd + ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(additionalCost, id);
}

// ============================================================================
// APPROVAL QUEUE MUTATIONS
// ============================================================================

/**
 * Add item to approval queue
 */
export function addToApprovalQueue(
  item: Omit<ApprovalQueueItem, 'id' | 'status' | 'policyId' | 'decidedAt' | 'decidedBy' | 'createdAt'>
): ApprovalQueueItem {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO approval_queue (session_id, request_type, request_details)
    VALUES (?, ?, ?)
  `).run(item.sessionId, item.requestType, item.requestDetails);

  const inserted = getApprovalQueueItem(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve inserted approval queue item with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Update approval status
 */
export function updateApprovalStatus(
  id: number,
  status: 'approved' | 'denied' | 'expired',
  decidedBy: 'user' | 'policy',
  policyId?: number
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE approval_queue SET
      status = ?,
      decided_at = datetime('now'),
      decided_by = ?,
      policy_id = ?
    WHERE id = ?
  `).run(status, decidedBy, policyId ?? null, id);
}

// ============================================================================
// APPROVAL POLICY MUTATIONS
// ============================================================================

/**
 * Create an approval policy
 */
export function createApprovalPolicy(
  policy: Omit<ApprovalPolicy, 'id' | 'createdAt' | 'updatedAt'>
): ApprovalPolicy {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO approval_policies (name, matcher, action, priority, conditions, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    policy.name,
    policy.matcher,
    policy.action,
    policy.priority,
    policy.conditions,
    policy.enabled ? 1 : 0
  );

  const inserted = getApprovalPolicy(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve inserted approval policy with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Update an approval policy
 */
export function updateApprovalPolicy(id: number, updates: Partial<ApprovalPolicy>): void {
  const db = getDatabase();
  const existing = getApprovalPolicy(id);
  if (!existing) throw new Error(`Approval policy not found: ${id}`);

  const merged = { ...existing, ...updates };

  db.prepare(`
    UPDATE approval_policies SET
      name = ?,
      matcher = ?,
      action = ?,
      priority = ?,
      conditions = ?,
      enabled = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.name,
    merged.matcher,
    merged.action,
    merged.priority,
    merged.conditions,
    merged.enabled ? 1 : 0,
    id
  );
}

/**
 * Delete an approval policy
 */
export function deleteApprovalPolicy(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM approval_policies WHERE id = ?').run(id);
}
