// ============================================================================
// PROJECT REGISTRY DATABASE - Project Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  RegisteredProject,
  RegisteredProjectRow,
  ProjectSettings,
} from './types.js';

// ============================================================================
// REGISTERED PROJECT OPERATIONS
// ============================================================================

/**
 * Register a new project
 */
export function registerProject(
  path: string,
  name: string,
  description?: string,
  settings?: ProjectSettings
): RegisteredProject {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO registered_projects (path, name, description, settings)
    VALUES (?, ?, ?, ?)
  `).run(
    path,
    name,
    description ?? null,
    JSON.stringify(settings ?? {})
  );

  const inserted = getRegisteredProject(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve registered project with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get registered project by ID
 */
export function getRegisteredProject(id: number): RegisteredProject | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM registered_projects WHERE id = ?').get(id) as RegisteredProjectRow | undefined;
  return row ? mapRowToProject(row) : null;
}

/**
 * Get registered project by path
 */
export function getRegisteredProjectByPath(path: string): RegisteredProject | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM registered_projects WHERE path = ?').get(path) as RegisteredProjectRow | undefined;
  return row ? mapRowToProject(row) : null;
}

/**
 * Get all registered projects
 */
export function getAllRegisteredProjects(): RegisteredProject[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM registered_projects
    ORDER BY last_opened DESC
  `).all() as RegisteredProjectRow[];
  return rows.map(mapRowToProject);
}

/**
 * Update a registered project
 */
export function updateRegisteredProject(
  id: number,
  updates: Partial<{
    name: string;
    description: string | null;
    settings: ProjectSettings;
  }>
): RegisteredProject | null {
  const db = getDatabase();
  const existing = getRegisteredProject(id);
  if (!existing) return null;

  const setters: string[] = ['updated_at = datetime(\'now\')'];
  const params: (string | number | null)[] = [];

  if (updates.name !== undefined) {
    setters.push('name = ?');
    params.push(updates.name);
  }

  if (updates.description !== undefined) {
    setters.push('description = ?');
    params.push(updates.description);
  }

  if (updates.settings !== undefined) {
    setters.push('settings = ?');
    params.push(JSON.stringify(updates.settings));
  }

  params.push(id);

  db.prepare(`
    UPDATE registered_projects SET ${setters.join(', ')}
    WHERE id = ?
  `).run(...params);

  return getRegisteredProject(id);
}

/**
 * Update last opened timestamp
 */
export function touchProject(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE registered_projects SET
      last_opened = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

/**
 * Remove a project from registry
 */
export function unregisterProject(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM registered_projects WHERE id = ?').run(id);
}

/**
 * Search projects by name or path
 */
export function searchProjects(query: string): RegisteredProject[] {
  const db = getDatabase();
  const searchTerm = `%${query}%`;
  const rows = db.prepare(`
    SELECT * FROM registered_projects
    WHERE name LIKE ? OR path LIKE ? OR description LIKE ?
    ORDER BY last_opened DESC
  `).all(searchTerm, searchTerm, searchTerm) as RegisteredProjectRow[];
  return rows.map(mapRowToProject);
}

export function mapRowToProject(row: RegisteredProjectRow): RegisteredProject {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    description: row.description,
    lastOpened: row.last_opened,
    settings: JSON.parse(row.settings ?? '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
