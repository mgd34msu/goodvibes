// ============================================================================
// DATABASE PRIMITIVES - Session Operations (Skills, Tasks, Project Configs)
// ============================================================================

import { getDatabase } from '../connection.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import type {
  Skill,
  SkillRow,
  TaskDefinition,
  TaskDefinitionRow,
  ProjectConfig,
  ProjectConfigRow,
  HookConfig,
} from './types.js';

// ============================================================================
// SKILL OPERATIONS
// ============================================================================

export function createSkill(skill: Omit<Skill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>): Skill {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO skills (name, description, content, allowed_tools, scope, project_path)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    skill.name,
    skill.description,
    skill.content,
    skill.allowedTools ? JSON.stringify(skill.allowedTools) : null,
    skill.scope,
    skill.projectPath
  );

  const inserted = getSkill(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve created skill with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

export function getSkill(id: number): Skill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as SkillRow | undefined;
  return row ? mapRowToSkill(row) : null;
}

export function getSkillByName(name: string): Skill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as SkillRow | undefined;
  return row ? mapRowToSkill(row) : null;
}

export function getAllSkills(scope?: 'user' | 'project', projectPath?: string): Skill[] {
  const db = getDatabase();
  let query = 'SELECT * FROM skills';
  const params: (string | undefined)[] = [];

  if (scope) {
    query += ' WHERE scope = ?';
    params.push(scope);
    if (scope === 'project' && projectPath) {
      query += ' AND project_path = ?';
      params.push(projectPath);
    }
  }

  query += ' ORDER BY name';
  const rows = db.prepare(query).all(...params) as SkillRow[];
  return rows.map(mapRowToSkill);
}

export function updateSkill(id: number, updates: Partial<Skill>): void {
  const db = getDatabase();
  const existing = getSkill(id);
  if (!existing) throw new Error(`Skill not found: ${id}`);

  const merged = { ...existing, ...updates };

  db.prepare(`
    UPDATE skills SET
      name = ?, description = ?, content = ?, allowed_tools = ?,
      scope = ?, project_path = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.name,
    merged.description,
    merged.content,
    merged.allowedTools ? JSON.stringify(merged.allowedTools) : null,
    merged.scope,
    merged.projectPath,
    id
  );
}

export function recordSkillUsage(id: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE skills SET
      use_count = use_count + 1,
      last_used = datetime('now'),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(id);
}

export function deleteSkill(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM skills WHERE id = ?').run(id);
}

function mapRowToSkill(row: SkillRow): Skill {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    content: row.content,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
    scope: row.scope,
    projectPath: row.project_path,
    useCount: row.use_count,
    lastUsed: row.last_used,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// TASK DEFINITION OPERATIONS
// ============================================================================

export function createTaskDefinition(task: Omit<TaskDefinition, 'id' | 'lastRun' | 'lastResult' | 'runCount' | 'createdAt' | 'updatedAt'>): TaskDefinition {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO task_definitions (name, description, template_id, prompt, schedule, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    task.name,
    task.description,
    task.templateId,
    task.prompt,
    task.schedule,
    task.enabled ? 1 : 0
  );

  const inserted = getTaskDefinition(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve created task definition with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

export function getTaskDefinition(id: number): TaskDefinition | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM task_definitions WHERE id = ?').get(id) as TaskDefinitionRow | undefined;
  return row ? mapRowToTaskDefinition(row) : null;
}

export function getAllTaskDefinitions(): TaskDefinition[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM task_definitions ORDER BY name').all() as TaskDefinitionRow[];
  return rows.map(mapRowToTaskDefinition);
}

export function getScheduledTasks(): TaskDefinition[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM task_definitions
    WHERE enabled = 1 AND schedule IS NOT NULL
    ORDER BY name
  `).all() as TaskDefinitionRow[];
  return rows.map(mapRowToTaskDefinition);
}

export function updateTaskDefinition(id: number, updates: Partial<TaskDefinition>): void {
  const db = getDatabase();
  const existing = getTaskDefinition(id);
  if (!existing) throw new Error(`Task definition not found: ${id}`);

  const merged = { ...existing, ...updates };

  db.prepare(`
    UPDATE task_definitions SET
      name = ?, description = ?, template_id = ?, prompt = ?,
      schedule = ?, enabled = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.name,
    merged.description,
    merged.templateId,
    merged.prompt,
    merged.schedule,
    merged.enabled ? 1 : 0,
    id
  );
}

export function recordTaskRun(id: number, result: 'success' | 'failure'): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE task_definitions SET
      run_count = run_count + 1,
      last_run = datetime('now'),
      last_result = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(result, id);
}

export function deleteTaskDefinition(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM task_definitions WHERE id = ?').run(id);
}

function mapRowToTaskDefinition(row: TaskDefinitionRow): TaskDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    templateId: row.template_id,
    prompt: row.prompt,
    schedule: row.schedule,
    enabled: row.enabled === 1,
    lastRun: row.last_run,
    lastResult: row.last_result,
    runCount: row.run_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// PROJECT CONFIG OPERATIONS
// ============================================================================

export function createProjectConfig(config: Omit<ProjectConfig, 'createdAt' | 'updatedAt'>): ProjectConfig {
  const db = getDatabase();
  const now = formatTimestamp();

  db.prepare(`
    INSERT INTO project_configs (
      project_path, default_template_id, settings, hooks, mcp_servers, claude_md_override,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    config.projectPath,
    config.defaultTemplateId,
    JSON.stringify(config.settings || {}),
    JSON.stringify(config.hooks || []),
    JSON.stringify(config.mcpServers || []),
    config.claudeMdOverride,
    now,
    now
  );

  return { ...config, createdAt: now, updatedAt: now };
}

export function getProjectConfig(projectPath: string): ProjectConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM project_configs WHERE project_path = ?').get(projectPath) as ProjectConfigRow | undefined;
  return row ? mapRowToProjectConfig(row) : null;
}

export function getAllProjectConfigs(): ProjectConfig[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM project_configs ORDER BY project_path').all() as ProjectConfigRow[];
  return rows.map(mapRowToProjectConfig);
}

export function updateProjectConfig(projectPath: string, updates: Partial<ProjectConfig>): void {
  const db = getDatabase();
  const existing = getProjectConfig(projectPath);
  if (!existing) throw new Error(`Project config not found: ${projectPath}`);

  const merged = { ...existing, ...updates, updatedAt: formatTimestamp() };

  db.prepare(`
    UPDATE project_configs SET
      default_template_id = ?, settings = ?, hooks = ?, mcp_servers = ?,
      claude_md_override = ?, updated_at = ?
    WHERE project_path = ?
  `).run(
    merged.defaultTemplateId,
    JSON.stringify(merged.settings || {}),
    JSON.stringify(merged.hooks || []),
    JSON.stringify(merged.mcpServers || []),
    merged.claudeMdOverride,
    merged.updatedAt,
    projectPath
  );
}

export function deleteProjectConfig(projectPath: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM project_configs WHERE project_path = ?').run(projectPath);
}

function mapRowToProjectConfig(row: ProjectConfigRow): ProjectConfig {
  return {
    projectPath: row.project_path,
    defaultTemplateId: row.default_template_id,
    settings: JSON.parse(row.settings ?? '{}'),
    hooks: JSON.parse(row.hooks ?? '[]') as HookConfig[],
    mcpServers: JSON.parse(row.mcp_servers ?? '[]'),
    claudeMdOverride: row.claude_md_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
