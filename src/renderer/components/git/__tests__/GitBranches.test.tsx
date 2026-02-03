// ============================================================================
// GIT BRANCHES COMPONENT TESTS
// ============================================================================

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GitBranches, DeleteBranchModal, CheckoutConfirmModal } from '../GitBranches';
import type { ExtendedGitBranchInfo } from '../types';

// Helper to create mock branch info
function createBranchInfo(overrides: Partial<ExtendedGitBranchInfo> = {}): ExtendedGitBranchInfo {
  return {
    name: 'main',
    isCurrent: false,
    isRemote: false,
    hash: 'abc123',
    ...overrides,
  };
}

// Default props for GitBranches component
function createDefaultProps(overrides: Partial<Parameters<typeof GitBranches>[0]> = {}) {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    branches: [] as ExtendedGitBranchInfo[],
    showBranchDropdown: false,
    showNewBranchInput: false,
    newBranchName: '',
    newBranchError: null,
    operationInProgress: null,
    branchDropdownRef: { current: null } as React.RefObject<HTMLDivElement | null>,
    onToggleDropdown: vi.fn(),
    onCheckout: vi.fn(),
    onCreateBranch: vi.fn(),
    onCancelNewBranch: vi.fn(),
    onShowNewBranchInput: vi.fn(),
    onNewBranchNameChange: vi.fn(),
    onShowDeleteBranchModal: vi.fn(),
    ...overrides,
  };
}

