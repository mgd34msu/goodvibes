// ============================================================================
// DATABASE MODULE - Better-SQLite3 Implementation
// ============================================================================
//
// This file provides the main database entry point and re-exports all
// database operations from domain-specific modules.
//
// ============================================================================

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Logger } from '../services/logger.js';
import { getTodayString } from '../../shared/dateUtils.js';
import type {
  Analytics,
} from '../../shared/types/index.js';
import {
  type SessionRow,
} from './mappers.js';
import { createPrimitiveTables } from './primitives.js';
import { createAgencyIndexTables } from './agencyIndex.js';
import { createSessionSummariesTables } from './sessionSummaries/index.js';
import {
  getDatabase,
  setDatabaseInstance,
  clearDatabaseInstance,
} from './connection.js';
import { runMigrations, MIGRATIONS } from './migrations.js';

// Re-export getDatabase from connection.ts for backward compatibility
export { getDatabase } from './connection.js';

// Re-export session operations
export {
  upsertSession,
  getAllSessions,
  getSession,
  deleteSession,
  toggleFavorite,
  toggleArchive,
  getActiveSessions,
  getFavoriteSessions,
  getArchivedSessions,
  getKnownSessionPaths,
  getKnownSessionPathsWithMtime,
} from './sessions.js';

// Re-export message operations
export {
  storeMessages,
  getSessionMessages,
} from './messages.js';

// Re-export tag operations
export {
  // Tag CRUD
  getAllTags,
  getTag,
  getTagByName,
  createTag,
  updateTag,
  deleteTag,
  mergeTags,
  // Tag Properties
  toggleTagPinned,
  setTagColor,
  setTagEffect,
  setTagParent,
  createTagAlias,
  getTagChildren,
  getTagAliases,
  // Session-Tag Associations
  addTagToSession,
  removeTagFromSession,
  getSessionTags,
  clearSessionTags,
  setSessionTags,
  // Bulk Operations
  addTagToSessions,
  removeTagFromSessions,
  clearTagsFromSessions,
  // Recent & Pinned
  getRecentTags,
  recordTagUsage,
  getPinnedTags,
  // Usage Count
  incrementTagUsage,
  decrementTagUsage,
  recalculateTagUsageCount,
  recalculateAllTagUsageCounts,
} from './tags.js';

// Re-export tag suggestion operations
export {
  createSuggestions,
  getSessionSuggestions,
  getSuggestion,
  updateSuggestionStatus,
  acceptSuggestion,
  rejectSuggestion,
  dismissSuggestion,
  acceptAllSuggestions,
  dismissAllSuggestions,
  deleteOldSuggestions,
  recordSuggestionFeedback,
  getSuggestionFeedback,
  isTagFrequentlyRejected,
  updateSessionScanStatus,
  getPendingSessions,
  getSessionsNeedingRescan,
  getScanCounts,
  getSessionScanStatus,
  skipOldSessions,
} from './tagSuggestions.js';

// Re-export tag filter operations
export {
  buildTagFilterQuery,
  getFilteredSessionIds,
  validateTagIds,
  type FilterResult,
  type ValidationResult,
} from './tagFilters.js';

// Re-export analytics operations
export {
  upsertSessionAnalytics,
  getSessionAnalytics,
  recordDetailedToolUsage,
  getDetailedToolUsageBySession,
  getToolEfficiencyStats,
  clearDetailedToolUsage,
  batchRecordDetailedToolUsage,
  getSessionToolCostBreakdown,
} from './primitives/analytics.js';

// Re-export analytics types
export type {
  DetailedToolUsage,
  ToolCostBreakdown,
  ToolEfficiencyStats,
  SessionAnalytics,
} from './primitives/types.js';

const logger = new Logger('Database');

let db: Database.Database | null = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the database connection and create all necessary tables
 * @param userDataPath - Path to the user data directory where the database will be stored
 * @returns Promise that resolves when database initialization is complete
 * @example
 * await initDatabase(app.getPath('userData'))
 */
export async function initDatabase(userDataPath: string): Promise<void> {
  const dbPath = path.join(userDataPath, 'goodvibes.db');

  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);

  // Set the database instance in the shared connection module
  setDatabaseInstance(db);

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Create tables
  createTables();

  // Create primitive tables (agent_registry, hooks, mcp_servers, etc.)
  createPrimitiveTables();

  // Create agency index tables (indexed agents, skills, active agents, queued skills)
  createAgencyIndexTables();

  // Create session summaries tables (for cross-session search and resumption)
  createSessionSummariesTables();

  // Run database migrations
  const migrationsApplied = runMigrations(db, MIGRATIONS);
  if (migrationsApplied > 0) {
    logger.info(`Applied ${migrationsApplied} database migrations`);
  }

  logger.info(`Database initialized at ${dbPath}`);
}

