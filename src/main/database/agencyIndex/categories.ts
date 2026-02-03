// ============================================================================
// AGENCY INDEX DATABASE - Category Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  AgencyCategory,
  CategoryRow,
} from './types.js';

// ============================================================================
// CATEGORY OPERATIONS
// ============================================================================

export function upsertCategory(category: Omit<AgencyCategory, 'id' | 'createdAt' | 'updatedAt'>): AgencyCategory {
  const db = getDatabase();

  const existing = db.prepare('SELECT id FROM agency_categories WHERE path = ?').get(category.path) as { id: number } | undefined;

  if (existing) {
    db.prepare(`
      UPDATE agency_categories SET
        name = ?,
        parent_id = ?,
        type = ?,
        item_count = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      category.name,
      category.parentId,
      category.type,
      category.itemCount,
      existing.id
    );
    const updated = getCategory(existing.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated category with id ${existing.id}`);
    }
    return updated;
  } else {
    const result = db.prepare(`
      INSERT INTO agency_categories (name, path, parent_id, type, item_count)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      category.name,
      category.path,
      category.parentId,
      category.type,
      category.itemCount
    );
    const inserted = getCategory(result.lastInsertRowid as number);
    if (!inserted) {
      throw new Error(`Failed to retrieve inserted category with id ${result.lastInsertRowid}`);
    }
    return inserted;
  }
}

export function getCategory(id: number): AgencyCategory | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agency_categories WHERE id = ?').get(id) as CategoryRow | undefined;
  return row ? mapRowToCategory(row) : null;
}

export function getCategoryByPath(path: string): AgencyCategory | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agency_categories WHERE path = ?').get(path) as CategoryRow | undefined;
  return row ? mapRowToCategory(row) : null;
}

export function getCategories(type?: 'agent' | 'skill'): AgencyCategory[] {
  const db = getDatabase();
  let query = 'SELECT * FROM agency_categories';
  const params: string[] = [];

  if (type) {
    query += ' WHERE type = ?';
    params.push(type);
  }

  query += ' ORDER BY path';
  const rows = db.prepare(query).all(...params) as CategoryRow[];
  return rows.map(mapRowToCategory);
}

export function getCategoryTree(type: 'agent' | 'skill'): AgencyCategory[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM agency_categories
    WHERE type = ?
    ORDER BY path
  `).all(type) as CategoryRow[];
  return rows.map(mapRowToCategory);
}

export function updateCategoryCount(id: number, count: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agency_categories SET
      item_count = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(count, id);
}

function mapRowToCategory(row: CategoryRow): AgencyCategory {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    parentId: row.parent_id,
    type: row.type,
    itemCount: row.item_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
