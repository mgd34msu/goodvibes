// ============================================================================
// PROJECT REGISTRY DATABASE - Template Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  ProjectTemplate,
  ProjectTemplateRow,
  ProjectSettings,
  TemplateAgent,
  RegisteredProject,
} from './types.js';
import { getRegisteredProject, updateRegisteredProject } from './projects.js';
import { assignAgentToProject, getProjectAgents } from './agents.js';

// ============================================================================
// PROJECT TEMPLATE OPERATIONS
// ============================================================================

/**
 * Create a project template
 */
export function createProjectTemplate(
  name: string,
  description?: string,
  settings?: ProjectSettings,
  agents?: TemplateAgent[]
): ProjectTemplate {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO project_templates (name, description, settings, agents)
    VALUES (?, ?, ?, ?)
  `).run(
    name,
    description || null,
    JSON.stringify(settings || {}),
    JSON.stringify(agents || [])
  );

  const inserted = getProjectTemplate(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve project template with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

/**
 * Get project template by ID
 */
export function getProjectTemplate(id: number): ProjectTemplate | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM project_templates WHERE id = ?').get(id) as ProjectTemplateRow | undefined;
  return row ? mapRowToTemplate(row) : null;
}

/**
 * Get project template by name
 */
export function getProjectTemplateByName(name: string): ProjectTemplate | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM project_templates WHERE name = ?').get(name) as ProjectTemplateRow | undefined;
  return row ? mapRowToTemplate(row) : null;
}

/**
 * Get all project templates
 */
export function getAllProjectTemplates(): ProjectTemplate[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM project_templates
    ORDER BY name ASC
  `).all() as ProjectTemplateRow[];
  return rows.map(mapRowToTemplate);
}

/**
 * Update a project template
 */
export function updateProjectTemplate(
  id: number,
  updates: Partial<{
    name: string;
    description: string | null;
    settings: ProjectSettings;
    agents: TemplateAgent[];
  }>
): ProjectTemplate | null {
  const db = getDatabase();
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

  if (updates.agents !== undefined) {
    setters.push('agents = ?');
    params.push(JSON.stringify(updates.agents));
  }

  params.push(id);

  db.prepare(`
    UPDATE project_templates SET ${setters.join(', ')}
    WHERE id = ?
  `).run(...params);

  return getProjectTemplate(id);
}

/**
 * Delete a project template
 */
export function deleteProjectTemplate(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM project_templates WHERE id = ?').run(id);
}

/**
 * Apply template to a project
 */
export function applyTemplateToProject(projectId: number, templateId: number): RegisteredProject | null {
  const db = getDatabase();
  const template = getProjectTemplate(templateId);
  const project = getRegisteredProject(projectId);

  if (!template || !project) return null;

  // Update project settings from template
  updateRegisteredProject(projectId, { settings: template.settings });

  // Clear existing agents and apply template agents
  db.prepare('DELETE FROM project_agents WHERE project_id = ?').run(projectId);

  for (const agent of template.agents) {
    assignAgentToProject(projectId, agent.agentId, agent.priority, agent.settings);
  }

  return getRegisteredProject(projectId);
}

/**
 * Create template from existing project
 */
export function createTemplateFromProject(
  projectId: number,
  templateName: string,
  description?: string
): ProjectTemplate | null {
  const project = getRegisteredProject(projectId);
  if (!project) return null;

  const projectAgents = getProjectAgents(projectId);
  const agents: TemplateAgent[] = projectAgents.map(pa => ({
    agentId: pa.agentId,
    priority: pa.priority,
    settings: pa.settings,
  }));

  return createProjectTemplate(templateName, description, project.settings, agents);
}

function mapRowToTemplate(row: ProjectTemplateRow): ProjectTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    settings: JSON.parse(row.settings ?? '{}'),
    agents: JSON.parse(row.agents ?? '[]'),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
