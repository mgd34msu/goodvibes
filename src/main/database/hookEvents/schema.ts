// ============================================================================
// HOOK EVENTS - Schema and table creation
// ============================================================================

import { getDatabase } from '../connection.js';
import { Logger } from '../../services/logger.js';

const logger = new Logger('HookEventsSchema');

// ============================================================================
// TABLE CREATION
// ============================================================================

export function createHookEventsTables(): void {
  const db = getDatabase();

  // Hook events table - stores all hook events for real-time display and analytics
  db.exec(`
    CREATE TABLE IF NOT EXISTS hook_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      session_id TEXT,
      project_path TEXT,
      tool_name TEXT,
      tool_input TEXT,
      tool_result TEXT,
      blocked INTEGER DEFAULT 0,
      block_reason TEXT,
      duration_ms INTEGER DEFAULT 0,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Budget tracking table
  db.exec(`
    CREATE TABLE IF NOT EXISTS budgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_path TEXT,
      session_id TEXT,
      limit_usd REAL NOT NULL,
      spent_usd REAL DEFAULT 0,
      warning_threshold REAL DEFAULT 0.8,
      hard_stop_enabled INTEGER DEFAULT 0,
      reset_period TEXT DEFAULT 'session',
      last_reset TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Approval queue table
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      request_type TEXT NOT NULL,
      request_details TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      policy_id INTEGER,
      decided_at TEXT,
      decided_by TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (policy_id) REFERENCES approval_policies(id)
    )
  `);

  // Approval policies table
  db.exec(`
    CREATE TABLE IF NOT EXISTS approval_policies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      matcher TEXT NOT NULL,
      action TEXT NOT NULL,
      priority INTEGER DEFAULT 0,
      conditions TEXT,
      enabled INTEGER DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  createHookEventsIndexes();

  logger.info('Hook events tables created');
}

function createHookEventsIndexes(): void {
  const db = getDatabase();

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_hook_events_type ON hook_events(event_type)',
    'CREATE INDEX IF NOT EXISTS idx_hook_events_session ON hook_events(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_hook_events_timestamp ON hook_events(timestamp)',
    'CREATE INDEX IF NOT EXISTS idx_hook_events_tool ON hook_events(tool_name)',
    'CREATE INDEX IF NOT EXISTS idx_budgets_project ON budgets(project_path)',
    'CREATE INDEX IF NOT EXISTS idx_budgets_session ON budgets(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_approval_queue_status ON approval_queue(status)',
    'CREATE INDEX IF NOT EXISTS idx_approval_queue_session ON approval_queue(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_approval_policies_enabled ON approval_policies(enabled)',
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
