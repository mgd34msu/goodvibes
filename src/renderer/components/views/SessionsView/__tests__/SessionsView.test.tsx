// ============================================================================
// SESSIONS VIEW COMPONENT TESTS
// ============================================================================
//
// Comprehensive tests for the SessionsView component and its subcomponents.
// Tests cover rendering, state management, user interactions, and edge cases.
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Session } from '../types';

// Import components under test
import SessionsView from '../index';
import { SessionFilters } from '../SessionFilters';
import { SessionCard } from '../SessionCard';
import { LoadingSkeleton, EmptyState, ErrorState } from '../SessionStates';

// ============================================================================
// TEST UTILITIES
// ============================================================================

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

/**
 * Creates a QueryClient configured for testing
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
 * Wrapper component providing necessary providers for testing
 */
function TestWrapper({ children }: { children: React.ReactNode }) {
  const queryClient = createTestQueryClient();
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

/**
 * Renders a component within the test wrapper
 */
function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        {ui}
      </QueryClientProvider>
    ),
    queryClient,
  };
}

// ============================================================================
// TEST SETUP
// ============================================================================

// Store original mock implementations
let originalGetActiveSessions: ReturnType<typeof vi.fn>;
let originalGetFavoriteSessions: ReturnType<typeof vi.fn>;
let originalGetArchivedSessions: ReturnType<typeof vi.fn>;
let originalGetLiveSessions: ReturnType<typeof vi.fn>;
let originalToggleFavorite: ReturnType<typeof vi.fn>;
let originalToggleArchive: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  // Save original implementations
  originalGetActiveSessions = window.goodvibes.getActiveSessions;
  originalGetFavoriteSessions = window.goodvibes.getFavoriteSessions;
  originalGetArchivedSessions = window.goodvibes.getArchivedSessions;
  originalGetLiveSessions = window.goodvibes.getLiveSessions;
  originalToggleFavorite = window.goodvibes.toggleFavorite;
  originalToggleArchive = window.goodvibes.toggleArchive;

  // Reset to default mock implementations
  vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue([]);
  vi.mocked(window.goodvibes.toggleFavorite).mockResolvedValue(true);
  vi.mocked(window.goodvibes.toggleArchive).mockResolvedValue(true);
});

afterEach(() => {
  // Restore original implementations
  window.goodvibes.getActiveSessions = originalGetActiveSessions;
  window.goodvibes.getFavoriteSessions = originalGetFavoriteSessions;
  window.goodvibes.getArchivedSessions = originalGetArchivedSessions;
  window.goodvibes.getLiveSessions = originalGetLiveSessions;
  window.goodvibes.toggleFavorite = originalToggleFavorite;
  window.goodvibes.toggleArchive = originalToggleArchive;
});

// ============================================================================
// SESSION FILTERS COMPONENT TESTS
// ============================================================================

