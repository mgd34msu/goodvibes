// ============================================================================
// DATABASE - Session Operations Tests
// ============================================================================
//
// Tests for session database operations covering:
// - upsertSession creates new session
// - upsertSession updates existing session
// - getAllSessions returns sessions
// - deleteSession removes session
// - Handles concurrent operations
// - Session filtering (active, favorite, archived)
//
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Session } from '../../../shared/types/index.js';
import type Database from 'better-sqlite3';

// ============================================================================
// MOCKS
// ============================================================================

// Mock in-memory session storage
const sessions = new Map<string, any>();

// Create mock database with SQLite-like API
function createMockStatement(sql: string) {
  return {
    run: vi.fn((...params: any[]) => {
      if (sql.includes('INSERT INTO sessions')) {
        const [id, projectName, filePath, startTime, endTime, messageCount, tokenCount, cost, status, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, fileMtime] = params;
        sessions.set(id, {
          id,
          project_name: projectName,
          file_path: filePath,
          start_time: startTime,
          end_time: endTime,
          message_count: messageCount,
          token_count: tokenCount,
          cost,
          status,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_write_tokens: cacheWriteTokens,
          cache_read_tokens: cacheReadTokens,
          file_mtime: fileMtime,
          favorite: 0,
          archived: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      } else if (sql.includes('favorite = NOT favorite')) {
        const [id] = params;
        const existing = sessions.get(id);
        if (existing) {
          existing.favorite = existing.favorite ? 0 : 1;
          existing.updated_at = new Date().toISOString();
        }
      } else if (sql.includes('archived = NOT archived')) {
        const [id] = params;
        const existing = sessions.get(id);
        if (existing) {
          existing.archived = existing.archived ? 0 : 1;
          existing.updated_at = new Date().toISOString();
        }
      } else if (sql.includes('UPDATE sessions')) {
        const [projectName, filePath, startTime, endTime, messageCount, tokenCount, cost, status, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, fileMtime, id] = params;
        const existing = sessions.get(id);
        if (existing) {
          sessions.set(id, {
            ...existing,
            project_name: projectName,
            file_path: filePath,
            start_time: startTime,
            end_time: endTime,
            message_count: messageCount,
            token_count: tokenCount,
            cost,
            status,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            cache_write_tokens: cacheWriteTokens,
            cache_read_tokens: cacheReadTokens,
            file_mtime: fileMtime,
            updated_at: new Date().toISOString(),
          });
        }
      } else if (sql.includes('DELETE FROM sessions')) {
        const [id] = params;
        sessions.delete(id);
      }
      return { changes: 1 };
    }),
    get: vi.fn((...params: any[]) => {
      if (sql.includes('SELECT id FROM sessions')) {
        const [id] = params;
        const session = sessions.get(id);
        return session ? { id: session.id } : undefined;
      } else if (sql.includes('SELECT * FROM sessions WHERE id')) {
        const [id] = params;
        return sessions.get(id);
      } else if (sql.includes('SELECT file_path FROM sessions')) {
        return undefined;
      }
      return undefined;
    }),
    all: vi.fn((...params: any[]) => {
      const allSessions = Array.from(sessions.values());

      if (sql.includes('WHERE archived = 0')) {
        return allSessions.filter(s => s.archived === 0 || s.archived === null);
      } else if (sql.includes('WHERE favorite = 1')) {
        return allSessions.filter(s => s.favorite === 1 && (s.archived === 0 || s.archived === null));
      } else if (sql.includes('WHERE archived = 1')) {
        return allSessions.filter(s => s.archived === 1);
      } else if (sql.includes('SELECT file_path FROM sessions')) {
        return allSessions.filter(s => s.file_path).map(s => ({ file_path: s.file_path }));
      } else if (sql.includes('LIMIT') && params.length > 0) {
        const [limit, offset] = params;
        return allSessions.slice(offset || 0, (offset || 0) + limit);
      }

      return allSessions;
    }),
  };
}

const mockDatabase = {
  prepare: vi.fn((sql: string) => createMockStatement(sql)),
} as unknown as Database.Database;

// Mock the database connection
vi.mock('../connection.js', () => ({
  getDatabase: vi.fn(() => mockDatabase),
}));

// Mock the mappers
vi.mock('../mappers.js', () => ({
  mapRowToSession: vi.fn((row: any): Session => ({
    id: row.id,
    projectName: row.project_name,
    filePath: row.file_path,
    startTime: row.start_time,
    endTime: row.end_time,
    messageCount: row.message_count,
    tokenCount: row.token_count,
    cost: row.cost,
    status: row.status,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    cacheReadTokens: row.cache_read_tokens,
    fileMtime: row.file_mtime,
    favorite: row.favorite === 1,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  })),
}));

// Import after mocks
import {
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
} from '../sessions.js';

// ============================================================================
// TESTS
// ============================================================================

describe('Session Database Operations', () => {
  beforeEach(() => {
    // Clear sessions before each test
    sessions.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ==========================================================================
  // upsertSession - CREATE
  // ==========================================================================

  describe('upsertSession - create new session', () => {
    it('creates new session with all fields', () => {
      const session: Partial<Session> & { id: string } = {
        id: 'session-1',
        projectName: 'Test Project',
        filePath: '/test/path/session.json',
        startTime: '2024-01-01T00:00:00Z',
        endTime: '2024-01-01T01:00:00Z',
        messageCount: 10,
        tokenCount: 1000,
        cost: 0.05,
        status: 'complete',
        inputTokens: 500,
        outputTokens: 400,
        cacheWriteTokens: 50,
        cacheReadTokens: 50,
        fileMtime: '2024-01-01T00:00:00Z',
      };

      upsertSession(session);

      expect(sessions.has('session-1')).toBe(true);
      const created = sessions.get('session-1');
      expect(created).toMatchObject({
        id: 'session-1',
        project_name: 'Test Project',
        file_path: '/test/path/session.json',
        message_count: 10,
        token_count: 1000,
      });
    });

    it('creates session with minimal required fields', () => {
      const session: Partial<Session> & { id: string } = {
        id: 'session-2',
      };

      upsertSession(session);

      expect(sessions.has('session-2')).toBe(true);
      const created = sessions.get('session-2');
      expect(created.id).toBe('session-2');
      expect(created.message_count).toBe(0);
      expect(created.token_count).toBe(0);
      expect(created.cost).toBe(0);
    });

    it('uses null for optional fields when not provided', () => {
      const session: Partial<Session> & { id: string } = {
        id: 'session-3',
      };

      upsertSession(session);

      const created = sessions.get('session-3');
      expect(created.project_name).toBeNull();
      expect(created.file_path).toBeNull();
      expect(created.start_time).toBeNull();
      expect(created.end_time).toBeNull();
    });
  });

  // ==========================================================================
  // upsertSession - UPDATE
  // ==========================================================================

  describe('upsertSession - update existing session', () => {
    beforeEach(() => {
      // Create initial session
      sessions.set('session-1', {
        id: 'session-1',
        project_name: 'Original Project',
        file_path: '/original/path',
        start_time: '2024-01-01T00:00:00Z',
        end_time: null,
        message_count: 5,
        token_count: 500,
        cost: 0.025,
        status: 'active',
        input_tokens: 250,
        output_tokens: 200,
        cache_write_tokens: 25,
        cache_read_tokens: 25,
        file_mtime: '2024-01-01T00:00:00Z',
        favorite: 0,
        archived: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
    });

    it('updates existing session', () => {
      const updates: Partial<Session> & { id: string } = {
        id: 'session-1',
        messageCount: 10,
        tokenCount: 1000,
        endTime: '2024-01-01T01:00:00Z',
        status: 'complete',
      };

      upsertSession(updates);

      const updated = sessions.get('session-1');
      expect(updated.message_count).toBe(10);
      expect(updated.token_count).toBe(1000);
      expect(updated.end_time).toBe('2024-01-01T01:00:00Z');
      expect(updated.status).toBe('complete');
      // Original fields should be overwritten
      expect(updated.project_name).toBeNull();
    });

    it('updates project name', () => {
      const updates: Partial<Session> & { id: string } = {
        id: 'session-1',
        projectName: 'Updated Project',
      };

      upsertSession(updates);

      const updated = sessions.get('session-1');
      expect(updated.project_name).toBe('Updated Project');
    });

    it('updates token counts', () => {
      const updates: Partial<Session> & { id: string } = {
        id: 'session-1',
        inputTokens: 600,
        outputTokens: 500,
        cacheWriteTokens: 60,
        cacheReadTokens: 40,
      };

      upsertSession(updates);

      const updated = sessions.get('session-1');
      expect(updated.input_tokens).toBe(600);
      expect(updated.output_tokens).toBe(500);
      expect(updated.cache_write_tokens).toBe(60);
      expect(updated.cache_read_tokens).toBe(40);
    });
  });

  // ==========================================================================
  // getAllSessions
  // ==========================================================================

  describe('getAllSessions', () => {
    beforeEach(() => {
      // Create multiple sessions
      sessions.set('session-1', {
        id: 'session-1',
        project_name: 'Project 1',
        file_path: '/path/1',
        end_time: '2024-01-01T00:00:00Z',
        message_count: 10,
        token_count: 1000,
        cost: 0.05,
        status: 'complete',
        input_tokens: 500,
        output_tokens: 500,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
      sessions.set('session-2', {
        id: 'session-2',
        project_name: 'Project 2',
        file_path: '/path/2',
        end_time: '2024-01-02T00:00:00Z',
        message_count: 20,
        token_count: 2000,
        cost: 0.1,
        status: 'complete',
        input_tokens: 1000,
        output_tokens: 1000,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-02T00:00:00Z',
        updated_at: '2024-01-02T00:00:00Z',
      });
      sessions.set('session-3', {
        id: 'session-3',
        project_name: 'Project 3',
        file_path: '/path/3',
        end_time: '2024-01-03T00:00:00Z',
        message_count: 30,
        token_count: 3000,
        cost: 0.15,
        status: 'complete',
        input_tokens: 1500,
        output_tokens: 1500,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-03T00:00:00Z',
        updated_at: '2024-01-03T00:00:00Z',
      });
    });

    it('returns all sessions', () => {
      const result = getAllSessions();

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({ id: 'session-1' });
      expect(result[1]).toMatchObject({ id: 'session-2' });
      expect(result[2]).toMatchObject({ id: 'session-3' });
    });

    it('returns empty array when no sessions exist', () => {
      sessions.clear();

      const result = getAllSessions();

      expect(result).toEqual([]);
    });

    it('supports limit parameter', () => {
      const result = getAllSessions({ limit: 2 });

      expect(result).toHaveLength(2);
    });

    it('supports offset parameter', () => {
      const result = getAllSessions({ limit: 2, offset: 1 });

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'session-2' });
      expect(result[1]).toMatchObject({ id: 'session-3' });
    });
  });

  // ==========================================================================
  // getSession
  // ==========================================================================

  describe('getSession', () => {
    beforeEach(() => {
      sessions.set('session-1', {
        id: 'session-1',
        project_name: 'Test Project',
        file_path: '/test/path',
        message_count: 10,
        token_count: 1000,
        cost: 0.05,
        status: 'complete',
        input_tokens: 500,
        output_tokens: 500,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
    });

    it('returns session by id', () => {
      const result = getSession('session-1');

      expect(result).not.toBeNull();
      expect(result?.id).toBe('session-1');
      expect(result?.projectName).toBe('Test Project');
    });

    it('returns null for non-existent session', () => {
      const result = getSession('non-existent');

      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // deleteSession
  // ==========================================================================

  describe('deleteSession', () => {
    beforeEach(() => {
      sessions.set('session-1', {
        id: 'session-1',
        project_name: 'Test Project',
        file_path: '/test/path',
        message_count: 10,
        token_count: 1000,
        cost: 0.05,
        status: 'complete',
        input_tokens: 500,
        output_tokens: 500,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
    });

    it('removes session successfully', () => {
      expect(sessions.has('session-1')).toBe(true);

      deleteSession('session-1');

      expect(sessions.has('session-1')).toBe(false);
    });

    it('handles deletion of non-existent session', () => {
      // Should not throw
      expect(() => deleteSession('non-existent')).not.toThrow();
    });
  });

  // ==========================================================================
  // toggleFavorite
  // ==========================================================================

  describe('toggleFavorite', () => {
    beforeEach(() => {
      sessions.set('session-1', {
        id: 'session-1',
        project_name: 'Test Project',
        file_path: '/test/path',
        message_count: 10,
        token_count: 1000,
        cost: 0.05,
        status: 'complete',
        input_tokens: 500,
        output_tokens: 500,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
    });

    it('toggles favorite from false to true', () => {
      toggleFavorite('session-1');

      const session = sessions.get('session-1');
      expect(session.favorite).toBe(1);
    });

    it('toggles favorite from true to false', () => {
      const session = sessions.get('session-1');
      session.favorite = 1;

      toggleFavorite('session-1');

      expect(session.favorite).toBe(0);
    });
  });

  // ==========================================================================
  // toggleArchive
  // ==========================================================================

  describe('toggleArchive', () => {
    beforeEach(() => {
      sessions.set('session-1', {
        id: 'session-1',
        project_name: 'Test Project',
        file_path: '/test/path',
        message_count: 10,
        token_count: 1000,
        cost: 0.05,
        status: 'complete',
        input_tokens: 500,
        output_tokens: 500,
        cache_write_tokens: 0,
        cache_read_tokens: 0,
        file_mtime: null,
        favorite: 0,
        archived: 0,
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
      });
    });

    it('toggles archived from false to true', () => {
      toggleArchive('session-1');

      const session = sessions.get('session-1');
      expect(session.archived).toBe(1);
    });

    it('toggles archived from true to false', () => {
      const session = sessions.get('session-1');
      session.archived = 1;

      toggleArchive('session-1');

      expect(session.archived).toBe(0);
    });
  });

  // ==========================================================================
  // Session Filtering
  // ==========================================================================

  describe('getActiveSessions', () => {
    beforeEach(() => {
      sessions.set('active-1', {
        id: 'active-1',
        archived: 0,
        favorite: 0,
        end_time: '2024-01-01T00:00:00Z',
      });
      sessions.set('archived-1', {
        id: 'archived-1',
        archived: 1,
        favorite: 0,
        end_time: '2024-01-02T00:00:00Z',
      });
    });

    it('returns only non-archived sessions', () => {
      const result = getActiveSessions();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'active-1' });
    });
  });

  describe('getFavoriteSessions', () => {
    beforeEach(() => {
      sessions.set('favorite-1', {
        id: 'favorite-1',
        favorite: 1,
        archived: 0,
        end_time: '2024-01-01T00:00:00Z',
      });
      sessions.set('favorite-archived', {
        id: 'favorite-archived',
        favorite: 1,
        archived: 1,
        end_time: '2024-01-02T00:00:00Z',
      });
      sessions.set('not-favorite', {
        id: 'not-favorite',
        favorite: 0,
        archived: 0,
        end_time: '2024-01-03T00:00:00Z',
      });
    });

    it('returns only favorite and non-archived sessions', () => {
      const result = getFavoriteSessions();

      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({ id: 'favorite-1' });
    });
  });

  describe('getArchivedSessions', () => {
    beforeEach(() => {
      sessions.set('archived-1', {
        id: 'archived-1',
        archived: 1,
        favorite: 0,
        end_time: '2024-01-01T00:00:00Z',
      });
      sessions.set('archived-2', {
        id: 'archived-2',
        archived: 1,
        favorite: 1,
        end_time: '2024-01-02T00:00:00Z',
      });
      sessions.set('not-archived', {
        id: 'not-archived',
        archived: 0,
        favorite: 0,
        end_time: '2024-01-03T00:00:00Z',
      });
    });

    it('returns only archived sessions', () => {
      const result = getArchivedSessions();

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({ id: 'archived-1' });
      expect(result[1]).toMatchObject({ id: 'archived-2' });
    });
  });

  // ==========================================================================
  // getKnownSessionPaths
  // ==========================================================================

  describe('getKnownSessionPaths', () => {
    beforeEach(() => {
      sessions.set('session-1', {
        id: 'session-1',
        file_path: '/path/1',
      });
      sessions.set('session-2', {
        id: 'session-2',
        file_path: '/path/2',
      });
      sessions.set('session-3', {
        id: 'session-3',
        file_path: null,
      });
    });

    it('returns set of file paths', () => {
      const result = getKnownSessionPaths();

      expect(result).toBeInstanceOf(Set);
      expect(result.size).toBe(2);
      expect(result.has('/path/1')).toBe(true);
      expect(result.has('/path/2')).toBe(true);
    });

    it('returns empty set when no sessions have file paths', () => {
      sessions.clear();
      sessions.set('session-1', {
        id: 'session-1',
        file_path: null,
      });

      const result = getKnownSessionPaths();

      expect(result.size).toBe(0);
    });
  });

  // ==========================================================================
  // Concurrent Operations
  // ==========================================================================

  describe('concurrent operations', () => {
    it('handles multiple upsert operations', () => {
      const session1: Partial<Session> & { id: string } = {
        id: 'concurrent-1',
        projectName: 'Project 1',
      };
      const session2: Partial<Session> & { id: string } = {
        id: 'concurrent-2',
        projectName: 'Project 2',
      };

      upsertSession(session1);
      upsertSession(session2);

      expect(sessions.has('concurrent-1')).toBe(true);
      expect(sessions.has('concurrent-2')).toBe(true);
    });

    it('handles rapid updates to same session', () => {
      const session: Partial<Session> & { id: string } = {
        id: 'rapid-update',
        messageCount: 1,
      };

      upsertSession(session);
      upsertSession({ id: 'rapid-update', messageCount: 2 });
      upsertSession({ id: 'rapid-update', messageCount: 3 });

      const final = sessions.get('rapid-update');
      expect(final.message_count).toBe(3);
    });

    it('handles create, read, update, delete sequence', () => {
      // Create
      upsertSession({ id: 'seq-1', projectName: 'Original' });
      expect(sessions.has('seq-1')).toBe(true);

      // Read
      const read = getSession('seq-1');
      expect(read?.projectName).toBe('Original');

      // Update
      upsertSession({ id: 'seq-1', projectName: 'Updated' });
      const updated = sessions.get('seq-1');
      expect(updated.project_name).toBe('Updated');

      // Delete
      deleteSession('seq-1');
      expect(sessions.has('seq-1')).toBe(false);
    });
  });
});
