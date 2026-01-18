// ============================================================================
// DATABASE PRIMITIVES - Agent Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import type {
  AgentTemplate,
  AgentTemplateRow,
  AgentRecord,
  AgentRecordRow,
  AgentStatus,
} from './types.js';

const logger = new Logger('DatabasePrimitives:Agents');

// ============================================================================
// AGENT TEMPLATE OPERATIONS
// ============================================================================

export function createAgentTemplate(template: Omit<AgentTemplate, 'createdAt' | 'updatedAt'>): AgentTemplate {
  const db = getDatabase();

  const now = formatTimestamp();
  db.prepare(`
    INSERT INTO agent_templates (
      id, name, description, cwd, initial_prompt, claude_md_content,
      flags, model, permission_mode, allowed_tools, denied_tools,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    template.id,
    template.name,
    template.description,
    template.cwd,
    template.initialPrompt,
    template.claudeMdContent,
    JSON.stringify(template.flags || []),
    template.model,
    template.permissionMode,
    template.allowedTools ? JSON.stringify(template.allowedTools) : null,
    template.deniedTools ? JSON.stringify(template.deniedTools) : null,
    now,
    now
  );

  return { ...template, createdAt: now, updatedAt: now };
}

export function getAgentTemplate(id: string): AgentTemplate | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(id) as AgentTemplateRow | undefined;
  return row ? mapRowToAgentTemplate(row) : null;
}

export function getAllAgentTemplates(): AgentTemplate[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM agent_templates ORDER BY name').all() as AgentTemplateRow[];
  return rows.map(mapRowToAgentTemplate);
}

export function updateAgentTemplate(id: string, updates: Partial<AgentTemplate>): void {
  const db = getDatabase();
  const existing = getAgentTemplate(id);
  if (!existing) throw new Error(`Agent template not found: ${id}`);

  const merged = { ...existing, ...updates, updatedAt: formatTimestamp() };

  db.prepare(`
    UPDATE agent_templates SET
      name = ?, description = ?, cwd = ?, initial_prompt = ?, claude_md_content = ?,
      flags = ?, model = ?, permission_mode = ?, allowed_tools = ?, denied_tools = ?,
      updated_at = ?
    WHERE id = ?
  `).run(
    merged.name,
    merged.description,
    merged.cwd,
    merged.initialPrompt,
    merged.claudeMdContent,
    JSON.stringify(merged.flags || []),
    merged.model,
    merged.permissionMode,
    merged.allowedTools ? JSON.stringify(merged.allowedTools) : null,
    merged.deniedTools ? JSON.stringify(merged.deniedTools) : null,
    merged.updatedAt,
    id
  );
}

export function deleteAgentTemplate(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM agent_templates WHERE id = ?').run(id);
}

function mapRowToAgentTemplate(row: AgentTemplateRow): AgentTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cwd: row.cwd,
    initialPrompt: row.initial_prompt,
    claudeMdContent: row.claude_md_content,
    flags: JSON.parse(row.flags ?? '[]'),
    model: row.model,
    permissionMode: row.permission_mode,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
    deniedTools: row.denied_tools ? JSON.parse(row.denied_tools) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// AGENT REGISTRY OPERATIONS
// ============================================================================

export function registerAgent(agent: Omit<AgentRecord, 'spawnedAt' | 'lastActivity' | 'completedAt' | 'exitCode' | 'errorMessage'>): AgentRecord {
  const db = getDatabase();

  const now = formatTimestamp();
  db.prepare(`
    INSERT INTO agent_registry (
      id, name, pid, cwd, parent_id, template_id, status, session_path, initial_prompt,
      spawned_at, last_activity
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    agent.id,
    agent.name,
    agent.pid,
    agent.cwd,
    agent.parentId,
    agent.templateId,
    agent.status,
    agent.sessionPath,
    agent.initialPrompt,
    now,
    now
  );

  return {
    ...agent,
    spawnedAt: now,
    lastActivity: now,
    completedAt: null,
    exitCode: null,
    errorMessage: null,
  };
}

export function getAgent(id: string): AgentRecord | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agent_registry WHERE id = ?').get(id) as AgentRecordRow | undefined;
  return row ? mapRowToAgentRecord(row) : null;
}

