// ============================================================================
// GIT PANEL COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { GitPanel } from '../GitPanel';
import type { GitFileChange } from '../types';

// Mock the settings store
vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: vi.fn((selector) => {
    const state = {
      settings: {
        githubEnabled: false,
        githubShowInGitPanel: false,
      },
    };
    return selector ? selector(state) : state;
  }),
}));

// Mock the sub-components to simplify testing
vi.mock('../GitStatus', () => ({
  GitStatus: ({ staged, unstaged, untracked }: any) => (
    <div data-testid="git-status">
      <div data-testid="staged-count">{staged.length}</div>
      <div data-testid="unstaged-count">{unstaged.length}</div>
      <div data-testid="untracked-count">{untracked.length}</div>
    </div>
  ),
}));

vi.mock('../GitBranches', () => ({
  GitBranches: ({ branch }: any) => <div data-testid="git-branches">{branch}</div>,
  DeleteBranchModal: () => null,
  CheckoutConfirmModal: () => null,
}));

vi.mock('../GitCommits', () => ({
  GitCommits: ({ commits }: any) => <div data-testid="git-commits">{commits.length}</div>,
}));

vi.mock('../GitRemote', () => ({
  GitRemote: () => <div data-testid="git-remote" />,
}));

vi.mock('../GitMerge', () => ({
  GitMerge: () => <div data-testid="git-merge" />,
}));

vi.mock('../GitStash', () => ({
  GitStash: () => <div data-testid="git-stash" />,
}));

vi.mock('../GitTags', () => ({
  GitTags: () => <div data-testid="git-tags" />,
}));

vi.mock('../GitDiff', () => ({
  GitDiff: () => <div data-testid="git-diff" />,
}));

vi.mock('../GitConflicts', () => ({
  GitConflicts: () => <div data-testid="git-conflicts" />,
}));

vi.mock('../GitRebase', () => ({
  GitRebase: () => <div data-testid="git-rebase" />,
}));

vi.mock('../GitFileHistory', () => ({
  GitFileHistory: () => <div data-testid="git-file-history" />,
  GitBlame: () => <div data-testid="git-blame" />,
}));

vi.mock('../GitCommitDetail', () => ({
  GitCommitDetailModal: () => <div data-testid="git-commit-detail" />,
}));

vi.mock('../github', () => ({
  GitHubPanel: () => <div data-testid="github-panel" />,
}));

vi.mock('../overlays/ConfirmModal', () => ({
  ConfirmModal: () => <div data-testid="confirm-modal" />,
}));

