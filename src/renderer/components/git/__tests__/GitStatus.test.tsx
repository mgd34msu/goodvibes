// ============================================================================
// GIT STATUS COMPONENT TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitStatus } from '../GitStatus';
import type { GitFileChange } from '../types';

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

// Default props for the GitStatus component
function createDefaultProps(overrides: Partial<Parameters<typeof GitStatus>[0]> = {}) {
  return {
    staged: [] as GitFileChange[],
    unstaged: [] as GitFileChange[],
    untracked: [] as GitFileChange[],
    expandedSections: {
      staged: true,
      unstaged: true,
      untracked: true,
    },
    toggleSection: vi.fn(),
    onStage: vi.fn().mockResolvedValue(undefined),
    onUnstage: vi.fn().mockResolvedValue(undefined),
    onStageAll: vi.fn().mockResolvedValue(undefined),
    onUnstageAll: vi.fn().mockResolvedValue(undefined),
    onDiscard: vi.fn().mockResolvedValue(undefined),
    onViewDiff: vi.fn(),
    onViewBlame: vi.fn(),
    onViewFileHistory: vi.fn(),
    ...overrides,
  };
}

describe('GitStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Empty State', () => {
    it('displays "Working tree clean" when no changes exist', () => {
      const props = createDefaultProps();
      render(<GitStatus {...props} />);

      expect(screen.getByText('Working tree clean')).toBeInTheDocument();
    });

    it('does not render file sections when no changes exist', () => {
      const props = createDefaultProps();
      render(<GitStatus {...props} />);

      expect(screen.queryByText('Staged Changes')).not.toBeInTheDocument();
      expect(screen.queryByText('Changes')).not.toBeInTheDocument();
      expect(screen.queryByText('Untracked')).not.toBeInTheDocument();
    });
  });

  describe('Staged Changes Section', () => {
    it('renders staged changes section with correct count', () => {
      const props = createDefaultProps({
        staged: [
          createFileChange({ file: 'src/app.ts', status: 'modified', staged: true }),
          createFileChange({ file: 'src/utils.ts', status: 'added', staged: true }),
        ],
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('Staged Changes')).toBeInTheDocument();
      expect(screen.getByText('(2)')).toBeInTheDocument();
    });

    it('displays staged files in the list', () => {
      const props = createDefaultProps({
        staged: [
          createFileChange({ file: 'src/components/Button.tsx', status: 'modified', staged: true }),
        ],
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
      expect(screen.getByText('src/components')).toBeInTheDocument();
    });

    it('shows correct status icon for modified files', () => {
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'modified.ts', status: 'modified', staged: true })],
      });
      render(<GitStatus {...props} />);

      // Look for the 'M' status indicator
      const statusIcon = screen.getByText('M');
      expect(statusIcon).toBeInTheDocument();
    });

    it('shows correct status icon for added files', () => {
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'new.ts', status: 'added', staged: true })],
      });
      render(<GitStatus {...props} />);

      const statusIcon = screen.getByText('A');
      expect(statusIcon).toBeInTheDocument();
    });

    it('shows correct status icon for deleted files', () => {
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'removed.ts', status: 'deleted', staged: true })],
      });
      render(<GitStatus {...props} />);

      const statusIcon = screen.getByText('D');
      expect(statusIcon).toBeInTheDocument();
    });

    it('calls onUnstageAll when "- All" button is clicked', () => {
      const onUnstageAll = vi.fn().mockResolvedValue(undefined);
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'test.ts', staged: true })],
        onUnstageAll,
      });
      render(<GitStatus {...props} />);

      const unstageAllButton = screen.getByTitle('Unstage all');
      fireEvent.click(unstageAllButton);

      expect(onUnstageAll).toHaveBeenCalledTimes(1);
    });

    it('toggles staged section when header is clicked', () => {
      const toggleSection = vi.fn();
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'test.ts', staged: true })],
        toggleSection,
      });
      render(<GitStatus {...props} />);

      const sectionHeader = screen.getByText('Staged Changes').closest('[role="button"]');
      expect(sectionHeader).toBeInTheDocument();
      if (sectionHeader) {
        fireEvent.click(sectionHeader);
      }

      expect(toggleSection).toHaveBeenCalledWith('staged');
    });
  });

  describe('Unstaged Changes Section', () => {
    it('renders unstaged changes section with correct count', () => {
      const props = createDefaultProps({
        unstaged: [
          createFileChange({ file: 'src/app.ts', status: 'modified' }),
          createFileChange({ file: 'src/utils.ts', status: 'modified' }),
          createFileChange({ file: 'src/helper.ts', status: 'modified' }),
        ],
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('Changes')).toBeInTheDocument();
      expect(screen.getByText('(3)')).toBeInTheDocument();
    });

    it('calls onStageAll when "+ All" button is clicked', () => {
      const onStageAll = vi.fn().mockResolvedValue(undefined);
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts' })],
        onStageAll,
      });
      render(<GitStatus {...props} />);

      const stageAllButton = screen.getByTitle('Stage all');
      fireEvent.click(stageAllButton);

      expect(onStageAll).toHaveBeenCalledTimes(1);
    });

    it('shows stage and discard buttons on file hover', () => {
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts', status: 'modified' })],
      });
      render(<GitStatus {...props} />);

      // The buttons are present but may be visually hidden until hover
      const stageButton = screen.getByTitle('Stage');
      const discardButton = screen.getByTitle('Discard');

      expect(stageButton).toBeInTheDocument();
      expect(discardButton).toBeInTheDocument();
    });

    it('calls onStage when stage button is clicked', () => {
      const onStage = vi.fn().mockResolvedValue(undefined);
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts', status: 'modified' })],
        onStage,
      });
      render(<GitStatus {...props} />);

      const stageButton = screen.getByTitle('Stage');
      fireEvent.click(stageButton);

      expect(onStage).toHaveBeenCalledWith(['test.ts']);
    });

    it('calls onDiscard when discard button is clicked', () => {
      const onDiscard = vi.fn().mockResolvedValue(undefined);
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts', status: 'modified' })],
        onDiscard,
      });
      render(<GitStatus {...props} />);

      const discardButton = screen.getByTitle('Discard');
      fireEvent.click(discardButton);

      expect(onDiscard).toHaveBeenCalledWith('test.ts', false);
    });
  });

  describe('Untracked Files Section', () => {
    it('renders untracked files section with correct count', () => {
      const props = createDefaultProps({
        untracked: [
          createFileChange({ file: 'new-file.ts', status: 'untracked' }),
        ],
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('Untracked')).toBeInTheDocument();
      expect(screen.getByText('(1)')).toBeInTheDocument();
    });

    it('shows U status icon for untracked files', () => {
      const props = createDefaultProps({
        untracked: [createFileChange({ file: 'new.ts', status: 'untracked' })],
      });
      render(<GitStatus {...props} />);

      const statusIcon = screen.getByText('U');
      expect(statusIcon).toBeInTheDocument();
    });

    it('calls onStage with all untracked files when "+ All" button is clicked', () => {
      const onStage = vi.fn().mockResolvedValue(undefined);
      const props = createDefaultProps({
        untracked: [
          createFileChange({ file: 'new1.ts', status: 'untracked' }),
          createFileChange({ file: 'new2.ts', status: 'untracked' }),
        ],
        onStage,
      });
      render(<GitStatus {...props} />);

      const stageAllButton = screen.getByTitle('Stage all untracked');
      fireEvent.click(stageAllButton);

      expect(onStage).toHaveBeenCalledWith(['new1.ts', 'new2.ts']);
    });

    it('calls onDiscard with isUntracked=true for untracked files', () => {
      const onDiscard = vi.fn().mockResolvedValue(undefined);
      const props = createDefaultProps({
        untracked: [createFileChange({ file: 'new.ts', status: 'untracked' })],
        onDiscard,
      });
      render(<GitStatus {...props} />);

      const discardButton = screen.getByTitle('Discard');
      fireEvent.click(discardButton);

      expect(onDiscard).toHaveBeenCalledWith('new.ts', true);
    });
  });

  describe('File Actions', () => {
    it('calls onViewDiff when file name is clicked for modified files', () => {
      const onViewDiff = vi.fn();
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts', status: 'modified' })],
        onViewDiff,
      });
      render(<GitStatus {...props} />);

      // Click the file name button
      const fileButton = screen.getByText('test.ts');
      fireEvent.click(fileButton);

      expect(onViewDiff).toHaveBeenCalledWith('test.ts', false);
    });

    it('does not call onViewDiff for untracked files when clicked', () => {
      const onViewDiff = vi.fn();
      const props = createDefaultProps({
        untracked: [createFileChange({ file: 'new.ts', status: 'untracked' })],
        onViewDiff,
      });
      render(<GitStatus {...props} />);

      // Click the file name button - it should be disabled for untracked files
      const fileButton = screen.getByText('new.ts');
      fireEvent.click(fileButton);

      expect(onViewDiff).not.toHaveBeenCalled();
    });

    it('calls onViewBlame when blame button is clicked', () => {
      const onViewBlame = vi.fn();
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts', status: 'modified' })],
        onViewBlame,
      });
      render(<GitStatus {...props} />);

      const blameButton = screen.getByTitle('Blame');
      fireEvent.click(blameButton);

      expect(onViewBlame).toHaveBeenCalledWith('test.ts');
    });

    it('calls onViewFileHistory when history button is clicked', () => {
      const onViewFileHistory = vi.fn();
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'test.ts', status: 'modified' })],
        onViewFileHistory,
      });
      render(<GitStatus {...props} />);

      const historyButton = screen.getByTitle('History');
      fireEvent.click(historyButton);

      expect(onViewFileHistory).toHaveBeenCalledWith('test.ts');
    });

    it('does not show blame and history buttons for untracked files', () => {
      const props = createDefaultProps({
        untracked: [createFileChange({ file: 'new.ts', status: 'untracked' })],
      });
      render(<GitStatus {...props} />);

      expect(screen.queryByTitle('Blame')).not.toBeInTheDocument();
      expect(screen.queryByTitle('History')).not.toBeInTheDocument();
    });
  });

  describe('Section Expansion', () => {
    it('hides file list when section is collapsed', () => {
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'test.ts', staged: true })],
        expandedSections: {
          staged: false,
          unstaged: true,
          untracked: true,
        },
      });
      render(<GitStatus {...props} />);

      // The section header should be visible
      expect(screen.getByText('Staged Changes')).toBeInTheDocument();
      // But the file should not be visible
      expect(screen.queryByText('test.ts')).not.toBeInTheDocument();
    });

    it('shows file list when section is expanded', () => {
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'test.ts', staged: true })],
        expandedSections: {
          staged: true,
          unstaged: true,
          untracked: true,
        },
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('test.ts')).toBeInTheDocument();
    });
  });

  describe('Keyboard Accessibility', () => {
    it('toggles section on Enter key press', () => {
      const toggleSection = vi.fn();
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'test.ts', staged: true })],
        toggleSection,
      });
      render(<GitStatus {...props} />);

      const sectionHeader = screen.getByText('Staged Changes').closest('[role="button"]');
      expect(sectionHeader).toBeInTheDocument();
      if (sectionHeader) {
        fireEvent.keyDown(sectionHeader, { key: 'Enter' });
      }

      expect(toggleSection).toHaveBeenCalledWith('staged');
    });

    it('toggles section on Space key press', () => {
      const toggleSection = vi.fn();
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'test.ts', staged: true })],
        toggleSection,
      });
      render(<GitStatus {...props} />);

      const sectionHeader = screen.getByText('Staged Changes').closest('[role="button"]');
      expect(sectionHeader).toBeInTheDocument();
      if (sectionHeader) {
        fireEvent.keyDown(sectionHeader, { key: ' ' });
      }

      expect(toggleSection).toHaveBeenCalledWith('staged');
    });
  });

  describe('File Path Display', () => {
    it('displays only filename when file is in root', () => {
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'README.md', status: 'modified' })],
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('README.md')).toBeInTheDocument();
    });

    it('displays filename and directory path separately for nested files', () => {
      const props = createDefaultProps({
        unstaged: [createFileChange({ file: 'src/components/Button.tsx', status: 'modified' })],
      });
      render(<GitStatus {...props} />);

      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
      expect(screen.getByText('src/components')).toBeInTheDocument();
    });
  });

  describe('Renamed Files', () => {
    it('shows R status icon for renamed files', () => {
      const props = createDefaultProps({
        staged: [createFileChange({ file: 'newName.ts', status: 'renamed', originalPath: 'oldName.ts', staged: true })],
      });
      render(<GitStatus {...props} />);

      const statusIcon = screen.getByText('R');
      expect(statusIcon).toBeInTheDocument();
    });
  });
});