describe('SessionFilters', () => {
  const defaultFilterProps = {
    filter: 'all' as const,
    onFilterChange: vi.fn(),
    search: '',
    onSearchChange: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders the session history header', () => {
      render(<SessionFilters {...defaultFilterProps} />);

      expect(screen.getByText('Session History')).toBeInTheDocument();
    });

    it('renders all filter options', () => {
      render(<SessionFilters {...defaultFilterProps} />);

      expect(screen.getByRole('button', { name: /all/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /favorites/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /archived/i })).toBeInTheDocument();
    });

    it('renders the search input with placeholder', () => {
      render(<SessionFilters {...defaultFilterProps} />);

      const searchInput = screen.getByPlaceholderText('Search sessions...');
      expect(searchInput).toBeInTheDocument();
    });

    it('displays the current search value', () => {
      render(<SessionFilters {...defaultFilterProps} search="test query" />);

      const searchInput = screen.getByPlaceholderText('Search sessions...');
      expect(searchInput).toHaveValue('test query');
    });
  });

  describe('Filter Tab Interactions', () => {
    it('calls onFilterChange when "All" filter is clicked', async () => {
      const onFilterChange = vi.fn();
      render(<SessionFilters {...defaultFilterProps} filter="favorites" onFilterChange={onFilterChange} />);

      const allButton = screen.getByRole('button', { name: /all/i });
      await userEvent.click(allButton);

      expect(onFilterChange).toHaveBeenCalledWith('all');
    });

    it('calls onFilterChange when "Favorites" filter is clicked', async () => {
      const onFilterChange = vi.fn();
      render(<SessionFilters {...defaultFilterProps} onFilterChange={onFilterChange} />);

      const favoritesButton = screen.getByRole('button', { name: /favorites/i });
      await userEvent.click(favoritesButton);

      expect(onFilterChange).toHaveBeenCalledWith('favorites');
    });

    it('calls onFilterChange when "Archived" filter is clicked', async () => {
      const onFilterChange = vi.fn();
      render(<SessionFilters {...defaultFilterProps} onFilterChange={onFilterChange} />);

      const archivedButton = screen.getByRole('button', { name: /archived/i });
      await userEvent.click(archivedButton);

      expect(onFilterChange).toHaveBeenCalledWith('archived');
    });

    it('highlights the active filter tab', () => {
      render(<SessionFilters {...defaultFilterProps} filter="favorites" />);

      const favoritesButton = screen.getByRole('button', { name: /favorites/i });
      // The active tab should have specific styling classes
      expect(favoritesButton).toHaveClass('bg-primary-500/20');
    });
  });

  describe('Search Interactions', () => {
    it('calls onSearchChange when typing in the search input', async () => {
      const onSearchChange = vi.fn();
      render(<SessionFilters {...defaultFilterProps} onSearchChange={onSearchChange} />);

      const searchInput = screen.getByPlaceholderText('Search sessions...');
      await userEvent.type(searchInput, 'test');

      // Each character triggers an onChange event with event.target.value
      // Since the input is uncontrolled in this test (value prop updates based on state),
      // each event returns just the individual character typed
      expect(onSearchChange).toHaveBeenCalledTimes(4);
      // Just verify the handler was called for each character
      expect(onSearchChange).toHaveBeenCalled();
    });

    it('calls onSearchChange with updated value when search is cleared', async () => {
      const onSearchChange = vi.fn();
      render(<SessionFilters {...defaultFilterProps} search="existing" onSearchChange={onSearchChange} />);

      const searchInput = screen.getByPlaceholderText('Search sessions...');
      await userEvent.clear(searchInput);

      expect(onSearchChange).toHaveBeenCalledWith('');
    });
  });
});

// ============================================================================
// SESSION CARD COMPONENT TESTS
// ============================================================================

