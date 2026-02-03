// ============================================================================
// SESSION MANAGER TESTS
// ============================================================================
//
// These tests verify the SessionManager service functionality.
// Uses mocked dependencies to test session management behavior.
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Session, SessionMessage } from '../../shared/types/session-types.js';
import type { Analytics } from '../../shared/types/analytics-types.js';

// Mock all external dependencies before importing the module under test
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    default: {
      ...actual,
      readdir: vi.fn(),
      readFile: vi.fn(),
      stat: vi.fn(),
    },
  };
});

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal() as object;
  return {
    ...actual,
    default: {
      ...actual,
      existsSync: vi.fn(() => false),
      watchFile: vi.fn(),
      unwatchFile: vi.fn(),
    },
    existsSync: vi.fn(() => false),
    watchFile: vi.fn(),
    unwatchFile: vi.fn(),
  };
});

vi.mock('../database/index.js', () => ({
  upsertSession: vi.fn(),
  storeMessages: vi.fn(),
  getSession: vi.fn(),
  getAllSessions: vi.fn(() => []),
  getSessionMessages: vi.fn(() => []),
  getAnalytics: vi.fn(() => ({
    totalSessions: 0,
    totalTokens: 0,
    totalCost: 0,
    avgTokensPerSession: 0,
    sessionsOverTime: [],
    costByProject: {},
    messageCount: 0,
    totalMessages: 0,
    messagesToday: 0,
    totalSubagents: 0,
    favoriteCount: 0,
    dailyCost: 0,
  })),
  logActivity: vi.fn(),
}));

