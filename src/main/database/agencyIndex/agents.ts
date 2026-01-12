// ============================================================================
// AGENCY INDEX DATABASE - Indexed Agent Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  IndexedAgent,
  IndexedAgentRow,
  SearchResult,
} from './types.js';

// ============================================================================
// INDEXED AGENT OPERATIONS
// ============================================================================

export function upsertIndexedAgent(agent: Omit<IndexedAgent, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>): IndexedAgent {
  const db = getDatabase();

  const existing = db.prepare('SELECT id, use_count, last_used FROM indexed_agents WHERE slug = ?').get(agent.slug) as { id: number; use_count: number; last_used: string | null } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE indexed_agents SET
        name = ?,
        description = ?,
        content = ?,
        category_id = ?,
        category_path = ?,
        file_path = ?,
        skills = ?,
        tags = ?,
        last_indexed = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      agent.name,
      agent.description,
      agent.content,
      agent.categoryId,
      agent.categoryPath,
      agent.filePath,
      JSON.stringify(agent.skills || []),
      JSON.stringify(agent.tags || []),
      agent.lastIndexed,
      existing.id
    );
    const updated = getIndexedAgent(existing.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated agent with id ${existing.id}`);
    }
    return updated;
  } else {
    const result = db.prepare(`
      INSERT INTO indexed_agents (
        name, slug, description, content, category_id, category_path,
        file_path, skills, tags, last_indexed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      agent.name,
      agent.slug,
      agent.description,
      agent.content,
      agent.categoryId,
      agent.categoryPath,
      agent.filePath,
      JSON.stringify(agent.skills || []),
      JSON.stringify(agent.tags || []),
      agent.lastIndexed
    );
    const inserted = getIndexedAgent(result.lastInsertRowid as number);
    if (!inserted) {
      throw new Error(`Failed to retrieve inserted agent with id ${result.lastInsertRowid}`);
    }
    return inserted;
  }
}

export function getIndexedAgent(id: number): IndexedAgent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM indexed_agents WHERE id = ?').get(id) as IndexedAgentRow | undefined;
  return row ? mapRowToIndexedAgent(row) : null;
}

export function getIndexedAgentBySlug(slug: string): IndexedAgent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM indexed_agents WHERE slug = ?').get(slug) as IndexedAgentRow | undefined;
  return row ? mapRowToIndexedAgent(row) : null;
}

export function getAllIndexedAgents(): IndexedAgent[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM indexed_agents ORDER BY name').all() as IndexedAgentRow[];
  return rows.map(mapRowToIndexedAgent);
}

export function getIndexedAgentsByCategory(categoryId: number): IndexedAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_agents
    WHERE category_id = ?
    ORDER BY name
  `).all(categoryId) as IndexedAgentRow[];
  return rows.map(mapRowToIndexedAgent);
}

export function getIndexedAgentsByCategoryPath(categoryPath: string): IndexedAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_agents
    WHERE category_path LIKE ?
    ORDER BY name
  `).all(`${categoryPath}%`) as IndexedAgentRow[];
  return rows.map(mapRowToIndexedAgent);
}

export function getPopularAgents(limit: number = 10): IndexedAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_agents
    ORDER BY use_count DESC, name
    LIMIT ?
  `).all(limit) as IndexedAgentRow[];
  return rows.map(mapRowToIndexedAgent);
}

export function getRecentlyUsedAgents(limit: number = 10): IndexedAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_agents
    WHERE last_used IS NOT NULL
    ORDER BY last_used DESC
    LIMIT ?
  `).all(limit) as IndexedAgentRow[];
  return rows.map(mapRowToIndexedAgent);
}

export function searchIndexedAgents(query: string, limit: number = 50): SearchResult<IndexedAgent>[] {
  const db = getDatabase();

  // Use FTS5 for full-text search
  const rows = db.prepare(`
    SELECT ia.*, fts.rank
    FROM indexed_agents ia
    JOIN indexed_agents_fts fts ON ia.id = fts.rowid
    WHERE indexed_agents_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(query, limit) as IndexedAgentRow[];

  return rows.map(row => ({
    item: mapRowToIndexedAgent(row),
    score: -(row.rank ?? 0), // FTS5 rank is negative, lower is better
    matchedFields: ['name', 'description', 'content'], // Simplified
  }));
}

export function recordAgentUsage(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE indexed_agents SET
      use_count = use_count + 1,
      last_used = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function deleteIndexedAgent(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM indexed_agents WHERE id = ?').run(id);
}

export function clearIndexedAgents(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM indexed_agents').run();
}

export function getAgentCount(): number {
  const db = getDatabase();
  const result = db.prepare('SELECT COUNT(*) as count FROM indexed_agents').get() as { count: number };
  return result.count;
}

function mapRowToIndexedAgent(row: IndexedAgentRow): IndexedAgent {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    content: row.content,
    categoryId: row.category_id,
    categoryPath: row.category_path,
    filePath: row.file_path,
    skills: JSON.parse(row.skills || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    useCount: row.use_count,
    lastUsed: row.last_used,
    lastIndexed: row.last_indexed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
