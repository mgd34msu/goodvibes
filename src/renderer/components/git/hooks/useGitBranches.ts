// ============================================================================
// USE GIT BRANCHES HOOK - Branch operations, checkout, create, delete
// ============================================================================

import { useCallback, useMemo } from 'react';
import { createLogger } from '../../../../shared/logger';
import type { ExtendedGitBranchInfo } from '../types';
import type { GitHookBaseProps, UseGitBranchesReturn } from './types';

const logger = createLogger('useGitBranches');

/**
 * Hook for managing Git branch operations
 */
export function useGitBranches({
  cwd,
  state,
  setState,
  fetchGitInfo,
}: GitHookBaseProps): UseGitBranchesReturn {
  // Sort branches: main/master first, then alphabetically but grouped by parent
  const localBranches = useMemo((): ExtendedGitBranchInfo[] => {
    const branches = state.branches.filter(b => !b.isRemote);

    // Separate main branches from others
    const mainBranches = branches.filter(b => b.name === 'main' || b.name === 'master');
    const otherBranches = branches.filter(b => b.name !== 'main' && b.name !== 'master');

    // Sort other branches: those without parents first, then by parent grouping
    const sortedOthers = otherBranches.sort((a, b) => {
      // Branches without parents come first (after main)
      if (!a.parentBranch && b.parentBranch) return -1;
      if (a.parentBranch && !b.parentBranch) return 1;

      // If same parent, sort alphabetically
      if (a.parentBranch === b.parentBranch) {
        return a.name.localeCompare(b.name);
      }

      // Group by parent: if a's parent is b's name, a comes after b
      if (a.parentBranch === b.name) return 1;
      if (b.parentBranch === a.name) return -1;

      // Otherwise sort alphabetically
      return a.name.localeCompare(b.name);
    });

    return [...mainBranches, ...sortedOthers];
  }, [state.branches]);

  const performCheckout = useCallback(async (branch: string) => {
    setState(prev => ({
      ...prev,
      operationInProgress: 'checkout',
      showBranchDropdown: false,
      showCheckoutConfirmModal: false,
      pendingCheckoutBranch: null,
    }));

    try {
      const result = await window.goodvibes.gitCheckout(cwd, branch);
      if (!result.success) {
        logger.error('Checkout failed:', result.error);
        setState(prev => ({
          ...prev,
          operationInProgress: null,
          error: `Checkout failed: ${result.error}`,
        }));
        setTimeout(() => {
          setState(prev => prev.error?.startsWith('Checkout failed') ? { ...prev, error: null } : prev);
        }, 5000);
        return;
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to checkout:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchGitInfo, setState]);

  const handleCheckout = useCallback(async (branch: string) => {
    const hasChanges = state.staged.length > 0 || state.unstaged.length > 0;

    if (hasChanges) {
      setState(prev => ({
        ...prev,
        showBranchDropdown: false,
        showCheckoutConfirmModal: true,
        pendingCheckoutBranch: branch,
      }));
      return;
    }

    await performCheckout(branch);
  }, [state.staged.length, state.unstaged.length, performCheckout, setState]);

  const handleDiscardAndCheckout = useCallback(async () => {
    const branch = state.pendingCheckoutBranch;
    if (!branch) return;

    setState(prev => ({
      ...prev,
      operationInProgress: 'discarding',
      showCheckoutConfirmModal: false,
    }));

    try {
      if (state.staged.length > 0) {
        await window.goodvibes.gitUnstage(cwd, state.staged.map(f => f.file));
      }

      const filesToDiscard = state.unstaged.filter(f => f.status !== 'untracked').map(f => f.file);
      if (filesToDiscard.length > 0) {
        await window.goodvibes.gitDiscardChanges(cwd, filesToDiscard);
      }

      await performCheckout(branch);
    } catch (err) {
      logger.error('Failed to discard changes:', err);
      setState(prev => ({
        ...prev,
        operationInProgress: null,
        pendingCheckoutBranch: null,
        error: 'Failed to discard changes',
      }));
    }
  }, [cwd, state.pendingCheckoutBranch, state.staged, state.unstaged, performCheckout, setState]);

  const handleCancelCheckout = useCallback(() => {
    setState(prev => ({
      ...prev,
      showCheckoutConfirmModal: false,
      pendingCheckoutBranch: null,
      operationInProgress: null,
    }));
  }, [setState]);

  const handleCreateBranch = useCallback(async () => {
    const branchName = state.newBranchName.trim();
    if (!branchName) return;

    setState(prev => ({ ...prev, newBranchError: null, operationInProgress: 'creating-branch' }));

    try {
      const result = await window.goodvibes.gitCreateBranch(cwd, branchName, true);
      if (result.success) {
        setState(prev => ({
          ...prev,
          newBranchName: '',
          showNewBranchInput: false,
          newBranchError: null,
          operationInProgress: null,
        }));
        await fetchGitInfo();
      } else {
        setState(prev => ({
          ...prev,
          newBranchError: result.error || 'Failed to create branch',
          operationInProgress: null,
        }));
      }
    } catch (err) {
      logger.error('Failed to create branch:', err);
      setState(prev => ({
        ...prev,
        newBranchError: 'An unexpected error occurred',
        operationInProgress: null,
      }));
    }
  }, [cwd, state.newBranchName, fetchGitInfo, setState]);

  const handleCancelNewBranch = useCallback(() => {
    setState(prev => ({
      ...prev,
      showNewBranchInput: false,
      newBranchName: '',
      newBranchError: null,
    }));
  }, [setState]);

  const handleDeleteBranch = useCallback(async () => {
    if (!state.branchToDelete) return;

    setState(prev => ({ ...prev, operationInProgress: 'deleting-branch' }));
    try {
      const result = await window.goodvibes.gitDeleteBranch(cwd, state.branchToDelete, {
        force: state.deleteBranchForce,
      });
      if (!result.success) {
        setState(prev => ({ ...prev, error: `Failed to delete branch: ${result.error}` }));
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to delete branch:', err);
    }
    setState(prev => ({
      ...prev,
      operationInProgress: null,
      showDeleteBranchModal: false,
      branchToDelete: null,
      deleteBranchForce: false,
    }));
  }, [cwd, state.branchToDelete, state.deleteBranchForce, fetchGitInfo, setState]);

  return {
    localBranches,
    handleCheckout,
    performCheckout,
    handleDiscardAndCheckout,
    handleCancelCheckout,
    handleCreateBranch,
    handleCancelNewBranch,
    handleDeleteBranch,
  };
}
