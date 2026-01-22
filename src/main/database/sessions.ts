// ============================================================================
// DATABASE - Session Operations
// ============================================================================

import { getDatabase } from './connection.js';
import type { Session } from '../../shared/types/index.js';
import { mapRowToSession, type SessionRow } from './mappers.js';

// ============================================================================
// SESSION OPERATIONS
// ============================================================================

export function upsertSession(session: Partial<Session> & { id: string }): void {
  const database = getDatabase();

  const existing = database.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);

  if (existing) {
    database.prepare(`
      UPDATE sessions SET
        project_name = ?,
        file_path = ?,
        start_time = ?,
        end_time = ?,
        message_count = ?,
        token_count = ?,
        cost = ?,
        status = ?,
        input_tokens = ?,
        output_tokens = ?,
        cache_write_tokens = ?,
        cache_read_tokens = ?,
        file_mtime = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      session.projectName ?? null,
      session.filePath ?? null,
      session.startTime ?? null,
      session.endTime ?? null,
      session.messageCount ?? 0,
      session.tokenCount ?? 0,
      session.cost ?? 0,
      session.status ?? 'unknown',
      session.inputTokens ?? 0,
      session.outputTokens ?? 0,
      session.cacheWriteTokens ?? 0,
      session.cacheReadTokens ?? 0,
      session.fileMtime ?? null,
      session.id
    );
  } else {
    database.prepare(`
      INSERT INTO sessions (
        id, project_name, file_path, start_time, end_time,
        message_count, token_count, cost, status,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
        file_mtime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.projectName ?? null,
      session.filePath ?? null,
      session.startTime ?? null,
      session.endTime ?? null,
      session.messageCount ?? 0,
      session.tokenCount ?? 0,
      session.cost ?? 0,
      session.status ?? 'unknown',
      session.inputTokens ?? 0,
      session.outputTokens ?? 0,
      session.cacheWriteTokens ?? 0,
      session.cacheReadTokens ?? 0,
      session.fileMtime ?? null
    );
  }
}

export function getAllSessions(options?: { limit?: number; offset?: number }): Session[] {
  const database = getDatabase();
  const { limit, offset = 0 } = options ?? {};

  let query = 'SELECT * FROM sessions ORDER BY end_time DESC';
  const params: number[] = [];

  if (limit !== undefined) {
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);
  }

  const stmt = database.prepare(query);
  const rows = (params.length > 0 ? stmt.all(...params) : stmt.all()) as SessionRow[];
  return rows.map(mapRowToSession);
}

export function getSession(sessionId: string): Session | null {
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  return row ? mapRowToSession(row) : null;
}

export function deleteSession(sessionId: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function toggleFavorite(sessionId: string): void {
  const database = getDatabase();
  database.prepare("UPDATE sessions SET favorite = NOT favorite, updated_at = datetime('now') WHERE id = ?").run(sessionId);
}

export function toggleArchive(sessionId: string): void {
  const database = getDatabase();
  database.prepare("UPDATE sessions SET archived = NOT archived, updated_at = datetime('now') WHERE id = ?").run(sessionId);
}

export function getActiveSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE archived = 0 OR archived IS NULL ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}

export function getFavoriteSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE favorite = 1 AND (archived = 0 OR archived IS NULL) ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}

export function getArchivedSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE archived = 1 ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}
