// ============================================================================
// USE GIT STATE HOOK - Centralized state management for GitPanel
// Composes focused hooks for different Git operations
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
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

// Forward-declared type - defined after the function
export type UseGitStateReturn = ReturnType<typeof useGitStateImpl>;

/**
 * Custom hook for managing Git panel state and operations
 * Composes multiple focused hooks together
 */
function useGitStateImpl(cwd: string) {
  const gitAutoRefresh = useSettingsStore((s) => s.settings.gitAutoRefresh);
  const [state, setState] = useState<GitPanelState>(initialGitPanelState);
  const lastRemoteFetchRef = useRef<number>(0);

  // Fetch LOCAL git information only (no remote calls)
  const fetchLocalGitInfo = useCallback(async () => {
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

      // Fetch only LOCAL git info in parallel (no gitAheadBehind - that's remote)
      const [
        detailedStatus,
        branchesResult,
        commitsResult,
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

  // Fetch REMOTE git information (ahead/behind counts)
  const fetchRemoteGitInfo = useCallback(async () => {
    if (!cwd || !state.isRepo) return;

    try {
      const aheadBehindResult = await window.goodvibes.gitAheadBehind(cwd);
      lastRemoteFetchRef.current = Date.now();

      setState(prev => ({
        ...prev,
        ahead: aheadBehindResult.ahead || 0,
        behind: aheadBehindResult.behind || 0,
        hasRemote: aheadBehindResult.hasRemote || false,
        hasUpstream: aheadBehindResult.hasUpstream || false,
      }));
    } catch (err) {
      // Silent fail for remote info - not critical
    }
  }, [cwd, state.isRepo]);

  // Fetch ALL git information (local + remote) - used for initial load
  const fetchGitInfo = useCallback(async () => {
    await fetchLocalGitInfo();
    await fetchRemoteGitInfo();
  }, [fetchLocalGitInfo, fetchRemoteGitInfo]);

  // Initial fetch and setup git watcher
  useEffect(() => {
    fetchGitInfo();

    // Start watching for git changes
    window.goodvibes.gitWatch(cwd);

    // Listen for git-changed events
    const unsubscribe = window.goodvibes.onGitChanged((data) => {
      // Only refresh if the change is for our repo
      if (data.path === cwd) {
        fetchLocalGitInfo();
      }
    });

    return () => {
      unsubscribe();
      window.goodvibes.gitUnwatch(cwd);
    };
  }, [cwd, fetchGitInfo, fetchLocalGitInfo]);

  // Poll REMOTE info only (ahead/behind) every 5 minutes when window is focused
  useEffect(() => {
    if (!gitAutoRefresh || !state.isRepo) return;

    let interval: ReturnType<typeof setInterval> | null = null;

    const startInterval = () => {
      if (interval) clearInterval(interval);
      interval = setInterval(fetchRemoteGitInfo, 300000); // 5 minutes
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
  }, [fetchRemoteGitInfo, gitAutoRefresh, state.isRepo]);

  // Local info is refreshed via git operations - no polling needed

  // Base props for hooks
  const hookProps = { cwd, state, setState, fetchGitInfo, fetchLocalGitInfo, fetchRemoteGitInfo };

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
  } = useGitViews(hookProps);

  return {
    state,
    setState,
    branchDropdownRef,
    localBranches,
    totalChanges,
    fetchGitInfo,
    fetchLocalGitInfo,
    fetchRemoteGitInfo,
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

/**
 * Main hook export with explicit return type
 */
export function useGitState(cwd: string): UseGitStateReturn {
  return useGitStateImpl(cwd);
}