/**
 * Close the database connection and clean up resources
 */
export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    clearDatabaseInstance();
    logger.info('Database closed');
  }
}

// ============================================================================
// TABLE CREATION
// ============================================================================

function createTables(): void {
  if (!db) return;

  // Sessions table
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      project_name TEXT,
      file_path TEXT,
      start_time TEXT,
      end_time TEXT,
      message_count INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      status TEXT DEFAULT 'unknown',
      tags TEXT,
      notes TEXT,
      favorite INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      collection_id INTEGER,
      summary TEXT,
      custom_title TEXT,
      rating INTEGER,
      outcome TEXT,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cache_write_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0,
      file_mtime REAL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (collection_id) REFERENCES collections(id)
    )
  `);

  // Messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_index INTEGER,
      role TEXT,
      content TEXT,
      timestamp TEXT,
      token_count INTEGER DEFAULT 0,
      tool_name TEXT,
      tool_input TEXT,
      tool_result TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Tags table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT DEFAULT '#6366f1',
      parent_id INTEGER,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES tags(id)
    )
  `);

  // Session tags junction table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tags (
      session_id TEXT,
      tag_id INTEGER,
      PRIMARY KEY (session_id, tag_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    )
  `);

  // Collections table
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      icon TEXT DEFAULT '📁',
      parent_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (parent_id) REFERENCES collections(id)
    )
  `);

  // Smart collections table
  db.exec(`
    CREATE TABLE IF NOT EXISTS smart_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1',
      icon TEXT DEFAULT '📁',
      rules TEXT NOT NULL,
      match_mode TEXT DEFAULT 'all',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Bookmarks table
  db.exec(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      message_index INTEGER,
      label TEXT,
      color TEXT DEFAULT '#f59e0b',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Settings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Prompts table
  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT DEFAULT 'General',
      use_count INTEGER DEFAULT 0,
      last_used TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Quick notes table
  db.exec(`
    CREATE TABLE IF NOT EXISTS quick_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      session_id TEXT,
      status TEXT DEFAULT 'active',
      priority TEXT DEFAULT 'normal',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Notifications table
  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT,
      priority TEXT DEFAULT 'normal',
      read INTEGER DEFAULT 0,
      dismissed INTEGER DEFAULT 0,
      session_id TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    )
  `);

  // Knowledge entries table
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      category TEXT,
      tags TEXT,
      source_session_id TEXT,
      view_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_session_id) REFERENCES sessions(id)
    )
  `);

  // Session links table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_session_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      link_type TEXT NOT NULL,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (target_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      UNIQUE(source_session_id, target_session_id, link_type)
    )
  `);

  // Tool usage table
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      count INTEGER DEFAULT 1,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Activity log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      session_id TEXT,
      description TEXT,
      metadata TEXT,
      timestamp TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Saved searches table
  db.exec(`
    CREATE TABLE IF NOT EXISTS saved_searches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      filters TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Analytics snapshots table
  db.exec(`
    CREATE TABLE IF NOT EXISTS analytics_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE,
      session_count INTEGER DEFAULT 0,
      token_count INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      data TEXT
    )
  `);

  // Create indexes for performance
  createIndexes();

  logger.info('Database tables created');
}

function createIndexes(): void {
  if (!db) return;

  const indexes = [
    'CREATE INDEX IF NOT EXISTS idx_sessions_start_time ON sessions(start_time)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_end_time ON sessions(end_time)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_favorite ON sessions(favorite)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived)',
    'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_messages_session_message ON messages(session_id, message_index)',
    'CREATE INDEX IF NOT EXISTS idx_messages_role ON messages(role)',
    'CREATE INDEX IF NOT EXISTS idx_tool_usage_session ON tool_usage(session_id)',
    'CREATE INDEX IF NOT EXISTS idx_tool_usage_name ON tool_usage(tool_name)',
    'CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activity_log(type)',
    'CREATE INDEX IF NOT EXISTS idx_activity_log_session ON activity_log(session_id)',
  ];

  for (const index of indexes) {
    try {
      db.exec(index);
    } catch (e: unknown) {
      const error = e as Error;
      const message = error?.message || String(e);
      if (!message.includes('already exists')) {
        logger.warn(`Failed to create index: ${message}`, { index });
      }
    }
  }
}

