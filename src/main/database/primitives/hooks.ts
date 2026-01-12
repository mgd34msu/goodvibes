// ============================================================================
// DATABASE PRIMITIVES - Hook and MCP Server Operations
// ============================================================================

import { getDatabase } from '../connection.js';
import type {
  HookConfig,
  HookRow,
  HookEventType,
  MCPServer,
  MCPServerRow,
} from './types.js';

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

  const inserted = getHook(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve created hook with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

export function getHook(id: number): HookConfig | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM hooks WHERE id = ?').get(id) as HookRow | undefined;
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
  const rows = db.prepare(query).all(...params) as HookRow[];
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

  const rows = db.prepare(query).all(...params) as HookRow[];
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

function mapRowToHook(row: HookRow): HookConfig {
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

  const inserted = getMCPServer(result.lastInsertRowid as number);
  if (!inserted) {
    throw new Error(`Failed to retrieve created MCP server with id ${result.lastInsertRowid}`);
  }
  return inserted;
}

export function getMCPServer(id: number): MCPServer | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as MCPServerRow | undefined;
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
  const rows = db.prepare(query).all(...params) as MCPServerRow[];
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

function mapRowToMCPServer(row: MCPServerRow): MCPServer {
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
