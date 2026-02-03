// ============================================================================
// PROJECT REGISTRY DATABASE - Project Agent Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  ProjectAgent,
  ProjectAgentRow,
  ProjectAgentSettings,
} from './types.js';

// ============================================================================
// PROJECT AGENT OPERATIONS
// ============================================================================

/**
 * Assign an agent to a project
 */
export function assignAgentToProject(
  projectId: number,
  agentId: number,
  priority: number = 0,
  settings?: ProjectAgentSettings
): ProjectAgent {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO project_agents (project_id, agent_id, priority, settings)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id, agent_id) DO UPDATE SET
      priority = excluded.priority,
      settings = excluded.settings,
      updated_at = datetime('now')
  `).run(
    projectId,
    agentId,
    priority,
    JSON.stringify(settings || {})
  );

  const inserted = getProjectAgent(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve project agent with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get project agent by ID
 */
export function getProjectAgent(id: number): ProjectAgent | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM project_agents WHERE id = ?').get(id) as ProjectAgentRow | undefined;
  return row ? mapRowToProjectAgent(row) : null;
}

/**
 * Get all agents for a project
 */
export function getProjectAgents(projectId: number): ProjectAgent[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM project_agents
    WHERE project_id = ?
    ORDER BY priority DESC
  `).all(projectId) as ProjectAgentRow[];
  return rows.map(mapRowToProjectAgent);
}

/**
 * Update project agent settings
 */
export function updateProjectAgent(
  id: number,
  updates: Partial<{ priority: number; settings: ProjectAgentSettings }>
): ProjectAgent | null {
  const db = getDatabase();
  const setters: string[] = ['updated_at = datetime(\'now\')'];
  const params: (string | number)[] = [];

  if (updates.priority !== undefined) {
    setters.push('priority = ?');
    params.push(updates.priority);
  }

  if (updates.settings !== undefined) {
    setters.push('settings = ?');
    params.push(JSON.stringify(updates.settings));
  }

  params.push(id);

  db.prepare(`
    UPDATE project_agents SET ${setters.join(', ')}
    WHERE id = ?
  `).run(...params);

  return getProjectAgent(id);
}

/**
 * Remove agent from project
 */
export function removeAgentFromProject(projectId: number, agentId: number): void {
  const db = getDatabase();
  db.prepare(`
    DELETE FROM project_agents
    WHERE project_id = ? AND agent_id = ?
  `).run(projectId, agentId);
}

export function mapRowToProjectAgent(row: ProjectAgentRow): ProjectAgent {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    priority: row.priority,
    settings: JSON.parse(row.settings ?? '{}'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