// ============================================================================
// SETTINGS OPERATIONS
// ============================================================================

/**
 * Retrieve a setting value from the database by key
 * @param key - The setting key to retrieve
 * @returns The parsed setting value of type T, or null if not found
 * @example
 * const theme = getSetting<string>('theme') // => "dark" or null
 */
export function getSetting<T>(key: string): T | null {
  const database = getDatabase();
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch (error) {
    logger.debug(`Failed to parse setting value for key '${key}'`, { error });
    return null;
  }
}

/**
 * Store or update a setting value in the database
 * @param key - The setting key to store
 * @param value - The value to store (will be JSON stringified)
 * @example
 * setSetting('theme', 'dark')
 * setSetting('windowBounds', { x: 100, y: 100, width: 800, height: 600 })
 */
export function setSetting(key: string, value: unknown): void {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
}

/**
 * Retrieve all settings from the database
 * @returns Object containing all settings as key-value pairs
 * @example
 * const settings = getAllSettings() // => { theme: 'dark', windowBounds: {...}, ... }
 */
export function getAllSettings(): Record<string, unknown> {
  const database = getDatabase();
  const rows = database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, unknown> = {};

  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch (error) {
      logger.debug(`Failed to parse setting value for key '${row.key}', using raw value`, { error });
      settings[row.key] = row.value;
    }
  }

  return settings;
}

// ============================================================================
// ANALYTICS
// ============================================================================

/**
 * Compute comprehensive analytics data from all sessions
 * @returns Analytics object containing totals, daily stats, project costs, and time series data
 * @example
 * const analytics = getAnalytics()
 * console.log(analytics.totalCost, analytics.totalSessions)
 */
export function getAnalytics(): Analytics {
  const database = getDatabase();
  const today = getTodayString();

  // Main aggregations query - single pass to get all stats
  const mainStats = database.prepare(`
    SELECT
      COUNT(*) as totalSessions,
      COALESCE(SUM(token_count), 0) as totalTokens,
      COALESCE(SUM(cost), 0) as totalCost,
      COALESCE(SUM(message_count), 0) as totalMessages,
      COALESCE(AVG(token_count), 0) as avgTokensPerSession,
      SUM(CASE WHEN start_time LIKE ? || '%' THEN COALESCE(cost, 0) ELSE 0 END) as dailyCost,
      SUM(CASE WHEN start_time LIKE ? || '%' THEN COALESCE(message_count, 0) ELSE 0 END) as messagesToday,
      SUM(CASE WHEN id LIKE 'agent-%' THEN 1 ELSE 0 END) as totalSubagents,
      SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END) as favoriteCount
    FROM sessions
  `).get(today, today) as {
    totalSessions: number;
    totalTokens: number;
    totalCost: number;
    totalMessages: number;
    avgTokensPerSession: number;
    dailyCost: number;
    messagesToday: number;
    totalSubagents: number;
    favoriteCount: number;
  };

  // Cost by project - attribute subagent costs to their parent project
  // Subagent sessions have project_name='subagents' but their file_path contains the parent project
  const projectGroups = database.prepare(`
    SELECT 
      CASE 
        WHEN project_name = 'subagents' AND file_path LIKE '%/projects/%' THEN
          SUBSTR(
            file_path,
            INSTR(file_path, '/projects/') + 10,
            INSTR(SUBSTR(file_path, INSTR(file_path, '/projects/') + 10), '/') - 1
          )
        ELSE project_name
      END as project_name,
      SUM(cost) as project_cost
    FROM sessions
    GROUP BY project_name
    LIMIT 100
  `).all() as { project_name: string; project_cost: number }[];

  const costByProject: Record<string, number> = {};
  projectGroups.forEach(p => {
    costByProject[p.project_name ?? 'Unknown'] = p.project_cost ?? 0;
  });

  // Sessions over time - get aggregated data from database
  const sessionsFromDb = database.prepare(`
    SELECT
      DATE(start_time) as date,
      COUNT(*) as count,
      COALESCE(SUM(token_count), 0) as tokens,
      COALESCE(SUM(cost), 0) as cost
    FROM sessions
    WHERE start_time IS NOT NULL AND start_time >= datetime('now', '-84 days')
    GROUP BY DATE(start_time)
    ORDER BY date
  `).all() as { date: string; count: number; tokens: number; cost: number }[];

  const dateDataMap = new Map<string, { count: number; tokens: number; cost: number }>();
  for (const row of sessionsFromDb) {
    dateDataMap.set(row.date, { count: row.count, tokens: row.tokens, cost: row.cost });
  }

  const sessionsOverTime: { date: string; count: number; tokens: number; cost: number }[] = [];
  const now = new Date();
  for (let i = 83; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const data = dateDataMap.get(dateStr);
    sessionsOverTime.push({
      date: dateStr,
      count: data?.count ?? 0,
      tokens: data?.tokens ?? 0,
      cost: data?.cost ?? 0,
    });
  }

  return {
    totalSessions: mainStats.totalSessions,
    totalTokens: mainStats.totalTokens,
    totalCost: mainStats.totalCost,
    dailyCost: mainStats.dailyCost,
    avgTokensPerSession: Math.round(mainStats.avgTokensPerSession),
    costByProject,
    sessionsOverTime,
    messageCount: mainStats.totalMessages,
    totalMessages: mainStats.totalMessages,
    messagesToday: mainStats.messagesToday,
    totalSubagents: mainStats.totalSubagents,
    favoriteCount: mainStats.favoriteCount,
  };
}

