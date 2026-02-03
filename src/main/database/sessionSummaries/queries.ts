// ============================================================================
// SESSION SUMMARIES - Core CRUD operations
// ============================================================================

import { getDatabase } from '../connection.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import type {
  SessionSummary,
  SessionSummaryRow,
  SessionCheckpoint,
  SessionCheckpointRow,
} from './types.js';

// ============================================================================
// MAPPERS
// ============================================================================

export function mapRowToSessionSummary(row: SessionSummaryRow): SessionSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectPath: row.project_path,
    title: row.title,
    description: row.description,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationMs: row.duration_ms,
    status: row.status,
    toolCalls: row.tool_calls,
    filesModified: row.files_modified,
    filesCreated: row.files_created,
    testsRun: row.tests_run,
    testsPassed: row.tests_passed,
    testsFailed: row.tests_failed,
    tokensUsed: row.tokens_used,
    costUsd: row.cost_usd,
    activeAgentIds: row.active_agent_ids,
    injectedSkillIds: row.injected_skill_ids,
    keyTopics: row.key_topics,
    fileChanges: row.file_changes,
    lastPrompt: row.last_prompt,
    contextSnapshot: row.context_snapshot,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapRowToCheckpoint(row: SessionCheckpointRow): SessionCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    checkpointName: row.checkpoint_name,
    context: row.context,
    createdAt: row.created_at,
  };
}

// ============================================================================
// SESSION SUMMARY OPERATIONS
// ============================================================================

/**
 * Create or update a session summary
 */
export function upsertSessionSummary(
  summary: Omit<SessionSummary, 'id' | 'createdAt' | 'updatedAt'>
): SessionSummary {
  const db = getDatabase();

  const existing = db.prepare(
    'SELECT id FROM session_summaries WHERE session_id = ?'
  ).get(summary.sessionId) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE session_summaries SET
        project_path = ?,
        title = ?,
        description = ?,
        started_at = ?,
        ended_at = ?,
        duration_ms = ?,
        status = ?,
        tool_calls = ?,
        files_modified = ?,
        files_created = ?,
        tests_run = ?,
        tests_passed = ?,
        tests_failed = ?,
        tokens_used = ?,
        cost_usd = ?,
        active_agent_ids = ?,
        injected_skill_ids = ?,
        key_topics = ?,
        file_changes = ?,
        last_prompt = ?,
        context_snapshot = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      summary.projectPath,
      summary.title,
      summary.description,
      summary.startedAt,
      summary.endedAt,
      summary.durationMs,
      summary.status,
      summary.toolCalls,
      summary.filesModified,
      summary.filesCreated,
      summary.testsRun,
      summary.testsPassed,
      summary.testsFailed,
      summary.tokensUsed,
      summary.costUsd,
      summary.activeAgentIds,
      summary.injectedSkillIds,
      summary.keyTopics,
      summary.fileChanges,
      summary.lastPrompt,
      summary.contextSnapshot,
      existing.id
    );
    const updated = getSessionSummary(existing.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated session summary with id ${existing.id}`);
    }
    return updated;
  } else {
    const result = db.prepare(`
      INSERT INTO session_summaries (
        session_id, project_path, title, description,
        started_at, ended_at, duration_ms, status,
        tool_calls, files_modified, files_created,
        tests_run, tests_passed, tests_failed,
        tokens_used, cost_usd,
        active_agent_ids, injected_skill_ids,
        key_topics, file_changes,
        last_prompt, context_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      summary.sessionId,
      summary.projectPath,
      summary.title,
      summary.description,
      summary.startedAt,
      summary.endedAt,
      summary.durationMs,
      summary.status,
      summary.toolCalls,
      summary.filesModified,
      summary.filesCreated,
      summary.testsRun,
      summary.testsPassed,
      summary.testsFailed,
      summary.tokensUsed,
      summary.costUsd,
      summary.activeAgentIds,
      summary.injectedSkillIds,
      summary.keyTopics,
      summary.fileChanges,
      summary.lastPrompt,
      summary.contextSnapshot
    );
    const inserted = getSessionSummary(result.lastInsertRowid as number);
    if (!inserted) {
      throw new Error(`Failed to retrieve inserted session summary with id ${result.lastInsertRowid}`);
    }
    return inserted;
  }
}

/**
 * Get session summary by ID
 */
export function getSessionSummary(id: number): SessionSummary | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM session_summaries WHERE id = ?').get(id) as SessionSummaryRow | undefined;
  return row ? mapRowToSessionSummary(row) : null;
}

/**
 * Get session summary by session ID
 */
export function getSessionSummaryBySessionId(sessionId: string): SessionSummary | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM session_summaries WHERE session_id = ?').get(sessionId) as SessionSummaryRow | undefined;
  return row ? mapRowToSessionSummary(row) : null;
}

/**
 * Get recent sessions for a project
 */
export function getRecentSessionsForProject(
  projectPath: string,
  limit: number = 20
): SessionSummary[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM session_summaries
    WHERE project_path = ?
    ORDER BY started_at DESC
    LIMIT ?
  `).all(projectPath, limit) as SessionSummaryRow[];
  return rows.map(mapRowToSessionSummary);
}

/**
 * Get all recent sessions
 */
export function getRecentSessions(limit: number = 50): SessionSummary[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM session_summaries
    ORDER BY started_at DESC
    LIMIT ?
  `).all(limit) as SessionSummaryRow[];
  return rows.map(mapRowToSessionSummary);
}

