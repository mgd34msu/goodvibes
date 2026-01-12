// ============================================================================
// DATABASE MODULE - Better-SQLite3 Implementation
// ============================================================================

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { Logger } from '../services/logger.js';
import { getTodayString } from '../../shared/dateUtils.js';
import type {
  Session,
  SessionMessage,
  Tag,
  Analytics,
  ToolUsageStat,
  ActivityLogEntry,
} from '../../shared/types/index.js';
import {
  mapRowToSession,
  mapRowToMessage,
  mapRowToTag,
  mapRowToActivity,
  type SessionRow,
  type MessageRow,
  type TagRow,
  type ActivityLogRow,
} from './mappers.js';
import { createPrimitiveTables } from './primitives.js';
import { createAgencyIndexTables } from './agencyIndex.js';
import {
  getDatabase,
  setDatabaseInstance,
  clearDatabaseInstance,
} from './connection.js';

// Re-export getDatabase from connection.ts for backward compatibility
export { getDatabase } from './connection.js';

const logger = new Logger('Database');

let db: Database.Database | null = null;

// ============================================================================
// INITIALIZATION
// ============================================================================

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

  logger.info(`Database initialized at ${dbPath}`);
}

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
    'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_name)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_favorite ON sessions(favorite)',
    'CREATE INDEX IF NOT EXISTS idx_sessions_archived ON sessions(archived)',
    'CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id)',
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
      // SQLite returns an error even with IF NOT EXISTS in some edge cases (e.g., concurrent access)
      // Log non-trivial errors but don't fail the application
      const error = e as Error;
      const message = error?.message || String(e);
      // Only log if it's not an "already exists" error (which shouldn't happen with IF NOT EXISTS, but just in case)
      if (!message.includes('already exists')) {
        logger.warn(`Failed to create index: ${message}`, { index });
      }
    }
  }
}

// ============================================================================
// SESSION OPERATIONS
// ============================================================================

export function upsertSession(session: Partial<Session> & { id: string }): void {
  const database = getDatabase();

  const existing = database.prepare('SELECT id FROM sessions WHERE id = ?').get(session.id);

  if (existing) {
    database.prepare(`
      UPDATE sessions SET
        project_name = ?,
        file_path = ?,
        start_time = ?,
        end_time = ?,
        message_count = ?,
        token_count = ?,
        cost = ?,
        status = ?,
        input_tokens = ?,
        output_tokens = ?,
        cache_write_tokens = ?,
        cache_read_tokens = ?,
        file_mtime = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      session.projectName ?? null,
      session.filePath ?? null,
      session.startTime ?? null,
      session.endTime ?? null,
      session.messageCount ?? 0,
      session.tokenCount ?? 0,
      session.cost ?? 0,
      session.status ?? 'unknown',
      session.inputTokens ?? 0,
      session.outputTokens ?? 0,
      session.cacheWriteTokens ?? 0,
      session.cacheReadTokens ?? 0,
      session.fileMtime ?? null,
      session.id
    );
  } else {
    database.prepare(`
      INSERT INTO sessions (
        id, project_name, file_path, start_time, end_time,
        message_count, token_count, cost, status,
        input_tokens, output_tokens, cache_write_tokens, cache_read_tokens,
        file_mtime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      session.projectName ?? null,
      session.filePath ?? null,
      session.startTime ?? null,
      session.endTime ?? null,
      session.messageCount ?? 0,
      session.tokenCount ?? 0,
      session.cost ?? 0,
      session.status ?? 'unknown',
      session.inputTokens ?? 0,
      session.outputTokens ?? 0,
      session.cacheWriteTokens ?? 0,
      session.cacheReadTokens ?? 0,
      session.fileMtime ?? null
    );
  }
}

export function getAllSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}

export function getSession(sessionId: string): Session | null {
  const database = getDatabase();
  const row = database.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as SessionRow | undefined;
  return row ? mapRowToSession(row) : null;
}