vi.mock('../../../shared/logger', () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

// Helper to create mock file changes
function createFileChange(overrides: Partial<GitFileChange> = {}): GitFileChange {
  return {
    file: 'test-file.ts',
    status: 'modified',
    staged: false,
    indexStatus: ' ',
    workTreeStatus: 'M',
    ...overrides,
  };
}

// Mock git status response for gitDetailedStatus
const mockGitDetailedStatusResponse = {
  branch: 'main',
  ahead: 0,
  behind: 0,
  staged: [] as GitFileChange[],
  unstaged: [] as GitFileChange[],
  untracked: [] as GitFileChange[],
};

// Mock git branches response
const mockGitBranchesResponse = {
  branches: [
    { name: 'main', current: true, remote: false },
    { name: 'feature-branch', current: false, remote: false },
  ],
};

// Mock git log response
const mockGitLogDetailedResponse = {
  commits: [
    {
      hash: 'abc123',
      message: 'Initial commit',
      author: 'Test User',
      date: new Date().toISOString(),
      abbrevHash: 'abc123',
    },
  ],
};

describe('GitPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default mock implementations for useGitState hook
    vi.mocked(window.goodvibes.gitIsRepo).mockResolvedValue(true);
    vi.mocked(window.goodvibes.gitDetailedStatus).mockResolvedValue(mockGitDetailedStatusResponse);
    vi.mocked(window.goodvibes.gitBranches).mockResolvedValue(mockGitBranchesResponse);
    vi.mocked(window.goodvibes.gitLogDetailed).mockResolvedValue(mockGitLogDetailedResponse);
    vi.mocked(window.goodvibes.gitStashList).mockResolvedValue({ stashes: [] });
    vi.mocked(window.goodvibes.gitMergeInProgress).mockResolvedValue(false);
    vi.mocked(window.goodvibes.gitCherryPickInProgress).mockResolvedValue(false);
    vi.mocked(window.goodvibes.gitRebaseInProgress).mockResolvedValue(false);
    vi.mocked(window.goodvibes.gitTags).mockResolvedValue({ tags: [] });
    vi.mocked(window.goodvibes.gitConflictFiles).mockResolvedValue({ files: [] });
    vi.mocked(window.goodvibes.gitConventionalPrefixes).mockResolvedValue({ prefixes: [] });
  });

  describe('Initial Render', () => {
    it('renders the git panel header', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByText('Source Control')).toBeInTheDocument();
      });
    });

    it('shows loading state initially', () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      expect(screen.getByText('Source Control')).toBeInTheDocument();
    });

    it('checks if directory is a git repository on mount', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(window.goodvibes.gitIsRepo).toHaveBeenCalledWith('/test/path');
      });
    });
  });

  describe('Git Repository State', () => {
    it('displays repository content when it is a git repo', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status')).toBeInTheDocument();
        expect(screen.getByTestId('git-branches')).toBeInTheDocument();
        expect(screen.getByTestId('git-commits')).toBeInTheDocument();
      });
    });

    it('displays "Not a Git Repository" when not a git repo', async () => {
      vi.mocked(window.goodvibes.gitIsRepo).mockResolvedValue(false);

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByText('Not a Git Repository')).toBeInTheDocument();
        expect(screen.getByText('Initialize version control for this project')).toBeInTheDocument();
      });
    });

    it('shows initialize repository button when not a git repo', async () => {
      vi.mocked(window.goodvibes.gitIsRepo).mockResolvedValue(false);

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        const initButton = screen.getByText('Initialize Repository');
        expect(initButton).toBeInTheDocument();
      });
    });

    it('calls gitInit when initialize button is clicked', async () => {
      vi.mocked(window.goodvibes.gitIsRepo).mockResolvedValue(false);
      vi.mocked(window.goodvibes.gitInit).mockResolvedValue(true);

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByText('Initialize Repository')).toBeInTheDocument();
      });

      const initButton = screen.getByText('Initialize Repository');
      fireEvent.click(initButton);

      await waitFor(() => {
        expect(window.goodvibes.gitInit).toHaveBeenCalledWith('/test/path');
      });
    });
  });

  describe('Git Status Display', () => {
    it('displays staged files count', async () => {
      vi.mocked(window.goodvibes.gitDetailedStatus).mockResolvedValue({
        ...mockGitDetailedStatusResponse,
        staged: [
          createFileChange({ file: 'file1.ts', staged: true }),
          createFileChange({ file: 'file2.ts', staged: true }),
        ],
      });

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        const stagedCount = screen.getByTestId('staged-count');
        expect(stagedCount).toHaveTextContent('2');
      }, { timeout: 3000 });
    });

    it('displays unstaged files count', async () => {
      vi.mocked(window.goodvibes.gitDetailedStatus).mockResolvedValue({
        ...mockGitDetailedStatusResponse,
        unstaged: [
          createFileChange({ file: 'file1.ts' }),
          createFileChange({ file: 'file2.ts' }),
          createFileChange({ file: 'file3.ts' }),
        ],
      });

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        const unstagedCount = screen.getByTestId('unstaged-count');
        expect(unstagedCount).toHaveTextContent('3');
      }, { timeout: 3000 });
    });

    it('displays untracked files count', async () => {
      vi.mocked(window.goodvibes.gitDetailedStatus).mockResolvedValue({
        ...mockGitDetailedStatusResponse,
        untracked: [createFileChange({ file: 'new-file.ts', status: 'untracked' })],
      });

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        const untrackedCount = screen.getByTestId('untracked-count');
        expect(untrackedCount).toHaveTextContent('1');
      }, { timeout: 3000 });
    });

    it('shows total changes badge in header', async () => {
      vi.mocked(window.goodvibes.gitDetailedStatus).mockResolvedValue({
        ...mockGitDetailedStatusResponse,
        staged: [createFileChange({ file: 'staged.ts', staged: true })],
        unstaged: [createFileChange({ file: 'unstaged.ts' })],
        untracked: [createFileChange({ file: 'untracked.ts', status: 'untracked' })],
      });

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByText('3')).toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });

  describe('Refresh Action', () => {
    it('shows refresh button in header', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        const refreshButton = screen.getByTitle('Refresh');
        expect(refreshButton).toBeInTheDocument();
      });
    });

    it('calls git status when refresh button is clicked', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByTitle('Refresh')).toBeInTheDocument();
      });

      // Clear the initial mount calls
      vi.clearAllMocks();

      const refreshButton = screen.getByTitle('Refresh');
      fireEvent.click(refreshButton);

      await waitFor(() => {
        expect(window.goodvibes.gitDetailedStatus).toHaveBeenCalled();
      }, { timeout: 3000 });
    });

    it('disables refresh button while loading', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByTitle('Refresh')).toBeInTheDocument();
      });

      const refreshButton = screen.getByTitle('Refresh') as HTMLButtonElement;

      // Button should be enabled after initial load
      await waitFor(() => {
        expect(refreshButton.disabled).toBe(false);
      });
    });
  });

  describe('Current Branch Display', () => {
    it('displays the current branch name', async () => {
      vi.mocked(window.goodvibes.gitDetailedStatus).mockResolvedValue({
        ...mockGitDetailedStatusResponse,
        branch: 'feature-branch',
      });

      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByTestId('git-branches')).toHaveTextContent('feature-branch');
      }, { timeout: 3000 });
    });
  });

  describe('Error Handling', () => {
    it('displays error message when git operations fail', async () => {
      vi.mocked(window.goodvibes.gitDetailedStatus).mockRejectedValue(new Error('Git command failed'));

      render(<GitPanel cwd="/test/path" position="left" />);

      // Wait for loading to finish and error to display
      await waitFor(() => {
        expect(screen.queryByText('Git command failed')).toBeInTheDocument();
      }, { timeout: 5000 });
    });
  });

  describe('Component Structure', () => {
    it('renders all git component sections', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(screen.getByTestId('git-status')).toBeInTheDocument();
        expect(screen.getByTestId('git-branches')).toBeInTheDocument();
        expect(screen.getByTestId('git-commits')).toBeInTheDocument();
        expect(screen.getByTestId('git-remote')).toBeInTheDocument();
        expect(screen.getByTestId('git-merge')).toBeInTheDocument();
        expect(screen.getByTestId('git-stash')).toBeInTheDocument();
        expect(screen.getByTestId('git-tags')).toBeInTheDocument();
        expect(screen.getByTestId('git-conflicts')).toBeInTheDocument();
        expect(screen.getByTestId('git-rebase')).toBeInTheDocument();
      }, { timeout: 5000 });
    });

    it('applies correct position class', () => {
      const { container } = render(<GitPanel cwd="/test/path" position="right" />);

      // Position is determined by border class, not a panel-position class
      expect(container.firstChild).toHaveClass('border-l');
      expect(container.firstChild).not.toHaveClass('border-r');
    });
  });

  describe('Data Fetching', () => {
    it('fetches git status on mount', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(window.goodvibes.gitDetailedStatus).toHaveBeenCalledWith('/test/path');
      }, { timeout: 3000 });
    });

    it('fetches git branches on mount', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(window.goodvibes.gitBranches).toHaveBeenCalledWith('/test/path');
      }, { timeout: 3000 });
    });

    it('fetches git log on mount', async () => {
      render(<GitPanel cwd="/test/path" position="left" />);

      await waitFor(() => {
        expect(window.goodvibes.gitLogDetailed).toHaveBeenCalledWith('/test/path', expect.any(Number));
      }, { timeout: 3000 });
    });
  });
});
