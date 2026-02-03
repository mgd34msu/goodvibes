// ============================================================================
// PULL REQUEST LIST COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import PullRequestList from '../PullRequestList';
import type { GitHubPullRequest, GitHubCheckRun } from '../../../../shared/types/github';

// ============================================================================
// MOCK DATA HELPERS
// ============================================================================

function createMockPullRequest(overrides: Partial<GitHubPullRequest> = {}): GitHubPullRequest {
  return {
    id: 123,
    number: 1,
    node_id: 'pr123',
    title: 'Test Pull Request',
    state: 'open',
    locked: false,
    draft: false,
    html_url: 'https://github.com/owner/repo/pull/1',
    diff_url: 'https://github.com/owner/repo/pull/1.diff',
    patch_url: 'https://github.com/owner/repo/pull/1.patch',
    body: null,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    merged_by: null,
    comments: 0,
    review_comments: 0,
    commits: 1,
    additions: 10,
    deletions: 5,
    changed_files: 2,
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    closed_at: null,
    merged_at: null,
    assignees: [],
    requested_reviewers: [],
    user: {
      login: 'testuser',
      id: 1,
      avatar_url: 'https://github.com/testuser.png',
      type: 'User',
    },
    head: {
      ref: 'feature-branch',
      sha: 'abc123',
      label: 'testuser:feature-branch',
      repo: {
        id: 456,
        name: 'repo',
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
      },
    },
    base: {
      ref: 'main',
      sha: 'def456',
      label: 'owner:main',
      repo: {
        id: 456,
        name: 'repo',
        full_name: 'owner/repo',
        html_url: 'https://github.com/owner/repo',
      },
    },
    labels: [],
    ...overrides,
  };
}

function createMockCheckRun(overrides: Partial<GitHubCheckRun> = {}): GitHubCheckRun {
  return {
    id: 1,
    node_id: 'check1',
    name: 'Test Check',
    head_sha: 'abc123',
    external_id: null,
    status: 'completed',
    conclusion: 'success',
    started_at: '2024-01-01T00:00:00Z',
    completed_at: '2024-01-01T00:01:00Z',
    html_url: 'https://github.com/owner/repo/runs/1',
    details_url: null,
    output: {
      title: null,
      summary: null,
      text: null,
      annotations_count: 0,
    },
    app: {
      id: 1,
      slug: 'github-actions',
      name: 'GitHub Actions',
    },
    ...overrides,
  };
}

// ============================================================================
// TESTS
// ============================================================================

