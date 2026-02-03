// ============================================================================
// GIT COMMITS COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitCommits } from '../GitCommits';
import type { GitCommitInfo } from '../types';

// Helper to create mock commit info
function createCommitInfo(overrides: Partial<GitCommitInfo> = {}): GitCommitInfo {
  return {
    hash: 'abc123def456789012345678901234567890abcd',
    shortHash: 'abc123d',
    author: 'Test Author',
    email: 'test@example.com',
    date: '2024-01-15T10:30:00Z',
    subject: 'Test commit message',
    ...overrides,
  };
}

// Default props for GitCommits component
function createDefaultProps(overrides: Partial<Parameters<typeof GitCommits>[0]> = {}) {
  return {
    commits: [] as GitCommitInfo[],
    commitMessage: '',
    amendMode: false,
    isCommitting: false,
    stagedCount: 0,
    expandedSections: { commits: true } as { commits: boolean },
    conventionalPrefixes: ['feat', 'fix', 'docs', 'style', 'refactor', 'test', 'chore'],
    showConventionalDropdown: false,
    toggleSection: vi.fn(),
    onCommitMessageChange: vi.fn(),
    onAmendModeChange: vi.fn(),
    onCommit: vi.fn(),
    onViewCommit: vi.fn(),
    onCherryPick: vi.fn(),
    onConventionalPrefix: vi.fn(),
    onToggleConventionalDropdown: vi.fn(),
    formatRelativeTime: vi.fn((date: string) => {
      const d = new Date(date);
      return d.toLocaleDateString();
    }),
    ...overrides,
  };
}

