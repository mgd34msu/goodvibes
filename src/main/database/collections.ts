// ============================================================================
// COLLECTION DATABASE OPERATIONS
// ============================================================================

import { getDatabase } from './connection.js';
import type { Collection, SmartCollection, SmartCollectionRule, Session } from '../../shared/types/index.js';
import {
  mapRowToSession,
  mapRowToCollection,
  mapRowToSmartCollection,
  type SessionRow,
  type CollectionRow,
  type SmartCollectionRow,
} from './mappers.js';

// ============================================================================
// COLLECTIONS
// ============================================================================

export function createCollection(name: string, color?: string, icon?: string, parentId?: number): number {
  const database = getDatabase();
  const result = database.prepare(`
    INSERT INTO collections (name, color, icon, parent_id)
    VALUES (?, ?, ?, ?)
  `).run(name, color ?? '#6366f1', icon ?? '📁', parentId ?? null);
  return result.lastInsertRowid as number;
}

export function getAllCollections(): Collection[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM collections ORDER BY sort_order, name').all() as CollectionRow[];
  return rows.map(mapRowToCollection);
}

export function updateCollection(id: number, name: string, color: string, icon: string): void {
  const database = getDatabase();
  database.prepare('UPDATE collections SET name = ?, color = ?, icon = ? WHERE id = ?').run(name, color, icon, id);
}

export function deleteCollection(id: number): void {
  const database = getDatabase();
  database.prepare('UPDATE sessions SET collection_id = NULL WHERE collection_id = ?').run(id);
  database.prepare('DELETE FROM collections WHERE id = ?').run(id);
}

export function addSessionToCollection(sessionId: string, collectionId: number): void {
  const database = getDatabase();
  database.prepare('UPDATE sessions SET collection_id = ? WHERE id = ?').run(collectionId, sessionId);
}

export function getSessionsByCollection(collectionId: number): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE collection_id = ? ORDER BY end_time DESC').all(collectionId) as SessionRow[];
  return rows.map(mapRowToSession);
}

// mapRowToCollection is now imported from './mappers.js'

// ============================================================================
// SMART COLLECTIONS
// ============================================================================

export function createSmartCollection(
  name: string,
  rules: SmartCollectionRule[],
  color?: string,
  icon?: string,
  matchMode?: 'all' | 'any'
): number {
  const database = getDatabase();
  const result = database.prepare(`
    INSERT INTO smart_collections (name, rules, color, icon, match_mode)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, JSON.stringify(rules), color ?? '#6366f1', icon ?? '📁', matchMode ?? 'all');
  return result.lastInsertRowid as number;
}

export function getAllSmartCollections(): SmartCollection[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM smart_collections ORDER BY name').all() as SmartCollectionRow[];
  return rows.map(mapRowToSmartCollection);
}

export function getSmartCollection(id: number): SmartCollection | null {
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM smart_collections WHERE id = ?').get(id) as SmartCollectionRow | undefined;
  return row ? mapRowToSmartCollection(row) : null;
}

export function updateSmartCollection(
  id: number,
  name: string,
  rules: SmartCollectionRule[],
  color: string,
  icon: string,
  matchMode: 'all' | 'any'
): void {
  const database = getDatabase();
  database.prepare(`
    UPDATE smart_collections
    SET name = ?, rules = ?, color = ?, icon = ?, match_mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name, JSON.stringify(rules), color, icon, matchMode, id);
}

export function deleteSmartCollection(id: number): void {
  const database = getDatabase();
  database.prepare('DELETE FROM smart_collections WHERE id = ?').run(id);
}

export function getSessionsForSmartCollection(id: number): Session[] {
  const collection = getSmartCollection(id);
  if (!collection) return [];

  const database = getDatabase();
  const rules = collection.rules;
  const matchMode = collection.matchMode;

  const conditions: string[] = [];
  const params: unknown[] = [];

  rules.forEach(rule => {
    switch (rule.type) {
      case 'TAG':
        conditions.push('EXISTS (SELECT 1 FROM session_tags st JOIN tags t ON st.tag_id = t.id WHERE st.session_id = sessions.id AND t.name LIKE ?)');
        params.push(`%${rule.value}%`);
        break;
      case 'PROJECT':
        conditions.push('project_name LIKE ?');
        params.push(`%${rule.value}%`);
        break;
      case 'DATE_RANGE':
        if (rule.startDate) {
          conditions.push('start_time >= ?');
          params.push(rule.startDate);
        }
        if (rule.endDate) {
          conditions.push('start_time <= ?');
          params.push(rule.endDate);
        }
        break;
      case 'RATING':
        if (rule.operator === 'gte') {
          conditions.push('rating >= ?');
        } else if (rule.operator === 'lte') {
          conditions.push('rating <= ?');
        } else {
          conditions.push('rating = ?');
        }
        params.push(rule.value);
        break;
      case 'COST':
        if (rule.operator === 'gte') {
          conditions.push('cost >= ?');
        } else if (rule.operator === 'lte') {
          conditions.push('cost <= ?');
        }
        params.push(rule.value);
        break;
      case 'OUTCOME':
        conditions.push('outcome = ?');
        params.push(rule.value);
        break;
    }
  });

  if (conditions.length === 0) return [];

  const joiner = matchMode === 'all' ? ' AND ' : ' OR ';
  const sql = `SELECT * FROM sessions WHERE ${conditions.join(joiner)} ORDER BY end_time DESC`;

  const rows = database.prepare(sql).all(...params) as SessionRow[];
  return rows.map(mapRowToSession);
}

// mapRowToSmartCollection and mapRowToSession are now imported from './mappers.js'
