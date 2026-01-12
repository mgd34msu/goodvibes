// ============================================================================
// PROJECT REGISTRY DATABASE - Cross-Project Session Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  CrossProjectSession,
  CrossProjectSessionRow,
} from './types.js';

// ============================================================================
// CROSS-PROJECT SESSION OPERATIONS
// ============================================================================

/**
 * Record a session for cross-project tracking
 */
export function recordCrossProjectSession(
  sessionId: string,
  projectId: number,
  agentSessionId?: string,
  metadata?: Record<string, unknown>
): CrossProjectSession {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO cross_project_sessions (session_id, project_id, agent_session_id, metadata)
    VALUES (?, ?, ?, ?)
  `).run(
    sessionId,
    projectId,
    agentSessionId || null,
    metadata ? JSON.stringify(metadata) : null
  );

  const inserted = getCrossProjectSession(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve cross-project session with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get cross-project session by ID
 */
export function getCrossProjectSession(id: number): CrossProjectSession | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM cross_project_sessions WHERE id = ?').get(id) as CrossProjectSessionRow | undefined;
  return row ? mapRowToCrossProjectSession(row) : null;
}

/**
 * Get cross-project session by session ID
 */
export function getCrossProjectSessionBySessionId(sessionId: string): CrossProjectSession | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM cross_project_sessions WHERE session_id = ?').get(sessionId) as CrossProjectSessionRow | undefined;
  return row ? mapRowToCrossProjectSession(row) : null;
}

/**
 * Get all sessions for a project
 */
export function getProjectSessions(projectId: number, limit: number = 50): CrossProjectSession[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM cross_project_sessions
    WHERE project_id = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(projectId, limit) as CrossProjectSessionRow[];
  return rows.map(mapRowToCrossProjectSession);
}

/**
 * Get active sessions across all projects
 */
export function getActiveCrossProjectSessions(): CrossProjectSession[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM cross_project_sessions
    WHERE status = 'active'
    ORDER BY started_at DESC
  `).all() as CrossProjectSessionRow[];
  return rows.map(mapRowToCrossProjectSession);
}

/**
 * Update cross-project session
 */
export function updateCrossProjectSession(
  sessionId: string,
  updates: Partial<{
    status: 'active' | 'completed' | 'failed';
    tokensUsed: number;
    costUsd: number;
    metadata: Record<string, unknown>;
  }>
): void {
  const db = getDatabase();
  const setters: string[] = [];
  const params: (string | number)[] = [];

  if (updates.status !== undefined) {
    setters.push('status = ?');
    params.push(updates.status);
    if (updates.status !== 'active') {
      setters.push('ended_at = datetime(\'now\')');
    }
  }

  if (updates.tokensUsed !== undefined) {
    setters.push('tokens_used = ?');
    params.push(updates.tokensUsed);
  }

  if (updates.costUsd !== undefined) {
    setters.push('cost_usd = ?');
    params.push(updates.costUsd);
  }

  if (updates.metadata !== undefined) {
    setters.push('metadata = ?');
    params.push(JSON.stringify(updates.metadata));
  }

  if (setters.length === 0) return;

  params.push(sessionId);

  db.prepare(`
    UPDATE cross_project_sessions SET ${setters.join(', ')}
    WHERE session_id = ?
  `).run(...params);
}

/**
 * Increment session metrics
 */
export function incrementSessionMetrics(sessionId: string, tokens: number, cost: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE cross_project_sessions SET
      tokens_used = tokens_used + ?,
      cost_usd = cost_usd + ?
    WHERE session_id = ?
  `).run(tokens, cost, sessionId);
}

function mapRowToCrossProjectSession(row: CrossProjectSessionRow): CrossProjectSession {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    agentSessionId: row.agent_session_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    tokensUsed: row.tokens_used,
    costUsd: row.cost_usd,
    metadata: row.metadata,
  };
}