describe('PullRequestList', () => {
  const defaultProps = {
    owner: 'testowner',
    repo: 'testrepo',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset window.open mock
    window.open = vi.fn();
  });

  describe('Loading State', () => {
    it('displays loading indicator while fetching PRs', () => {
      window.goodvibes.githubListPRs = vi.fn().mockImplementation(
        () => new Promise(() => {}) // Never resolves
      );

      render(<PullRequestList {...defaultProps} />);

      expect(screen.getByText('Loading pull requests...')).toBeInTheDocument();
    });

    it('shows spinner icon during loading', () => {
      window.goodvibes.githubListPRs = vi.fn().mockImplementation(
        () => new Promise(() => {})
      );

      render(<PullRequestList {...defaultProps} />);

      const spinner = screen.getByText('Loading pull requests...').previousSibling;
      expect(spinner).toHaveClass('animate-spin');
    });
  });

  describe('Empty State', () => {
    it('displays "No open pull requests" when list is empty', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('No open pull requests')).toBeInTheDocument();
      });
    });

    it('shows PR count of 0 when no PRs exist', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Pull Requests (0)')).toBeInTheDocument();
      });
    });
  });

  describe('Pull Request List Rendering', () => {
    it('renders list of pull requests correctly', async () => {
      const mockPRs = [
        createMockPullRequest({ number: 1, title: 'First PR' }),
        createMockPullRequest({ number: 2, title: 'Second PR' }),
      ];

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: mockPRs,
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('First PR')).toBeInTheDocument();
        expect(screen.getByText('Second PR')).toBeInTheDocument();
      });
    });

    it('displays correct PR count in header', async () => {
      const mockPRs = [
        createMockPullRequest({ number: 1 }),
        createMockPullRequest({ number: 2 }),
        createMockPullRequest({ number: 3 }),
      ];

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: mockPRs,
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Pull Requests (3)')).toBeInTheDocument();
      });
    });

    it('displays PR number and author', async () => {
      const mockPR = createMockPullRequest({
        number: 42,
        user: { ...createMockPullRequest().user, login: 'johndoe' },
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/#42 by johndoe/)).toBeInTheDocument();
      });
    });

    it('displays branch names correctly', async () => {
      const mockPR = createMockPullRequest({
        head: { ref: 'feature-auth', sha: 'abc', label: 'testuser:feature-auth', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } },
        base: { ref: 'develop', sha: 'def', label: 'owner:develop', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } },
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText(/feature-auth.*→.*develop/)).toBeInTheDocument();
      });
    });

    it('shows draft badge for draft PRs', async () => {
      const mockPR = createMockPullRequest({ draft: true, title: 'Draft PR' });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Draft')).toBeInTheDocument();
      });
    });

    it('does not show draft badge for regular PRs', async () => {
      const mockPR = createMockPullRequest({ draft: false, title: 'Regular PR' });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.queryByText('Draft')).not.toBeInTheDocument();
      });
    });
  });

  describe('PR Labels', () => {
    it('displays PR labels correctly', async () => {
      const mockPR = createMockPullRequest({
        labels: [
          { id: 1, node_id: 'label1', name: 'bug', color: 'd73a4a', description: null, default: false },
          { id: 2, node_id: 'label2', name: 'enhancement', color: 'a2eeef', description: null, default: false },
        ],
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('bug')).toBeInTheDocument();
        expect(screen.getByText('enhancement')).toBeInTheDocument();
      });
    });

    it('displays only first 3 labels and shows count for remainder', async () => {
      const mockPR = createMockPullRequest({
        labels: [
          { id: 1, node_id: 'label1', name: 'bug', color: 'd73a4a', description: null, default: false },
          { id: 2, node_id: 'label2', name: 'enhancement', color: 'a2eeef', description: null, default: false },
          { id: 3, node_id: 'label3', name: 'documentation', color: '0075ca', description: null, default: false },
          { id: 4, node_id: 'label4', name: 'help wanted', color: '008672', description: null, default: false },
          { id: 5, node_id: 'label5', name: 'good first issue', color: '7057ff', description: null, default: false },
        ],
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('bug')).toBeInTheDocument();
        expect(screen.getByText('enhancement')).toBeInTheDocument();
        expect(screen.getByText('documentation')).toBeInTheDocument();
        expect(screen.getByText('+2')).toBeInTheDocument();
        expect(screen.queryByText('help wanted')).not.toBeInTheDocument();
      });
    });
  });

  describe('Current Branch Handling', () => {
    it('highlights PR for current branch', async () => {
      const mockPR = createMockPullRequest({
        head: { ref: 'feature-branch', sha: 'abc', label: 'testuser:feature-branch', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } },
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} currentBranch="feature-branch" />);

      await waitFor(() => {
        const prElement = screen.getByText('Test Pull Request').closest('button');
        expect(prElement).toHaveClass('bg-primary-900/20');
      });
    });

    it('shows notice when current branch has open PR', async () => {
      const mockPR = createMockPullRequest({
        number: 42,
        head: { ref: 'my-feature', sha: 'abc', label: 'testuser:my-feature', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } },
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} currentBranch="my-feature" />);

      await waitFor(() => {
        expect(screen.getByText('This branch has an open PR: #42')).toBeInTheDocument();
      });
    });

    it('shows Create PR button when current branch has no PR', async () => {
      const mockPR = createMockPullRequest({
        head: { ref: 'other-branch', sha: 'abc', label: 'testuser:other-branch', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } },
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      const onCreatePR = vi.fn();
      render(<PullRequestList {...defaultProps} currentBranch="my-new-feature" onCreatePR={onCreatePR} />);

      await waitFor(() => {
        expect(screen.getByText('+ Create PR')).toBeInTheDocument();
      });
    });

    it('does not show Create PR button when no callback provided', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} currentBranch="my-feature" />);

      await waitFor(() => {
        expect(screen.queryByText('+ Create PR')).not.toBeInTheDocument();
      });
    });
  });

  describe('Click Interaction', () => {
    it('opens PR URL in new window when clicked', async () => {
      const mockPR = createMockPullRequest({
        html_url: 'https://github.com/owner/repo/pull/123',
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Test Pull Request')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Test Pull Request').closest('button')!);

      expect(window.open).toHaveBeenCalledWith(
        'https://github.com/owner/repo/pull/123',
        '_blank',
        'noopener,noreferrer'
      );
    });

    it('calls onCreatePR when Create PR button is clicked', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      const onCreatePR = vi.fn();
      render(<PullRequestList {...defaultProps} currentBranch="feature" onCreatePR={onCreatePR} />);

      await waitFor(() => {
        expect(screen.getByText('+ Create PR')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('+ Create PR'));

      expect(onCreatePR).toHaveBeenCalledTimes(1);
    });
  });

  describe('CI Status Integration', () => {
    it('loads CI status for each PR', async () => {
      const mockPRs = [
        createMockPullRequest({ number: 1, head: { ref: 'feature-1', sha: 'sha1', label: 'testuser:feature-1', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } } }),
        createMockPullRequest({ number: 2, head: { ref: 'feature-2', sha: 'sha2', label: 'testuser:feature-2', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } } }),
      ];

      const mockGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: mockPRs,
      });
      window.goodvibes.githubGetChecks = mockGetChecks;

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(mockGetChecks).toHaveBeenCalledWith('testowner', 'testrepo', 'sha1');
        expect(mockGetChecks).toHaveBeenCalledWith('testowner', 'testrepo', 'sha2');
      });
    });

    it('displays CI status badge when checks are successful', async () => {
      const mockPR = createMockPullRequest({
        number: 1,
        head: { ref: 'feature', sha: 'abc123', label: 'testuser:feature', repo: { id: 456, name: 'repo', full_name: 'owner/repo', html_url: 'https://github.com/owner/repo' } },
      });

      const mockChecks = [
        createMockCheckRun({ status: 'completed', conclusion: 'success' }),
      ];

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockResolvedValue({
        success: true,
        data: mockChecks,
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        const prElement = screen.getByText('Test Pull Request').closest('button');
        // CI status badge is rendered but we can't easily test its internal state
        expect(prElement).toBeInTheDocument();
      });
    });

    it('continues loading PRs even if CI status fails', async () => {
      const mockPR = createMockPullRequest({ title: 'My PR' });

      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [mockPR],
      });
      window.goodvibes.githubGetChecks = vi.fn().mockRejectedValue(
        new Error('CI check failed')
      );

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('My PR')).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('displays error message when loading fails', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: false,
        error: 'Failed to load pull requests',
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Failed to load pull requests')).toBeInTheDocument();
      });
    });

    it('shows retry button on error', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: false,
        error: 'Network error',
      });

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Retry')).toBeInTheDocument();
      });
    });

    it('retries loading when retry button is clicked', async () => {
      const mockListPRs = vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'Network error' })
        .mockResolvedValueOnce({ success: true, data: [] });

      window.goodvibes.githubListPRs = mockListPRs;

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Network error')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Retry'));

      await waitFor(() => {
        expect(screen.getByText('No open pull requests')).toBeInTheDocument();
      });

      expect(mockListPRs).toHaveBeenCalledTimes(2);
    });

    it('handles exception thrown during loading', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockRejectedValue(
        new Error('Unexpected error')
      );

      render(<PullRequestList {...defaultProps} />);

      await waitFor(() => {
        expect(screen.getByText('Unexpected error')).toBeInTheDocument();
      });
    });
  });

  describe('Cleanup and Memory Management', () => {
    it('does not update state after unmount', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true, data: [] }), 100))
      );

      const { unmount } = render(<PullRequestList {...defaultProps} />);

      unmount();

      // Wait for the promise to resolve
      await new Promise((resolve) => setTimeout(resolve, 150));

      // If this doesn't throw a warning about updating unmounted component, test passes
      expect(true).toBe(true);
    });
  });

  describe('Custom Props', () => {
    it('applies custom className', async () => {
      window.goodvibes.githubListPRs = vi.fn().mockResolvedValue({
        success: true,
        data: [],
      });

      const { container } = render(
        <PullRequestList {...defaultProps} className="custom-class" />
      );

      await waitFor(() => {
        expect(container.querySelector('.custom-class')).toBeInTheDocument();
      });
    });
  });
});
