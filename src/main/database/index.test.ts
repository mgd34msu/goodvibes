// ============================================================================
// DATABASE MODULE TESTS
// ============================================================================
//
// These tests verify the database module functionality.
// Uses an in-memory SQLite database for isolation and speed.
//
// NOTE: These tests require better-sqlite3 native module to be properly
// compiled for the current Node.js version. If the native module fails to
// load, tests will be skipped gracefully.
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Check if better-sqlite3 can be loaded
let canLoadDatabase = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('better-sqlite3');
} catch {
  canLoadDatabase = false;
}

// Skip all tests if native module cannot be loaded
const describeIfDb = canLoadDatabase ? describe : describe.skip;

// We need to test the actual database module, but with a test database
// Create a temporary directory for the test database
const TEST_DIR = path.join(os.tmpdir(), 'goodvibes-test-' + Date.now());

// Since the database module uses a global instance, we need to import it
// and initialize it with our test path. We'll mock the app.getPath for logs.
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(TEST_DIR),
  },
}));

vi.mock('../services/logger.js', () => ({
  Logger: vi.fn().mockImplementation(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// Import after mocks - use dynamic import to prevent module load errors
let initDatabase: typeof import('./index.js').initDatabase;
let closeDatabase: typeof import('./index.js').closeDatabase;
let getDatabase: typeof import('./index.js').getDatabase;
let upsertSession: typeof import('./index.js').upsertSession;
let getAllSessions: typeof import('./index.js').getAllSessions;
let getSession: typeof import('./index.js').getSession;
let deleteSession: typeof import('./index.js').deleteSession;
let toggleFavorite: typeof import('./index.js').toggleFavorite;
let toggleArchive: typeof import('./index.js').toggleArchive;
let getActiveSessions: typeof import('./index.js').getActiveSessions;
let getFavoriteSessions: typeof import('./index.js').getFavoriteSessions;
let getArchivedSessions: typeof import('./index.js').getArchivedSessions;
let storeMessages: typeof import('./index.js').storeMessages;
let getSessionMessages: typeof import('./index.js').getSessionMessages;
let getSetting: typeof import('./index.js').getSetting;
let setSetting: typeof import('./index.js').setSetting;
let getAllSettings: typeof import('./index.js').getAllSettings;
let getAnalytics: typeof import('./index.js').getAnalytics;
let getAllTags: typeof import('./index.js').getAllTags;
let createTag: typeof import('./index.js').createTag;
let deleteTag: typeof import('./index.js').deleteTag;
let addTagToSession: typeof import('./index.js').addTagToSession;
let removeTagFromSession: typeof import('./index.js').removeTagFromSession;
let getSessionTags: typeof import('./index.js').getSessionTags;
let getToolUsageStats: typeof import('./index.js').getToolUsageStats;
let trackToolUsage: typeof import('./index.js').trackToolUsage;
let logActivity: typeof import('./index.js').logActivity;
let getRecentActivity: typeof import('./index.js').getRecentActivity;

// ============================================================================
// TEST SETUP
// ============================================================================

beforeAll(async () => {
  if (!canLoadDatabase) {
    console.warn('Skipping database tests: better-sqlite3 native module cannot be loaded');
    return;
  }

  // Dynamic import to prevent module load errors when native module is incompatible
  const dbModule = await import('./index.js');
  initDatabase = dbModule.initDatabase;
  closeDatabase = dbModule.closeDatabase;
  getDatabase = dbModule.getDatabase;
  upsertSession = dbModule.upsertSession;
  getAllSessions = dbModule.getAllSessions;
  getSession = dbModule.getSession;
  deleteSession = dbModule.deleteSession;
  toggleFavorite = dbModule.toggleFavorite;
  toggleArchive = dbModule.toggleArchive;
  getActiveSessions = dbModule.getActiveSessions;
  getFavoriteSessions = dbModule.getFavoriteSessions;
  getArchivedSessions = dbModule.getArchivedSessions;
  storeMessages = dbModule.storeMessages;
  getSessionMessages = dbModule.getSessionMessages;
  getSetting = dbModule.getSetting;
  setSetting = dbModule.setSetting;
  getAllSettings = dbModule.getAllSettings;
  getAnalytics = dbModule.getAnalytics;
  getAllTags = dbModule.getAllTags;
  createTag = dbModule.createTag;
  deleteTag = dbModule.deleteTag;
  addTagToSession = dbModule.addTagToSession;
  removeTagFromSession = dbModule.removeTagFromSession;
  getSessionTags = dbModule.getSessionTags;
  getToolUsageStats = dbModule.getToolUsageStats;
  trackToolUsage = dbModule.trackToolUsage;
  logActivity = dbModule.logActivity;
  getRecentActivity = dbModule.getRecentActivity;

  // Create test directory
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  // Initialize database
  await initDatabase(TEST_DIR);
});

afterAll(() => {
  if (!canLoadDatabase) return;

  closeDatabase();

  // Clean up test directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

beforeEach(() => {
  if (!canLoadDatabase) return;

  // Clean up tables before each test
  const db = getDatabase();
  db.exec('DELETE FROM session_tags');
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM tool_usage');
  db.exec('DELETE FROM activity_log');
  db.exec('DELETE FROM settings');
});

// ============================================================================
// TESTS
// ============================================================================

describeIfDb('Database Initialization', () => {
  it('should initialize database successfully', () => {
    const db = getDatabase();
    expect(db).toBeDefined();
  });

  it('should create all required tables', () => {
    const db = getDatabase();

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as { name: string }[];

    const tableNames = tables.map(t => t.name);

    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('messages');
    expect(tableNames).toContain('tags');
    expect(tableNames).toContain('session_tags');
    expect(tableNames).toContain('collections');
    expect(tableNames).toContain('smart_collections');
    expect(tableNames).toContain('settings');
    expect(tableNames).toContain('prompts');
    expect(tableNames).toContain('quick_notes');
    expect(tableNames).toContain('notifications');
    expect(tableNames).toContain('knowledge_entries');
    expect(tableNames).toContain('tool_usage');
    expect(tableNames).toContain('activity_log');
  });

  it('should enable WAL mode', () => {
    const db = getDatabase();
    const result = db.pragma('journal_mode') as { journal_mode: string }[];
    expect(result[0].journal_mode).toBe('wal');
  });

  it('should enable foreign keys', () => {
    const db = getDatabase();
    const result = db.pragma('foreign_keys') as { foreign_keys: number }[];
    expect(result[0].foreign_keys).toBe(1);
  });
});

describeIfDb('Session Operations', () => {
  describe('upsertSession', () => {
    it('should insert a new session', () => {
      upsertSession({
        id: 'session-1',
        projectName: 'Test Project',
        filePath: '/path/to/session.jsonl',
        startTime: '2024-01-15T10:00:00Z',
        endTime: '2024-01-15T11:00:00Z',
        messageCount: 10,
        tokenCount: 5000,
        cost: 0.15,
        status: 'completed',
      });

      const session = getSession('session-1');

      expect(session).not.toBeNull();
      expect(session?.projectName).toBe('Test Project');
      expect(session?.tokenCount).toBe(5000);
    });

    it('should update an existing session', () => {
      upsertSession({
        id: 'session-1',
        projectName: 'Test Project',
        tokenCount: 5000,
      });

      upsertSession({
        id: 'session-1',
        projectName: 'Updated Project',
        tokenCount: 7500,
      });

      const session = getSession('session-1');

      expect(session?.projectName).toBe('Updated Project');
      expect(session?.tokenCount).toBe(7500);
    });

    it('should store token breakdown', () => {
      upsertSession({
        id: 'session-1',
        projectName: 'Test',
        inputTokens: 1000,
        outputTokens: 500,
        cacheWriteTokens: 100,
        cacheReadTokens: 50,
      });

      const session = getSession('session-1');

      expect(session?.inputTokens).toBe(1000);
      expect(session?.outputTokens).toBe(500);
      expect(session?.cacheWriteTokens).toBe(100);
      expect(session?.cacheReadTokens).toBe(50);
    });
  });

  describe('getAllSessions', () => {
    it('should return all sessions ordered by end_time', () => {
      upsertSession({ id: 'session-1', endTime: '2024-01-15T10:00:00Z' });
      upsertSession({ id: 'session-2', endTime: '2024-01-15T12:00:00Z' });
      upsertSession({ id: 'session-3', endTime: '2024-01-15T11:00:00Z' });

      const sessions = getAllSessions();

      expect(sessions).toHaveLength(3);
      expect(sessions[0].id).toBe('session-2'); // Most recent first
      expect(sessions[1].id).toBe('session-3');
      expect(sessions[2].id).toBe('session-1');
    });

    it('should return empty array when no sessions', () => {
      const sessions = getAllSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('getSession', () => {
    it('should return session by ID', () => {
      upsertSession({ id: 'session-1', projectName: 'Test' });

      const session = getSession('session-1');

      expect(session).not.toBeNull();
      expect(session?.id).toBe('session-1');
    });

    it('should return null for non-existent session', () => {
      const session = getSession('non-existent');
      expect(session).toBeNull();
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      upsertSession({ id: 'session-1' });

      deleteSession('session-1');

      expect(getSession('session-1')).toBeNull();
    });

    it('should cascade delete messages', () => {
      upsertSession({ id: 'session-1' });
      storeMessages('session-1', [
        { role: 'user', content: 'Hello' },
      ]);

      deleteSession('session-1');

      const messages = getSessionMessages('session-1');
      expect(messages).toHaveLength(0);
    });
  });

  describe('toggleFavorite', () => {
    it('should toggle favorite status', () => {
      upsertSession({ id: 'session-1' });

      expect(getSession('session-1')?.favorite).toBe(false);

      toggleFavorite('session-1');
      expect(getSession('session-1')?.favorite).toBe(true);

      toggleFavorite('session-1');
      expect(getSession('session-1')?.favorite).toBe(false);
    });
  });

  describe('toggleArchive', () => {
    it('should toggle archive status', () => {
      upsertSession({ id: 'session-1' });

      expect(getSession('session-1')?.archived).toBe(false);

      toggleArchive('session-1');
      expect(getSession('session-1')?.archived).toBe(true);

      toggleArchive('session-1');
      expect(getSession('session-1')?.archived).toBe(false);
    });
  });

  describe('getActiveSessions', () => {
    it('should return non-archived sessions', () => {
      upsertSession({ id: 'session-1' });
      upsertSession({ id: 'session-2' });
      toggleArchive('session-2');

      const active = getActiveSessions();

      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('session-1');
    });
  });

  describe('getFavoriteSessions', () => {
    it('should return favorite non-archived sessions', () => {
      upsertSession({ id: 'session-1' });
      upsertSession({ id: 'session-2' });
      upsertSession({ id: 'session-3' });

      toggleFavorite('session-1');
      toggleFavorite('session-2');
      toggleArchive('session-2');

      const favorites = getFavoriteSessions();

      expect(favorites).toHaveLength(1);
      expect(favorites[0].id).toBe('session-1');
    });
  });

  describe('getArchivedSessions', () => {
    it('should return only archived sessions', () => {
      upsertSession({ id: 'session-1' });
      upsertSession({ id: 'session-2' });
      toggleArchive('session-1');

      const archived = getArchivedSessions();

      expect(archived).toHaveLength(1);
      expect(archived[0].id).toBe('session-1');
    });
  });
});

describeIfDb('Message Operations', () => {
  beforeEach(() => {
    upsertSession({ id: 'session-1' });
  });

  describe('storeMessages', () => {
    it('should store messages for a session', () => {
      storeMessages('session-1', [
        { role: 'user', content: 'Hello', timestamp: '2024-01-15T10:00:00Z' },
        { role: 'assistant', content: 'Hi there!', timestamp: '2024-01-15T10:00:05Z' },
      ]);

      const messages = getSessionMessages('session-1');

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('user');
      expect(messages[1].role).toBe('assistant');
    });

    it('should replace existing messages on re-store', () => {
      storeMessages('session-1', [
        { role: 'user', content: 'First' },
      ]);

      storeMessages('session-1', [
        { role: 'user', content: 'Second' },
        { role: 'assistant', content: 'Response' },
      ]);

      const messages = getSessionMessages('session-1');

      expect(messages).toHaveLength(2);
      expect(messages[0].content).toBe('Second');
    });

    it('should store message metadata', () => {
      storeMessages('session-1', [
        {
          role: 'tool',
          content: 'Tool output',
          tokenCount: 150,
          toolName: 'read_file',
          toolInput: '{"path": "/test.txt"}',
          toolResult: 'File contents',
        },
      ]);

      const messages = getSessionMessages('session-1');

      expect(messages[0].tokenCount).toBe(150);
      expect(messages[0].toolName).toBe('read_file');
    });
  });

  describe('getSessionMessages', () => {
    it('should return messages in order', () => {
      storeMessages('session-1', [
        { role: 'user', content: 'First' },
        { role: 'assistant', content: 'Second' },
        { role: 'user', content: 'Third' },
      ]);

      const messages = getSessionMessages('session-1');

      expect(messages[0].messageIndex).toBe(0);
      expect(messages[1].messageIndex).toBe(1);
      expect(messages[2].messageIndex).toBe(2);
    });

    it('should return empty array for session with no messages', () => {
      const messages = getSessionMessages('session-1');
      expect(messages).toEqual([]);
    });
  });
});

describeIfDb('Settings Operations', () => {
  describe('setSetting / getSetting', () => {
    it('should store and retrieve string setting', () => {
      setSetting('theme', 'dark');

      expect(getSetting<string>('theme')).toBe('dark');
    });

    it('should store and retrieve boolean setting', () => {
      setSetting('notifications', true);

      expect(getSetting<boolean>('notifications')).toBe(true);
    });

    it('should store and retrieve object setting', () => {
      const config = { fontSize: 14, fontFamily: 'monospace' };
      setSetting('editorConfig', config);

      expect(getSetting<typeof config>('editorConfig')).toEqual(config);
    });

    it('should return null for non-existent setting', () => {
      expect(getSetting('non-existent')).toBeNull();
    });

    it('should update existing setting', () => {
      setSetting('theme', 'dark');
      setSetting('theme', 'light');

      expect(getSetting<string>('theme')).toBe('light');
    });
  });

  describe('getAllSettings', () => {
    it('should return all settings', () => {
      setSetting('theme', 'dark');
      setSetting('fontSize', 14);
      setSetting('enabled', true);

      const settings = getAllSettings();

      expect(settings.theme).toBe('dark');
      expect(settings.fontSize).toBe(14);
      expect(settings.enabled).toBe(true);
    });

    it('should return empty object when no settings', () => {
      const settings = getAllSettings();
      expect(settings).toEqual({});
    });
  });
});

describeIfDb('Analytics', () => {
  describe('getAnalytics', () => {
    it('should return aggregate statistics', () => {
      upsertSession({ id: 'session-1', tokenCount: 1000, cost: 0.05, messageCount: 10 });
      upsertSession({ id: 'session-2', tokenCount: 2000, cost: 0.10, messageCount: 20 });

      const analytics = getAnalytics();

      expect(analytics.totalSessions).toBe(2);
      expect(analytics.totalTokens).toBe(3000);
      expect(analytics.totalCost).toBe(0.15);
      expect(analytics.totalMessages).toBe(30);
    });

    it('should calculate average tokens per session', () => {
      upsertSession({ id: 'session-1', tokenCount: 1000 });
      upsertSession({ id: 'session-2', tokenCount: 3000 });

      const analytics = getAnalytics();

      expect(analytics.avgTokensPerSession).toBe(2000);
    });

    it('should group cost by project', () => {
      upsertSession({ id: 'session-1', projectName: 'Project A', cost: 0.05 });
      upsertSession({ id: 'session-2', projectName: 'Project A', cost: 0.10 });
      upsertSession({ id: 'session-3', projectName: 'Project B', cost: 0.20 });

      const analytics = getAnalytics();

      expect(analytics.costByProject['Project A']).toBe(0.15);
      expect(analytics.costByProject['Project B']).toBe(0.20);
    });

    it('should count subagents', () => {
      upsertSession({ id: 'session-1' });
      upsertSession({ id: 'agent-abc123' });
      upsertSession({ id: 'agent-def456' });

      const analytics = getAnalytics();

      expect(analytics.totalSubagents).toBe(2);
    });

    it('should count favorites', () => {
      upsertSession({ id: 'session-1' });
      upsertSession({ id: 'session-2' });
      toggleFavorite('session-1');

      const analytics = getAnalytics();

      expect(analytics.favoriteCount).toBe(1);
    });
  });
});

describeIfDb('Tag Operations', () => {
  describe('createTag / getAllTags', () => {
    it('should create a tag', () => {
      createTag('feature', '#22c55e');

      const tags = getAllTags();

      expect(tags).toHaveLength(1);
      expect(tags[0].name).toBe('feature');
      expect(tags[0].color).toBe('#22c55e');
    });

    it('should not duplicate tags', () => {
      createTag('feature', '#22c55e');
      createTag('feature', '#ff0000');

      const tags = getAllTags();

      expect(tags).toHaveLength(1);
    });
  });

  describe('deleteTag', () => {
    it('should delete a tag', () => {
      createTag('feature', '#22c55e');
      const tags = getAllTags();

      deleteTag(tags[0].id);

      expect(getAllTags()).toHaveLength(0);
    });

    it('should remove tag from sessions when deleted', () => {
      upsertSession({ id: 'session-1' });
      createTag('feature', '#22c55e');
      const tags = getAllTags();

      addTagToSession('session-1', tags[0].id);
      deleteTag(tags[0].id);

      const sessionTags = getSessionTags('session-1');
      expect(sessionTags).toHaveLength(0);
    });
  });

  describe('addTagToSession / removeTagFromSession', () => {
    beforeEach(() => {
      upsertSession({ id: 'session-1' });
      createTag('feature', '#22c55e');
    });

    it('should add tag to session', () => {
      const tags = getAllTags();
      addTagToSession('session-1', tags[0].id);

      const sessionTags = getSessionTags('session-1');

      expect(sessionTags).toHaveLength(1);
      expect(sessionTags[0].name).toBe('feature');
    });

    it('should remove tag from session', () => {
      const tags = getAllTags();
      addTagToSession('session-1', tags[0].id);
      removeTagFromSession('session-1', tags[0].id);

      const sessionTags = getSessionTags('session-1');

      expect(sessionTags).toHaveLength(0);
    });

    it('should not duplicate tag assignments', () => {
      const tags = getAllTags();
      addTagToSession('session-1', tags[0].id);
      addTagToSession('session-1', tags[0].id);

      const sessionTags = getSessionTags('session-1');

      expect(sessionTags).toHaveLength(1);
    });
  });
});

describeIfDb('Tool Usage Operations', () => {
  describe('trackToolUsage / getToolUsageStats', () => {
    beforeEach(() => {
      upsertSession({ id: 'session-1' });
    });

    it('should track tool usage', () => {
      trackToolUsage('session-1', 'read_file', 5);
      trackToolUsage('session-1', 'write_file', 3);

      const stats = getToolUsageStats();

      expect(stats).toHaveLength(2);
    });

    it('should aggregate tool usage counts', () => {
      trackToolUsage('session-1', 'read_file', 5);
      trackToolUsage('session-1', 'read_file', 3);

      const stats = getToolUsageStats();
      const readFile = stats.find(s => s.toolName === 'read_file');

      expect(readFile?.totalCount).toBe(8);
    });

    it('should order by total count descending', () => {
      trackToolUsage('session-1', 'read_file', 5);
      trackToolUsage('session-1', 'write_file', 10);
      trackToolUsage('session-1', 'exec', 2);

      const stats = getToolUsageStats();

      expect(stats[0].toolName).toBe('write_file');
      expect(stats[1].toolName).toBe('read_file');
      expect(stats[2].toolName).toBe('exec');
    });
  });
});

describeIfDb('Activity Log Operations', () => {
  describe('logActivity / getRecentActivity', () => {
    it('should log activity', () => {
      logActivity('session_start', 'session-1', 'Started session');

      const activity = getRecentActivity(10);

      expect(activity).toHaveLength(1);
      expect(activity[0].type).toBe('session_start');
      expect(activity[0].description).toBe('Started session');
    });

    it('should store activity metadata as JSON', () => {
      logActivity('terminal_start', null, 'Started terminal', { cwd: '/test' });

      const activity = getRecentActivity(10);

      expect(activity[0].metadata).toBe('{"cwd":"/test"}');
    });

    it('should limit results', () => {
      for (let i = 0; i < 20; i++) {
        logActivity('test', null, `Activity ${i}`);
      }

      const activity = getRecentActivity(5);

      expect(activity).toHaveLength(5);
    });

    it('should order by timestamp descending', () => {
      logActivity('first', null, 'First');
      logActivity('second', null, 'Second');
      logActivity('third', null, 'Third');

      const activity = getRecentActivity(10);

      expect(activity[0].type).toBe('third');
      expect(activity[2].type).toBe('first');
    });
  });
});
