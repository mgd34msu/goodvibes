// ============================================================================
// AGENCY INDEX DATABASE - Indexed Skill Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  IndexedSkill,
  IndexedSkillRow,
  SearchResult,
} from './types.js';

// ============================================================================
// INDEXED SKILL OPERATIONS
// ============================================================================

export function upsertIndexedSkill(skill: Omit<IndexedSkill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>): IndexedSkill {
  const db = getDatabase();

  const existing = db.prepare('SELECT id, use_count, last_used FROM indexed_skills WHERE slug = ?').get(skill.slug) as { id: number; use_count: number; last_used: string | null } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE indexed_skills SET
        name = ?,
        description = ?,
        content = ?,
        category_id = ?,
        category_path = ?,
        file_path = ?,
        agent_slug = ?,
        triggers = ?,
        tags = ?,
        last_indexed = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      skill.name,
      skill.description,
      skill.content,
      skill.categoryId,
      skill.categoryPath,
      skill.filePath,
      skill.agentSlug,
      JSON.stringify(skill.triggers || []),
      JSON.stringify(skill.tags || []),
      skill.lastIndexed,
      existing.id
    );
    const updated = getIndexedSkill(existing.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated skill with id ${existing.id}`);
    }
    return updated;
  } else {
    const result = db.prepare(`
      INSERT INTO indexed_skills (
        name, slug, description, content, category_id, category_path,
        file_path, agent_slug, triggers, tags, last_indexed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      skill.name,
      skill.slug,
      skill.description,
      skill.content,
      skill.categoryId,
      skill.categoryPath,
      skill.filePath,
      skill.agentSlug,
      JSON.stringify(skill.triggers || []),
      JSON.stringify(skill.tags || []),
      skill.lastIndexed
    );
    const inserted = getIndexedSkill(result.lastInsertRowid as number);
    if (!inserted) {
      throw new Error(`Failed to retrieve inserted skill with id ${result.lastInsertRowid}`);
    }
    return inserted;
  }
}

export function getIndexedSkill(id: number): IndexedSkill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM indexed_skills WHERE id = ?').get(id) as IndexedSkillRow | undefined;
  return row ? mapRowToIndexedSkill(row) : null;
}

export function getIndexedSkillBySlug(slug: string): IndexedSkill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM indexed_skills WHERE slug = ?').get(slug) as IndexedSkillRow | undefined;
  return row ? mapRowToIndexedSkill(row) : null;
}

export function getAllIndexedSkills(): IndexedSkill[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM indexed_skills ORDER BY name').all() as IndexedSkillRow[];
  return rows.map(mapRowToIndexedSkill);
}

export function getIndexedSkillsByCategory(categoryId: number): IndexedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_skills
    WHERE category_id = ?
    ORDER BY name
  `).all(categoryId) as IndexedSkillRow[];
  return rows.map(mapRowToIndexedSkill);
}

export function getIndexedSkillsByCategoryPath(categoryPath: string): IndexedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_skills
    WHERE category_path LIKE ?
    ORDER BY name
  `).all(`${categoryPath}%`) as IndexedSkillRow[];
  return rows.map(mapRowToIndexedSkill);
}

export function getIndexedSkillsByAgent(agentSlug: string): IndexedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_skills
    WHERE agent_slug = ?
    ORDER BY name
  `).all(agentSlug) as IndexedSkillRow[];
  return rows.map(mapRowToIndexedSkill);
}

export function getPopularSkills(limit: number = 10): IndexedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_skills
    ORDER BY use_count DESC, name
    LIMIT ?
  `).all(limit) as IndexedSkillRow[];
  return rows.map(mapRowToIndexedSkill);
}

export function getRecentlyUsedSkills(limit: number = 10): IndexedSkill[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM indexed_skills
    WHERE last_used IS NOT NULL
    ORDER BY last_used DESC
    LIMIT ?
  `).all(limit) as IndexedSkillRow[];
  return rows.map(mapRowToIndexedSkill);
}

export function searchIndexedSkills(query: string, limit: number = 50): SearchResult<IndexedSkill>[] {
  const db = getDatabase();

  // Use FTS5 for full-text search
  const rows = db.prepare(`
    SELECT isk.*, fts.rank
    FROM indexed_skills isk
    JOIN indexed_skills_fts fts ON isk.id = fts.rowid
    WHERE indexed_skills_fts MATCH ?
    ORDER BY fts.rank
    LIMIT ?
  `).all(query, limit) as IndexedSkillRow[];

  return rows.map(row => ({
    item: mapRowToIndexedSkill(row),
    score: -(row.rank ?? 0),
    matchedFields: ['name', 'description', 'content', 'triggers'],
  }));
}

export function recordSkillUsage(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE indexed_skills SET
      use_count = use_count + 1,
      last_used = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function deleteIndexedSkill(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM indexed_skills WHERE id = ?').run(id);
}

export function clearIndexedSkills(): void {
  const db = getDatabase();
  db.prepare('DELETE FROM indexed_skills').run();
}

export function getSkillCount(): number {
  const db = getDatabase();
  const result = db.prepare('SELECT COUNT(*) as count FROM indexed_skills').get() as { count: number };
  return result.count;
}

function mapRowToIndexedSkill(row: IndexedSkillRow): IndexedSkill {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    content: row.content,
    categoryId: row.category_id,
    categoryPath: row.category_path,
    filePath: row.file_path,
    agentSlug: row.agent_slug,
    triggers: JSON.parse(row.triggers || '[]'),
    tags: JSON.parse(row.tags || '[]'),
    useCount: row.use_count,
    lastUsed: row.last_used,
    lastIndexed: row.last_indexed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
