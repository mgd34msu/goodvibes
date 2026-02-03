// ============================================================================
// USE GIT VIEWS HOOK - Diff, file history, blame, reflog views
// ============================================================================

import { useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import type { GitHookBaseProps, UseGitViewsReturn } from './types';

const logger = createLogger('useGitViews');

/**
 * Hook for managing Git view operations (diff, history, blame, reflog)
 */
export function useGitViews({
  cwd,
  setState,
}: Pick<GitHookBaseProps, 'cwd' | 'setState'>): UseGitViewsReturn {
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
  }, [cwd, setState]);

  const handleCloseDiffModal = useCallback(() => {
    setState(prev => ({
      ...prev,
      showDiffModal: false,
      diffFile: null,
      diffContent: null,
      diffCommit: null,
    }));
  }, [setState]);

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
  }, [cwd, setState]);

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
  }, [cwd, setState]);

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
  }, [cwd, setState]);

  return {
    handleViewDiff,
    handleCloseDiffModal,
    handleViewFileHistory,
    handleViewBlame,
    handleViewReflog,
  };
}
