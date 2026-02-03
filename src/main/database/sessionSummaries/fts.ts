// ============================================================================
// SESSION SUMMARIES - Full-text search and comparison operations
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';
import type { SessionSummary, SessionSummaryRow, SessionComparison } from './types.js';
import { mapRowToSessionSummary, getSessionSummaryBySessionId } from './queries.js';

const logger = new Logger('SessionSummariesDB:FTS');

// ============================================================================
// FULL-TEXT SEARCH OPERATIONS
// ============================================================================

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
    JSON.parse(session1.fileChanges ?? '[]').map((c: { filePath: string }) => c.filePath)
  );
  const files2 = new Set<string>(
    JSON.parse(session2.fileChanges ?? '[]').map((c: { filePath: string }) => c.filePath)
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
