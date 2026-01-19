// ============================================================================
// USE GITHUB OAUTH CONFIG HOOK
// ============================================================================
//
// Hook for managing custom GitHub OAuth credentials configuration.
// Provides CRUD operations for custom OAuth settings.
//
// ============================================================================

import { useState, useCallback, useEffect, useRef } from 'react';
import { createLogger } from '../../shared/logger';
import type { CustomOAuthConfigStatus, CustomOAuthCredentials } from '../../shared/types/github';

const logger = createLogger('useGitHubOAuthConfig');

// ============================================================================
// TYPES
// ============================================================================

export interface UseGitHubOAuthConfigReturn {
  /** Current OAuth configuration status */
  oauthStatus: CustomOAuthConfigStatus | null;
  /** Whether the status is being loaded */
  isLoading: boolean;
  /** Error message if any */
  error: string | null;
  /** Set custom OAuth credentials */
  setCustomCredentials: (config: CustomOAuthCredentials) => Promise<boolean>;
  /** Clear custom OAuth credentials */
  clearCustomCredentials: () => Promise<boolean>;
  /** Refresh the OAuth status */
  refresh: () => Promise<void>;
}

// ============================================================================
// DEFAULT STATUS
// ============================================================================

const DEFAULT_STATUS: CustomOAuthConfigStatus = {
  isConfigured: true,
  source: 'default',
  clientId: null,
  useDeviceFlow: true,
  hasClientSecret: false,
};

// ============================================================================
// HOOK
// ============================================================================

export function useGitHubOAuthConfig(): UseGitHubOAuthConfigReturn {
  const [oauthStatus, setOauthStatus] = useState<CustomOAuthConfigStatus | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isMountedRef = useRef(true);

  // ============================================================================
  // FETCH STATUS
  // ============================================================================

  const refresh = useCallback(async (): Promise<void> => {
    if (!isMountedRef.current) return;

    setIsLoading(true);
    setError(null);

    try {
      const status = await window.goodvibes.githubGetCustomOAuthStatus();
      if (isMountedRef.current) {
        setOauthStatus(status ?? DEFAULT_STATUS);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fetch OAuth status';
      logger.error('Failed to fetch OAuth status:', err);
      if (isMountedRef.current) {
        setError(message);
        setOauthStatus(DEFAULT_STATUS);
      }
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, []);

  // ============================================================================
  // SET CUSTOM CREDENTIALS
  // ============================================================================

  const setCustomCredentials = useCallback(async (config: CustomOAuthCredentials): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes.githubSetCustomOAuth({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        useDeviceFlow: config.useDeviceFlow,
      });

      if (result?.success) {
        await refresh();
        return true;
      }

      const errorMessage = result?.error ?? 'Failed to set custom OAuth credentials';
      if (isMountedRef.current) {
        setError(errorMessage);
      }
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set custom OAuth credentials';
      logger.error('Failed to set custom OAuth credentials:', err);
      if (isMountedRef.current) {
        setError(message);
      }
      return false;
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [refresh]);

  // ============================================================================
  // CLEAR CUSTOM CREDENTIALS
  // ============================================================================

  const clearCustomCredentials = useCallback(async (): Promise<boolean> => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes.githubClearCustomOAuth();

      if (result?.success) {
        await refresh();
        return true;
      }

      const errorMessage = result?.error ?? 'Failed to clear custom OAuth credentials';
      if (isMountedRef.current) {
        setError(errorMessage);
      }
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to clear custom OAuth credentials';
      logger.error('Failed to clear custom OAuth credentials:', err);
      if (isMountedRef.current) {
        setError(message);
      }
      return false;
    } finally {
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  }, [refresh]);

  // ============================================================================
  // AUTO-FETCH ON MOUNT
  // ============================================================================

  useEffect(() => {
    isMountedRef.current = true;
    refresh();

    return () => {
      isMountedRef.current = false;
    };
  }, [refresh]);

  // ============================================================================
  // RETURN
  // ============================================================================

  return {
    oauthStatus,
    isLoading,
    error,
    setCustomCredentials,
    clearCustomCredentials,
    refresh,
  };
}

export default useGitHubOAuthConfig;
