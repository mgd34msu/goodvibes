// ============================================================================
// DATABASE PRIMITIVES - Schema extensions for GoodVibes advanced features
// ============================================================================

import { getDatabase } from './index.js';
import { Logger } from '../services/logger.js';

const logger = new Logger('DatabasePrimitives');

// ============================================================================
// TYPES
// ============================================================================

export interface AgentTemplate {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  initialPrompt: string | null;
  claudeMdContent: string | null;
  flags: string[]; // JSON array in DB
  model: string | null;
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | null;
  allowedTools: string[] | null; // JSON array
  deniedTools: string[] | null; // JSON array
  createdAt: string;
  updatedAt: string;
}

export interface ProjectConfig {
  projectPath: string;
  defaultTemplateId: string | null;
  settings: Record<string, unknown>; // JSON object
  hooks: HookConfig[];
  mcpServers: string[]; // IDs of MCP servers
  claudeMdOverride: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HookConfig {
  id: number;
  name: string;
  eventType: HookEventType;
  matcher: string | null;
  command: string;
  timeout: number;
  enabled: boolean;
  scope: 'user' | 'project';
  projectPath: string | null;
  executionCount: number;
  lastExecuted: string | null;
  lastResult: 'success' | 'failure' | 'timeout' | null;
  createdAt: string;
  updatedAt: string;
}

export type HookEventType =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification'
  | 'Stop';

export interface MCPServer {
  id: number;
  name: string;
  description: string | null;
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  args: string[]; // JSON array
  env: Record<string, string>; // JSON object
  scope: 'user' | 'project';
  projectPath: string | null;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastConnected: string | null;
  errorMessage: string | null;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  pid: number | null;
  cwd: string;
  parentId: string | null;
  templateId: string | null;
  status: AgentStatus;
  sessionPath: string | null;
  initialPrompt: string | null;
  spawnedAt: string;
  lastActivity: string;
  completedAt: string | null;
  exitCode: number | null;
  errorMessage: string | null;
}

export type AgentStatus =
  | 'spawning'
  | 'ready'
  | 'active'
  | 'idle'
  | 'completed'
  | 'error'
  | 'terminated';

export interface Skill {
  id: number;
  name: string;
  description: string | null;
  content: string; // SKILL.md content
  allowedTools: string[] | null;
  scope: 'user' | 'project';
  projectPath: string | null;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDefinition {
  id: number;
  name: string;
  description: string | null;
  templateId: string | null;
  prompt: string;
  schedule: string | null; // cron expression
  enabled: boolean;
  lastRun: string | null;
  lastResult: 'success' | 'failure' | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createPrimitiveTables(): void {
  const db = getDatabase();

  // Agent Templates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      cwd TEXT,
      initial_prompt TEXT,
      claude_md_content TEXT,
      flags TEXT DEFAULT '[]',
      model TEXT,
      permission_mode TEXT,
      allowed_tools TEXT,
      denied_tools TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Project Configs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_configs (
      project_path TEXT PRIMARY KEY,
      default_template_id TEXT,
      settings TEXT DEFAULT '{}',
      hooks TEXT DEFAULT '[]',
      mcp_servers TEXT DEFAULT '[]',
      claude_md_override TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (default_template_id) REFERENCES agent_templates(id) ON DELETE SET NULL
    )
  `);

  // Hooks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS hooks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      event_type TEXT NOT NULL,
      matcher TEXT,
      command TEXT NOT NULL,
      timeout INTEGER DEFAULT 30000,
      enabled INTEGER DEFAULT 1,
      scope TEXT DEFAULT 'user',
      project_path TEXT,
      execution_count INTEGER DEFAULT 0,
      last_executed TEXT,
      last_result TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // MCP Servers table
  db.exec(`
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      transport TEXT NOT NULL,
      command TEXT,
      url TEXT,
      args TEXT DEFAULT '[]',
      env TEXT DEFAULT '{}',
      scope TEXT DEFAULT 'user',
      project_path TEXT,
      enabled INTEGER DEFAULT 1,
      status TEXT DEFAULT 'unknown',
      last_connected TEXT,
      error_message TEXT,
      tool_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Agent Registry table (runtime tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pid INTEGER,
      cwd TEXT NOT NULL,
      parent_id TEXT,
      template_id TEXT,
      status TEXT DEFAULT 'spawning',
      session_path TEXT,
      initial_prompt TEXT,
      spawned_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_activity TEXT DEFAULT CURRENT_TIMESTAMP,
      completed_at TEXT,
      exit_code INTEGER,
      error_message TEXT,
      FOREIGN KEY (parent_id) REFERENCES agent_registry(id) ON DELETE SET NULL,
      FOREIGN KEY (template_id) REFERENCES agent_templates(id) ON DELETE SET NULL
    )
  `);

  // Skills table
  db.exec(`
    CREATE TABLE IF NOT EXISTS skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      allowed_tools TEXT,
      scope TEXT DEFAULT 'user',
      project_path TEXT,
      use_count INTEGER DEFAULT 0,
      last_used TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Task Definitions table (for headless automation)
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_definitions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      template_id TEXT,
      prompt TEXT NOT NULL,
      schedule TEXT,
      enabled INTEGER DEFAULT 1,
      last_run TEXT,
      last_result TEXT,
      run_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (template_id) REFERENCES agent_templates(id) ON DELETE SET NULL
    )
  `);

  // Session analytics extension
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_analytics (
      session_id TEXT PRIMARY KEY,
      success_score REAL,
      iteration_count INTEGER DEFAULT 0,
      tool_efficiency REAL,
      context_usage_peak INTEGER,
      estimated_roi REAL,
      tags_auto TEXT DEFAULT '[]',
      outcome_analysis TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Tool usage detailed tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_usage_detailed (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      tool_input TEXT,
      tool_result_preview TEXT,
      success INTEGER,
      duration_ms INTEGER,
      token_cost INTEGER,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Create indexes for performance
  createPrimitiveIndexes();

  logger.info('Primitive tables created successfully');
}

function createPrimitiveIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_hooks_event_type ON hooks(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_hooks_scope ON hooks(scope)',
    'CREATE INDEX IF NOT EXISTS idx_hooks_enabled ON hooks(enabled)',
    'CREATE INDEX IF NOT EXISTS idx_mcp_servers_scope ON mcp_servers(scope)',
    'CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabled ON mcp_servers(enabled)',
    'CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status)',
    'CREATE INDEX IF NOT EXISTS idx_agent_registry_parent ON agent_registry(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope)',
    'CREATE INDEX IF NOT EXISTS idx_task_definitions_enabled ON task_definitions(enabled)',
    'CREATE INDEX IF NOT EXISTS idx_session_analytics_score ON session_analytics(success_score)',
    'CREATE INDEX IF NOT EXISTS idx_tool_usage_detailed_session ON tool_usage_detailed(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_tool_usage_detailed_tool ON tool_usage_detailed(tool_name)',
  ];

  for (const index of indexes) {
    try {
      db.exec(index);
    } catch (e) {
      const error = e as Error;
      if (!error.message?.includes('already exists')) {
        logger.warn(`Failed to create index: ${error.message}`);
      }
    }
  }
}

// ============================================================================
// AGENT TEMPLATE OPERATIONS
// ============================================================================

export function createAgentTemplate(template: Omit<AgentTemplate, 'createdAt' | 'updatedAt'>): AgentTemplate {
  const db = getDatabase();

  const now = new Date().toISOString();
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
  const row = db.prepare('SELECT * FROM agent_templates WHERE id = ?').get(id) as any;
  return row ? mapRowToAgentTemplate(row) : null;
}

export function getAllAgentTemplates(): AgentTemplate[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM agent_templates ORDER BY name').all() as any[];
  return rows.map(mapRowToAgentTemplate);
}

export function updateAgentTemplate(id: string, updates: Partial<AgentTemplate>): void {
  const db = getDatabase();
  const existing = getAgentTemplate(id);
  if (!existing) throw new Error(`Agent template not found: ${id}`);

  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };

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

function mapRowToAgentTemplate(row: any): AgentTemplate {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cwd: row.cwd,
    initialPrompt: row.initial_prompt,
    claudeMdContent: row.claude_md_content,
    flags: JSON.parse(row.flags || '[]'),
    model: row.model,
    permissionMode: row.permission_mode,
    allowedTools: row.allowed_tools ? JSON.parse(row.allowed_tools) : null,
    deniedTools: row.denied_tools ? JSON.parse(row.denied_tools) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// HOOK OPERATIONS
// ============================================================================

export function createHook(hook: Omit<HookConfig, 'id' | 'executionCount' | 'lastExecuted' | 'lastResult' | 'createdAt' | 'updatedAt'>): HookConfig {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO hooks (
      name, event_type, matcher, command, timeout, enabled, scope, project_path
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    hook.name,
    hook.eventType,
    hook.matcher,
    hook.command,
    hook.timeout,
    hook.enabled ? 1 : 0,
    hook.scope,
    hook.projectPath
  );

  return getHook(result.lastInsertRowid as number)!;
}

export function getHook(id: number): HookConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hooks WHERE id = ?').get(id) as any;
  return row ? mapRowToHook(row) : null;
}

export function getAllHooks(scope?: 'user' | 'project', projectPath?: string): HookConfig[] {
  const db = getDatabase();
  let query = 'SELECT * FROM hooks';
  const params: (string | undefined)[] = [];

  if (scope) {
    query += ' WHERE scope = ?';
    params.push(scope);
    if (scope === 'project' && projectPath) {
      query += ' AND project_path = ?';
      params.push(projectPath);
    }
  }

  query += ' ORDER BY event_type, name';
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(mapRowToHook);
}

export function getHooksByEventType(eventType: HookEventType, projectPath?: string): HookConfig[] {
  const db = getDatabase();

  let query = 'SELECT * FROM hooks WHERE event_type = ? AND enabled = 1';
  const params: (string | undefined)[] = [eventType];

  if (projectPath) {
    query += ' AND (scope = ? OR (scope = ? AND project_path = ?))';
    params.push('user', 'project', projectPath);
  } else {
    query += ' AND scope = ?';
    params.push('user');
  }

  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(mapRowToHook);
}

export function updateHook(id: number, updates: Partial<HookConfig>): void {
  const db = getDatabase();
  const existing = getHook(id);
  if (!existing) throw new Error(`Hook not found: ${id}`);

  const merged = { ...existing, ...updates };

  db.prepare(`
    UPDATE hooks SET
      name = ?, event_type = ?, matcher = ?, command = ?, timeout = ?,
      enabled = ?, scope = ?, project_path = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.name,
    merged.eventType,
    merged.matcher,
    merged.command,
    merged.timeout,
    merged.enabled ? 1 : 0,
    merged.scope,
    merged.projectPath,
    id
  );
}

export function recordHookExecution(id: number, result: 'success' | 'failure' | 'timeout'): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE hooks SET
      execution_count = execution_count + 1,
      last_executed = datetime('now'),
      last_result = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(result, id);
}

