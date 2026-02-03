// ============================================================================
// USE GIT REMOTE HOOK - Push, pull, fetch, remote management
// ============================================================================

import { useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import type { GitHookBaseProps, UseGitRemoteReturn } from './types';

const logger = createLogger('useGitRemote');

/**
 * Hook for managing Git remote operations
 */
export function useGitRemote({
  cwd,
  setState,
  fetchGitInfo,
}: GitHookBaseProps): UseGitRemoteReturn {
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
  }, [cwd, fetchGitInfo, setState]);

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
  }, [cwd, fetchGitInfo, setState]);

  const handleFetch = useCallback(async () => {
    setState(prev => ({ ...prev, isFetching: true }));
    try {
      await window.goodvibes.gitFetch(cwd);
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to fetch:', err);
    }
    setState(prev => ({ ...prev, isFetching: false }));
  }, [cwd, fetchGitInfo, setState]);

  return {
    handlePush,
    handlePull,
    handleFetch,
  };
}
