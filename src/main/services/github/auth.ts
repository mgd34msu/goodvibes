// ============================================================================
// GITHUB AUTHENTICATION - Main Entry Point
// ============================================================================
//
// This module orchestrates GitHub authentication by coordinating:
// - oauth-flow.ts: OAuth flow handling (callbacks, browser windows)
// - device-flow.ts: OAuth device flow for desktop apps (recommended)
// - state.ts: Auth state management and credential storage
// - token-manager.ts: Token refresh operations
// - oauth-config.ts: OAuth configuration management
// - credentials.ts: OAuth credential loading
// - api.ts: GitHub API calls
//
// ============================================================================

import { Logger } from '../logger.js';
import type { GitHubAuthResult } from '../../../shared/types/github.js';
import { getOAuthCredentialsInternal } from './credentials.js';
import { verifyToken } from './api.js';
import {
  handleOAuthCallback,
  setPendingOAuthCallback,
  buildAuthUrl,
  generateOAuthState,
  getDefaultScopes,
  startExternalBrowserOAuth,
  startWindowOAuth,
} from './oauth-flow.js';
import {
  getAccessToken,
  isAuthenticated,
  getCurrentUser,
  getAuthState,
  clearStoredCredentials,
  getStoredCredentials,
  updateAuthState,
  logout,
} from './state.js';
import { refreshTokenIfNeeded } from './token-manager.js';
import { getOAuthConfig, setOAuthCredentials, clearOAuthCredentials } from './oauth-config.js';
import {
  startDeviceFlow,
  waitForDeviceFlowCompletion,
  cancelDeviceFlow,
  getDeviceFlowState,
  isDeviceFlowAvailable,
  authenticateWithDeviceFlow,
  getDeviceFlowClientId,
  shouldUseDeviceFlow,
} from './device-flow.js';

const logger = new Logger('GitHubAuth');

// ============================================================================
// RE-EXPORTS (for backward compatibility)
// ============================================================================

export {
  // OAuth flow
  handleOAuthCallback,
  setPendingOAuthCallback,
  // Device flow
  startDeviceFlow,
  waitForDeviceFlowCompletion,
  cancelDeviceFlow,
  getDeviceFlowState,
  isDeviceFlowAvailable,
  authenticateWithDeviceFlow,
  getDeviceFlowClientId,
  shouldUseDeviceFlow,
  // State accessors
  getAccessToken,
  isAuthenticated,
  getCurrentUser,
  getAuthState,
  // State mutators
  clearStoredCredentials,
  logout,
  // Token management
  refreshTokenIfNeeded,
  // OAuth config
  getOAuthConfig,
  setOAuthCredentials,
  clearOAuthCredentials,
};

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Initialize the GitHub service by loading any stored credentials
 */
export async function initializeGitHub(): Promise<void> {
  logger.info('Initializing GitHub service');

  try {
    const { accessToken: storedToken, user: storedUser, tokenExpiresAt } = getStoredCredentials();

    if (storedToken && storedUser) {
      const isValid = await verifyToken(storedToken);

      if (isValid) {
        updateAuthState({
          isAuthenticated: true,
          user: storedUser,
          accessToken: storedToken,
          tokenExpiresAt: tokenExpiresAt ?? null,
        });
        logger.info('GitHub authentication restored from storage', { user: storedUser.login });
      } else {
        logger.info('Stored GitHub token is invalid, clearing credentials');
        await clearStoredCredentials();
      }
    }
  } catch (error) {
    logger.error('Failed to initialize GitHub service', error);
    await clearStoredCredentials();
  }
}

// ============================================================================
// AUTHENTICATION
// ============================================================================

export interface AuthenticateOptions {
  scopes?: string[];
  useExternalBrowser?: boolean;
}

/**
 * Authenticate with GitHub using OAuth flow
 */
export async function authenticateWithGitHub(
  options?: AuthenticateOptions
): Promise<GitHubAuthResult> {
  logger.info('Starting GitHub OAuth flow');

  const { clientId, clientSecret } = getOAuthCredentialsInternal();

  if (!clientId || !clientSecret) {
    return {
      success: false,
      error:
        'GitHub integration is not configured. The application developer needs to set up GitHub OAuth credentials.',
    };
  }

  const scopes = options?.scopes || getDefaultScopes();
  const useExternalBrowser = options?.useExternalBrowser ?? true;

  try {
    const state = generateOAuthState();
    const authUrl = buildAuthUrl(clientId, scopes, state);

    if (useExternalBrowser) {
      return startExternalBrowserOAuth(authUrl, state, scopes);
    } else {
      return startWindowOAuth(authUrl, state, clientId, clientSecret);
    }
  } catch (error) {
    logger.error('GitHub OAuth flow failed', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during authentication',
    };
  }
}