describe('SessionCard', () => {
  const defaultCardProps = {
    session: createMockSession(),
    projectsRoot: '/home/user/projects',
    isLive: false,
    onClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('renders the session title', () => {
      const session = createMockSession({ customTitle: 'My Custom Session' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('My Custom Session')).toBeInTheDocument();
    });

    it('renders the decoded project name when no custom title', () => {
      const session = createMockSession({ customTitle: null, projectName: 'test-project' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      // The decoded project name should be displayed
      expect(screen.getByText('test-project')).toBeInTheDocument();
    });

    it('displays the session summary', () => {
      const session = createMockSession({ summary: 'This is a test summary' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('This is a test summary')).toBeInTheDocument();
    });

    it('displays message count', () => {
      const session = createMockSession({ messageCount: 42 });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('42')).toBeInTheDocument();
    });

    it('displays formatted token count', () => {
      const session = createMockSession({ tokenCount: 5000 });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('5,000')).toBeInTheDocument();
    });

    it('displays formatted cost', () => {
      const session = createMockSession({ cost: 1.50 });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('$1.50')).toBeInTheDocument();
    });

    it('shows live indicator when session is live', () => {
      renderWithProviders(<SessionCard {...defaultCardProps} isLive={true} />);

      const liveIndicator = screen.getByTitle('Session is live');
      expect(liveIndicator).toBeInTheDocument();
    });

    it('does not show live indicator when session is not live', () => {
      renderWithProviders(<SessionCard {...defaultCardProps} isLive={false} />);

      expect(screen.queryByTitle('Session is live')).not.toBeInTheDocument();
    });

    it('shows favorite star when session is favorited', () => {
      const session = createMockSession({ favorite: true });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      // The star icon should have the fill class
      const starIcons = document.querySelectorAll('.fill-warning-400');
      expect(starIcons.length).toBeGreaterThan(0);
    });

    it('shows agent badge for agent sessions', () => {
      const session = createMockSession({ id: 'agent-abc123' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('agent')).toBeInTheDocument();
    });

    it('shows outcome badge when outcome is set', () => {
      const session = createMockSession({ outcome: 'success' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByText('success')).toBeInTheDocument();
    });

    it('shows rating badge when rating is set', () => {
      const session = createMockSession({ rating: 3 });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      // Rating is displayed as stars
      expect(screen.getByText('***')).toBeInTheDocument();
    });
  });

  describe('User Interactions', () => {
    it('calls onClick when the card is clicked', async () => {
      const onClick = vi.fn();
      renderWithProviders(<SessionCard {...defaultCardProps} onClick={onClick} />);

      const card = screen.getByText(defaultCardProps.session.projectName!).closest('.card-hover');
      expect(card).toBeInTheDocument();
      if (card) {
        await userEvent.click(card);
      }

      expect(onClick).toHaveBeenCalledTimes(1);
    });

    it('calls toggleFavorite when favorite button is clicked', async () => {
      const session = createMockSession({ id: 'session-123' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      const favoriteButton = screen.getByTitle(/add to favorites|remove from favorites/i);
      await userEvent.click(favoriteButton);

      expect(window.goodvibes.toggleFavorite).toHaveBeenCalledWith('session-123');
    });

    it('calls toggleArchive when archive button is clicked', async () => {
      const session = createMockSession({ id: 'session-123' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      const archiveButton = screen.getByTitle(/archive|unarchive/i);
      await userEvent.click(archiveButton);

      expect(window.goodvibes.toggleArchive).toHaveBeenCalledWith('session-123');
    });

    it('stops event propagation when action buttons are clicked', async () => {
      const onClick = vi.fn();
      const session = createMockSession({ id: 'session-123' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} onClick={onClick} />);

      const favoriteButton = screen.getByTitle(/add to favorites|remove from favorites/i);
      await userEvent.click(favoriteButton);

      // Card onClick should NOT be called when action button is clicked
      expect(onClick).not.toHaveBeenCalled();
    });
  });

  describe('Action Buttons', () => {
    it('renders preview button', () => {
      renderWithProviders(<SessionCard {...defaultCardProps} />);

      expect(screen.getByTitle('Open Preview')).toBeInTheDocument();
    });

    it('renders CLI button', () => {
      renderWithProviders(<SessionCard {...defaultCardProps} />);

      expect(screen.getByTitle('Open in CLI')).toBeInTheDocument();
    });

    it('renders favorite button with correct title based on state', () => {
      const session = createMockSession({ favorite: false });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByTitle('Add to favorites')).toBeInTheDocument();
    });

    it('renders archive button with correct title based on state', () => {
      const session = createMockSession({ archived: false });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByTitle('Archive')).toBeInTheDocument();
    });

    it('shows "Unarchive" title when session is archived', () => {
      const session = createMockSession({ archived: true });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByTitle('Unarchive')).toBeInTheDocument();
    });

    it('shows "Remove from favorites" title when session is favorited', () => {
      const session = createMockSession({ favorite: true });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      expect(screen.getByTitle('Remove from favorites')).toBeInTheDocument();
    });
  });

  describe('Outcome Badge Styling', () => {
    it('applies success styling for success outcome', () => {
      const session = createMockSession({ outcome: 'success' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      const badge = screen.getByText('success');
      expect(badge).toHaveClass('card-badge-success');
    });

    it('applies warning styling for partial outcome', () => {
      const session = createMockSession({ outcome: 'partial' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      const badge = screen.getByText('partial');
      expect(badge).toHaveClass('card-badge-warning');
    });

    it('applies error styling for failed outcome', () => {
      const session = createMockSession({ outcome: 'failed' });
      renderWithProviders(<SessionCard {...defaultCardProps} session={session} />);

      const badge = screen.getByText('failed');
      expect(badge).toHaveClass('card-badge-error');
    });
  });
});

// ============================================================================
// SESSION STATES COMPONENT TESTS
// ============================================================================

describe('SessionStates', () => {
  describe('LoadingSkeleton', () => {
    it('renders multiple skeleton cards', () => {
      render(<LoadingSkeleton />);

      // Should render 8 skeleton cards
      const skeletonContainer = document.querySelector('.flex-1.overflow-auto');
      expect(skeletonContainer).toBeInTheDocument();
      expect(skeletonContainer?.children.length).toBe(8);
    });
  });

  describe('EmptyState', () => {
    it('renders empty state for no sessions', () => {
      render(<EmptyState filter="all" search="" />);

      expect(screen.getByText('No sessions')).toBeInTheDocument();
      expect(screen.getByText('Start a new Claude session to see it here')).toBeInTheDocument();
    });

    it('renders empty state for no favorites', () => {
      render(<EmptyState filter="favorites" search="" />);

      expect(screen.getByText('No favorites sessions')).toBeInTheDocument();
      expect(screen.getByText('Star sessions to add them to favorites')).toBeInTheDocument();
    });

    it('renders empty state for no archived sessions', () => {
      render(<EmptyState filter="archived" search="" />);

      expect(screen.getByText('No archived sessions')).toBeInTheDocument();
      expect(screen.getByText('Archived sessions will appear here')).toBeInTheDocument();
    });

    it('renders empty state for search with no results', () => {
      render(<EmptyState filter="all" search="nonexistent" />);

      expect(screen.getByText('No matching sessions')).toBeInTheDocument();
      expect(screen.getByText('Try a different search term')).toBeInTheDocument();
    });
  });

  describe('ErrorState', () => {
    it('renders error state with error message', () => {
      const error = new Error('Database connection failed');
      render(<ErrorState error={error} />);

      expect(screen.getByText('Failed to load sessions')).toBeInTheDocument();
      expect(screen.getByText('Database connection failed')).toBeInTheDocument();
    });

    it('renders error state with generic message for non-Error objects', () => {
      render(<ErrorState error="Something went wrong" />);

      expect(screen.getByText('Failed to load sessions')).toBeInTheDocument();
      expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
    });

    it('renders retry button', () => {
      render(<ErrorState error={new Error('Test error')} />);

      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });
  });
});

// ============================================================================
// SESSIONS VIEW INTEGRATION TESTS
// ============================================================================

describe('SessionsView Integration', () => {
  // Note: The SessionsView uses VirtualSessionList which requires the scroll container
  // to have proper dimensions. In jsdom tests, getBoundingClientRect returns 0
  // for all dimensions, so the virtualizer won't render visible items.
  // We test the VirtualSessionList behavior indirectly through its unit tests
  // and focus on testing the SessionsView's filter, search, and state management.

  describe('Rendering', () => {
    it('renders SessionFilters component', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(screen.getByText('Session History')).toBeInTheDocument();
      });
    });

    it('renders MonitorPanel component', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      renderWithProviders(<SessionsView />);

      // MonitorPanel should be rendered in the right panel
      await waitFor(() => {
        const rightPanel = document.querySelector('.w-\\[40\\%\\]');
        expect(rightPanel).toBeInTheDocument();
      });
    });

    it('shows loading skeleton while fetching sessions', async () => {
      // Keep the query pending
      vi.mocked(window.goodvibes.getActiveSessions).mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      renderWithProviders(<SessionsView />);

      // LoadingSkeleton should be visible initially
      const skeletonContainer = document.querySelector('.space-y-3');
      expect(skeletonContainer).toBeInTheDocument();
    });
  });

  describe('Session List Display', () => {
    it('calls getActiveSessions API when mounted', async () => {
      const sessions = [
        createMockSession({ id: 'session-1', projectName: 'Project Alpha' }),
      ];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(sessions);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });
    });

    it('displays empty state when no sessions exist', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(screen.getByText('No sessions')).toBeInTheDocument();
      });
    });

    it('displays error state when fetching fails', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockRejectedValue(
        new Error('Network error')
      );

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load sessions')).toBeInTheDocument();
      });
    });
  });

  describe('Filter Functionality', () => {
    it('fetches favorite sessions when favorites filter is selected', async () => {
      const activeSessions = [createMockSession({ id: 'active-1' })];
      const favoriteSessions = [createMockSession({ id: 'favorite-1', favorite: true, projectName: 'Favorite Project' })];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(activeSessions);
      vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue(favoriteSessions);

      renderWithProviders(<SessionsView />);

      // Wait for initial load
      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });

      // Click favorites filter
      const favoritesButton = screen.getByRole('button', { name: /favorites/i });
      await userEvent.click(favoritesButton);

      await waitFor(() => {
        expect(window.goodvibes.getFavoriteSessions).toHaveBeenCalled();
      });
    });

    it('fetches archived sessions when archived filter is selected', async () => {
      const activeSessions = [createMockSession({ id: 'active-1' })];
      const archivedSessions = [createMockSession({ id: 'archived-1', archived: true, projectName: 'Archived Project' })];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(activeSessions);
      vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue(archivedSessions);

      renderWithProviders(<SessionsView />);

      // Wait for initial load
      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });

      // Click archived filter
      const archivedButton = screen.getByRole('button', { name: /archived/i });
      await userEvent.click(archivedButton);

      await waitFor(() => {
        expect(window.goodvibes.getArchivedSessions).toHaveBeenCalled();
      });
    });
  });

  describe('Search Functionality', () => {
    // Note: Search filtering is tested through the empty state display since
    // VirtualSessionList doesn't render items in jsdom (no scroll dimensions).
    // The useSessionFilters hook is tested more thoroughly in the hooks section.

    it('shows empty state when search term matches no sessions', async () => {
      const sessions = [
        createMockSession({ id: 'session-1', projectName: 'Project A' }),
      ];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(sessions);

      renderWithProviders(<SessionsView />);

      // Wait for initial load - sessions exist but virtualizer doesn't show them
      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });

      // Type a search term that won't match any session
      const searchInput = screen.getByPlaceholderText('Search sessions...');
      await userEvent.type(searchInput, 'nonexistent-query-xyz');

      await waitFor(() => {
        expect(screen.getByText('No matching sessions')).toBeInTheDocument();
        expect(screen.getByText('Try a different search term')).toBeInTheDocument();
      });
    });

    it('updates search input value as user types', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      renderWithProviders(<SessionsView />);

      const searchInput = screen.getByPlaceholderText('Search sessions...');
      await userEvent.type(searchInput, 'test query');

      expect(searchInput).toHaveValue('test query');
    });

    it('clears search when user deletes text', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

      renderWithProviders(<SessionsView />);

      const searchInput = screen.getByPlaceholderText('Search sessions...');
      await userEvent.type(searchInput, 'test');
      expect(searchInput).toHaveValue('test');

      await userEvent.clear(searchInput);
      expect(searchInput).toHaveValue('');
    });
  });

  describe('Live Sessions Polling', () => {
    it('calls getLiveSessions API when mounted', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);
      vi.mocked(window.goodvibes.getLiveSessions).mockResolvedValue([]);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(window.goodvibes.getLiveSessions).toHaveBeenCalled();
      });
    });
  });
});

