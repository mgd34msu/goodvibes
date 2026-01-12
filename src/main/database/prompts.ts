// ============================================================================
// PROMPT DATABASE OPERATIONS
// ============================================================================

import { getDatabase } from './connection.js';
import type { Prompt } from '../../shared/types/index.js';

/**
 * Database row type for prompts table
 */
interface PromptRow {
  id: number;
  title: string;
  content: string;
  category: string;
  use_count: number;
  last_used: string | null;
  created_at: string;
}

export function savePrompt(title: string, content: string, category?: string): number {
  const database = getDatabase();
  const result = database.prepare(`
    INSERT INTO prompts (title, content, category)
    VALUES (?, ?, ?)
  `).run(title, content, category ?? 'General');
  return result.lastInsertRowid as number;
}

export function getAllPrompts(): Prompt[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM prompts ORDER BY use_count DESC, created_at DESC').all() as PromptRow[];
  return rows.map(mapRowToPrompt);
}

export function getPromptsByCategory(category: string): Prompt[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM prompts WHERE category = ? ORDER BY use_count DESC').all(category) as PromptRow[];
  return rows.map(mapRowToPrompt);
}

export function usePrompt(id: number): void {
  const database = getDatabase();
  database.prepare('UPDATE prompts SET use_count = use_count + 1, last_used = datetime("now") WHERE id = ?').run(id);
}

export function updatePrompt(id: number, title: string, content: string, category: string): void {
  const database = getDatabase();
  database.prepare('UPDATE prompts SET title = ?, content = ?, category = ? WHERE id = ?').run(title, content, category, id);
}

export function deletePrompt(id: number): void {
  const database = getDatabase();
  database.prepare('DELETE FROM prompts WHERE id = ?').run(id);
}

export function getPromptCategories(): string[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT DISTINCT category FROM prompts ORDER BY category').all() as { category: string }[];
  return rows.map(r => r.category);
}

function mapRowToPrompt(row: PromptRow): Prompt {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    category: row.category,
    useCount: row.use_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
  };
}