export function getAgentsByParent(parentId: string | null): AgentRecord[] {
  const db = getDatabase();
  const query = parentId
    ? 'SELECT * FROM agent_registry WHERE parent_id = ? ORDER BY spawned_at'
    : 'SELECT * FROM agent_registry WHERE parent_id IS NULL ORDER BY spawned_at';
  const rows = db.prepare(query).all(parentId ?? undefined) as AgentRecordRow[];
  return rows.map(mapRowToAgentRecord);
}

export function getActiveAgents(): AgentRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM agent_registry
    WHERE status IN ('spawning', 'ready', 'active', 'idle')
    ORDER BY spawned_at DESC
  `).all() as AgentRecordRow[];
  return rows.map(mapRowToAgentRecord);
}

export function getAllAgents(): AgentRecord[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM agent_registry ORDER BY spawned_at DESC').all() as AgentRecordRow[];
  return rows.map(mapRowToAgentRecord);
}

export function updateAgentStatus(id: string, status: AgentStatus, errorMessage?: string): void {
  const db = getDatabase();

  const completedAt = ['completed', 'error', 'terminated'].includes(status)
    ? formatTimestamp()
    : null;

  db.prepare(`
    UPDATE agent_registry SET
      status = ?,
      last_activity = datetime('now'),
      completed_at = COALESCE(?, completed_at),
      error_message = ?
    WHERE id = ?
  `).run(status, completedAt, errorMessage || null, id);
}

export function updateAgentActivity(id: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agent_registry SET last_activity = datetime('now') WHERE id = ?
  `).run(id);
}

