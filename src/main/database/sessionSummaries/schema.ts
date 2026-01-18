// ============================================================================
// SESSION SUMMARIES - Table creation and indexes
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';

const logger = new Logger('SessionSummariesDB:Schema');

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createSessionSummariesTables(): void {
  const db = getDatabase();

  // Session summaries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      duration_ms INTEGER DEFAULT 0,
      status TEXT DEFAULT 'completed' CHECK (status IN ('completed', 'aborted', 'error')),

      tool_calls INTEGER DEFAULT 0,
      files_modified INTEGER DEFAULT 0,
      files_created INTEGER DEFAULT 0,
      tests_run INTEGER DEFAULT 0,
      tests_passed INTEGER DEFAULT 0,
      tests_failed INTEGER DEFAULT 0,
      tokens_used INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,

      active_agent_ids TEXT DEFAULT '[]',
      injected_skill_ids TEXT DEFAULT '[]',
      key_topics TEXT DEFAULT '[]',
      file_changes TEXT DEFAULT '[]',

      last_prompt TEXT,
      context_snapshot TEXT,

      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Session checkpoints table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      checkpoint_name TEXT NOT NULL,
      context TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES session_summaries(session_id) ON DELETE CASCADE
    )
  `);

  // Create FTS5 table for full-text search
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summaries_fts USING fts5(
        title,
        description,
        key_topics,
        last_prompt,
        content='session_summaries',
        content_rowid='id',
        tokenize='porter unicode61'
      )
    `);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // FTS5 tables don't support IF NOT EXISTS properly in all SQLite versions
    // "already exists" is expected on subsequent runs, other errors are real problems
    if (errorMessage.includes('already exists')) {
      logger.debug('Session summaries FTS table already exists');
    } else {
      logger.error('Failed to create session summaries FTS table', error, {
        tableName: 'session_summaries_fts',
      });
      // Don't throw - FTS is optional functionality, app can work without it
    }
  }

  // Create triggers for FTS
  try {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ai AFTER INSERT ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(rowid, title, description, key_topics, last_prompt)
        VALUES (new.id, new.title, new.description, new.key_topics, new.last_prompt);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_ad AFTER DELETE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, description, key_topics, last_prompt)
        VALUES ('delete', old.id, old.title, old.description, old.key_topics, old.last_prompt);
      END
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS session_summaries_au AFTER UPDATE ON session_summaries BEGIN
        INSERT INTO session_summaries_fts(session_summaries_fts, rowid, title, description, key_topics, last_prompt)
        VALUES ('delete', old.id, old.title, old.description, old.key_topics, old.last_prompt);
        INSERT INTO session_summaries_fts(rowid, title, description, key_topics, last_prompt)
        VALUES (new.id, new.title, new.description, new.key_topics, new.last_prompt);
      END
    `);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    // Triggers use IF NOT EXISTS, but some SQLite versions may still error
    // "already exists" is expected on subsequent runs, other errors are real problems
    if (errorMessage.includes('already exists')) {
      logger.debug('Session summaries FTS triggers already exist');
    } else {
      logger.error('Failed to create session summaries FTS triggers', error, {
        triggers: ['session_summaries_ai', 'session_summaries_ad', 'session_summaries_au'],
      });
      // Don't throw - FTS triggers are optional, app can work without them
    }
  }

  // Create indexes
  createSessionSummariesIndexes();

  logger.info('Session summaries tables created');
}

function createSessionSummariesIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_session ON session_summaries(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_project ON session_summaries(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_started ON session_summaries(started_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_session_summaries_status ON session_summaries(status)',
    'CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session ON session_checkpoints(session_id)',
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
