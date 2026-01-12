// ============================================================================
// SESSION SUMMARIES DATABASE - Schema for session intelligence
// ============================================================================
//
// This module provides database operations for storing session summaries,
// enabling cross-session search, session comparison, and resumption.
//
// ============================================================================

import { getDatabase } from './connection.js';
import { Logger } from '../services/logger.js';
import { formatTimestamp } from '../../shared/dateUtils.js';

const logger = new Logger('SessionSummariesDB');

// ============================================================================
// DATABASE ROW TYPES (Raw SQLite rows before mapping)
// ============================================================================

/** Raw row from session_summaries table */
interface SessionSummaryRow {
  id: number;
  session_id: string;
  project_path: string;
  title: string;
  description: string;
  started_at: string;
  ended_at: string | null;
  duration_ms: number;
  status: 'completed' | 'aborted' | 'error';
  tool_calls: number;
  files_modified: number;
  files_created: number;
  tests_run: number;
  tests_passed: number;
  tests_failed: number;
  tokens_used: number;
  cost_usd: number;
  active_agent_ids: string;
  injected_skill_ids: string;
  key_topics: string;
  file_changes: string;
  last_prompt: string | null;
  context_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

/** Raw row from session_checkpoints table */
interface SessionCheckpointRow {
  id: number;
  session_id: string;
  checkpoint_name: string;
  context: string;
  created_at: string;
}

// ============================================================================
// TYPES
// ============================================================================

/**
 * Session summary record
 */
export interface SessionSummary {
  id: number;
  sessionId: string;
  projectPath: string;
  title: string;
  description: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  status: 'completed' | 'aborted' | 'error';

  // Metrics
  toolCalls: number;
  filesModified: number;
  filesCreated: number;
  testsRun: number;
  testsPassed: number;
  testsFailed: number;
  tokensUsed: number;
  costUsd: number;

  // Context
  activeAgentIds: string;  // JSON array
  injectedSkillIds: string;  // JSON array
  keyTopics: string;  // JSON array of extracted topics
  fileChanges: string;  // JSON array of file change summaries

  // Resumption
  lastPrompt: string | null;
  contextSnapshot: string | null;  // JSON object for resumption

  createdAt: string;
  updatedAt: string;
}

/**
 * Session checkpoint for resumption
 */
export interface SessionCheckpoint {
  id: number;
  sessionId: string;
  checkpointName: string;
  context: string;  // JSON snapshot
  createdAt: string;
}

/**
 * Session comparison result
 */
export interface SessionComparison {
  session1: SessionSummary;
  session2: SessionSummary;
  commonFiles: string[];
  session1OnlyFiles: string[];
  session2OnlyFiles: string[];
  durationDiff: number;
  costDiff: number;
  toolCallsDiff: number;
}

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createSessionSummariesTables(): void {
  const db = getDatabase();

  // Session summaries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER DEFAULT 0,
      status TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'aborted', 'error')),

      tool_calls INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0,
      files_created INTEGER DEFAULT 0,
      tests_run INTEGER DEFAULT 0,
      tests_passed INTEGER DEFAULT 0,
      tests_failed INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,

      active_agent_ids TEXT DEFAULT '[]',
      injected_skill_ids TEXT DEFAULT '[]',
      key_topics TEXT DEFAULT '[]',
      file_changes TEXT DEFAULT '[]',

      last_prompt TEXT,
      context_snapshot TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Session checkpoints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      checkpoint_name TEXT NOT NULL,
      context TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES session_summaries(session_id) ON DELETE CASCADE
    )
  `);

  // Create FTS5 table for full-text search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        title,
        description,
        key_topics,
        last_prompt,
        content='session_summaries',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);
  } catch {
    logger.debug('Session summaries FTS table already exists');
  }

  // Create triggers for FTS
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, title, description, key_topics, last_prompt)
        VALUES (new.id, new.title, new.description, new.key_topics, new.last_prompt);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, description, key_topics, last_prompt)
        VALUES ('delete', old.id, old.title, old.description, old.key_topics, old.last_prompt);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, description, key_topics, last_prompt)
        VALUES ('delete', old.id, old.title, old.description, old.key_topics, old.last_prompt);
        INSERT INTO session_summaries_fts(rowid, title, description, key_topics, last_prompt)
        VALUES (new.id, new.title, new.description, new.key_topics, new.last_prompt);
      END
    `);
  } catch {
    logger.debug('Session summaries FTS triggers already exist');
  }

  // Create indexes
  createSessionSummariesIndexes();

  logger.info('Session summaries tables created');
}

function createSessionSummariesIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_started ON session_summaries(started_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_status ON session_summaries(status)',
    'CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session ON session_checkpoints(session_id)',
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
 * Search sessions using full-text search
 */
export function searchSessions(
  query: string,
  projectPath?: string,
  limit: number = 50
): SessionSummary[] {
  const db = getDatabase();

  let sql = `
    SELECT ss.* FROM session_summaries ss
    JOIN session_summaries_fts fts ON ss.id = fts.rowid
    WHERE session_summaries_fts MATCH ?
  `;
  const params: (string | number)[] = [query];

  if (projectPath) {
    sql += ' AND ss.project_path = ?';
    params.push(projectPath);
  }

  sql += ' ORDER BY fts.rank LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as SessionSummaryRow[];
  return rows.map(mapRowToSessionSummary);
}

/**
 * Find sessions that modified a specific file
 */
export function findSessionsByFile(
  filePath: string,
  projectPath?: string,
  limit: number = 20
): SessionSummary[] {
  const db = getDatabase();

  let sql = `
    SELECT * FROM session_summaries
    WHERE file_changes LIKE ?
  `;
  const params: (string | number)[] = [`%"${filePath}"%`];

  if (projectPath) {
    sql += ' AND project_path = ?';
    params.push(projectPath);
  }

  sql += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(sql).all(...params) as SessionSummaryRow[];
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

  const changes = JSON.parse(existing.fileChanges) as typeof change[];
  changes.push(change);

  db.prepare(`
    UPDATE session_summaries SET
      file_changes = ?,
      updated_at = datetime('now')
    WHERE session_id = ?
  `).run(JSON.stringify(changes), sessionId);
}

function mapRowToSessionSummary(row: SessionSummaryRow): SessionSummary {
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

function mapRowToCheckpoint(row: SessionCheckpointRow): SessionCheckpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    checkpointName: row.checkpoint_name,
    context: row.context,
    createdAt: row.created_at,
  };
}

// ============================================================================
// SESSION COMPARISON
// ============================================================================

/**
 * Compare two sessions
 */
export function compareSessions(
  sessionId1: string,
  sessionId2: string
): SessionComparison | null {
  const session1 = getSessionSummaryBySessionId(sessionId1);
  const session2 = getSessionSummaryBySessionId(sessionId2);

  if (!session1 || !session2) return null;

  const files1 = new Set<string>(
    JSON.parse(session1.fileChanges).map((c: { filePath: string }) => c.filePath)
  );
  const files2 = new Set<string>(
    JSON.parse(session2.fileChanges).map((c: { filePath: string }) => c.filePath)
  );

  const commonFiles: string[] = [];
  const session1OnlyFiles: string[] = [];
  const session2OnlyFiles: string[] = [];

  for (const file of files1) {
    if (files2.has(file)) {
      commonFiles.push(file);
    } else {
      session1OnlyFiles.push(file);
    }
  }

  for (const file of files2) {
    if (!files1.has(file)) {
      session2OnlyFiles.push(file);
    }
  }

  return {
    session1,
    session2,
    commonFiles,
    session1OnlyFiles,
    session2OnlyFiles,
    durationDiff: session1.durationMs - session2.durationMs,
    costDiff: session1.costUsd - session2.costUsd,
    toolCallsDiff: session1.toolCalls - session2.toolCalls,
  };
}

// ============================================================================
// CLEANUP
// ============================================================================

/**
 * Clean up old sessions
 */
export function cleanupOldSessions(maxAgeDays: number = 30): number {
  const db = getDatabase();
  const threshold = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

  const result = db.prepare(`
    DELETE FROM session_summaries
    WHERE ended_at IS NOT NULL AND ended_at < ?
  `).run(threshold);

  if (result.changes > 0) {
    logger.info(`Cleaned up ${result.changes} old session summaries`);
  }

  return result.changes;
}
