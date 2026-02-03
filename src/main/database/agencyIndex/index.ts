// ============================================================================
// AGENCY INDEX DATABASE - Schema for indexed agents and skills from agency
// ============================================================================
//
// This module provides database operations for storing and querying indexed
// agents and skills from the external agency directory. It includes full-text
// search capabilities using SQLite FTS5.
//
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';

const logger = new Logger('AgencyIndexDB');

// Re-export all types
export * from './types.js';

// Re-export all operations
export * from './categories.js';
export * from './agents.js';
export * from './skills.js';
export * from './active.js';

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createAgencyIndexTables(): void {
  const db = getDatabase();

  // Categories table for hierarchical organization
  db.exec(`
    CREATE TABLE IF NOT EXISTS agency_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      parent_id INTEGER,
      type TEXT NOT NULL CHECK (type IN ('agent', 'skill')),
      item_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES agency_categories(id) ON DELETE SET NULL
    )
  `);

  // Indexed agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      category_id INTEGER,
      category_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      skills TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      use_count INTEGER DEFAULT 0,
      last_used TEXT,
      last_indexed TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES agency_categories(id) ON DELETE SET NULL
    )
  `);

  // Indexed skills table
  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      description TEXT,
      content TEXT NOT NULL,
      category_id INTEGER,
      category_path TEXT NOT NULL,
      file_path TEXT NOT NULL,
      agent_slug TEXT,
      triggers TEXT DEFAULT '[]',
      tags TEXT DEFAULT '[]',
      use_count INTEGER DEFAULT 0,
      last_used TEXT,
      last_indexed TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES agency_categories(id) ON DELETE SET NULL
    )
  `);

  // Active agents table
  db.exec(`
    CREATE TABLE IF NOT EXISTS active_agents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project_path TEXT,
      agent_id INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      activated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      deactivated_at TEXT,
      is_active INTEGER DEFAULT 1,
      FOREIGN KEY (agent_id) REFERENCES indexed_agents(id) ON DELETE CASCADE
    )
  `);

  // Queued skills table
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      project_path TEXT,
      skill_id INTEGER NOT NULL,
      priority INTEGER DEFAULT 0,
      injected INTEGER DEFAULT 0,
      injected_at TEXT,
      queued_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (skill_id) REFERENCES indexed_skills(id) ON DELETE CASCADE
    )
  `);

  // Create FTS5 virtual tables for full-text search
  createFTSTables();

  // Create indexes
  createAgencyIndexIndexes();

  logger.info('Agency index tables created');
}

function createFTSTables(): void {
  const db = getDatabase();

  // FTS5 table for agent search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS indexed_agents_fts USING fts5(
        name,
        slug,
        description,
        content,
        tags,
        content='indexed_agents',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);
  } catch {
    // Table might already exist with different schema
    logger.debug('Agent FTS table already exists or creation failed');
  }

  // FTS5 table for skill search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS indexed_skills_fts USING fts5(
        name,
        slug,
        description,
        content,
        triggers,
        tags,
        content='indexed_skills',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);
  } catch {
    logger.debug('Skill FTS table already exists or creation failed');
  }

  // Create triggers to keep FTS tables in sync
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS indexed_agents_ai AFTER INSERT ON indexed_agents BEGIN
        INSERT INTO indexed_agents_fts(rowid, name, slug, description, content, tags)
        VALUES (new.id, new.name, new.slug, new.description, new.content, new.tags);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS indexed_agents_ad AFTER DELETE ON indexed_agents BEGIN
        INSERT INTO indexed_agents_fts(indexed_agents_fts, rowid, name, slug, description, content, tags)
        VALUES ('delete', old.id, old.name, old.slug, old.description, old.content, old.tags);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS indexed_agents_au AFTER UPDATE ON indexed_agents BEGIN
        INSERT INTO indexed_agents_fts(indexed_agents_fts, rowid, name, slug, description, content, tags)
        VALUES ('delete', old.id, old.name, old.slug, old.description, old.content, old.tags);
        INSERT INTO indexed_agents_fts(rowid, name, slug, description, content, tags)
        VALUES (new.id, new.name, new.slug, new.description, new.content, new.tags);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS indexed_skills_ai AFTER INSERT ON indexed_skills BEGIN
        INSERT INTO indexed_skills_fts(rowid, name, slug, description, content, triggers, tags)
        VALUES (new.id, new.name, new.slug, new.description, new.content, new.triggers, new.tags);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS indexed_skills_ad AFTER DELETE ON indexed_skills BEGIN
        INSERT INTO indexed_skills_fts(indexed_skills_fts, rowid, name, slug, description, content, triggers, tags)
        VALUES ('delete', old.id, old.name, old.slug, old.description, old.content, old.triggers, old.tags);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS indexed_skills_au AFTER UPDATE ON indexed_skills BEGIN
        INSERT INTO indexed_skills_fts(indexed_skills_fts, rowid, name, slug, description, content, triggers, tags)
        VALUES ('delete', old.id, old.name, old.slug, old.description, old.content, old.triggers, old.tags);
        INSERT INTO indexed_skills_fts(rowid, name, slug, description, content, triggers, tags)
        VALUES (new.id, new.name, new.slug, new.description, new.content, new.triggers, new.tags);
      END
    `);
  } catch {
    logger.debug('FTS triggers may already exist');
  }
}

function createAgencyIndexIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_agency_categories_path ON agency_categories(path)',
    'CREATE INDEX IF NOT EXISTS idx_agency_categories_parent ON agency_categories(parent_id)',
    'CREATE INDEX IF NOT EXISTS idx_agency_categories_type ON agency_categories(type)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_agents_category ON indexed_agents(category_id)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_agents_slug ON indexed_agents(slug)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_agents_use_count ON indexed_agents(use_count DESC)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_skills_category ON indexed_skills(category_id)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_skills_slug ON indexed_skills(slug)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_skills_agent ON indexed_skills(agent_slug)',
    'CREATE INDEX IF NOT EXISTS idx_indexed_skills_use_count ON indexed_skills(use_count DESC)',
    'CREATE INDEX IF NOT EXISTS idx_active_agents_session ON active_agents(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_active_agents_project ON active_agents(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_active_agents_active ON active_agents(is_active)',
    'CREATE INDEX IF NOT EXISTS idx_queued_skills_session ON queued_skills(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_queued_skills_project ON queued_skills(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_queued_skills_injected ON queued_skills(injected)',
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
// STATISTICS
// ============================================================================

export function getIndexStats(): {
  agentCount: number;
  skillCount: number;
  categoryCount: number;
  activeAgentCount: number;
  pendingSkillCount: number;
  lastIndexed: string | null;
} {
  const db = getDatabase();

  const agentCount = (db.prepare('SELECT COUNT(*) as count FROM indexed_agents').get() as { count: number }).count;
  const skillCount = (db.prepare('SELECT COUNT(*) as count FROM indexed_skills').get() as { count: number }).count;
  const categoryCount = (db.prepare('SELECT COUNT(*) as count FROM agency_categories').get() as { count: number }).count;
  const activeAgentCount = (db.prepare('SELECT COUNT(*) as count FROM active_agents WHERE is_active = 1').get() as { count: number }).count;
  const pendingSkillCount = (db.prepare('SELECT COUNT(*) as count FROM queued_skills WHERE injected = 0').get() as { count: number }).count;
  const lastIndexed = (db.prepare('SELECT MAX(last_indexed) as last FROM indexed_agents').get() as { last: string | null }).last;

  return {
    agentCount,
    skillCount,
    categoryCount,
    activeAgentCount,
    pendingSkillCount,
    lastIndexed,
  };
}
