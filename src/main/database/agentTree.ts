// ============================================================================
// AGENT TREE DATABASE - Schema for agent hierarchy and orchestration
// ============================================================================
//
// This module provides database operations for tracking agent hierarchies,
// parent-child relationships, budget allocation, and performance metrics.
//
// ============================================================================

import { getDatabase } from './connection.js';
import { Logger } from '../services/logger.js';
import { formatTimestamp } from '../../shared/dateUtils.js';

const logger = new Logger('AgentTreeDB');

// ============================================================================
// TYPES
// ============================================================================

/**
 * Agent tree node representing an active agent instance
 */
export interface AgentTreeNode {
  id: number;
  sessionId: string;
  agentName: string;
  parentId: number | null;
  parentSessionId: string | null;
  rootSessionId: string;
  depth: number;
  status: 'running' | 'completed' | 'failed' | 'terminated';
  startedAt: string;
  completedAt: string | null;
  allocatedBudgetUsd: number;
  spentBudgetUsd: number;
  toolCalls: number;
  tokensUsed: number;
  metadata: string | null; // JSON
}

/**
 * Agent performance metrics
 */
export interface AgentMetrics {
  agentName: string;
  totalSessions: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  avgToolCalls: number;
  avgTokensUsed: number;
  avgCostUsd: number;
  successRate: number;
}

/**
 * Agent hierarchy summary
 */
export interface AgentHierarchySummary {
  rootSessionId: string;
  totalAgents: number;
  maxDepth: number;
  totalBudgetAllocated: number;
  totalBudgetSpent: number;
  runningAgents: number;
  completedAgents: number;
  failedAgents: number;
}

/**
 * Database row type for agent_tree_nodes table (snake_case columns)
 */
interface AgentTreeNodeRow {
  id: number;
  session_id: string;
  agent_name: string;
  parent_id: number | null;
  parent_session_id: string | null;
  root_session_id: string;
  depth: number;
  status: 'running' | 'completed' | 'failed' | 'terminated';
  started_at: string;
  completed_at: string | null;
  allocated_budget_usd: number;
  spent_budget_usd: number;
  tool_calls: number;
  tokens_used: number;
  metadata: string | null;
}

/**
 * Database row type for agent_metrics table
 */
interface AgentMetricsRow {
  id: number;
  agent_name: string;
  total_sessions: number;
  success_count: number;
  failure_count: number;
  total_duration_ms: number;
  total_tool_calls: number;
  total_tokens_used: number;
  total_cost_usd: number;
  first_used: string;
  last_used: string;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createAgentTreeTables(): void {
  const db = getDatabase();

  // Agent tree nodes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tree_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      agent_name TEXT NOT NULL,
      parent_id INTEGER,
      parent_session_id TEXT,
      root_session_id TEXT NOT NULL,
      depth INTEGER DEFAULT 0,
      status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'terminated')),
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      allocated_budget_usd REAL DEFAULT 0,
      spent_budget_usd REAL DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      metadata TEXT,
      FOREIGN KEY (parent_id) REFERENCES agent_tree_nodes(id) ON DELETE SET NULL
    )
  `);

  // Agent performance metrics table (aggregated)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_name TEXT NOT NULL UNIQUE,
      total_sessions INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      total_duration_ms INTEGER DEFAULT 0,
      total_tool_calls INTEGER DEFAULT 0,
      total_tokens_used INTEGER DEFAULT 0,
      total_cost_usd REAL DEFAULT 0,
      last_used TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  createAgentTreeIndexes();

  logger.info('Agent tree tables created');
}

function createAgentTreeIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_agent_tree_session ON agent_tree_nodes(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tree_parent ON agent_tree_nodes(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tree_root ON agent_tree_nodes(root_session_id)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tree_status ON agent_tree_nodes(status)',
    'CREATE INDEX IF NOT EXISTS idx_agent_tree_name ON agent_tree_nodes(agent_name)',
    'CREATE INDEX IF NOT EXISTS idx_agent_metrics_name ON agent_metrics(agent_name)',
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
// AGENT TREE NODE OPERATIONS
// ============================================================================

/**
 * Register a new agent in the tree
 */
export function registerAgent(
  sessionId: string,
  agentName: string,
  parentSessionId?: string,
  allocatedBudgetUsd: number = 0
): AgentTreeNode {
  const db = getDatabase();

  // Find parent if exists
  let parentId: number | null = null;
  let rootSessionId = sessionId;
  let depth = 0;

  if (parentSessionId) {
    const parent = getAgentBySessionId(parentSessionId);
    if (parent) {
      parentId = parent.id;
      rootSessionId = parent.rootSessionId;
      depth = parent.depth + 1;
    }
  }

  const result = db.prepare(`
    INSERT INTO agent_tree_nodes (
      session_id, agent_name, parent_id, parent_session_id,
      root_session_id, depth, allocated_budget_usd
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    sessionId,
    agentName,
    parentId,
    parentSessionId || null,
    rootSessionId,
    depth,
    allocatedBudgetUsd
  );

  const inserted = getAgentNode(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve registered agent with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get agent node by ID
 */
export function getAgentNode(id: number): AgentTreeNode | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agent_tree_nodes WHERE id = ?').get(id) as AgentTreeNodeRow | undefined;
  return row ? mapRowToAgentNode(row) : null;
}