export function deleteSession(sessionId: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function toggleFavorite(sessionId: string): void {
  const database = getDatabase();
  database.prepare("UPDATE sessions SET favorite = NOT favorite, updated_at = datetime('now') WHERE id = ?").run(sessionId);
}

export function toggleArchive(sessionId: string): void {
  const database = getDatabase();
  database.prepare("UPDATE sessions SET archived = NOT archived, updated_at = datetime('now') WHERE id = ?").run(sessionId);
}

export function getActiveSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE archived = 0 OR archived IS NULL ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}

export function getFavoriteSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE favorite = 1 AND (archived = 0 OR archived IS NULL) ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}

export function getArchivedSessions(): Session[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM sessions WHERE archived = 1 ORDER BY end_time DESC').all() as SessionRow[];
  return rows.map(mapRowToSession);
}

// mapRowToSession is now imported from './mappers.js'

// ============================================================================
// MESSAGE OPERATIONS
// ============================================================================

export function storeMessages(sessionId: string, messages: Partial<SessionMessage>[]): void {
  const database = getDatabase();

  // Delete existing messages
  database.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

  // Insert new messages
  const insert = database.prepare(`
    INSERT INTO messages (session_id, message_index, role, content, timestamp, token_count, tool_name, tool_input, tool_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction((msgs: Partial<SessionMessage>[]) => {
    msgs.forEach((msg, index) => {
      insert.run(
        sessionId,
        index,
        msg.role ?? 'unknown',
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        msg.timestamp ?? null,
        msg.tokenCount ?? 0,
        msg.toolName ?? null,
        msg.toolInput ?? null,
        msg.toolResult ?? null
      );
    });
  });

  insertMany(messages);
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY message_index ASC').all(sessionId) as MessageRow[];
  return rows.map(mapRowToMessage);
}

// mapRowToMessage is now imported from './mappers.js'

// ============================================================================
// SETTINGS OPERATIONS
// ============================================================================

export function getSetting<T>(key: string): T | null {
  const database = getDatabase();
  const row = database.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return null;
  }
}

export function setSetting(key: string, value: unknown): void {
  const database = getDatabase();
  database.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, JSON.stringify(value));
}

export function getAllSettings(): Record<string, unknown> {
  const database = getDatabase();
  const rows = database.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, unknown> = {};

  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }

  return settings;
}

// ============================================================================
// ANALYTICS
// ============================================================================

export function getAnalytics(): Analytics {
  const database = getDatabase();

  const sessions = database.prepare('SELECT * FROM sessions').all() as SessionRow[];
  const totalSessions = sessions.length;

  let totalTokens = 0;
  let totalCost = 0;
  let totalMessages = 0;

  sessions.forEach(s => {
    totalTokens += s.token_count ?? 0;
    totalCost += s.cost ?? 0;
    totalMessages += s.message_count ?? 0;
  });

  const avgTokensPerSession = totalSessions > 0 ? Math.round(totalTokens / totalSessions) : 0;

  // Cost by project
  const projectGroups = database.prepare(`
    SELECT project_name, SUM(cost) as project_cost
    FROM sessions
    GROUP BY project_name
  `).all() as { project_name: string; project_cost: number }[];

  const costByProject: Record<string, number> = {};
  projectGroups.forEach(p => {
    costByProject[p.project_name ?? 'Unknown'] = p.project_cost ?? 0;
  });

  // Sessions over time - get aggregated data from database
  // Query sessions for last 12 weeks (84 days) to support heatmap
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

  // Create a map from date string to data for quick lookup
  const dateDataMap = new Map<string, { count: number; tokens: number; cost: number }>();
  for (const row of sessionsFromDb) {
    dateDataMap.set(row.date, { count: row.count, tokens: row.tokens, cost: row.cost });
  }

  // Generate full 84 days array (12 weeks for heatmap), filling in zeros for missing days
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

  // Daily cost
  const today = getTodayString();
  const todaySessions = sessions.filter(s => s.start_time?.startsWith(today));
  const dailyCost = todaySessions.reduce((sum, s) => sum + (s.cost ?? 0), 0);

  // Messages today - only count messages from sessions that started today
  const messagesToday = todaySessions.reduce((sum, s) => sum + (s.message_count ?? 0), 0);

  // Subagent count
  const totalSubagents = sessions.filter(s => s.id?.startsWith('agent-')).length;

  // Favorite count
  const favoriteCount = sessions.filter(s => s.favorite).length;

  return {
    totalSessions,
    totalTokens,
    totalCost,
    dailyCost,
    avgTokensPerSession,
    costByProject,
    sessionsOverTime,
    messageCount: totalMessages,
    totalMessages,
    messagesToday,
    totalSubagents,
    favoriteCount,
  };
}

// ============================================================================
// TAG OPERATIONS
// ============================================================================

export function getAllTags(): Tag[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM tags ORDER BY name').all() as TagRow[];
  return rows.map(mapRowToTag);
}

export function createTag(name: string, color: string): void {
  const database = getDatabase();
  try {
    database.prepare('INSERT OR IGNORE INTO tags (name, color) VALUES (?, ?)').run(name, color);
  } catch {
    // Tag may already exist
  }
}

export function deleteTag(tagId: number): void {
  const database = getDatabase();
  database.prepare('DELETE FROM session_tags WHERE tag_id = ?').run(tagId);
  database.prepare('DELETE FROM tags WHERE id = ?').run(tagId);
}

export function addTagToSession(sessionId: string, tagId: number): void {
  const database = getDatabase();
  try {
    database.prepare('INSERT OR IGNORE INTO session_tags (session_id, tag_id) VALUES (?, ?)').run(sessionId, tagId);
  } catch {
    // Already exists
  }
}

export function removeTagFromSession(sessionId: string, tagId: number): void {
  const database = getDatabase();
  database.prepare('DELETE FROM session_tags WHERE session_id = ? AND tag_id = ?').run(sessionId, tagId);
}

export function getSessionTags(sessionId: string): Tag[] {
  const database = getDatabase();
  const rows = database.prepare(`
    SELECT t.* FROM tags t
    JOIN session_tags st ON t.id = st.tag_id
    WHERE st.session_id = ?
  `).all(sessionId) as TagRow[];
  return rows.map(mapRowToTag);
}

// mapRowToTag is now imported from './mappers.js'

// ============================================================================
// TOOL USAGE OPERATIONS
// ============================================================================

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

export function trackToolUsage(sessionId: string, toolName: string, count: number = 1): void {
  const database = getDatabase();
  database.prepare('INSERT INTO tool_usage (session_id, tool_name, count) VALUES (?, ?, ?)').run(sessionId, toolName, count);
}

export function clearSessionToolUsage(sessionId: string): void {
  const database = getDatabase();
  database.prepare('DELETE FROM tool_usage WHERE session_id = ?').run(sessionId);
}

// ============================================================================
// ACTIVITY LOG
// ============================================================================

export function logActivity(type: string, sessionId: string | null, description: string, metadata?: unknown): void {
  const database = getDatabase();
  database.prepare('INSERT INTO activity_log (type, session_id, description, metadata) VALUES (?, ?, ?, ?)').run(
    type,
    sessionId,
    description,
    metadata ? JSON.stringify(metadata) : null
  );
}

export function getRecentActivity(limit: number = 50): ActivityLogEntry[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM activity_log ORDER BY timestamp DESC, id DESC LIMIT ?').all(limit) as ActivityLogRow[];
  return rows.map(mapRowToActivity);
}

export function clearActivityLog(): void {
  const database = getDatabase();
  database.prepare('DELETE FROM activity_log').run();
}

// mapRowToActivity is now imported from './mappers.js'

// Export all operations
export * from './collections.js';
export * from './prompts.js';
export * from './notes.js';
export * from './notifications.js';
export * from './knowledge.js';
export * from './search.js';
