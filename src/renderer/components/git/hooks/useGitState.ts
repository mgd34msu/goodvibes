// ============================================================================
// USE GIT STATE HOOK - Centralized state management for GitPanel
// Composes focused hooks for different Git operations
// ============================================================================

import { useCallback, useEffect, useState } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import {
  GitPanelState,
  initialGitPanelState,
} from '../types';

import { formatRelativeTime } from './types';
import { useGitStatus } from './useGitStatus';
import { useGitBranches } from './useGitBranches';
import { useGitCommits } from './useGitCommits';
import { useGitRemote } from './useGitRemote';
import { useGitViews } from './useGitViews';
import { useGitUI } from './useGitUI';

// Re-export formatRelativeTime for backward compatibility
export { formatRelativeTime };

/**
 * Custom hook for managing Git panel state and operations
 * Composes multiple focused hooks together
 */
export function useGitState(cwd: string) {
  const gitAutoRefresh = useSettingsStore((s) => s.settings.gitAutoRefresh);
  const [state, setState] = useState<GitPanelState>(initialGitPanelState);

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

  // Auto-refresh (every 30 seconds when panel is open and window is focused)
  useEffect(() => {
    if (!gitAutoRefresh || !state.isRepo) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const startInterval = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(fetchGitInfo, 30000); // 30 seconds, not 3
    };

    const stopInterval = () => {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    };

    // Only refresh when window is focused
    const handleFocus = () => startInterval();
    const handleBlur = () => stopInterval();

    window.addEventListener('focus', handleFocus);
    window.addEventListener('blur', handleBlur);

    // Start if window is already focused
    if (document.hasFocus()) {
      startInterval();
    }

    return () => {
      stopInterval();
      window.removeEventListener('focus', handleFocus);
      window.removeEventListener('blur', handleBlur);
    };
  }, [fetchGitInfo, gitAutoRefresh, state.isRepo]);

  // Base props for hooks
  const hookProps = { cwd, state, setState, fetchGitInfo };

  // Compose focused hooks
  const {
    branchDropdownRef,
    toggleSection,
    totalChanges,
  } = useGitUI(state, setState);

  const {
    handleStage,
    handleUnstage,
    handleStageAll,
    handleUnstageAll,
    handleDiscard,
  } = useGitStatus(hookProps);

  const {
    localBranches,
    handleCheckout,
    performCheckout,
    handleDiscardAndCheckout,
    handleCancelCheckout,
    handleCreateBranch,
    handleCancelNewBranch,
    handleDeleteBranch,
  } = useGitBranches(hookProps);

  const {
    handleCommit,
    handleCommitWithAmend,
    handleViewCommit,
    handleCloseCommitDetail,
    handleConventionalPrefix,
  } = useGitCommits(hookProps);

  const {
    handlePush,
    handlePull,
    handleFetch,
  } = useGitRemote(hookProps);

  const {
    handleViewDiff,
    handleCloseDiffModal,
    handleViewFileHistory,
    handleViewBlame,
    handleViewReflog,
  } = useGitViews({ cwd, state, setState });

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