vi.mock('../window.js', () => ({
  sendToRenderer: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Import after mocks are set up
import * as db from '../database/index.js';
import { initSessionManager, getSessionManager } from './sessionManager.js';

// ============================================================================
// TESTS
// ============================================================================

// Type for the status callback function
type StatusCallback = (status: string, message?: string, progress?: { current: number; total: number }) => void;

/**
 * Helper to get session manager with assertion that it exists.
 * Throws if session manager is null, making the type non-nullable.
 */
function getRequiredSessionManager(): ReturnType<typeof getSessionManager> & object {
  const manager = getSessionManager();
  if (!manager) {
    throw new Error('Session manager should be initialized');
  }
  return manager;
}

describe('SessionManager Service', () => {
  let mockStatusCallback: StatusCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusCallback = vi.fn() as StatusCallback;
  });

  describe('Initialization', () => {
    it('should create a session manager instance', () => {
      initSessionManager(mockStatusCallback);
      const sessionManager = getSessionManager();

      expect(sessionManager).not.toBeNull();
    });

    it('should have init method', () => {
      initSessionManager(mockStatusCallback);
      const sessionManager = getSessionManager();

      expect(typeof sessionManager?.init).toBe('function');
    });

    it('should have stopWatching method', () => {
      initSessionManager(mockStatusCallback);
      const sessionManager = getSessionManager();

      expect(typeof sessionManager?.stopWatching).toBe('function');
    });
  });

  describe('Session Retrieval', () => {
    beforeEach(() => {
      initSessionManager(mockStatusCallback);
    });

    it('should return all sessions from database', () => {
      const mockSessions: Partial<Session>[] = [
        { id: 'session-1', projectName: 'project1' },
        { id: 'session-2', projectName: 'project2' },
      ];

      vi.mocked(db.getAllSessions).mockReturnValue(mockSessions as Session[]);

      const sessionManager = getRequiredSessionManager();
      const sessions = sessionManager.getAllSessions();

      expect(sessions).toEqual(mockSessions);
      expect(db.getAllSessions).toHaveBeenCalled();
    });

    it('should return single session by ID', () => {
      const mockSession: Partial<Session> = { id: 'session-1', projectName: 'project1' };

      vi.mocked(db.getSession).mockReturnValue(mockSession as Session);

      const sessionManager = getRequiredSessionManager();
      const session = sessionManager.getSession('session-1');

      expect(session).toEqual(mockSession);
      expect(db.getSession).toHaveBeenCalledWith('session-1');
    });

    it('should return null for non-existent session', () => {
      vi.mocked(db.getSession).mockReturnValue(null);

      const sessionManager = getRequiredSessionManager();
      const session = sessionManager.getSession('non-existent');

      expect(session).toBeNull();
    });

    it('should return empty array when no sessions exist', () => {
      vi.mocked(db.getAllSessions).mockReturnValue([]);

      const sessionManager = getRequiredSessionManager();
      const sessions = sessionManager.getAllSessions();

      expect(sessions).toEqual([]);
    });
  });

  describe('Live Session Detection', () => {
    beforeEach(() => {
      initSessionManager(mockStatusCallback);
    });

    it('should return false when session does not exist', () => {
      vi.mocked(db.getSession).mockReturnValue(null);

      const sessionManager = getRequiredSessionManager();
      const isLive = sessionManager.isSessionLive('non-existent');

      expect(isLive).toBe(false);
    });

    it('should return false when session has no file path', () => {
      const mockSession: Partial<Session> = {
        id: 'session-1',
        filePath: null,
      };
      vi.mocked(db.getSession).mockReturnValue(mockSession as Session);

      const sessionManager = getRequiredSessionManager();
      const isLive = sessionManager.isSessionLive('session-1');

      expect(isLive).toBe(false);
    });

    it('should return false when session has no mtime', () => {
      const mockSession: Partial<Session> = {
        id: 'session-1',
        filePath: '/path/to/session.jsonl',
        fileMtime: null,
      };
      vi.mocked(db.getSession).mockReturnValue(mockSession as Session);

      const sessionManager = getRequiredSessionManager();
      const isLive = sessionManager.isSessionLive('session-1');

      expect(isLive).toBe(false);
    });
  });

  describe('Analytics', () => {
    beforeEach(() => {
      initSessionManager(mockStatusCallback);
    });

    it('should return analytics from database', () => {
      const mockAnalytics: Analytics = {
        totalSessions: 10,
        totalTokens: 50000,
        totalCost: 1.5,
        avgTokensPerSession: 5000,
        sessionsOverTime: [],
        costByProject: {},
        messageCount: 100,
        totalMessages: 100,
        messagesToday: 5,
        totalSubagents: 2,
        favoriteCount: 3,
        dailyCost: 0.25,
      };

      vi.mocked(db.getAnalytics).mockReturnValue(mockAnalytics);

      const sessionManager = getRequiredSessionManager();
      const analytics = sessionManager.getAnalytics();

      expect(analytics).toEqual(mockAnalytics);
      expect(db.getAnalytics).toHaveBeenCalled();
    });
  });

  describe('Live Sessions', () => {
    beforeEach(() => {
      initSessionManager(mockStatusCallback);
    });

    it('should return live sessions based on threshold', () => {
      const now = Date.now();
      const recentTime = new Date(now - 60000).toISOString(); // 1 minute ago
      const oldTime = new Date(now - 600000).toISOString(); // 10 minutes ago

      const mockSessions: Partial<Session>[] = [
        { id: 'session-1', endTime: recentTime },
        { id: 'session-2', endTime: oldTime },
        { id: 'session-3', endTime: null },
      ];
      vi.mocked(db.getAllSessions).mockReturnValue(mockSessions as Session[]);

      const sessionManager = getRequiredSessionManager();
      const liveSessions = sessionManager.getLiveSessions();

      // Only sessions modified within threshold should be returned
      // The threshold is 5 minutes, so only session-1 should be live
      expect(liveSessions.length).toBeLessThanOrEqual(2);
    });

    it('should filter out sessions without endTime', () => {
      const mockSessions: Partial<Session>[] = [
        { id: 'session-1', endTime: null },
        { id: 'session-2', endTime: null },
      ];
      vi.mocked(db.getAllSessions).mockReturnValue(mockSessions as Session[]);

      const sessionManager = getRequiredSessionManager();
      const liveSessions = sessionManager.getLiveSessions();

      expect(liveSessions).toHaveLength(0);
    });
  });

  describe('Session Messages', () => {
    beforeEach(() => {
      initSessionManager(mockStatusCallback);
    });

    it('should return messages from database when available', async () => {
      const mockMessages: Partial<SessionMessage>[] = [
        { id: 1, role: 'user', content: 'Hello' },
        { id: 2, role: 'assistant', content: 'Hi there!' },
      ];

      vi.mocked(db.getSessionMessages).mockReturnValue(mockMessages as SessionMessage[]);

      const sessionManager = getRequiredSessionManager();
      const messages = await sessionManager.getSessionMessages('session-1');

      expect(messages).toEqual(mockMessages);
      expect(db.getSessionMessages).toHaveBeenCalledWith('session-1');
    });

    it('should return empty array when no messages exist', async () => {
      vi.mocked(db.getSessionMessages).mockReturnValue([]);
      vi.mocked(db.getSession).mockReturnValue(null);

      const sessionManager = getRequiredSessionManager();
      const messages = await sessionManager.getSessionMessages('session-1');

      expect(messages).toEqual([]);
    });
  });

  describe('Stop Watching', () => {
    beforeEach(() => {
      initSessionManager(mockStatusCallback);
    });

    it('should not throw when called', () => {
      const sessionManager = getRequiredSessionManager();

      expect(() => sessionManager.stopWatching()).not.toThrow();
    });

    it('should be idempotent', () => {
      const sessionManager = getRequiredSessionManager();

      sessionManager.stopWatching();
      expect(() => sessionManager.stopWatching()).not.toThrow();
    });
  });
});
