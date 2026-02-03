// ============================================================================
// SESSION HOOKS UNIT TESTS
// ============================================================================
//
// Comprehensive tests for the session-related hooks:
// - useSessions: Fetches sessions based on filter type
// - useLiveSessions: Polls for live sessions with memoized IDs
// - useSessionFilters: Filters sessions by search term and settings
// - useAppUptime: Tracks app uptime in seconds
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useSessions, useLiveSessions, useSessionFilters, useAppUptime } from '../hooks';
import type { Session, SessionFilter } from '../types';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Creates a QueryClient configured for testing with no retries and instant GC
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
        staleTime: 0,
      },
    },
  });
}

/**
 * Creates a wrapper component with QueryClientProvider for hook testing
 */
function createWrapper() {
  const queryClient = createTestQueryClient();
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children
    );
  };
}

/**
 * Creates a mock Session object with sensible defaults
 */
function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${Math.random().toString(36).substring(7)}`,
    projectName: 'test-project',
    filePath: '/path/to/session.jsonl',
    startTime: '2024-01-15T10:00:00Z',
    endTime: '2024-01-15T11:00:00Z',
    messageCount: 10,
    tokenCount: 5000,
    cost: 0.15,
    status: 'completed',
    tags: null,
    notes: null,
    favorite: false,
    archived: false,
    collectionId: null,
    summary: 'Test session summary',
    customTitle: null,
    rating: null,
    outcome: null,
    inputTokens: 3000,
    outputTokens: 1500,
    cacheWriteTokens: 300,
    cacheReadTokens: 200,
    fileMtime: null,
    createdAt: '2024-01-15T10:00:00Z',
    updatedAt: '2024-01-15T11:00:00Z',
    ...overrides,
  };
}

// ============================================================================
// MOCK DATA
// ============================================================================

// Note: Use IDs that don't start with 'agent-' since DEFAULT_SETTINGS
// has hideAgentSessions: true and useSessionFilters filters them out
const mockActiveSessions: Session[] = [
  createMockSession({ id: 'session-active-1', projectName: 'Project A' }),
  createMockSession({ id: 'session-active-2', projectName: 'Project B' }),
  createMockSession({ id: 'session-active-3', projectName: 'Project C' }),
];

const mockFavoriteSessions: Session[] = [
  createMockSession({ id: 'favorite-1', projectName: 'Favorite Project', favorite: true }),
  createMockSession({ id: 'favorite-2', projectName: 'Another Favorite', favorite: true }),
];

const mockArchivedSessions: Session[] = [
  createMockSession({ id: 'archived-1', projectName: 'Archived Project', archived: true }),
];

const mockLiveSessions: Session[] = [
  createMockSession({ id: 'live-1', projectName: 'Live Project 1', status: 'active' }),
  createMockSession({ id: 'live-2', projectName: 'Live Project 2', status: 'active' }),
];

// ============================================================================
// TEST SETUP
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Reset all session API mocks to their defaults
  vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue([]);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ============================================================================
// useSessions HOOK TESTS
// ============================================================================

describe('useSessions', () => {
  describe('Initial State', () => {
    it('returns empty sessions array initially', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      // Initially loading
      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.sessions).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('returns loading state while fetching', async () => {
      // Create a promise that never resolves to keep loading state
      vi.mocked(window.goodvibes.getActiveSessions).mockImplementation(
        () => new Promise(() => {})
      );

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      expect(result.current.isLoading).toBe(true);
      expect(result.current.sessions).toEqual([]);
    });
  });

  describe('Filter: all', () => {
    it('calls getActiveSessions for "all" filter', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(mockActiveSessions);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(window.goodvibes.getActiveSessions).toHaveBeenCalledTimes(1);
      expect(result.current.sessions).toEqual(mockActiveSessions);
    });

    it('returns sessions from getActiveSessions', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(mockActiveSessions);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(3);
      });

      expect(result.current.sessions[0]?.id).toBe('session-active-1');
      expect(result.current.sessions[1]?.id).toBe('session-active-2');
      expect(result.current.sessions[2]?.id).toBe('session-active-3');
    });
  });

  describe('Filter: favorites', () => {
    it('calls getFavoriteSessions for "favorites" filter', async () => {
      vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue(mockFavoriteSessions);

      const { result } = renderHook(() => useSessions('favorites'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(window.goodvibes.getFavoriteSessions).toHaveBeenCalledTimes(1);
      expect(window.goodvibes.getActiveSessions).not.toHaveBeenCalled();
      expect(result.current.sessions).toEqual(mockFavoriteSessions);
    });

    it('returns only favorite sessions', async () => {
      vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue(mockFavoriteSessions);

      const { result } = renderHook(() => useSessions('favorites'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(2);
      });

      expect(result.current.sessions.every(s => s.favorite)).toBe(true);
    });
  });

  describe('Filter: archived', () => {
    it('calls getArchivedSessions for "archived" filter', async () => {
      vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue(mockArchivedSessions);

      const { result } = renderHook(() => useSessions('archived'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(window.goodvibes.getArchivedSessions).toHaveBeenCalledTimes(1);
      expect(window.goodvibes.getActiveSessions).not.toHaveBeenCalled();
      expect(window.goodvibes.getFavoriteSessions).not.toHaveBeenCalled();
      expect(result.current.sessions).toEqual(mockArchivedSessions);
    });

    it('returns only archived sessions', async () => {
      vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue(mockArchivedSessions);

      const { result } = renderHook(() => useSessions('archived'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      expect(result.current.sessions[0]?.archived).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('returns error when getActiveSessions fails', async () => {
      const testError = new Error('Network connection failed');
      vi.mocked(window.goodvibes.getActiveSessions).mockRejectedValue(testError);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeTruthy();
      expect(result.current.sessions).toEqual([]);
    });

    it('returns error when getFavoriteSessions fails', async () => {
      const testError = new Error('Database error');
      vi.mocked(window.goodvibes.getFavoriteSessions).mockRejectedValue(testError);

      const { result } = renderHook(() => useSessions('favorites'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeTruthy();
    });

    it('returns error when getArchivedSessions fails', async () => {
      const testError = new Error('Permission denied');
      vi.mocked(window.goodvibes.getArchivedSessions).mockRejectedValue(testError);

      const { result } = renderHook(() => useSessions('archived'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).toBeTruthy();
    });
  });

  describe('Filter Changes', () => {
    it('refetches when filter changes from all to favorites', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(mockActiveSessions);
      vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue(mockFavoriteSessions);

      const { result, rerender } = renderHook(
        ({ filter }: { filter: SessionFilter }) => useSessions(filter),
        {
          wrapper: createWrapper(),
          initialProps: { filter: 'all' as SessionFilter },
        }
      );

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(3);
      });

      // Change filter to favorites
      rerender({ filter: 'favorites' });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(2);
      });

      expect(window.goodvibes.getFavoriteSessions).toHaveBeenCalled();
    });

    it('refetches when filter changes from favorites to archived', async () => {
      vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue(mockFavoriteSessions);
      vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue(mockArchivedSessions);

      const { result, rerender } = renderHook(
        ({ filter }: { filter: SessionFilter }) => useSessions(filter),
        {
          wrapper: createWrapper(),
          initialProps: { filter: 'favorites' as SessionFilter },
        }
      );

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(2);
      });

      // Change filter to archived
      rerender({ filter: 'archived' });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      expect(window.goodvibes.getArchivedSessions).toHaveBeenCalled();
    });
  });

  describe('Query Key Behavior', () => {
    it('uses correct query key for each filter type', async () => {
      // This is implicitly tested by verifying the correct API is called for each filter
      // The query key includes the filter, ensuring separate cache entries

      const queryClient = createTestQueryClient();
      const wrapper = ({ children }: { children: React.ReactNode }) =>
        React.createElement(QueryClientProvider, { client: queryClient }, children);

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(mockActiveSessions);

      const { result } = renderHook(() => useSessions('all'), { wrapper });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Verify the query cache has an entry for ['sessions', 'all']
      const queryData = queryClient.getQueryData(['sessions', 'all']);
      expect(queryData).toEqual(mockActiveSessions);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty response gracefully', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.sessions).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('handles large session list', async () => {
      const largeSessions = Array.from({ length: 1000 }, (_, i) =>
        createMockSession({ id: `session-${i}`, projectName: `Project ${i}` })
      );
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(largeSessions);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1000);
      });
    });

    it('handles sessions with null values', async () => {
      const sessionsWithNulls = [
        createMockSession({
          id: 'null-session',
          projectName: null,
          summary: null,
          customTitle: null,
        }),
      ];
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(sessionsWithNulls);

      const { result } = renderHook(() => useSessions('all'), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.sessions).toHaveLength(1);
      });

      expect(result.current.sessions[0]?.projectName).toBeNull();
      expect(result.current.sessions[0]?.summary).toBeNull();
    });
  });
});

// ============================================================================
// useLiveSessions HOOK TESTS
// ============================================================================

describe('useLiveSessions', () => {
  describe('Initial State', () => {
    it('returns empty liveSessions array initially', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(window.goodvibes.getLiveSessions).toHaveBeenCalled();
      });

      expect(result.current.liveSessions).toEqual([]);
    });

    it('returns empty Set for liveSessionIds initially', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(window.goodvibes.getLiveSessions).toHaveBeenCalled();
      });

      expect(result.current.liveSessionIds.size).toBe(0);
    });
  });

  describe('Data Fetching', () => {
    it('calls getLiveSessions on mount', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(mockLiveSessions);

      renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(window.goodvibes.getLiveSessions).toHaveBeenCalledTimes(1);
      });
    });

    it('returns live sessions from API', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(mockLiveSessions);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.liveSessions).toHaveLength(2);
      });

      expect(result.current.liveSessions[0]?.id).toBe('live-1');
      expect(result.current.liveSessions[1]?.id).toBe('live-2');
    });
  });

  describe('Live Session IDs Memoization', () => {
    it('returns Set containing all live session IDs', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(mockLiveSessions);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.liveSessionIds.size).toBe(2);
      });

      expect(result.current.liveSessionIds.has('live-1')).toBe(true);
      expect(result.current.liveSessionIds.has('live-2')).toBe(true);
    });

    it('updates liveSessionIds when sessions change', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(mockLiveSessions);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.liveSessionIds.size).toBe(2);
      });

      // Simulate update with different sessions
      const newLiveSessions = [
        createMockSession({ id: 'live-3', status: 'active' }),
      ];
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(newLiveSessions);

      // Force refetch by creating new wrapper
      const newWrapper = createWrapper();
      const { result: newResult } = renderHook(() => useLiveSessions(), {
        wrapper: newWrapper,
      });

      await waitFor(() => {
        expect(newResult.current.liveSessionIds.has('live-3')).toBe(true);
      });
    });

    it('does not include non-live session IDs', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(mockLiveSessions);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.liveSessionIds.size).toBe(2);
      });

      // Verify non-live sessions are not in the set
      expect(result.current.liveSessionIds.has('active-1')).toBe(false);
      expect(result.current.liveSessionIds.has('favorite-1')).toBe(false);
    });
  });

  describe('Polling Behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('refetches at 5 second intervals', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(mockLiveSessions);

      renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      // Wait for initial fetch
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      const initialCallCount = vi.mocked(window.goodvibes.getLiveSessions).mock.calls.length;

      // Advance by 5 seconds (refetch interval)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      // Should have made another call
      expect(vi.mocked(window.goodvibes.getLiveSessions).mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  describe('Edge Cases', () => {
    it('handles empty live sessions', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue([]);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(window.goodvibes.getLiveSessions).toHaveBeenCalled();
      });

      expect(result.current.liveSessions).toEqual([]);
      expect(result.current.liveSessionIds.size).toBe(0);
    });

    it('handles API error gracefully', async () => {
      vi.mocked(window.goodvibes.getLiveSessions).mockRejectedValue(new Error('Network error'));

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(window.goodvibes.getLiveSessions).toHaveBeenCalled();
      });

      // Should default to empty arrays on error
      expect(result.current.liveSessions).toEqual([]);
    });

    it('handles sessions with special characters in IDs', async () => {
      const specialSessions = [
        createMockSession({ id: 'session-with-special_chars.123' }),
        createMockSession({ id: 'session/with/slashes' }),
      ];
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue(specialSessions);

      const { result } = renderHook(() => useLiveSessions(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => {
        expect(result.current.liveSessionIds.size).toBe(2);
      });

      expect(result.current.liveSessionIds.has('session-with-special_chars.123')).toBe(true);
      expect(result.current.liveSessionIds.has('session/with/slashes')).toBe(true);
    });
  });
});

// ============================================================================
// useSessionFilters HOOK TESTS
// ============================================================================

describe('useSessionFilters', () => {
  beforeEach(() => {
    // Reset the settings store mock before each test
    vi.clearAllMocks();
  });

  describe('Basic Filtering', () => {
    it('returns all sessions when no search term', () => {
      // Mock settings with hideAgentSessions disabled
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({
        hideAgentSessions: false,
      });

      const sessions = [...mockActiveSessions];

      const { result } = renderHook(
        () => useSessionFilters(sessions, ''),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(3);
    });

    it('returns empty array when sessions is empty', () => {
      const { result } = renderHook(
        () => useSessionFilters([], ''),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toEqual([]);
    });

    it('returns empty array when search matches nothing', () => {
      const sessions = [...mockActiveSessions];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'nonexistent-query-xyz'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toEqual([]);
    });
  });

  describe('Search by Project Name', () => {
    it('filters sessions by project name (case insensitive)', () => {
      const sessions = [
        createMockSession({ id: '1', projectName: 'My React App' }),
        createMockSession({ id: '2', projectName: 'Vue Dashboard' }),
        createMockSession({ id: '3', projectName: 'React Native Project' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'react'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(2);
      expect(result.current.filteredSessions.map(s => s.id)).toContain('1');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('3');
    });

    it('filters with partial project name match', () => {
      const sessions = [
        createMockSession({ id: '1', projectName: 'clausitron-app' }),
        createMockSession({ id: '2', projectName: 'other-project' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'claus'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('1');
    });

    it('handles null project names gracefully', () => {
      const sessions = [
        createMockSession({ id: '1', projectName: null, customTitle: 'Custom Title' }),
        createMockSession({ id: '2', projectName: 'Real Project' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'Real'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('2');
    });
  });

  describe('Search by Custom Title', () => {
    it('filters sessions by custom title', () => {
      const sessions = [
        createMockSession({ id: '1', customTitle: 'Bug Fix Session' }),
        createMockSession({ id: '2', customTitle: 'Feature Development' }),
        createMockSession({ id: '3', customTitle: 'Bug Investigation' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'bug'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(2);
      expect(result.current.filteredSessions.map(s => s.id)).toContain('1');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('3');
    });

    it('filters with partial custom title match', () => {
      const sessions = [
        createMockSession({ id: '1', customTitle: 'Implementing OAuth Flow' }),
        createMockSession({ id: '2', customTitle: 'Testing Suite' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'OAuth'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('1');
    });
  });

  describe('Search by Summary', () => {
    it('filters sessions by summary content', () => {
      const sessions = [
        createMockSession({ id: '1', summary: 'Fixed authentication bug in login flow' }),
        createMockSession({ id: '2', summary: 'Added new dashboard widgets' }),
        createMockSession({ id: '3', summary: 'Refactored authentication service' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'authentication'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(2);
      expect(result.current.filteredSessions.map(s => s.id)).toContain('1');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('3');
    });

    it('handles null summaries gracefully', () => {
      const sessions = [
        createMockSession({ id: '1', summary: null }),
        createMockSession({ id: '2', summary: 'Has a summary' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'summary'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('2');
    });
  });

  describe('Combined Search (projectName OR customTitle OR summary)', () => {
    it('matches any of the three fields', () => {
      const sessions = [
        createMockSession({
          id: '1',
          projectName: 'search-term-project',
          customTitle: null,
          summary: null,
        }),
        createMockSession({
          id: '2',
          projectName: 'unrelated',
          customTitle: 'search-term-title',
          summary: null,
        }),
        createMockSession({
          id: '3',
          projectName: 'other',
          customTitle: 'other',
          summary: 'contains search-term here',
        }),
        createMockSession({
          id: '4',
          projectName: 'no-match',
          customTitle: 'no-match',
          summary: 'no-match',
        }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'search-term'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(3);
      expect(result.current.filteredSessions.map(s => s.id)).toContain('1');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('2');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('3');
    });
  });

  describe('Agent Session Filtering', () => {
    it('filters out agent sessions when hideAgentSessions is true (default)', () => {
      // The useSessionFilters hook reads from useSettingsStore
      // DEFAULT_SETTINGS has hideAgentSessions: true

      const sessions = [
        createMockSession({ id: 'agent-session-1' }),
        createMockSession({ id: 'user-session-1' }),
        createMockSession({ id: 'agent-another-2' }),
        createMockSession({ id: 'regular-session' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, ''),
        { wrapper: createWrapper() }
      );

      // With default settings (hideAgentSessions: true), agent sessions should be filtered out
      // Only 'user-session-1' and 'regular-session' should remain
      expect(result.current.filteredSessions).toHaveLength(2);
      expect(result.current.filteredSessions.map(s => s.id)).toContain('user-session-1');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('regular-session');
      expect(result.current.filteredSessions.map(s => s.id)).not.toContain('agent-session-1');
      expect(result.current.filteredSessions.map(s => s.id)).not.toContain('agent-another-2');
    });

    it('correctly identifies agent sessions by id prefix', () => {
      const sessions = [
        createMockSession({ id: 'agent-abc123' }), // Should be filtered
        createMockSession({ id: 'user-session' }), // Should remain
        createMockSession({ id: 'my-agent-project' }), // Should remain (not prefixed with 'agent-')
        createMockSession({ id: 'agents-session' }), // Should remain (not prefixed with 'agent-')
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, ''),
        { wrapper: createWrapper() }
      );

      // Only sessions with id starting with 'agent-' are filtered
      expect(result.current.filteredSessions).toHaveLength(3);
      expect(result.current.filteredSessions.map(s => s.id)).not.toContain('agent-abc123');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('user-session');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('my-agent-project');
      expect(result.current.filteredSessions.map(s => s.id)).toContain('agents-session');
    });
  });

  describe('Search Term Edge Cases', () => {
    it('handles whitespace-only search term', () => {
      const sessions = [...mockActiveSessions];

      const { result } = renderHook(
        () => useSessionFilters(sessions, '   '),
        { wrapper: createWrapper() }
      );

      // Whitespace-only should be treated as no search (returns all)
      expect(result.current.filteredSessions).toHaveLength(3);
    });

    it('handles search term matching case-insensitively', () => {
      // Note: The hook uses search.toLowerCase().includes() for matching on
      // projectName, customTitle, and summary fields
      const sessions = [
        createMockSession({ id: 'test-1', projectName: 'Test Project', summary: null }),
        createMockSession({ id: 'other-2', projectName: 'Other Project', summary: 'Other summary' }),
      ];

      // Case-insensitive search for 'test' - should only match first session
      const { result } = renderHook(
        () => useSessionFilters(sessions, 'test'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('test-1');
    });

    it('does not match when search has leading/trailing whitespace', () => {
      // This documents the actual behavior - whitespace is NOT trimmed
      const sessions = [
        createMockSession({ id: '1', projectName: 'Test Project' }),
        createMockSession({ id: '2', projectName: 'Other' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, '  Test  '),
        { wrapper: createWrapper() }
      );

      // '  test  ' is not a substring of 'test project' (lowercase)
      // so no matches are found
      expect(result.current.filteredSessions).toHaveLength(0);
    });

    it('handles special regex characters in search term', () => {
      const sessions = [
        createMockSession({ id: '1', projectName: 'project.name' }),
        createMockSession({ id: '2', projectName: 'project-name' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'project.'),
        { wrapper: createWrapper() }
      );

      // The search uses includes(), not regex, so . is literal
      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('1');
    });

    it('handles unicode characters in search term', () => {
      const sessions = [
        createMockSession({ id: '1', projectName: 'Normal Project' }),
        createMockSession({ id: '2', projectName: 'Rocket Project' }),
        createMockSession({ id: '3', projectName: 'Other' }),
      ];

      // Search for 'Rocket' - standard unicode handling
      const { result } = renderHook(
        () => useSessionFilters(sessions, 'Rocket'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('2');
    });

    it('handles non-latin characters in search term', () => {
      const sessions = [
        createMockSession({ id: '1', projectName: 'Japanese project' }),
        createMockSession({ id: '2', projectName: 'English project' }),
      ];

      const { result } = renderHook(
        () => useSessionFilters(sessions, 'Japanese'),
        { wrapper: createWrapper() }
      );

      expect(result.current.filteredSessions).toHaveLength(1);
      expect(result.current.filteredSessions[0]?.id).toBe('1');
    });
  });

  describe('Memoization', () => {
    it('returns same reference when inputs unchanged', () => {
      const sessions = [...mockActiveSessions];

      const { result, rerender } = renderHook(
        ({ sessions, search }: { sessions: Session[]; search: string }) =>
          useSessionFilters(sessions, search),
        {
          wrapper: createWrapper(),
          initialProps: { sessions, search: '' },
        }
      );

      const firstResult = result.current.filteredSessions;

      // Rerender with same props
      rerender({ sessions, search: '' });

      const secondResult = result.current.filteredSessions;

      // Due to useMemo, same inputs should return same reference
      expect(firstResult).toBe(secondResult);
    });

    it('returns new reference when search changes', () => {
      const sessions = [...mockActiveSessions];

      const { result, rerender } = renderHook(
        ({ sessions, search }: { sessions: Session[]; search: string }) =>
          useSessionFilters(sessions, search),
        {
          wrapper: createWrapper(),
          initialProps: { sessions, search: '' },
        }
      );

      const firstResult = result.current.filteredSessions;

      // Rerender with different search
      rerender({ sessions, search: 'test' });

      const secondResult = result.current.filteredSessions;

      // Different inputs should return different reference
      expect(firstResult).not.toBe(secondResult);
    });

    it('returns new reference when sessions change', () => {
      const { result, rerender } = renderHook(
        ({ sessions, search }: { sessions: Session[]; search: string }) =>
          useSessionFilters(sessions, search),
        {
          wrapper: createWrapper(),
          initialProps: { sessions: mockActiveSessions, search: '' },
        }
      );

      const firstResult = result.current.filteredSessions;

      // Rerender with different sessions
      const newSessions = [createMockSession({ id: 'new-1' })];
      rerender({ sessions: newSessions, search: '' });

      const secondResult = result.current.filteredSessions;

      expect(firstResult).not.toBe(secondResult);
    });
  });
});

// ============================================================================
// useAppUptime HOOK TESTS
// ============================================================================

describe('useAppUptime', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initial State', () => {
    it('starts at 0 seconds', () => {
      const { result } = renderHook(() => useAppUptime());

      expect(result.current).toBe(0);
    });
  });

  describe('Timer Increment', () => {
    it('increments by 1 every second', async () => {
      const { result } = renderHook(() => useAppUptime());

      expect(result.current).toBe(0);

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current).toBe(1);

      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(result.current).toBe(2);
    });

    it('counts up to large values', async () => {
      const { result } = renderHook(() => useAppUptime());

      act(() => {
        vi.advanceTimersByTime(60000); // 60 seconds
      });

      expect(result.current).toBe(60);
    });

    it('counts continuously over long periods', async () => {
      const { result } = renderHook(() => useAppUptime());

      act(() => {
        vi.advanceTimersByTime(3600000); // 1 hour
      });

      expect(result.current).toBe(3600);
    });
  });

  describe('Cleanup', () => {
    it('cleans up interval on unmount', () => {
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      const { unmount, result } = renderHook(() => useAppUptime());

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result.current).toBe(3);

      unmount();

      // Verify clearInterval was called
      expect(clearIntervalSpy).toHaveBeenCalled();

      // Advance time after unmount
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // Value should not have increased after unmount (we can't check this directly
      // since hook is unmounted, but clearInterval being called proves cleanup)
    });

    it('does not leak intervals on rapid mount/unmount', () => {
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

      for (let i = 0; i < 10; i++) {
        const { unmount } = renderHook(() => useAppUptime());
        unmount();
      }

      // Each mount should set one interval, each unmount should clear it
      expect(setIntervalSpy).toHaveBeenCalledTimes(10);
      expect(clearIntervalSpy).toHaveBeenCalledTimes(10);
    });
  });

  describe('Edge Cases', () => {
    it('handles sub-second time advances', () => {
      const { result } = renderHook(() => useAppUptime());

      act(() => {
        vi.advanceTimersByTime(500); // 500ms
      });

      // Should still be 0 since interval hasn't fired yet
      expect(result.current).toBe(0);

      act(() => {
        vi.advanceTimersByTime(500); // Another 500ms = total 1000ms
      });

      // Now it should be 1
      expect(result.current).toBe(1);
    });

    it('increments correctly with irregular time advances', () => {
      const { result } = renderHook(() => useAppUptime());

      act(() => {
        vi.advanceTimersByTime(2500); // 2.5 seconds
      });

      // Should have incremented twice (at 1000ms and 2000ms)
      expect(result.current).toBe(2);

      act(() => {
        vi.advanceTimersByTime(1500); // 1.5 more seconds = total 4 seconds
      });

      // Should be at 4 now (incremented at 3000ms and 4000ms)
      expect(result.current).toBe(4);
    });
  });

  describe('Multiple Hook Instances', () => {
    it('each instance tracks independently', () => {
      const { result: result1 } = renderHook(() => useAppUptime());
      const { result: result2 } = renderHook(() => useAppUptime());

      expect(result1.current).toBe(0);
      expect(result2.current).toBe(0);

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      expect(result1.current).toBe(3);
      expect(result2.current).toBe(3);
    });

    it('unmounting one instance does not affect others', () => {
      const { result: result1, unmount: unmount1 } = renderHook(() => useAppUptime());
      const { result: result2 } = renderHook(() => useAppUptime());

      act(() => {
        vi.advanceTimersByTime(2000);
      });

      expect(result1.current).toBe(2);
      expect(result2.current).toBe(2);

      unmount1();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // result2 should continue incrementing
      expect(result2.current).toBe(5);
    });
  });
});