export function deleteHook(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM hooks WHERE id = ?').run(id);
}

function mapRowToHook(row: any): HookConfig {
  return {
    id: row.id,
    name: row.name,
    eventType: row.event_type as HookEventType,
    matcher: row.matcher,
    command: row.command,
    timeout: row.timeout,
    enabled: row.enabled === 1,
    scope: row.scope,
    projectPath: row.project_path,
    executionCount: row.execution_count,
    lastExecuted: row.last_executed,
    lastResult: row.last_result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// MCP SERVER OPERATIONS
// ============================================================================

export function createMCPServer(server: Omit<MCPServer, 'id' | 'status' | 'lastConnected' | 'errorMessage' | 'toolCount' | 'createdAt' | 'updatedAt'>): MCPServer {
  const db = getDatabase();

  const result = db.prepare(`
    INSERT INTO mcp_servers (
      name, description, transport, command, url, args, env, scope, project_path, enabled
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    server.name,
    server.description,
    server.transport,
    server.command,
    server.url,
    JSON.stringify(server.args || []),
    JSON.stringify(server.env || {}),
    server.scope,
    server.projectPath,
    server.enabled ? 1 : 0
  );

  return getMCPServer(result.lastInsertRowid as number)!;
}

export function getMCPServer(id: number): MCPServer | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as any;
  return row ? mapRowToMCPServer(row) : null;
}

export function getAllMCPServers(scope?: 'user' | 'project', projectPath?: string): MCPServer[] {
  const db = getDatabase();
  let query = 'SELECT * FROM mcp_servers';
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
  const rows = db.prepare(query).all(...params) as any[];
  return rows.map(mapRowToMCPServer);
}

export function updateMCPServer(id: number, updates: Partial<MCPServer>): void {
  const db = getDatabase();
  const existing = getMCPServer(id);
  if (!existing) throw new Error(`MCP Server not found: ${id}`);

  const merged = { ...existing, ...updates };

  db.prepare(`
    UPDATE mcp_servers SET
      name = ?, description = ?, transport = ?, command = ?, url = ?,
      args = ?, env = ?, scope = ?, project_path = ?, enabled = ?,
      status = ?, last_connected = ?, error_message = ?, tool_count = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    merged.name,
    merged.description,
    merged.transport,
    merged.command,
    merged.url,
    JSON.stringify(merged.args || []),
    JSON.stringify(merged.env || {}),
    merged.scope,
    merged.projectPath,
    merged.enabled ? 1 : 0,
    merged.status,
    merged.lastConnected,
    merged.errorMessage,
    merged.toolCount,
    id
  );
}

export function updateMCPServerStatus(id: number, status: MCPServer['status'], errorMessage?: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE mcp_servers SET
      status = ?,
      last_connected = CASE WHEN ? = 'connected' THEN datetime('now') ELSE last_connected END,
      error_message = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(status, status, errorMessage || null, id);
}

export function deleteMCPServer(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
}

function mapRowToMCPServer(row: any): MCPServer {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    transport: row.transport,
    command: row.command,
    url: row.url,
    args: JSON.parse(row.args || '[]'),
    env: JSON.parse(row.env || '{}'),
    scope: row.scope,
    projectPath: row.project_path,
    enabled: row.enabled === 1,
    status: row.status,
    lastConnected: row.last_connected,
    errorMessage: row.error_message,
    toolCount: row.tool_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// AGENT REGISTRY OPERATIONS
// ============================================================================

export function registerAgent(agent: Omit<AgentRecord, 'spawnedAt' | 'lastActivity' | 'completedAt' | 'exitCode' | 'errorMessage'>): AgentRecord {
  const db = getDatabase();

  const now = new Date().toISOString();
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
  const row = db.prepare('SELECT * FROM agent_registry WHERE id = ?').get(id) as any;
  return row ? mapRowToAgentRecord(row) : null;
}

export function getAgentsByParent(parentId: string | null): AgentRecord[] {
  const db = getDatabase();
  const query = parentId
    ? 'SELECT * FROM agent_registry WHERE parent_id = ? ORDER BY spawned_at'
    : 'SELECT * FROM agent_registry WHERE parent_id IS NULL ORDER BY spawned_at';
  const rows = db.prepare(query).all(parentId ?? undefined) as any[];
  return rows.map(mapRowToAgentRecord);
}

export function getActiveAgents(): AgentRecord[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM agent_registry
    WHERE status IN ('spawning', 'ready', 'active', 'idle')
    ORDER BY spawned_at DESC
  `).all() as any[];
  return rows.map(mapRowToAgentRecord);
}

export function getAllAgents(): AgentRecord[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM agent_registry ORDER BY spawned_at DESC').all() as any[];
  return rows.map(mapRowToAgentRecord);
}

export function updateAgentStatus(id: string, status: AgentStatus, errorMessage?: string): void {
  const db = getDatabase();

  const completedAt = ['completed', 'error', 'terminated'].includes(status)
    ? new Date().toISOString()
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
  const row = db.prepare('SELECT * FROM agent_registry WHERE session_path = ?').get(sessionId) as any;
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

    return getAgent(existing.id)!;
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

function mapRowToAgentRecord(row: any): AgentRecord {
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

  return getSkill(result.lastInsertRowid as number)!;
}

export function getSkill(id: number): Skill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM skills WHERE id = ?').get(id) as any;
  return row ? mapRowToSkill(row) : null;
}

export function getSkillByName(name: string): Skill | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM skills WHERE name = ?').get(name) as any;
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
  const rows = db.prepare(query).all(...params) as any[];
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

function mapRowToSkill(row: any): Skill {
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

  return getTaskDefinition(result.lastInsertRowid as number)!;
}

export function getTaskDefinition(id: number): TaskDefinition | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM task_definitions WHERE id = ?').get(id) as any;
  return row ? mapRowToTaskDefinition(row) : null;
}

export function getAllTaskDefinitions(): TaskDefinition[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM task_definitions ORDER BY name').all() as any[];
  return rows.map(mapRowToTaskDefinition);
}

export function getScheduledTasks(): TaskDefinition[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM task_definitions
    WHERE enabled = 1 AND schedule IS NOT NULL
    ORDER BY name
  `).all() as any[];
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

function mapRowToTaskDefinition(row: any): TaskDefinition {
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
// SESSION ANALYTICS OPERATIONS
// ============================================================================

export interface SessionAnalytics {
  sessionId: string;
  successScore: number | null;
  iterationCount: number;
  toolEfficiency: number | null;
  contextUsagePeak: number | null;
  estimatedRoi: number | null;
  tagsAuto: string[];
  outcomeAnalysis: string | null;
  createdAt: string;
  updatedAt: string;
}

export function upsertSessionAnalytics(analytics: Partial<SessionAnalytics> & { sessionId: string }): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO session_analytics (
      session_id, success_score, iteration_count, tool_efficiency,
      context_usage_peak, estimated_roi, tags_auto, outcome_analysis
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      success_score = COALESCE(excluded.success_score, success_score),
      iteration_count = COALESCE(excluded.iteration_count, iteration_count),
      tool_efficiency = COALESCE(excluded.tool_efficiency, tool_efficiency),
      context_usage_peak = COALESCE(excluded.context_usage_peak, context_usage_peak),
      estimated_roi = COALESCE(excluded.estimated_roi, estimated_roi),
      tags_auto = COALESCE(excluded.tags_auto, tags_auto),
      outcome_analysis = COALESCE(excluded.outcome_analysis, outcome_analysis),
      updated_at = datetime('now')
  `).run(
    analytics.sessionId,
    analytics.successScore ?? null,
    analytics.iterationCount ?? 0,
    analytics.toolEfficiency ?? null,
    analytics.contextUsagePeak ?? null,
    analytics.estimatedRoi ?? null,
    JSON.stringify(analytics.tagsAuto || []),
    analytics.outcomeAnalysis ?? null
  );
}

export function getSessionAnalytics(sessionId: string): SessionAnalytics | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM session_analytics WHERE session_id = ?').get(sessionId) as any;

  if (!row) return null;

  return {
    sessionId: row.session_id,
    successScore: row.success_score,
    iterationCount: row.iteration_count,
    toolEfficiency: row.tool_efficiency,
    contextUsagePeak: row.context_usage_peak,
    estimatedRoi: row.estimated_roi,
    tagsAuto: JSON.parse(row.tags_auto || '[]'),
    outcomeAnalysis: row.outcome_analysis,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ============================================================================
// DETAILED TOOL USAGE OPERATIONS
// ============================================================================

export interface DetailedToolUsage {
  id: number;
  sessionId: string | null;
  toolName: string;
  toolInput: string | null;
  toolResultPreview: string | null;
  success: boolean;
  durationMs: number | null;
  tokenCost: number | null;
  timestamp: string;
}

export function recordDetailedToolUsage(usage: Omit<DetailedToolUsage, 'id' | 'timestamp'>): void {
  const db = getDatabase();

  db.prepare(`
    INSERT INTO tool_usage_detailed (
      session_id, tool_name, tool_input, tool_result_preview,
      success, duration_ms, token_cost
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    usage.sessionId,
    usage.toolName,
    usage.toolInput,
    usage.toolResultPreview,
    usage.success ? 1 : 0,
    usage.durationMs,
    usage.tokenCost
  );
}

export function getDetailedToolUsageBySession(sessionId: string): DetailedToolUsage[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT * FROM tool_usage_detailed
    WHERE session_id = ?
    ORDER BY timestamp
  `).all(sessionId) as any[];

  return rows.map(row => ({
    id: row.id,
    sessionId: row.session_id,
    toolName: row.tool_name,
    toolInput: row.tool_input,
    toolResultPreview: row.tool_result_preview,
    success: row.success === 1,
    durationMs: row.duration_ms,
    tokenCost: row.token_cost,
    timestamp: row.timestamp,
  }));
}

export function getToolEfficiencyStats(): Array<{
  toolName: string;
  totalCalls: number;
  successRate: number;
  avgDurationMs: number | null;
  totalTokenCost: number;
}> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      tool_name,
      COUNT(*) as total_calls,
      AVG(CASE WHEN success = 1 THEN 1.0 ELSE 0.0 END) as success_rate,
      AVG(duration_ms) as avg_duration,
      SUM(COALESCE(token_cost, 0)) as total_tokens
    FROM tool_usage_detailed
    GROUP BY tool_name
    ORDER BY total_calls DESC
  `).all() as any[];

  return rows.map(row => ({
    toolName: row.tool_name,
    totalCalls: row.total_calls,
    successRate: row.success_rate,
    avgDurationMs: row.avg_duration,
    totalTokenCost: row.total_tokens,
  }));
}

// ============================================================================
// PROJECT CONFIG OPERATIONS
// ============================================================================

export function createProjectConfig(config: Omit<ProjectConfig, 'createdAt' | 'updatedAt'>): ProjectConfig {
  const db = getDatabase();
  const now = new Date().toISOString();

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
  const row = db.prepare('SELECT * FROM project_configs WHERE project_path = ?').get(projectPath) as any;
  return row ? mapRowToProjectConfig(row) : null;
}

export function getAllProjectConfigs(): ProjectConfig[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM project_configs ORDER BY project_path').all() as any[];
  return rows.map(mapRowToProjectConfig);
}

export function updateProjectConfig(projectPath: string, updates: Partial<ProjectConfig>): void {
  const db = getDatabase();
  const existing = getProjectConfig(projectPath);
  if (!existing) throw new Error(`Project config not found: ${projectPath}`);

  const merged = { ...existing, ...updates, updatedAt: new Date().toISOString() };

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

function mapRowToProjectConfig(row: any): ProjectConfig {
  return {
    projectPath: row.project_path,
    defaultTemplateId: row.default_template_id,
    settings: JSON.parse(row.settings || '{}'),
    hooks: JSON.parse(row.hooks || '[]'),
    mcpServers: JSON.parse(row.mcp_servers || '[]'),
    claudeMdOverride: row.claude_md_override,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