// ============================================================================
// HOOKS TESTS (INDIRECT THROUGH COMPONENT)
// ============================================================================

describe('SessionsView Hooks', () => {
  describe('useSessions', () => {
    it('returns loading state initially', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockImplementation(
        () => new Promise(() => {})
      );

      renderWithProviders(<SessionsView />);

      // Should show loading skeleton
      const skeletonContainer = document.querySelector('.space-y-3');
      expect(skeletonContainer).toBeInTheDocument();
    });

    it('makes API call for sessions when loaded', async () => {
      const sessions = [createMockSession({ projectName: 'Test Project' })];
      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(sessions);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });
    });

    it('returns error state when fetch fails', async () => {
      vi.mocked(window.goodvibes.getActiveSessions).mockRejectedValue(
        new Error('Fetch failed')
      );

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load sessions')).toBeInTheDocument();
      });
    });
  });

  describe('useSessionFilters', () => {
    it('shows empty state when all sessions are filtered out by search', async () => {
      // This tests the useSessionFilters behavior indirectly
      const sessions = [
        createMockSession({ id: 'session-1', projectName: 'Test' }),
      ];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(sessions);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });

      // Search for something that won't match
      const searchInput = screen.getByPlaceholderText('Search sessions...');
      await userEvent.type(searchInput, 'zzz-no-match');

      await waitFor(() => {
        expect(screen.getByText('No matching sessions')).toBeInTheDocument();
      });
    });
  });
});