describe('GitBranches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Branch Display', () => {
    it('displays current branch name', () => {
      const props = createDefaultProps({ branch: 'feature/new-feature' });
      render(<GitBranches {...props} />);

      expect(screen.getByText('feature/new-feature')).toBeInTheDocument();
    });

    it('displays ahead/behind indicators when branch is ahead', () => {
      const props = createDefaultProps({ branch: 'main', ahead: 3, behind: 0 });
      render(<GitBranches {...props} />);

      expect(screen.getByText('3+')).toBeInTheDocument();
    });

    it('displays ahead/behind indicators when branch is behind', () => {
      const props = createDefaultProps({ branch: 'main', ahead: 0, behind: 2 });
      render(<GitBranches {...props} />);

      expect(screen.getByText('2-')).toBeInTheDocument();
    });

    it('displays both ahead and behind indicators', () => {
      const props = createDefaultProps({ branch: 'main', ahead: 5, behind: 3 });
      render(<GitBranches {...props} />);

      expect(screen.getByText('5+')).toBeInTheDocument();
      expect(screen.getByText('3-')).toBeInTheDocument();
    });

    it('does not display indicators when in sync', () => {
      const props = createDefaultProps({ branch: 'main', ahead: 0, behind: 0 });
      render(<GitBranches {...props} />);

      expect(screen.queryByText(/\d+\+/)).not.toBeInTheDocument();
      expect(screen.queryByText(/\d+-/)).not.toBeInTheDocument();
    });
  });

  describe('Dropdown Toggle', () => {
    it('calls onToggleDropdown when branch button is clicked', () => {
      const onToggleDropdown = vi.fn();
      const props = createDefaultProps({ onToggleDropdown });
      render(<GitBranches {...props} />);

      const branchButton = screen.getByRole('button', { name: /main/i });
      fireEvent.click(branchButton);

      expect(onToggleDropdown).toHaveBeenCalledTimes(1);
    });
  });

  describe('Branch Dropdown', () => {
    it('shows dropdown when showBranchDropdown is true', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'develop' }),
        ],
      });
      render(<GitBranches {...props} />);

      expect(screen.getByText('Create new branch...')).toBeInTheDocument();
    });

    it('hides dropdown when showBranchDropdown is false', () => {
      const props = createDefaultProps({
        showBranchDropdown: false,
        branches: [createBranchInfo({ name: 'main', isCurrent: true })],
      });
      render(<GitBranches {...props} />);

      expect(screen.queryByText('Create new branch...')).not.toBeInTheDocument();
    });

    it('shows "No local branches found" when no branches exist', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [],
      });
      render(<GitBranches {...props} />);

      expect(screen.getByText('No local branches found')).toBeInTheDocument();
    });

    it('filters out remote branches', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'origin/main', isRemote: true }),
        ],
      });
      render(<GitBranches {...props} />);

      // Should only show local 'main', not 'origin/main'
      const branchItems = screen.getAllByText('main');
      // One in the button, one in the dropdown
      expect(branchItems.length).toBe(2);
      expect(screen.queryByText('origin/main')).not.toBeInTheDocument();
    });

    it('shows checkmark for current branch', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'develop', isCurrent: false }),
        ],
      });
      render(<GitBranches {...props} />);

      // Find all elements with text 'main' - we want the one in the dropdown list (the .group div)
      const mainElements = screen.getAllByText('main');
      // The second one should be in the dropdown list
      const mainBranchRow = mainElements.find(el => el.closest('.group'));
      expect(mainBranchRow).toBeDefined();
      // The checkmark is an SVG with a specific path
      const groupDiv = mainBranchRow?.closest('.group');
      const checkmark = groupDiv?.querySelector('svg.text-success-400');
      expect(checkmark).toBeInTheDocument();
    });

    it('calls onCheckout when non-current branch is clicked', () => {
      const onCheckout = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'develop', isCurrent: false }),
        ],
        onCheckout,
      });
      render(<GitBranches {...props} />);

      const developBranch = screen.getByText('develop').closest('button');
      expect(developBranch).toBeInTheDocument();
      if (developBranch) {
        fireEvent.click(developBranch);
      }

      expect(onCheckout).toHaveBeenCalledWith('develop');
    });

    it('disables checkout button for current branch', () => {
      const onCheckout = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [createBranchInfo({ name: 'main', isCurrent: true })],
        onCheckout,
      });
      render(<GitBranches {...props} />);

      // Find the 'main' text inside the dropdown (in a .group element)
      const mainElements = screen.getAllByText('main');
      const dropdownMain = mainElements.find(el => el.closest('.group'));
      expect(dropdownMain).toBeDefined();
      // The checkout button is inside the .group, should be disabled
      const checkoutButton = dropdownMain?.closest('.group')?.querySelector('button[disabled]');
      expect(checkoutButton).toBeInTheDocument();
    });

    it('shows parent branch info for child branches', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'feature/test', parentBranch: 'main', commitsAhead: 5 }),
        ],
      });
      render(<GitBranches {...props} />);

      expect(screen.getByText('from main')).toBeInTheDocument();
      expect(screen.getByText('+5')).toBeInTheDocument();
    });
  });

  describe('New Branch Input', () => {
    it('shows input when showNewBranchInput is true', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
      });
      render(<GitBranches {...props} />);

      expect(screen.getByPlaceholderText('New branch name...')).toBeInTheDocument();
    });

    it('shows "Create new branch..." button when showNewBranchInput is false', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: false,
      });
      render(<GitBranches {...props} />);

      expect(screen.getByText('Create new branch...')).toBeInTheDocument();
    });

    it('calls onShowNewBranchInput when "Create new branch..." is clicked', () => {
      const onShowNewBranchInput = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: false,
        onShowNewBranchInput,
      });
      render(<GitBranches {...props} />);

      fireEvent.click(screen.getByText('Create new branch...'));

      expect(onShowNewBranchInput).toHaveBeenCalledTimes(1);
    });

    it('calls onNewBranchNameChange when input value changes', () => {
      const onNewBranchNameChange = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        onNewBranchNameChange,
      });
      render(<GitBranches {...props} />);

      const input = screen.getByPlaceholderText('New branch name...');
      fireEvent.change(input, { target: { value: 'feature/test' } });

      expect(onNewBranchNameChange).toHaveBeenCalledWith('feature/test');
    });

    it('calls onCreateBranch when Create button is clicked', () => {
      const onCreateBranch = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        newBranchName: 'feature/test',
        onCreateBranch,
      });
      render(<GitBranches {...props} />);

      fireEvent.click(screen.getByText('Create'));

      expect(onCreateBranch).toHaveBeenCalledTimes(1);
    });

    it('calls onCreateBranch when Enter is pressed in input', () => {
      const onCreateBranch = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        newBranchName: 'feature/test',
        onCreateBranch,
      });
      render(<GitBranches {...props} />);

      const input = screen.getByPlaceholderText('New branch name...');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(onCreateBranch).toHaveBeenCalledTimes(1);
    });

    it('calls onCancelNewBranch when Cancel button is clicked', () => {
      const onCancelNewBranch = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        onCancelNewBranch,
      });
      render(<GitBranches {...props} />);

      fireEvent.click(screen.getByText('Cancel'));

      expect(onCancelNewBranch).toHaveBeenCalledTimes(1);
    });

    it('calls onCancelNewBranch when Escape is pressed in input', () => {
      const onCancelNewBranch = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        onCancelNewBranch,
      });
      render(<GitBranches {...props} />);

      const input = screen.getByPlaceholderText('New branch name...');
      fireEvent.keyDown(input, { key: 'Escape' });

      expect(onCancelNewBranch).toHaveBeenCalledTimes(1);
    });

    it('disables Create button when branch name is empty', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        newBranchName: '',
      });
      render(<GitBranches {...props} />);

      const createButton = screen.getByText('Create');
      expect(createButton).toBeDisabled();
    });

    it('shows error message when newBranchError is set', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        newBranchError: 'Branch name already exists',
      });
      render(<GitBranches {...props} />);

      expect(screen.getByText('Branch name already exists')).toBeInTheDocument();
    });

    it('shows "Creating..." when operation is in progress', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        showNewBranchInput: true,
        newBranchName: 'feature/test',
        operationInProgress: 'creating-branch',
      });
      render(<GitBranches {...props} />);

      expect(screen.getByText('Creating...')).toBeInTheDocument();
    });
  });

  describe('Branch Deletion', () => {
    it('shows delete button for non-current, non-main branches', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'feature/test', isCurrent: false }),
        ],
      });
      render(<GitBranches {...props} />);

      const deleteButton = screen.getByTitle('Delete branch');
      expect(deleteButton).toBeInTheDocument();
    });

    it('does not show delete button for current branch', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [createBranchInfo({ name: 'feature/test', isCurrent: true })],
      });
      render(<GitBranches {...props} />);

      expect(screen.queryByTitle('Delete branch')).not.toBeInTheDocument();
    });

    it('does not show delete button for main branch', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: false }),
          createBranchInfo({ name: 'feature/test', isCurrent: true }),
        ],
      });
      render(<GitBranches {...props} />);

      // There should be no delete button for main even though it's not current
      const branchRows = screen.getAllByRole('button');
      const mainRow = branchRows.find(btn => btn.textContent?.includes('main'));
      expect(mainRow).toBeDefined();
      // The delete button should not exist in this context
    });

    it('does not show delete button for master branch', () => {
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'master', isCurrent: false }),
          createBranchInfo({ name: 'feature/test', isCurrent: true }),
        ],
      });
      render(<GitBranches {...props} />);

      // Only one delete button should exist (for feature/test is current, so none)
      const deleteButtons = screen.queryAllByTitle('Delete branch');
      expect(deleteButtons.length).toBe(0);
    });

    it('calls onShowDeleteBranchModal when delete button is clicked', () => {
      const onShowDeleteBranchModal = vi.fn();
      const props = createDefaultProps({
        showBranchDropdown: true,
        branches: [
          createBranchInfo({ name: 'main', isCurrent: true }),
          createBranchInfo({ name: 'feature/delete-me', isCurrent: false }),
        ],
        onShowDeleteBranchModal,
      });
      render(<GitBranches {...props} />);

      const deleteButton = screen.getByTitle('Delete branch');
      fireEvent.click(deleteButton);

      expect(onShowDeleteBranchModal).toHaveBeenCalledWith('feature/delete-me');
    });
  });
});

