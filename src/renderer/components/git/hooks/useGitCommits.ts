// ============================================================================
// USE GIT COMMITS HOOK - Commit, amend, log operations
// ============================================================================

import { useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import type { GitHookBaseProps, UseGitCommitsReturn } from './types';

const logger = createLogger('useGitCommits');

/**
 * Hook for managing Git commit operations
 */
export function useGitCommits({
  cwd,
  state,
  setState,
  fetchGitInfo,
}: GitHookBaseProps): UseGitCommitsReturn {
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
  }, [cwd, state.commitMessage, state.staged.length, fetchGitInfo, setState]);

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
  }, [cwd, state.amendMode, state.commitMessage, fetchGitInfo, handleCommit, setState]);

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
  }, [cwd, setState]);

  const handleCloseCommitDetail = useCallback(() => {
    setState(prev => ({
      ...prev,
      showCommitDetail: false,
      selectedCommit: null,
    }));
  }, [setState]);

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
  }, [setState]);

  return {
    handleCommit,
    handleCommitWithAmend,
    handleViewCommit,
    handleCloseCommitDetail,
    handleConventionalPrefix,
  };
}
