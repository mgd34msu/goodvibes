// ============================================================================
// DATABASE PRIMITIVES - Schema extensions for GoodVibes advanced features
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';

const logger = new Logger('DatabasePrimitives');

// Re-export all types
export * from './types.js';

// Re-export all operations
export * from './agents.js';
export * from './sessions.js';
export * from './analytics.js';
export * from './hooks.js';

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
