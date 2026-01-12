// ============================================================================
// HOOK EVENTS DATABASE - Store and query hook events
// ============================================================================
//
// This module provides database operations for storing and querying hook events.
// Hook events are received from Claude hook scripts via the HTTP server and
// stored for real-time display and historical analysis.
//
// ============================================================================

import { getDatabase } from './connection.js';
import { Logger } from '../services/logger.js';
import { formatTimestamp } from '../../shared/dateUtils.js';

const logger = new Logger('HookEventsDB');

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from hook_events table */
interface HookEventRow {
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
interface BudgetRow {
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
interface ApprovalQueueRow {
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
interface ApprovalPolicyRow {
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

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createHookEventsTables(): void {
  const db = getDatabase();

  // Hook events table - stores all hook events for real-time display and analytics
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      session_id TEXT,
      project_path TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_result TEXT,
      blocked INTEGER DEFAULT 0,
      block_reason TEXT,
      duration_ms INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Budget tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT,
      session_id TEXT,
      limit_usd REAL NOT NULL,
      spent_usd REAL DEFAULT 0,
      warning_threshold REAL DEFAULT 0.8,
      hard_stop_enabled INTEGER DEFAULT 0,
      reset_period TEXT DEFAULT 'session',
      last_reset TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Approval queue table
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      request_details TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      policy_id INTEGER,
      decided_at TEXT,
      decided_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (policy_id) REFERENCES approval_policies(id)
    )
  `);

  // Approval policies table
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      matcher TEXT NOT NULL,
      action TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      conditions TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  createHookEventsIndexes();

  logger.info('Hook events tables created');
}

function createHookEventsIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_hook_events_type ON hook_events(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_hook_events_timestamp ON hook_events(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_hook_events_tool ON hook_events(tool_name)',
    'CREATE INDEX IF NOT EXISTS idx_budgets_project ON budgets(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_budgets_session ON budgets(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status)',
    'CREATE INDEX IF NOT EXISTS idx_approval_queue_session ON approval_queue(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_approval_policies_enabled ON approval_policies(enabled)',
  ];

  for (const index of indexes) {
    try {
      db.exec(index);
    } catch (e) {
      const error = e as Error;
      if (!error.message?.includes('already exists')) {
        logger.warn(`Failed to create index: ${error.message}`);
      }
    }
  }
}

// ============================================================================
// HOOK EVENT OPERATIONS
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
    event.timestamp || formatTimestamp()
  );

  return {
    ...event,
    id: result.lastInsertRowid as number,
  };
}

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

/**
 * Get hook event statistics
 */
export function getHookEventStats(): {
  totalEvents: number;
  eventsByType: Record<string, number>;
  blockedCount: number;
  avgDurationMs: number;
} {
  const db = getDatabase();

  const total = db.prepare('SELECT COUNT(*) as count FROM hook_events').get() as { count: number };

  const byType = db.prepare(`
    SELECT event_type, COUNT(*) as count
    FROM hook_events
    GROUP BY event_type
  `).all() as { event_type: string; count: number }[];

  const blocked = db.prepare(
    'SELECT COUNT(*) as count FROM hook_events WHERE blocked = 1'
  ).get() as { count: number };

  const avgDuration = db.prepare(
    'SELECT AVG(duration_ms) as avg FROM hook_events'
  ).get() as { avg: number | null };

  const eventsByType: Record<string, number> = {};
  for (const row of byType) {
    eventsByType[row.event_type] = row.count;
  }

  return {
    totalEvents: total.count,
    eventsByType,
    blockedCount: blocked.count,
    avgDurationMs: avgDuration.avg ?? 0,
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

function mapRowToHookEvent(row: HookEventRow): HookEventRecord {
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
// BUDGET OPERATIONS
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

/**
 * Get all budgets
 */
export function getAllBudgets(): BudgetRecord[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM budgets ORDER BY created_at DESC').all() as BudgetRow[];
  return rows.map(mapRowToBudget);
}

function mapRowToBudget(row: BudgetRow): BudgetRecord {
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
// APPROVAL QUEUE OPERATIONS
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

function mapRowToApprovalQueueItem(row: ApprovalQueueRow): ApprovalQueueItem {
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
// APPROVAL POLICY OPERATIONS
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

function mapRowToApprovalPolicy(row: ApprovalPolicyRow): ApprovalPolicy {
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
