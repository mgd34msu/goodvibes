// ============================================================================
// USE GIT STATUS HOOK - Status, staged changes, unstaged changes
// ============================================================================

import { useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import type { GitHookBaseProps, UseGitStatusReturn } from './types';

const logger = createLogger('useGitStatus');

/**
 * Hook for managing Git staging and status operations
 * Uses fetchLocalGitInfo for local-only operations (staging, unstaging, discard)
 */
export function useGitStatus({
  cwd,
  state,
  setState,
  fetchLocalGitInfo,
}: GitHookBaseProps): UseGitStatusReturn {
  const handleStage = useCallback(async (files: string[]) => {
    setState(prev => ({ ...prev, operationInProgress: 'staging' }));
    try {
      await window.goodvibes.gitStage(cwd, files);
      await fetchLocalGitInfo();
    } catch (err) {
      logger.error('Failed to stage files:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchLocalGitInfo, setState]);

  const handleUnstage = useCallback(async (files: string[]) => {
    setState(prev => ({ ...prev, operationInProgress: 'unstaging' }));
    try {
      await window.goodvibes.gitUnstage(cwd, files);
      await fetchLocalGitInfo();
    } catch (err) {
      logger.error('Failed to unstage files:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchLocalGitInfo, setState]);

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
      await fetchLocalGitInfo();
    } catch (err) {
      logger.error('Failed to discard changes:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchLocalGitInfo, setState]);

  return {
    handleStage,
    handleUnstage,
    handleStageAll,
    handleUnstageAll,
    handleDiscard,
  };
}
