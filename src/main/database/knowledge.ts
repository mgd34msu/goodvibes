// ============================================================================
// KNOWLEDGE BASE DATABASE OPERATIONS
// ============================================================================

import { getDatabase } from './connection.js';
import type { KnowledgeEntry } from '../../shared/types/index.js';

/**
 * Database row type for knowledge_entries table
 */
interface KnowledgeEntryRow {
  id: number;
  title: string;
  content: string;
  category: string | null;
  tags: string | null;
  source_session_id: string | null;
  view_count: number;
  created_at: string;
  updated_at: string;
}

export function createKnowledgeEntry(
  title: string,
  content: string,
  category?: string,
  tags?: string,
  sourceSessionId?: string
): number {
  const database = getDatabase();
  const result = database.prepare(`
    INSERT INTO knowledge_entries (title, content, category, tags, source_session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(title, content, category ?? null, tags ?? null, sourceSessionId ?? null);
  return result.lastInsertRowid as number;
}

export function getAllKnowledgeEntries(): KnowledgeEntry[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM knowledge_entries ORDER BY updated_at DESC').all() as KnowledgeEntryRow[];
  return rows.map(mapRowToKnowledgeEntry);
}

export function getKnowledgeEntry(id: number): KnowledgeEntry | null {
  const database = getDatabase();
  // Increment view count
  database.prepare('UPDATE knowledge_entries SET view_count = view_count + 1 WHERE id = ?').run(id);
  const row = database.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as KnowledgeEntryRow | undefined;
  return row ? mapRowToKnowledgeEntry(row) : null;
}

export function getKnowledgeByCategory(category: string): KnowledgeEntry[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM knowledge_entries WHERE category = ? ORDER BY updated_at DESC').all(category) as KnowledgeEntryRow[];
  return rows.map(mapRowToKnowledgeEntry);
}

export function searchKnowledge(searchTerm: string): KnowledgeEntry[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT * FROM knowledge_entries
    WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
    ORDER BY view_count DESC
  `).all(`%${searchTerm}%`, `%${searchTerm}%`, `%${searchTerm}%`) as KnowledgeEntryRow[];
  return rows.map(mapRowToKnowledgeEntry);
}

export function updateKnowledgeEntry(
  id: number,
  title: string,
  content: string,
  category?: string,
  tags?: string
): void {
  const database = getDatabase();
  database.prepare(`
    UPDATE knowledge_entries
    SET title = ?, content = ?, category = ?, tags = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, content, category ?? null, tags ?? null, id);
}

export function deleteKnowledgeEntry(id: number): void {
  const database = getDatabase();
  database.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
}

export function getKnowledgeCategories(): { category: string; count: number }[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT category, COUNT(*) as count
    FROM knowledge_entries
    WHERE category IS NOT NULL
    GROUP BY category
    ORDER BY count DESC
  `).all() as { category: string; count: number }[];
  return rows;
}

export function getMostViewedKnowledge(limit: number = 10): KnowledgeEntry[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM knowledge_entries ORDER BY view_count DESC LIMIT ?').all(limit) as KnowledgeEntryRow[];
  return rows.map(mapRowToKnowledgeEntry);
}

function mapRowToKnowledgeEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    tags: row.tags,
    sourceSessionId: row.source_session_id,
    viewCount: row.view_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