export function completeAgent(id: string, exitCode: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE agent_registry SET
      status = CASE WHEN ? = 0 THEN 'completed' ELSE 'error' END,
      exit_code = ?,
      completed_at = datetime('now'),
      last_activity = datetime('now')
    WHERE id = ?
  `).run(exitCode, exitCode, id);
}

export function deleteAgent(id: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM agent_registry WHERE id = ?').run(id);
}

export function cleanupStaleAgents(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
  const db = getDatabase();
  const threshold = new Date(Date.now() - maxAgeMs).toISOString();

  const result = db.prepare(`
    DELETE FROM agent_registry
    WHERE status IN ('completed', 'error', 'terminated')
    AND completed_at < ?
  `).run(threshold);

  return result.changes;
}

/**
 * Find an agent by session ID (sessionPath field stores this)
 */
export function findAgentBySession(sessionId: string): AgentRecord | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM agent_registry WHERE session_path = ?').get(sessionId) as AgentRecordRow | undefined;
  return row ? mapRowToAgentRecord(row) : null;
}

/**
 * Upsert an agent - update if exists (by sessionPath), insert if not
 * This prevents duplicate agent creation for the same session
 */
export function upsertAgent(agent: Omit<AgentRecord, 'spawnedAt' | 'lastActivity' | 'completedAt' | 'exitCode' | 'errorMessage'>): AgentRecord {
  const db = getDatabase();

  // Check if agent with this session already exists
  const existing = agent.sessionPath ? findAgentBySession(agent.sessionPath) : null;

  if (existing) {
    // Update existing agent
    db.prepare(`
      UPDATE agent_registry SET
        name = ?,
        pid = COALESCE(?, pid),
        cwd = ?,
        parent_id = COALESCE(?, parent_id),
        template_id = COALESCE(?, template_id),
        status = ?,
        initial_prompt = COALESCE(?, initial_prompt),
        last_activity = datetime('now')
      WHERE id = ?
    `).run(
      agent.name,
      agent.pid,
      agent.cwd,
      agent.parentId,
      agent.templateId,
      agent.status,
      agent.initialPrompt,
      existing.id
    );

    const updated = getAgent(existing.id);
    if (!updated) {
      throw new Error(`Failed to retrieve updated agent with id ${existing.id}`);
    }
    return updated;
  }

  // Insert new agent
  return registerAgent(agent);
}

/**
 * Delete all agents from the registry (for cleanup)
 */
export function deleteAllAgents(): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM agent_registry').run();
  logger.info(`Deleted all ${result.changes} agents from registry`);
  return result.changes;
}

/**
 * Clean up garbage agents - entries that are clearly wrong:
 * 1. Named 'Explore #XXX' (these are tool uses, not real agents)
 * 2. Named after common tools like 'Read', 'Write', 'Edit', etc.
 * 3. Agents with no session_path that are more than 1 hour old
 */
export function cleanupGarbageAgents(): number {
  const db = getDatabase();
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  // Define tool names that should NOT be agents
  const toolPatterns = [
    'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Task',
    'WebFetch', 'WebSearch', 'NotebookEdit', 'AskUserQuestion',
    'TodoWrite', 'Skill', 'EnterPlanMode', 'ExitPlanMode', 'LSP', 'KillShell', 'TaskOutput'
  ];

  let totalDeleted = 0;

  // Delete agents named after tools
  for (const toolName of toolPatterns) {
    const result = db.prepare(`DELETE FROM agent_registry WHERE name = ?`).run(toolName);
    totalDeleted += result.changes;
  }

  // Delete 'Explore #XXX' pattern agents (these are tool uses mistakenly registered)
  const exploreResult = db.prepare(`DELETE FROM agent_registry WHERE name LIKE 'Explore #%'`).run();
  totalDeleted += exploreResult.changes;

  // Delete agents with names matching 'ToolName #XXX' pattern for known tools
  for (const toolName of toolPatterns) {
    const result = db.prepare(`DELETE FROM agent_registry WHERE name LIKE ? || ' #%'`).run(toolName);
    totalDeleted += result.changes;
  }

  // Delete orphaned agents (no session, old, still marked active)
  const orphanResult = db.prepare(`
    DELETE FROM agent_registry
    WHERE session_path IS NULL
    AND spawned_at < ?
    AND status IN ('spawning', 'ready', 'active', 'idle')
  `).run(oneHourAgo);
  totalDeleted += orphanResult.changes;

  if (totalDeleted > 0) {
    logger.info(`Cleaned up ${totalDeleted} garbage agent entries`);
  }

  return totalDeleted;
}

/**
 * Update an existing agent by ID
 */
export function updateAgent(id: string, updates: Partial<AgentRecord>): void {
  const db = getDatabase();
  const existing = getAgent(id);
  if (!existing) {
    logger.warn(`Cannot update agent - not found: ${id}`);
    return;
  }

  const merged = { ...existing, ...updates };

  db.prepare(`
    UPDATE agent_registry SET
      name = ?,
      pid = ?,
      cwd = ?,
      parent_id = ?,
      template_id = ?,
      status = ?,
      session_path = ?,
      initial_prompt = ?,
      last_activity = datetime('now'),
      completed_at = ?,
      exit_code = ?,
      error_message = ?
    WHERE id = ?
  `).run(
    merged.name,
    merged.pid,
    merged.cwd,
    merged.parentId,
    merged.templateId,
    merged.status,
    merged.sessionPath,
    merged.initialPrompt,
    merged.completedAt,
    merged.exitCode,
    merged.errorMessage,
    id
  );
}

function mapRowToAgentRecord(row: AgentRecordRow): AgentRecord {
  return {
    id: row.id,
    name: row.name,
    pid: row.pid,
    cwd: row.cwd,
    parentId: row.parent_id,
    templateId: row.template_id,
    status: row.status as AgentStatus,
    sessionPath: row.session_path,
    initialPrompt: row.initial_prompt,
    spawnedAt: row.spawned_at,
    lastActivity: row.last_activity,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    errorMessage: row.error_message,
  };
}