/**
 * Get agent by session ID
 */
export function getAgentBySessionId(sessionId: string): AgentTreeNode | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agent_tree_nodes WHERE session_id = ?').get(sessionId) as AgentTreeNodeRow | undefined;
  return row ? mapRowToAgentNode(row) : null;
}

/**
 * Get all children of an agent
 */
export function getAgentChildren(parentId: number): AgentTreeNode[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM agent_tree_nodes
    WHERE parent_id = ?
    ORDER BY started_at ASC
  `).all(parentId) as AgentTreeNodeRow[];
  return rows.map(mapRowToAgentNode);
}

/**
 * Get all descendants of an agent (recursive)
 */
export function getAgentDescendants(rootSessionId: string): AgentTreeNode[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM agent_tree_nodes
    WHERE root_session_id = ?
    ORDER BY depth ASC, started_at ASC
  `).all(rootSessionId) as AgentTreeNodeRow[];
  return rows.map(mapRowToAgentNode);
}

/**
 * Get the full tree for a root session
 */
export function getAgentTree(rootSessionId: string): AgentTreeNode[] {
  return getAgentDescendants(rootSessionId);
}

/**
 * Get currently running agents
 */
export function getRunningAgents(rootSessionId?: string): AgentTreeNode[] {
  const db = getDatabase();

  let query = 'SELECT * FROM agent_tree_nodes WHERE status = ?';
  const params: string[] = ['running'];

  if (rootSessionId) {
    query += ' AND root_session_id = ?';
    params.push(rootSessionId);
  }

  query += ' ORDER BY started_at ASC';
  const rows = db.prepare(query).all(...params) as AgentTreeNodeRow[];
  return rows.map(mapRowToAgentNode);
}

/**
 * Update agent status
 */
export function updateAgentStatus(
  sessionId: string,
  status: 'running' | 'completed' | 'failed' | 'terminated'
): void {
  const db = getDatabase();
  const completedAt = status !== 'running' ? formatTimestamp() : null;

  db.prepare(`
    UPDATE agent_tree_nodes SET
      status = ?,
      completed_at = ?
    WHERE session_id = ?
  `).run(status, completedAt, sessionId);

  // Update aggregated metrics
  if (status === 'completed' || status === 'failed') {
    const node = getAgentBySessionId(sessionId);
    if (node) {
      updateAgentMetrics(node, status === 'completed');
    }
  }
}

/**
 * Update agent budget spent
 */
export function updateAgentBudgetSpent(sessionId: string, additionalCost: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agent_tree_nodes SET
      spent_budget_usd = spent_budget_usd + ?
    WHERE session_id = ?
  `).run(additionalCost, sessionId);
}

/**
 * Increment tool calls count
 */
export function incrementAgentToolCalls(sessionId: string, count: number = 1): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agent_tree_nodes SET
      tool_calls = tool_calls + ?
    WHERE session_id = ?
  `).run(count, sessionId);
}

/**
 * Update tokens used
 */
export function updateAgentTokensUsed(sessionId: string, tokens: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agent_tree_nodes SET
      tokens_used = tokens_used + ?
    WHERE session_id = ?
  `).run(tokens, sessionId);
}

/**
 * Set agent metadata
 */
export function setAgentMetadata(sessionId: string, metadata: Record<string, unknown>): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agent_tree_nodes SET
      metadata = ?
    WHERE session_id = ?
  `).run(JSON.stringify(metadata), sessionId);
}

/**
 * Allocate budget to a child agent from parent's remaining budget
 */
export function allocateBudgetToChild(
  parentSessionId: string,
  childSessionId: string,
  amount: number
): boolean {
  const db = getDatabase();

  // Get parent's remaining budget
  const parent = getAgentBySessionId(parentSessionId);
  if (!parent) return false;

  const remainingBudget = parent.allocatedBudgetUsd - parent.spentBudgetUsd;
  if (amount > remainingBudget) return false;

  // Update child's allocated budget
  db.prepare(`
    UPDATE agent_tree_nodes SET
      allocated_budget_usd = ?
    WHERE session_id = ?
  `).run(amount, childSessionId);

  return true;
}

function mapRowToAgentNode(row: AgentTreeNodeRow): AgentTreeNode {
  return {
    id: row.id,
    sessionId: row.session_id,
    agentName: row.agent_name,
    parentId: row.parent_id,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id,
    depth: row.depth,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    allocatedBudgetUsd: row.allocated_budget_usd,
    spentBudgetUsd: row.spent_budget_usd,
    toolCalls: row.tool_calls,
    tokensUsed: row.tokens_used,
    metadata: row.metadata,
  };
}

// ============================================================================
// AGENT METRICS OPERATIONS
// ============================================================================

/**
 * Update aggregated metrics for an agent
 */
