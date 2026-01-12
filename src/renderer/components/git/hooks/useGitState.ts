// ============================================================================
// USE GIT STATE HOOK - Centralized state management for GitPanel
// ============================================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import { createLogger } from '../../../../shared/logger';
import {
  GitPanelState,
  initialGitPanelState,
  ExpandedSections,
  ExtendedGitBranchInfo,
} from '../types';

const logger = createLogger('useGitState');

/**
 * Format a date string to relative time
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Custom hook for managing Git panel state and operations
 */
export function useGitState(cwd: string) {
  const gitAutoRefresh = useSettingsStore((s) => s.settings.gitAutoRefresh);
  const [state, setState] = useState<GitPanelState>(initialGitPanelState);
  const branchDropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (branchDropdownRef.current && !branchDropdownRef.current.contains(event.target as Node)) {
        setState(prev => ({ ...prev, showBranchDropdown: false }));
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch all git information
  const fetchGitInfo = useCallback(async () => {
    if (!cwd) return;

    try {
      const isRepo = await window.goodvibes.gitIsRepo(cwd);

      if (!isRepo) {
        setState(prev => ({
          ...prev,
          isRepo: false,
          isLoading: false,
          error: null,
        }));
        return;
      }

      // Fetch all git info in parallel
      const [
        detailedStatus,
        branchesResult,
        commitsResult,
        aheadBehindResult,
        stashResult,
        mergeInProgress,
        cherryPickInProgress,
        rebaseInProgress,
        tagsResult,
        conflictFilesResult,
        conventionalResult,
      ] = await Promise.all([
        window.goodvibes.gitDetailedStatus(cwd),
        window.goodvibes.gitBranches(cwd),
        window.goodvibes.gitLogDetailed(cwd, 10),
        window.goodvibes.gitAheadBehind(cwd),
        window.goodvibes.gitStashList(cwd),
        window.goodvibes.gitMergeInProgress(cwd),
        window.goodvibes.gitCherryPickInProgress(cwd),
        window.goodvibes.gitRebaseInProgress(cwd),
        window.goodvibes.gitTags(cwd),
        window.goodvibes.gitConflictFiles(cwd),
        window.goodvibes.gitConventionalPrefixes(cwd),
      ]);

      setState(prev => ({
        ...prev,
        isRepo: true,
        isLoading: false,
        error: null,
        branch: detailedStatus.branch || 'unknown',
        ahead: aheadBehindResult.ahead || 0,
        behind: aheadBehindResult.behind || 0,
        hasRemote: aheadBehindResult.hasRemote || false,
        hasUpstream: aheadBehindResult.hasUpstream || false,
        staged: detailedStatus.staged || [],
        unstaged: detailedStatus.unstaged || [],
        untracked: detailedStatus.untracked || [],
        branches: branchesResult.branches || [],
        commits: commitsResult.commits || [],
        stashes: stashResult.stashes || [],
        mergeInProgress: mergeInProgress || false,
        cherryPickInProgress: cherryPickInProgress || false,
        rebaseInProgress: rebaseInProgress || false,
        tags: tagsResult.tags || [],
        conflictFiles: conflictFilesResult.files || [],
        conventionalPrefixes: conventionalResult.prefixes || [],
      }));
    } catch (err) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Failed to fetch git info',
      }));
    }
  }, [cwd]);

  // Initial fetch
  useEffect(() => {
    fetchGitInfo();
  }, [fetchGitInfo]);

  // Auto-refresh (every 3 seconds when panel is open)
  useEffect(() => {
    if (!gitAutoRefresh || !state.isRepo) return;

    const interval = setInterval(fetchGitInfo, 3000);
    return () => clearInterval(interval);
  }, [fetchGitInfo, gitAutoRefresh, state.isRepo]);

  // Toggle section expand/collapse
  const toggleSection = useCallback((section: keyof ExpandedSections) => {
    setState(prev => ({
      ...prev,
      expandedSections: {
        ...prev.expandedSections,
        [section]: !prev.expandedSections[section],
      },
    }));
  }, []);

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

  // Total changes count
  const totalChanges = state.staged.length + state.unstaged.length + state.untracked.length;

  // ============================================================================
  // STAGING OPERATIONS
  // ============================================================================

  const handleStage = useCallback(async (files: string[]) => {
    setState(prev => ({ ...prev, operationInProgress: 'staging' }));
    try {
      await window.goodvibes.gitStage(cwd, files);
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to stage files:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchGitInfo]);

  const handleUnstage = useCallback(async (files: string[]) => {
    setState(prev => ({ ...prev, operationInProgress: 'unstaging' }));
    try {
      await window.goodvibes.gitUnstage(cwd, files);
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to unstage files:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchGitInfo]);

  const handleStageAll = useCallback(async () => {
    const allFiles = [...state.unstaged.map(f => f.file), ...state.untracked.map(f => f.file)];
    if (allFiles.length > 0) {
      await handleStage(allFiles);
    }
  }, [state.unstaged, state.untracked, handleStage]);

  const handleUnstageAll = useCallback(async () => {
    if (state.staged.length > 0) {
      await handleUnstage(state.staged.map(f => f.file));
    }
  }, [state.staged, handleUnstage]);

  const handleDiscard = useCallback(async (file: string, isUntracked: boolean) => {
    if (!confirm(`Discard changes to ${file}? This cannot be undone.`)) return;

    setState(prev => ({ ...prev, operationInProgress: 'discarding' }));
    try {
      if (isUntracked) {
        await window.goodvibes.gitCleanFile(cwd, file);
      } else {
        await window.goodvibes.gitDiscardChanges(cwd, [file]);
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to discard changes:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchGitInfo]);

  // ============================================================================
  // COMMIT OPERATIONS
  // ============================================================================

  const handleCommit = useCallback(async () => {
    if (!state.commitMessage.trim() || state.staged.length === 0) return;

    setState(prev => ({ ...prev, isCommitting: true }));
    try {
      const result = await window.goodvibes.gitCommit(cwd, state.commitMessage.trim());
      if (result.success) {
        setState(prev => ({ ...prev, commitMessage: '' }));
        await fetchGitInfo();
      } else {
        alert(`Commit failed: ${result.error}`);
      }
    } catch (err) {
      logger.error('Failed to commit:', err);
    }
    setState(prev => ({ ...prev, isCommitting: false }));
  }, [cwd, state.commitMessage, state.staged.length, fetchGitInfo]);

  const handleCommitWithAmend = useCallback(async () => {
    if (state.amendMode) {
      setState(prev => ({ ...prev, isCommitting: true }));
      try {
        const result = await window.goodvibes.gitCommitAmend(cwd, {
          message: state.commitMessage.trim() || undefined,
          noEdit: !state.commitMessage.trim(),
        });
        if (result.success) {
          setState(prev => ({ ...prev, commitMessage: '', amendMode: false }));
          await fetchGitInfo();
        } else {
          alert(`Amend failed: ${result.error}`);
        }
      } catch (err) {
        logger.error('Failed to amend:', err);
      }
      setState(prev => ({ ...prev, isCommitting: false }));
    } else {
      await handleCommit();
    }
  }, [cwd, state.amendMode, state.commitMessage, fetchGitInfo, handleCommit]);

  // ============================================================================
  // REMOTE OPERATIONS
  // ============================================================================

  const handlePush = useCallback(async () => {
    setState(prev => ({ ...prev, isPushing: true }));
    try {
      const result = await window.goodvibes.gitPush(cwd);
      if (!result.success) {
        alert(`Push failed: ${result.error}`);
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to push:', err);
    }
    setState(prev => ({ ...prev, isPushing: false }));
  }, [cwd, fetchGitInfo]);

  const handlePull = useCallback(async () => {
    setState(prev => ({ ...prev, isPulling: true }));
    try {
      const result = await window.goodvibes.gitPull(cwd);
      if (!result.success) {
        alert(`Pull failed: ${result.error}`);
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to pull:', err);
    }
    setState(prev => ({ ...prev, isPulling: false }));
  }, [cwd, fetchGitInfo]);

  const handleFetch = useCallback(async () => {
    setState(prev => ({ ...prev, isFetching: true }));
    try {
      await window.goodvibes.gitFetch(cwd);
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to fetch:', err);
    }
    setState(prev => ({ ...prev, isFetching: false }));
  }, [cwd, fetchGitInfo]);

  // ============================================================================
  // BRANCH OPERATIONS
  // ============================================================================

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
  }, [cwd, fetchGitInfo]);

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
  }, [state.staged.length, state.unstaged.length, performCheckout]);

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
  }, [cwd, state.pendingCheckoutBranch, state.staged, state.unstaged, performCheckout]);

  const handleCancelCheckout = useCallback(() => {
    setState(prev => ({
      ...prev,
      showCheckoutConfirmModal: false,
      pendingCheckoutBranch: null,
      operationInProgress: null,
    }));
  }, []);

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
  }, [cwd, state.newBranchName, fetchGitInfo]);

  const handleCancelNewBranch = useCallback(() => {
    setState(prev => ({
      ...prev,
      showNewBranchInput: false,
      newBranchName: '',
      newBranchError: null,
    }));
  }, []);

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
  }, [cwd, state.branchToDelete, state.deleteBranchForce, fetchGitInfo]);

  // ============================================================================
  // VIEW OPERATIONS
  // ============================================================================

  const handleViewCommit = useCallback(async (hash: string) => {
    setState(prev => ({ ...prev, isLoadingCommit: true, showCommitDetail: true }));
    try {
      const result = await window.goodvibes.gitShowCommit(cwd, hash);
      if (result.success && result.commit) {
        setState(prev => ({
          ...prev,
          selectedCommit: result.commit,
          isLoadingCommit: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingCommit: false,
          showCommitDetail: false,
        }));
        logger.error('Failed to load commit:', result.error);
      }
    } catch (err) {
      logger.error('Failed to load commit:', err);
      setState(prev => ({ ...prev, isLoadingCommit: false, showCommitDetail: false }));
    }
  }, [cwd]);

  const handleCloseCommitDetail = useCallback(() => {
    setState(prev => ({
      ...prev,
      showCommitDetail: false,
      selectedCommit: null,
    }));
  }, []);

  const handleViewDiff = useCallback(async (file: string, isStaged: boolean = false, commit?: string) => {
    setState(prev => ({
      ...prev,
      isLoadingDiff: true,
      showDiffModal: true,
      diffFile: file,
      diffIsStaged: isStaged,
      diffCommit: commit || null,
    }));
    try {
      const result = await window.goodvibes.gitDiffRaw(cwd, {
        file,
        staged: isStaged,
        commit,
      });
      if (result.success) {
        setState(prev => ({
          ...prev,
          diffContent: result.output || '(No differences)',
          isLoadingDiff: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          diffContent: `Error: ${result.error}`,
          isLoadingDiff: false,
        }));
      }
    } catch (err) {
      logger.error('Failed to load diff:', err);
      setState(prev => ({
        ...prev,
        diffContent: 'Failed to load diff',
        isLoadingDiff: false,
      }));
    }
  }, [cwd]);

  const handleCloseDiffModal = useCallback(() => {
    setState(prev => ({
      ...prev,
      showDiffModal: false,
      diffFile: null,
      diffContent: null,
      diffCommit: null,
    }));
  }, []);

  const handleViewFileHistory = useCallback(async (file: string) => {
    setState(prev => ({
      ...prev,
      showFileHistoryModal: true,
      fileHistoryFile: file,
      isLoadingFileHistory: true,
    }));
    try {
      const result = await window.goodvibes.gitFileHistory(cwd, file);
      if (result.success) {
        setState(prev => ({
          ...prev,
          fileHistoryCommits: result.commits,
          isLoadingFileHistory: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingFileHistory: false,
          error: `Failed to load file history: ${result.error}`,
        }));
      }
    } catch (err) {
      logger.error('Failed to load file history:', err);
      setState(prev => ({ ...prev, isLoadingFileHistory: false }));
    }
  }, [cwd]);

  const handleViewBlame = useCallback(async (file: string) => {
    setState(prev => ({
      ...prev,
      showBlameModal: true,
      blameFile: file,
      isLoadingBlame: true,
    }));
    try {
      const result = await window.goodvibes.gitBlame(cwd, file);
      if (result.success) {
        setState(prev => ({
          ...prev,
          blameLines: result.lines,
          isLoadingBlame: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingBlame: false,
          error: `Failed to load blame: ${result.error}`,
        }));
      }
    } catch (err) {
      logger.error('Failed to load blame:', err);
      setState(prev => ({ ...prev, isLoadingBlame: false }));
    }
  }, [cwd]);

  const handleViewReflog = useCallback(async () => {
    setState(prev => ({
      ...prev,
      showReflogModal: true,
      isLoadingReflog: true,
    }));
    try {
      const result = await window.goodvibes.gitReflog(cwd);
      if (result.success) {
        setState(prev => ({
          ...prev,
          reflogEntries: result.entries,
          isLoadingReflog: false,
        }));
      } else {
        setState(prev => ({
          ...prev,
          isLoadingReflog: false,
          error: `Failed to load reflog: ${result.error}`,
        }));
      }
    } catch (err) {
      logger.error('Failed to load reflog:', err);
      setState(prev => ({ ...prev, isLoadingReflog: false }));
    }
  }, [cwd]);

  // ============================================================================
  // CONVENTIONAL COMMITS
  // ============================================================================

  const handleConventionalPrefix = useCallback((prefix: string) => {
    setState(prev => {
      const currentMsg = prev.commitMessage;
      const hasPrefix = /^[a-z]+(\([^)]+\))?:/.test(currentMsg);
      if (hasPrefix) {
        return {
          ...prev,
          commitMessage: currentMsg.replace(/^[a-z]+(\([^)]+\))?:\s*/, `${prefix}: `),
          showConventionalDropdown: false,
        };
      } else {
        return {
          ...prev,
          commitMessage: `${prefix}: ${currentMsg}`,
          showConventionalDropdown: false,
        };
      }
    });
  }, []);

  return {
    state,
    setState,
    branchDropdownRef,
    localBranches,
    totalChanges,
    fetchGitInfo,
    toggleSection,
    formatRelativeTime,
    // Staging operations
    handleStage,
    handleUnstage,
    handleStageAll,
    handleUnstageAll,
    handleDiscard,
    // Commit operations
    handleCommit,
    handleCommitWithAmend,
    // Remote operations
    handlePush,
    handlePull,
    handleFetch,
    // Branch operations
    handleCheckout,
    performCheckout,
    handleDiscardAndCheckout,
    handleCancelCheckout,
    handleCreateBranch,
    handleCancelNewBranch,
    handleDeleteBranch,
    // View operations
    handleViewCommit,
    handleCloseCommitDetail,
    handleViewDiff,
    handleCloseDiffModal,
    handleViewFileHistory,
    handleViewBlame,
    handleViewReflog,
    // Conventional commits
    handleConventionalPrefix,
  };
}

export type UseGitStateReturn = ReturnType<typeof useGitState>;