// ============================================================================
// EDGE CASES AND ERROR HANDLING
// ============================================================================

describe('Edge Cases', () => {
  // Note: Edge cases that require visible session content from VirtualSessionList
  // are tested in the SessionCard component tests directly.

  describe('SessionCard Edge Cases (direct rendering)', () => {
    it('handles session with null projectName', () => {
      const session = createMockSession({ projectName: null, customTitle: 'Unnamed Session' });

      renderWithProviders(
        <SessionCard
          session={session}
          projectsRoot={null}
          isLive={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText('Unnamed Session')).toBeInTheDocument();
    });

    it('handles session with very long summary', () => {
      const longSummary = 'A'.repeat(500);
      const session = createMockSession({ summary: longSummary });

      renderWithProviders(
        <SessionCard
          session={session}
          projectsRoot={null}
          isLive={false}
          onClick={vi.fn()}
        />
      );

      // The summary should be present but truncated via CSS
      const summaryElement = screen.getByText(longSummary);
      expect(summaryElement).toBeInTheDocument();
      expect(summaryElement).toHaveClass('line-clamp-1');
    });

    it('handles session with zero cost', () => {
      const session = createMockSession({ cost: 0 });

      renderWithProviders(
        <SessionCard
          session={session}
          projectsRoot={null}
          isLive={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText('$0.00')).toBeInTheDocument();
    });

    it('handles session with very high token count', () => {
      const session = createMockSession({ tokenCount: 1500000 });

      renderWithProviders(
        <SessionCard
          session={session}
          projectsRoot={null}
          isLive={false}
          onClick={vi.fn()}
        />
      );

      expect(screen.getByText('1.50M')).toBeInTheDocument();
    });
  });

  describe('Filter and Search Edge Cases', () => {
    it('handles rapid filter switching without errors', async () => {
      const activeSessions = [createMockSession({ id: 'active-1' })];
      const favoriteSessions = [createMockSession({ id: 'favorite-1', favorite: true })];
      const archivedSessions = [createMockSession({ id: 'archived-1', archived: true })];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(activeSessions);
      vi.mocked(window.goodvibes.getFavoriteSessions).mockResolvedValue(favoriteSessions);
      vi.mocked(window.goodvibes.getArchivedSessions).mockResolvedValue(archivedSessions);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });

      // Rapidly click through filters
      const favoritesButton = screen.getByRole('button', { name: /favorites/i });
      const archivedButton = screen.getByRole('button', { name: /archived/i });
      const allButton = screen.getByRole('button', { name: /all/i });

      await userEvent.click(favoritesButton);
      await userEvent.click(archivedButton);
      await userEvent.click(allButton);
      await userEvent.click(favoritesButton);

      // Should not throw errors and should settle on the last filter
      await waitFor(() => {
        expect(window.goodvibes.getFavoriteSessions).toHaveBeenCalled();
      });
    });

    it('handles clearing search after having no matches', async () => {
      const sessions = [
        createMockSession({ id: 'session-1', projectName: 'Test Project' }),
      ];

      vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue(sessions);

      renderWithProviders(<SessionsView />);

      await waitFor(() => {
        expect(window.goodvibes.getActiveSessions).toHaveBeenCalled();
      });

      const searchInput = screen.getByPlaceholderText('Search sessions...');

      // Search for something that has no matches
      await userEvent.type(searchInput, 'nonexistent');
      await waitFor(() => {
        expect(screen.getByText('No matching sessions')).toBeInTheDocument();
      });

      // Clear the search - should not show empty state anymore
      await userEvent.clear(searchInput);
      await waitFor(() => {
        expect(screen.queryByText('No matching sessions')).not.toBeInTheDocument();
      });
    });
  });
});