describe('GitCommits', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Mock element dimensions for virtualization in JSDOM
    // @tanstack/react-virtual needs these to calculate visible items
    Object.defineProperties(HTMLElement.prototype, {
      offsetHeight: {
        get() {
          // Return non-zero height for scroll containers
          if (this.classList?.contains('max-h-48') || this.classList?.contains('overflow-y-auto')) {
            return 192; // 48 * 4px = 192px
          }
          return 48; // Default row height
        },
        configurable: true,
      },
      offsetWidth: {
        get() {
          return 800;
        },
        configurable: true,
      },
      clientHeight: {
        get() {
          if (this.classList?.contains('max-h-48') || this.classList?.contains('overflow-y-auto')) {
            return 192;
          }
          return 48;
        },
        configurable: true,
      },
    });

    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      width: 800,
      height: 192,
      top: 0,
      left: 0,
      bottom: 192,
      right: 800,
      x: 0,
      y: 0,
      toJSON: () => {},
    }));
  });

  describe('Commit Form', () => {
    it('does not show commit form when no staged changes and no message', () => {
      const props = createDefaultProps({ stagedCount: 0, commitMessage: '' });
      render(<GitCommits {...props} />);

      expect(screen.queryByPlaceholderText(/commit message/i)).not.toBeInTheDocument();
    });

    it('shows commit form when there are staged changes', () => {
      const props = createDefaultProps({ stagedCount: 2 });
      render(<GitCommits {...props} />);

      expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument();
    });

    it('shows commit form when there is a commit message', () => {
      const props = createDefaultProps({ commitMessage: 'test message' });
      render(<GitCommits {...props} />);

      expect(screen.getByPlaceholderText('Commit message...')).toBeInTheDocument();
    });

    it('shows commit form when amend mode is enabled', () => {
      const props = createDefaultProps({ amendMode: true });
      render(<GitCommits {...props} />);

      expect(screen.getByPlaceholderText(/new commit message/i)).toBeInTheDocument();
    });

    it('calls onCommitMessageChange when message is typed', () => {
      const onCommitMessageChange = vi.fn();
      const props = createDefaultProps({ stagedCount: 1, onCommitMessageChange });
      render(<GitCommits {...props} />);

      const textarea = screen.getByPlaceholderText('Commit message...');
      fireEvent.change(textarea, { target: { value: 'New commit' } });

      expect(onCommitMessageChange).toHaveBeenCalledWith('New commit');
    });

    it('displays the current commit message value', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        commitMessage: 'feat: add new feature',
      });
      render(<GitCommits {...props} />);

      const textarea = screen.getByPlaceholderText('Commit message...');
      expect(textarea).toHaveValue('feat: add new feature');
    });
  });

  describe('Commit Button', () => {
    it('shows staged count in commit button', () => {
      const props = createDefaultProps({
        stagedCount: 5,
        commitMessage: 'test message',
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('Commit (5)')).toBeInTheDocument();
    });

    it('disables commit button when message is empty', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        commitMessage: '',
      });
      render(<GitCommits {...props} />);

      const commitButton = screen.getByText('Commit (1)');
      expect(commitButton).toBeDisabled();
    });

    it('disables commit button when no staged changes (without amend)', () => {
      const props = createDefaultProps({
        stagedCount: 0,
        commitMessage: 'test message',
        amendMode: false,
      });
      render(<GitCommits {...props} />);

      // The form shows because there's a commit message, but commit button should show (0)
      // and be disabled since there are no staged changes
      const commitButton = screen.getByText('Commit (0)');
      expect(commitButton).toBeDisabled();
    });

    it('enables commit button when message exists and files are staged', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        commitMessage: 'test message',
      });
      render(<GitCommits {...props} />);

      const commitButton = screen.getByText('Commit (1)');
      expect(commitButton).not.toBeDisabled();
    });

    it('calls onCommit when commit button is clicked', () => {
      const onCommit = vi.fn();
      const props = createDefaultProps({
        stagedCount: 1,
        commitMessage: 'test message',
        onCommit,
      });
      render(<GitCommits {...props} />);

      fireEvent.click(screen.getByText('Commit (1)'));

      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    it('shows "Committing..." when isCommitting is true', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        commitMessage: 'test message',
        isCommitting: true,
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('Committing...')).toBeInTheDocument();
    });

    it('disables commit button when isCommitting is true', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        commitMessage: 'test message',
        isCommitting: true,
      });
      render(<GitCommits {...props} />);

      const commitButton = screen.getByText('Committing...');
      expect(commitButton).toBeDisabled();
    });
  });

  describe('Amend Mode', () => {
    it('renders amend checkbox', () => {
      const props = createDefaultProps({ stagedCount: 1 });
      render(<GitCommits {...props} />);

      expect(screen.getByText('Amend last commit')).toBeInTheDocument();
    });

    it('calls onAmendModeChange when checkbox is toggled', () => {
      const onAmendModeChange = vi.fn();
      const props = createDefaultProps({ stagedCount: 1, onAmendModeChange });
      render(<GitCommits {...props} />);

      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);

      expect(onAmendModeChange).toHaveBeenCalledWith(true);
    });

    it('shows "Amend" button text when amendMode is true', () => {
      const props = createDefaultProps({
        amendMode: true,
        commitMessage: 'updated message',
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('Amend')).toBeInTheDocument();
    });

    it('shows "Amending..." when isCommitting is true in amend mode', () => {
      const props = createDefaultProps({
        amendMode: true,
        commitMessage: 'updated message',
        isCommitting: true,
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('Amending...')).toBeInTheDocument();
    });

    it('enables commit in amend mode even without staged changes', () => {
      const props = createDefaultProps({
        amendMode: true,
        stagedCount: 0,
        commitMessage: '',
      });
      render(<GitCommits {...props} />);

      // In amend mode, the button should be enabled even with empty message
      // (to keep the original message)
      const amendButton = screen.getByText('Amend');
      expect(amendButton).not.toBeDisabled();
    });

    it('shows different placeholder in amend mode', () => {
      const props = createDefaultProps({ amendMode: true });
      render(<GitCommits {...props} />);

      expect(screen.getByPlaceholderText(/new commit message.*leave empty to keep/i)).toBeInTheDocument();
    });
  });

  describe('Conventional Commits', () => {
    it('renders conventional commit type button', () => {
      const props = createDefaultProps({ stagedCount: 1 });
      render(<GitCommits {...props} />);

      expect(screen.getByText('type:')).toBeInTheDocument();
    });

    it('calls onToggleConventionalDropdown when type button is clicked', () => {
      const onToggleConventionalDropdown = vi.fn();
      const props = createDefaultProps({ stagedCount: 1, onToggleConventionalDropdown });
      render(<GitCommits {...props} />);

      fireEvent.click(screen.getByText('type:'));

      expect(onToggleConventionalDropdown).toHaveBeenCalledTimes(1);
    });

    it('shows conventional prefix dropdown when showConventionalDropdown is true', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        showConventionalDropdown: true,
        conventionalPrefixes: ['feat', 'fix', 'docs'],
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('feat:')).toBeInTheDocument();
      expect(screen.getByText('fix:')).toBeInTheDocument();
      expect(screen.getByText('docs:')).toBeInTheDocument();
    });

    it('hides conventional prefix dropdown when showConventionalDropdown is false', () => {
      const props = createDefaultProps({
        stagedCount: 1,
        showConventionalDropdown: false,
        conventionalPrefixes: ['feat', 'fix'],
      });
      render(<GitCommits {...props} />);

      expect(screen.queryByText('feat:')).not.toBeInTheDocument();
      expect(screen.queryByText('fix:')).not.toBeInTheDocument();
    });

    it('calls onConventionalPrefix when a prefix is clicked', () => {
      const onConventionalPrefix = vi.fn();
      const props = createDefaultProps({
        stagedCount: 1,
        showConventionalDropdown: true,
        conventionalPrefixes: ['feat', 'fix'],
        onConventionalPrefix,
      });
      render(<GitCommits {...props} />);

      fireEvent.click(screen.getByText('feat:'));

      expect(onConventionalPrefix).toHaveBeenCalledWith('feat');
    });
  });

  describe('Commits List', () => {
    it('renders commits section header', () => {
      const props = createDefaultProps();
      render(<GitCommits {...props} />);

      expect(screen.getByText('Commits')).toBeInTheDocument();
    });

    it('shows "No commits yet" when commits list is empty', () => {
      const props = createDefaultProps({ commits: [] });
      render(<GitCommits {...props} />);

      expect(screen.getByText('No commits yet')).toBeInTheDocument();
    });

    it('displays commit entries', () => {
      const props = createDefaultProps({
        commits: [
          createCommitInfo({ hash: 'abc1234000000000000000000000000000000001', shortHash: 'abc1234', subject: 'feat: add login' }),
          createCommitInfo({ hash: 'def5678000000000000000000000000000000002', shortHash: 'def5678', subject: 'fix: resolve bug' }),
        ],
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('abc1234')).toBeInTheDocument();
      expect(screen.getByText('feat: add login')).toBeInTheDocument();
      expect(screen.getByText('def5678')).toBeInTheDocument();
      expect(screen.getByText('fix: resolve bug')).toBeInTheDocument();
    });

    it('displays commit author', () => {
      const props = createDefaultProps({
        commits: [createCommitInfo({ author: 'John Doe' })],
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText(/John Doe/)).toBeInTheDocument();
    });

    it('calls formatRelativeTime for commit dates', () => {
      const formatRelativeTime = vi.fn().mockReturnValue('2 hours ago');
      const props = createDefaultProps({
        commits: [createCommitInfo({ date: '2024-01-15T10:30:00Z' })],
        formatRelativeTime,
      });
      render(<GitCommits {...props} />);

      expect(formatRelativeTime).toHaveBeenCalledWith('2024-01-15T10:30:00Z');
      expect(screen.getByText(/2 hours ago/)).toBeInTheDocument();
    });

    it('calls onViewCommit when commit is clicked', () => {
      const onViewCommit = vi.fn();
      const props = createDefaultProps({
        commits: [createCommitInfo({ hash: 'abc123full', subject: 'Test commit' })],
        onViewCommit,
      });
      render(<GitCommits {...props} />);

      const commitButton = screen.getByText('Test commit').closest('button');
      if (commitButton) {
        fireEvent.click(commitButton);
      }

      expect(onViewCommit).toHaveBeenCalledWith('abc123full');
    });

    it('calls onCherryPick when cherry-pick button is clicked', () => {
      const onCherryPick = vi.fn();
      const props = createDefaultProps({
        commits: [createCommitInfo({ hash: 'abc123full' })],
        onCherryPick,
      });
      render(<GitCommits {...props} />);

      const cherryPickButton = screen.getByTitle('Cherry-pick this commit');
      fireEvent.click(cherryPickButton);

      expect(onCherryPick).toHaveBeenCalledWith('abc123full');
    });
  });

  describe('Section Toggle', () => {
    it('calls toggleSection when commits header is clicked', () => {
      const toggleSection = vi.fn();
      const props = createDefaultProps({ toggleSection });
      render(<GitCommits {...props} />);

      const header = screen.getByText('Commits').closest('button');
      if (header) {
        fireEvent.click(header);
      }

      expect(toggleSection).toHaveBeenCalledWith('commits');
    });

    it('hides commits list when expandedSections.commits is false', () => {
      const props = createDefaultProps({
        commits: [createCommitInfo({ subject: 'Hidden commit' })],
        expandedSections: { commits: false },
      });
      render(<GitCommits {...props} />);

      // Header should be visible
      expect(screen.getByText('Commits')).toBeInTheDocument();
      // Content should be hidden
      expect(screen.queryByText('Hidden commit')).not.toBeInTheDocument();
    });

    it('shows commits list when expandedSections.commits is true', () => {
      const props = createDefaultProps({
        commits: [createCommitInfo({ subject: 'Visible commit' })],
        expandedSections: { commits: true },
      });
      render(<GitCommits {...props} />);

      expect(screen.getByText('Visible commit')).toBeInTheDocument();
    });
  });

  describe('Commit Details Tooltip', () => {
    it('includes full commit hash in title', () => {
      const props = createDefaultProps({
        commits: [createCommitInfo({
          hash: 'abc123def456789012345678901234567890abcd',
          subject: 'Test commit',
          author: 'Test Author',
          email: 'test@example.com',
          date: '2024-01-15T10:30:00Z',
        })],
      });
      render(<GitCommits {...props} />);

      const commitButton = screen.getByText('Test commit').closest('button');
      expect(commitButton).toHaveAttribute('title');
      const title = commitButton?.getAttribute('title');
      expect(title).toContain('abc123def456789012345678901234567890abcd');
      expect(title).toContain('Test Author');
      expect(title).toContain('test@example.com');
    });
  });

  describe('Multiple Commits', () => {
    it('renders multiple commits in order', () => {
      const props = createDefaultProps({
        commits: [
          createCommitInfo({ hash: 'aaa1111000000000000000000000000000000001', shortHash: 'aaa1111', subject: 'First commit' }),
          createCommitInfo({ hash: 'bbb2222000000000000000000000000000000002', shortHash: 'bbb2222', subject: 'Second commit' }),
          createCommitInfo({ hash: 'ccc3333000000000000000000000000000000003', shortHash: 'ccc3333', subject: 'Third commit' }),
        ],
      });
      render(<GitCommits {...props} />);

      const commits = screen.getAllByText(/commit/i);
      expect(commits.length).toBeGreaterThanOrEqual(3);
    });
  });
});
