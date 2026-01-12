// ============================================================================
// QUICK NOTES DATABASE OPERATIONS
// ============================================================================

import { getDatabase } from './connection.js';
import type { QuickNote } from '../../shared/types/index.js';

/**
 * Database row type for quick_notes table (with join to sessions)
 */
interface QuickNoteRow {
  id: number;
  content: string;
  session_id: string | null;
  status: string;
  priority: string;
  project_name: string | null;
  created_at: string;
}

export function createQuickNote(content: string, sessionId?: string, priority?: string): number {
  const database = getDatabase();
  const result = database.prepare(`
    INSERT INTO quick_notes (content, session_id, priority)
    VALUES (?, ?, ?)
  `).run(content, sessionId ?? null, priority ?? 'normal');
  return result.lastInsertRowid as number;
}

export function getQuickNotes(status: string = 'active'): QuickNote[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT qn.*, s.project_name
    FROM quick_notes qn
    LEFT JOIN sessions s ON qn.session_id = s.id
    WHERE qn.status = ?
    ORDER BY qn.created_at DESC
  `).all(status) as QuickNoteRow[];
  return rows.map(mapRowToQuickNote);
}

export function updateQuickNote(id: number, content: string): void {
  const database = getDatabase();
  database.prepare('UPDATE quick_notes SET content = ? WHERE id = ?').run(content, id);
}

export function setQuickNoteStatus(id: number, status: string): void {
  const database = getDatabase();
  database.prepare('UPDATE quick_notes SET status = ? WHERE id = ?').run(status, id);
}

export function deleteQuickNote(id: number): void {
  const database = getDatabase();
  database.prepare('DELETE FROM quick_notes WHERE id = ?').run(id);
}

export function linkQuickNoteToSession(noteId: number, sessionId: string): void {
  const database = getDatabase();
  database.prepare('UPDATE quick_notes SET session_id = ? WHERE id = ?').run(sessionId, noteId);
}

function mapRowToQuickNote(row: QuickNoteRow): QuickNote {
  return {
    id: row.id,
    content: row.content,
    sessionId: row.session_id,
    status: row.status as 'active' | 'completed' | 'archived',
    priority: row.priority as 'low' | 'normal' | 'high',
    projectName: row.project_name ?? undefined,
    createdAt: row.created_at,
  };
}