// ============================================================================
// ACCESSIBILITY TESTS
// ============================================================================

describe('Accessibility', () => {
  it('search input has proper label/placeholder', async () => {
    vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

    renderWithProviders(<SessionsView />);

    await waitFor(() => {
      const searchInput = screen.getByPlaceholderText('Search sessions...');
      expect(searchInput).toBeInTheDocument();
      expect(searchInput.tagName).toBe('INPUT');
    });
  });

  it('filter buttons are focusable', async () => {
    vi.mocked(window.goodvibes.getActiveSessions).mockResolvedValue([]);

    renderWithProviders(<SessionsView />);

    await waitFor(() => {
      const allButton = screen.getByRole('button', { name: /all/i });
      expect(allButton).not.toHaveAttribute('tabindex', '-1');
    });
  });

  it('SessionCard action buttons have accessible titles', () => {
    // Test SessionCard directly since VirtualSessionList doesn't render in jsdom
    const session = createMockSession();

    renderWithProviders(
      <SessionCard
        session={session}
        projectsRoot={null}
        isLive={false}
        onClick={vi.fn()}
      />
    );

    expect(screen.getByTitle('Open Preview')).toBeInTheDocument();
    expect(screen.getByTitle('Open in CLI')).toBeInTheDocument();
    expect(screen.getByTitle('Add to favorites')).toBeInTheDocument();
    expect(screen.getByTitle('Archive')).toBeInTheDocument();
  });

  it('error state retry button is accessible', async () => {
    vi.mocked(window.goodvibes.getActiveSessions).mockRejectedValue(
      new Error('Test error')
    );

    renderWithProviders(<SessionsView />);

    await waitFor(() => {
      const retryButton = screen.getByRole('button', { name: /retry/i });
      expect(retryButton).toBeInTheDocument();
      expect(retryButton).not.toBeDisabled();
    });
  });
});
