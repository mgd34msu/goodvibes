// ============================================================================
// PROJECT REGISTRY DATABASE - Schema for multi-project orchestration
// ============================================================================
//
// This module provides database operations for managing project registrations,
// project-specific agent configurations, templates, and cross-project analytics.
//
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';

const logger = new Logger('ProjectRegistryDB');

// Re-export all types
export * from './types.js';

// Re-export all operations
export * from './projects.js';
export * from './agents.js';
export * from './templates.js';
export * from './sessions.js';
export * from './analytics.js';

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createProjectRegistryTables(): void {
  const db = getDatabase();

  // Projects table
  db.exec(`
    CREATE TABLE IF NOT EXISTS registered_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      path TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      last_opened TEXT DEFAULT CURRENT_TIMESTAMP,
      settings TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Project agents table (many-to-many relationship)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      settings TEXT DEFAULT '{}',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES registered_projects(id) ON DELETE CASCADE,
      UNIQUE(project_id, agent_id)
    )
  `);

  // Project templates table
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      settings TEXT DEFAULT '{}',
      agents TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Cross-project session tracking
  db.exec(`
    CREATE TABLE IF NOT EXISTS cross_project_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      project_id INTEGER NOT NULL,
      agent_session_id TEXT,
      status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'failed')),
      started_at TEXT DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      tokens_used INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      metadata TEXT,
      FOREIGN KEY (project_id) REFERENCES registered_projects(id) ON DELETE CASCADE
    )
  `);

  // Create indexes
  createProjectRegistryIndexes();

  logger.info('Project registry tables created');
}

function createProjectRegistryIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_registered_projects_path ON registered_projects(path)',
    'CREATE INDEX IF NOT EXISTS idx_registered_projects_name ON registered_projects(name)',
    'CREATE INDEX IF NOT EXISTS idx_registered_projects_last_opened ON registered_projects(last_opened DESC)',
    'CREATE INDEX IF NOT EXISTS idx_project_agents_project ON project_agents(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_project_agents_agent ON project_agents(agent_id)',
    'CREATE INDEX IF NOT EXISTS idx_project_templates_name ON project_templates(name)',
    'CREATE INDEX IF NOT EXISTS idx_cross_project_sessions_session ON cross_project_sessions(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_cross_project_sessions_project ON cross_project_sessions(project_id)',
    'CREATE INDEX IF NOT EXISTS idx_cross_project_sessions_status ON cross_project_sessions(status)',
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
