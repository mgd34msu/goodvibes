// ============================================================================
// HOOK EVENTS - Read operations (get*, list*, search*)
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  HookEventRecord,
  ExtendedHookEventType,
  HookEventRow,
  BudgetRecord,
  BudgetRow,
  ApprovalQueueItem,
  ApprovalQueueRow,
  ApprovalPolicy,
  ApprovalPolicyRow,
} from './types.js';
import {
  mapRowToHookEvent,
  mapRowToBudget,
  mapRowToApprovalQueueItem,
  mapRowToApprovalPolicy,
} from './mappers.js';

// ============================================================================
// HOOK EVENT QUERIES
// ============================================================================

/**
 * Get hook events for a session
 */
export function getHookEventsBySession(sessionId: string, limit = 100): HookEventRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM hook_events
    WHERE session_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(sessionId, limit) as HookEventRow[];

  return rows.map(mapRowToHookEvent);
}

/**
 * Get recent hook events
 */
export function getRecentHookEvents(limit = 100): HookEventRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM hook_events
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(limit) as HookEventRow[];

  return rows.map(mapRowToHookEvent);
}

/**
 * Get hook events by type
 */
export function getHookEventsByType(
  eventType: ExtendedHookEventType,
  limit = 100
): HookEventRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM hook_events
    WHERE event_type = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(eventType, limit) as HookEventRow[];

  return rows.map(mapRowToHookEvent);
}

// ============================================================================
// BUDGET QUERIES
// ============================================================================

/**
 * Get a budget by ID
 */
export function getBudget(id: number): BudgetRecord | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id) as BudgetRow | undefined;
  return row ? mapRowToBudget(row) : null;
}

/**
 * Get budget for a project or session
 */
export function getBudgetForScope(
  projectPath?: string,
  sessionId?: string
): BudgetRecord | null {
  const db = getDatabase();

  // First try to find session-specific budget
  if (sessionId) {
    const sessionBudget = db.prepare(
      'SELECT * FROM budgets WHERE session_id = ?'
    ).get(sessionId) as BudgetRow | undefined;
    if (sessionBudget) return mapRowToBudget(sessionBudget);
  }

  // Then try project-specific budget
  if (projectPath) {
    const projectBudget = db.prepare(
      'SELECT * FROM budgets WHERE project_path = ? AND session_id IS NULL'
    ).get(projectPath) as BudgetRow | undefined;
    if (projectBudget) return mapRowToBudget(projectBudget);
  }

  // Finally try global budget
  const globalBudget = db.prepare(
    'SELECT * FROM budgets WHERE project_path IS NULL AND session_id IS NULL'
  ).get() as BudgetRow | undefined;

  return globalBudget ? mapRowToBudget(globalBudget) : null;
}

/**
 * Get all budgets
 */
export function getAllBudgets(): BudgetRecord[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM budgets ORDER BY created_at DESC').all() as BudgetRow[];
  return rows.map(mapRowToBudget);
}

// ============================================================================
// APPROVAL QUEUE QUERIES
// ============================================================================

/**
 * Get an approval queue item
 */
export function getApprovalQueueItem(id: number): ApprovalQueueItem | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM approval_queue WHERE id = ?').get(id) as ApprovalQueueRow | undefined;
  return row ? mapRowToApprovalQueueItem(row) : null;
}

/**
 * Get pending approval items
 */
export function getPendingApprovals(sessionId?: string): ApprovalQueueItem[] {
  const db = getDatabase();

  let query = 'SELECT * FROM approval_queue WHERE status = ?';
  const params: string[] = ['pending'];

  if (sessionId) {
    query += ' AND session_id = ?';
    params.push(sessionId);
  }

  query += ' ORDER BY created_at ASC';

  const rows = db.prepare(query).all(...params) as ApprovalQueueRow[];
  return rows.map(mapRowToApprovalQueueItem);
}

// ============================================================================
// APPROVAL POLICY QUERIES
// ============================================================================

/**
 * Get an approval policy
 */
export function getApprovalPolicy(id: number): ApprovalPolicy | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM approval_policies WHERE id = ?').get(id) as ApprovalPolicyRow | undefined;
  return row ? mapRowToApprovalPolicy(row) : null;
}

/**
 * Get all enabled approval policies
 */
export function getEnabledApprovalPolicies(): ApprovalPolicy[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM approval_policies WHERE enabled = 1 ORDER BY priority DESC'
  ).all() as ApprovalPolicyRow[];
  return rows.map(mapRowToApprovalPolicy);
}

/**
 * Get all approval policies
 */
export function getAllApprovalPolicies(): ApprovalPolicy[] {
  const db = getDatabase();
  const rows = db.prepare(
    'SELECT * FROM approval_policies ORDER BY priority DESC'
  ).all() as ApprovalPolicyRow[];
  return rows.map(mapRowToApprovalPolicy);
}