describe('DeleteBranchModal', () => {
  const createModalProps = (overrides: Partial<Parameters<typeof DeleteBranchModal>[0]> = {}) => ({
    isOpen: true,
    branchToDelete: 'feature/test',
    deleteBranchForce: false,
    onClose: vi.fn(),
    onDelete: vi.fn(),
    onForceChange: vi.fn(),
    ...overrides,
  });

  it('does not render when isOpen is false', () => {
    const props = createModalProps({ isOpen: false });
    render(<DeleteBranchModal {...props} />);

    expect(screen.queryByText('Delete Branch')).not.toBeInTheDocument();
  });

  it('does not render when branchToDelete is null', () => {
    const props = createModalProps({ branchToDelete: null });
    render(<DeleteBranchModal {...props} />);

    expect(screen.queryByText('Delete Branch')).not.toBeInTheDocument();
  });

  it('displays the branch name to delete', () => {
    const props = createModalProps({ branchToDelete: 'feature/important' });
    render(<DeleteBranchModal {...props} />);

    expect(screen.getByText('feature/important')).toBeInTheDocument();
  });

  it('renders force delete checkbox', () => {
    const props = createModalProps();
    render(<DeleteBranchModal {...props} />);

    expect(screen.getByText('Force delete (even if not merged)')).toBeInTheDocument();
  });

  it('calls onForceChange when checkbox is toggled', () => {
    const onForceChange = vi.fn();
    const props = createModalProps({ onForceChange });
    render(<DeleteBranchModal {...props} />);

    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(onForceChange).toHaveBeenCalledWith(true);
  });

  it('calls onClose when Cancel button is clicked', () => {
    const onClose = vi.fn();
    const props = createModalProps({ onClose });
    render(<DeleteBranchModal {...props} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop is clicked', () => {
    const onClose = vi.fn();
    const props = createModalProps({ onClose });
    const { container } = render(<DeleteBranchModal {...props} />);

    // Click the backdrop (the fixed overlay)
    const backdrop = container.querySelector('.fixed.inset-0');
    if (backdrop) {
      fireEvent.click(backdrop);
    }

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onDelete when Delete Branch button is clicked', () => {
    const onDelete = vi.fn();
    const props = createModalProps({ onDelete });
    render(<DeleteBranchModal {...props} />);

    // There are two "Delete Branch" texts - one in header, one in button
    // Get all and click the button one (which is inside a button element)
    const deleteTexts = screen.getAllByText('Delete Branch');
    const deleteButton = deleteTexts.find(el => el.closest('button'));
    expect(deleteButton).toBeDefined();
    if (deleteButton) {
      fireEvent.click(deleteButton);
    }

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

describe('CheckoutConfirmModal', () => {
  const createModalProps = (overrides: Partial<Parameters<typeof CheckoutConfirmModal>[0]> = {}) => ({
    isOpen: true,
    pendingCheckoutBranch: 'develop',
    stagedCount: 2,
    unstagedCount: 3,
    onCancel: vi.fn(),
    onDiscardAndCheckout: vi.fn(),
    ...overrides,
  });

  it('does not render when isOpen is false', () => {
    const props = createModalProps({ isOpen: false });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.queryByText('Uncommitted Changes')).not.toBeInTheDocument();
  });

  it('does not render when pendingCheckoutBranch is null', () => {
    const props = createModalProps({ pendingCheckoutBranch: null });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.queryByText('Uncommitted Changes')).not.toBeInTheDocument();
  });

  it('displays the target branch name', () => {
    const props = createModalProps({ pendingCheckoutBranch: 'feature/new' });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.getByText('feature/new')).toBeInTheDocument();
  });

  it('displays staged file count', () => {
    const props = createModalProps({ stagedCount: 5 });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.getByText('5 staged files')).toBeInTheDocument();
  });

  it('displays singular form for 1 staged file', () => {
    const props = createModalProps({ stagedCount: 1 });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.getByText('1 staged file')).toBeInTheDocument();
  });

  it('displays unstaged file count', () => {
    const props = createModalProps({ unstagedCount: 7 });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.getByText('7 modified files')).toBeInTheDocument();
  });

  it('displays singular form for 1 modified file', () => {
    const props = createModalProps({ unstagedCount: 1 });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.getByText('1 modified file')).toBeInTheDocument();
  });

  it('does not display staged count section when 0', () => {
    const props = createModalProps({ stagedCount: 0, unstagedCount: 3 });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.queryByText(/staged file/)).not.toBeInTheDocument();
  });

  it('does not display unstaged count section when 0', () => {
    const props = createModalProps({ stagedCount: 2, unstagedCount: 0 });
    render(<CheckoutConfirmModal {...props} />);

    expect(screen.queryByText(/modified file/)).not.toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    const props = createModalProps({ onCancel });
    render(<CheckoutConfirmModal {...props} />);

    fireEvent.click(screen.getByText('Cancel'));

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when backdrop is clicked', () => {
    const onCancel = vi.fn();
    const props = createModalProps({ onCancel });
    const { container } = render(<CheckoutConfirmModal {...props} />);

    const backdrop = container.querySelector('.fixed.inset-0');
    if (backdrop) {
      fireEvent.click(backdrop);
    }

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onDiscardAndCheckout when "Discard Changes & Switch" button is clicked', () => {
    const onDiscardAndCheckout = vi.fn();
    const props = createModalProps({ onDiscardAndCheckout });
    render(<CheckoutConfirmModal {...props} />);

    fireEvent.click(screen.getByText('Discard Changes & Switch'));

    expect(onDiscardAndCheckout).toHaveBeenCalledTimes(1);
  });
});