function updateAgentMetrics(node: AgentTreeNode, success: boolean): void {
  const db = getDatabase();

  // Calculate duration
  const startTime = new Date(node.startedAt).getTime();
  const endTime = node.completedAt
    ? new Date(node.completedAt).getTime()
    : Date.now();
  const durationMs = endTime - startTime;

  // Check if metrics record exists
  const existing = db.prepare(
    'SELECT id FROM agent_metrics WHERE agent_name = ?'
  ).get(node.agentName) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE agent_metrics SET
        total_sessions = total_sessions + 1,
        success_count = success_count + ?,
        failure_count = failure_count + ?,
        total_duration_ms = total_duration_ms + ?,
        total_tool_calls = total_tool_calls + ?,
        total_tokens_used = total_tokens_used + ?,
        total_cost_usd = total_cost_usd + ?,
        last_used = datetime('now'),
        updated_at = datetime('now')
      WHERE agent_name = ?
    `).run(
      success ? 1 : 0,
      success ? 0 : 1,
      durationMs,
      node.toolCalls,
      node.tokensUsed,
      node.spentBudgetUsd,
      node.agentName
    );
  } else {
    db.prepare(`
      INSERT INTO agent_metrics (
        agent_name, total_sessions, success_count, failure_count,
        total_duration_ms, total_tool_calls, total_tokens_used,
        total_cost_usd, last_used
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      node.agentName,
      success ? 1 : 0,
      success ? 0 : 1,
      durationMs,
      node.toolCalls,
      node.tokensUsed,
      node.spentBudgetUsd
    );
  }
}

/**
 * Get metrics for an agent
 */
export function getAgentMetricsByName(agentName: string): AgentMetrics | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agent_metrics WHERE agent_name = ?').get(agentName) as AgentMetricsRow | undefined;

  if (!row) return null;

  return {
    agentName: row.agent_name,
    totalSessions: row.total_sessions,
    successCount: row.success_count,
    failureCount: row.failure_count,
    avgDurationMs: row.total_sessions > 0 ? row.total_duration_ms / row.total_sessions : 0,
    avgToolCalls: row.total_sessions > 0 ? row.total_tool_calls / row.total_sessions : 0,
    avgTokensUsed: row.total_sessions > 0 ? row.total_tokens_used / row.total_sessions : 0,
    avgCostUsd: row.total_sessions > 0 ? row.total_cost_usd / row.total_sessions : 0,
    successRate: row.total_sessions > 0 ? row.success_count / row.total_sessions : 0,
  };
}

/**
 * Get all agent metrics sorted by usage
 */
export function getAllAgentMetrics(): AgentMetrics[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM agent_metrics
    ORDER BY total_sessions DESC
  `).all() as AgentMetricsRow[];

  return rows.map(row => ({
    agentName: row.agent_name,
    totalSessions: row.total_sessions,
    successCount: row.success_count,
    failureCount: row.failure_count,
    avgDurationMs: row.total_sessions > 0 ? row.total_duration_ms / row.total_sessions : 0,
    avgToolCalls: row.total_sessions > 0 ? row.total_tool_calls / row.total_sessions : 0,
    avgTokensUsed: row.total_sessions > 0 ? row.total_tokens_used / row.total_sessions : 0,
    avgCostUsd: row.total_sessions > 0 ? row.total_cost_usd / row.total_sessions : 0,
    successRate: row.total_sessions > 0 ? row.success_count / row.total_sessions : 0,
  }));
}

/**
 * Get hierarchy summary for a root session
 */
export function getHierarchySummary(rootSessionId: string): AgentHierarchySummary {
  const db = getDatabase();

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_agents,
      MAX(depth) as max_depth,
      SUM(allocated_budget_usd) as total_allocated,
      SUM(spent_budget_usd) as total_spent,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) as running,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM agent_tree_nodes
    WHERE root_session_id = ?
  `).get(rootSessionId) as {
    total_agents: number;
    max_depth: number;
    total_allocated: number | null;
    total_spent: number | null;
    running: number;
    completed: number;
    failed: number;
  };

  return {
    rootSessionId,
    totalAgents: stats.total_agents || 0,
    maxDepth: stats.max_depth || 0,
    totalBudgetAllocated: stats.total_allocated || 0,
    totalBudgetSpent: stats.total_spent || 0,
    runningAgents: stats.running || 0,
    completedAgents: stats.completed || 0,
    failedAgents: stats.failed || 0,
  };
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up old completed agent trees
 */
export function cleanupOldAgentTrees(maxAgeHours: number = 72): number {
  const db = getDatabase();
  const threshold = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000).toISOString();

  // Only delete trees where all agents are completed
  const result = db.prepare(`
    DELETE FROM agent_tree_nodes
    WHERE root_session_id IN (
      SELECT root_session_id FROM agent_tree_nodes
      WHERE completed_at IS NOT NULL AND completed_at < ?
      GROUP BY root_session_id
      HAVING COUNT(*) = SUM(CASE WHEN status != 'running' THEN 1 ELSE 0 END)
    )
  `).run(threshold);

  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} old agent tree nodes`);
  }

  return result.changes;
}