/**
 * Update session metrics
 */
export function updateSessionMetrics(
  sessionId: string,
  metrics: Partial<Pick<SessionSummary,
    'toolCalls' | 'filesModified' | 'filesCreated' |
    'testsRun' | 'testsPassed' | 'testsFailed' |
    'tokensUsed' | 'costUsd'
  >>
): void {
  const db = getDatabase();
  const existing = getSessionSummaryBySessionId(sessionId);
  if (!existing) return;

  const updates: string[] = [];
  const params: (string | number)[] = [];

  if (metrics.toolCalls !== undefined) {
    updates.push('tool_calls = ?');
    params.push(metrics.toolCalls);
  }
  if (metrics.filesModified !== undefined) {
    updates.push('files_modified = ?');
    params.push(metrics.filesModified);
  }
  if (metrics.filesCreated !== undefined) {
    updates.push('files_created = ?');
    params.push(metrics.filesCreated);
  }
  if (metrics.testsRun !== undefined) {
    updates.push('tests_run = ?');
    params.push(metrics.testsRun);
  }
  if (metrics.testsPassed !== undefined) {
    updates.push('tests_passed = ?');
    params.push(metrics.testsPassed);
  }
  if (metrics.testsFailed !== undefined) {
    updates.push('tests_failed = ?');
    params.push(metrics.testsFailed);
  }
  if (metrics.tokensUsed !== undefined) {
    updates.push('tokens_used = ?');
    params.push(metrics.tokensUsed);
  }
  if (metrics.costUsd !== undefined) {
    updates.push('cost_usd = ?');
    params.push(metrics.costUsd);
  }

  if (updates.length === 0) return;

  updates.push('updated_at = datetime(\'now\')');
  params.push(sessionId);

  db.prepare(`
    UPDATE session_summaries SET ${updates.join(', ')}
    WHERE session_id = ?
  `).run(...params);
}

/**
 * End a session
 */
export function endSession(
  sessionId: string,
  status: 'completed' | 'aborted' | 'error'
): void {
  const db = getDatabase();
  const now = formatTimestamp();

  const existing = getSessionSummaryBySessionId(sessionId);
  if (!existing) return;

  const startTime = new Date(existing.startedAt).getTime();
  const endTime = Date.now();
  const durationMs = endTime - startTime;

  db.prepare(`
    UPDATE session_summaries SET
      ended_at = ?,
      duration_ms = ?,
      status = ?,
      updated_at = datetime('now')
    WHERE session_id = ?
  `).run(now, durationMs, status, sessionId);
}

/**
 * Update context snapshot for resumption
 */
export function updateContextSnapshot(
  sessionId: string,
  snapshot: Record<string, unknown>
): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE session_summaries SET
      context_snapshot = ?,
      updated_at = datetime('now')
    WHERE session_id = ?
  `).run(JSON.stringify(snapshot), sessionId);
}

/**
 * Update last prompt
 */
export function updateLastPrompt(sessionId: string, prompt: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE session_summaries SET
      last_prompt = ?,
      updated_at = datetime('now')
    WHERE session_id = ?
  `).run(prompt, sessionId);
}

/**
 * Add file change to session
 */
export function addFileChange(
  sessionId: string,
  change: { filePath: string; action: 'created' | 'modified' | 'deleted'; timestamp: string }
): void {
  const db = getDatabase();
  const existing = getSessionSummaryBySessionId(sessionId);
  if (!existing) return;

  const changes = JSON.parse(existing.fileChanges ?? '[]') as typeof change[];
  changes.push(change);

  db.prepare(`
    UPDATE session_summaries SET
      file_changes = ?,
      updated_at = datetime('now')
    WHERE session_id = ?
  `).run(JSON.stringify(changes), sessionId);
}

// ============================================================================
// SESSION CHECKPOINT OPERATIONS
// ============================================================================

/**
 * Create a checkpoint
 */
export function createCheckpoint(
  sessionId: string,
  name: string,
  context: Record<string, unknown>
): SessionCheckpoint {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO session_checkpoints (session_id, checkpoint_name, context)
    VALUES (?, ?, ?)
  `).run(sessionId, name, JSON.stringify(context));

  const inserted = getCheckpoint(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve created checkpoint with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get a checkpoint
 */
export function getCheckpoint(id: number): SessionCheckpoint | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM session_checkpoints WHERE id = ?').get(id) as SessionCheckpointRow | undefined;
  return row ? mapRowToCheckpoint(row) : null;
}

/**
 * Get checkpoints for a session
 */
export function getSessionCheckpoints(sessionId: string): SessionCheckpoint[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM session_checkpoints
    WHERE session_id = ?
    ORDER BY created_at DESC
  `).all(sessionId) as SessionCheckpointRow[];
  return rows.map(mapRowToCheckpoint);
}

/**
 * Delete a checkpoint
 */
export function deleteCheckpoint(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM session_checkpoints WHERE id = ?').run(id);
}