// ============================================================================
// TOOL USAGE OPERATIONS
// ============================================================================

import type { ToolUsageStat, ActivityLogEntry } from '../../shared/types/index.js';
import { mapRowToActivity, type ActivityLogRow } from './mappers.js';

/**
 * Get aggregated tool usage statistics across all sessions
 * @returns Array of tool usage statistics sorted by usage count descending
 * @example
 * const stats = getToolUsageStats()
 * // => [{ toolName: 'Read', totalCount: 523, lastUsed: '2024-01-15' }, ...]
 */
export function getToolUsageStats(): ToolUsageStat[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT tool_name, SUM(count) as total_count, MAX(timestamp) as last_used
    FROM tool_usage
    GROUP BY tool_name
    ORDER BY total_count DESC
  `).all() as { tool_name: string; total_count: number; last_used: string }[];

  return rows.map(row => ({
    toolName: row.tool_name,
    totalCount: row.total_count,
    lastUsed: row.last_used,
  }));
}

/**
 * Record tool usage for a session
 * @param sessionId - The session ID
 * @param toolName - The name of the tool used
 * @param count - Number of times the tool was used (default: 1)
 * @example
 * trackToolUsage('session-123', 'Read', 5)
 */
export function trackToolUsage(sessionId: string, toolName: string, count: number = 1): void {
  const database = getDatabase();
  database.prepare('INSERT INTO tool_usage (session_id, tool_name, count) VALUES (?, ?, ?)').run(sessionId, toolName, count);
}

/**
 * Delete all tool usage records for a specific session
 * @param sessionId - The session ID whose tool usage records should be cleared
 */
export function clearSessionToolUsage(sessionId: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM tool_usage WHERE session_id = ?').run(sessionId);
}

// ============================================================================
// ACTIVITY LOG
// ============================================================================

/**
 * Log an activity event to the activity log
 * @param type - The type of activity (e.g., 'session_created', 'session_deleted')
 * @param sessionId - Associated session ID or null for global activities
 * @param description - Human-readable description of the activity
 * @param metadata - Optional additional data to store with the activity
 * @example
 * logActivity('session_created', 'session-123', 'Created new session', { project: 'myapp' })
 */
export function logActivity(type: string, sessionId: string | null, description: string, metadata?: unknown): void {
  const database = getDatabase();
  database.prepare('INSERT INTO activity_log (type, session_id, description, metadata) VALUES (?, ?, ?, ?)').run(
    type,
    sessionId,
    description,
    metadata ? JSON.stringify(metadata) : null
  );
}

/**
 * Retrieve recent activity log entries
 * @param limit - Maximum number of entries to return (default: 50)
 * @returns Array of activity log entries sorted by timestamp descending
 * @example
 * const activities = getRecentActivity(10)
 */
export function getRecentActivity(limit: number = 50): ActivityLogEntry[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM activity_log ORDER BY timestamp DESC, id DESC LIMIT ?').all(limit) as ActivityLogRow[];
  return rows.map(mapRowToActivity);
}

/**
 * Delete all entries from the activity log
 */
export function clearActivityLog(): void {
  const database = getDatabase();
  database.prepare('DELETE FROM activity_log').run();
}

// Export all operations from other modules
export * from './collections.js';
export * from './prompts.js';
export * from './notes.js';
export * from './notifications.js';
export * from './knowledge.js';
export * from './search.js';
