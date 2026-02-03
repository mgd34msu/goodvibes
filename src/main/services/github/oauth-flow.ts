// ============================================================================
// GITHUB OAUTH FLOW HANDLING
// ============================================================================

import { BrowserWindow, shell } from 'electron';
import crypto from 'crypto';
import { Logger } from '../logger.js';
import type { GitHubAuthResult } from '../../../shared/types/github.js';
import {
  GITHUB_AUTHORIZE_URL,
  DEFAULT_SCOPES,
  OAUTH_CALLBACK_URL,
  OAUTH_TIMEOUT_MS,
} from './types.js';
import { getOAuthCredentialsInternal } from './credentials.js';
import { exchangeCodeForTokens, fetchGitHubUser } from './api.js';
import { storeTokensAndUser, updateAuthState } from './state.js';

const logger = new Logger('GitHubOAuthFlow');

// ============================================================================
// PENDING OAUTH CALLBACK STATE
// ============================================================================

interface PendingOAuthCallback {
  state: string;
  scopes: string[];
  resolve: (result: GitHubAuthResult) => void;
  timeoutId: NodeJS.Timeout;
}

let pendingOAuthCallback: PendingOAuthCallback | null = null;

/**
 * Set pending OAuth callback (called when opening external browser for OAuth)
 */
export function setPendingOAuthCallback(
  state: string,
  scopes: string[],
  resolve: (result: GitHubAuthResult) => void
): void {
  if (pendingOAuthCallback) {
    clearTimeout(pendingOAuthCallback.timeoutId);
    pendingOAuthCallback.resolve({
      success: false,
      error: 'OAuth flow was superseded by a new authentication attempt',
    });
  }

  const timeoutId = setTimeout(() => {
    if (pendingOAuthCallback && pendingOAuthCallback.state === state) {
      logger.warn('OAuth callback timeout reached');
      pendingOAuthCallback.resolve({
        success: false,
        error: 'OAuth flow timed out. Please try again.',
      });
      pendingOAuthCallback = null;
    }
  }, OAUTH_TIMEOUT_MS);

  pendingOAuthCallback = {
    state,
    scopes,
    resolve,
    timeoutId,
  };

  logger.debug('Pending OAuth callback set', { state });
}

/**
 * Handle OAuth callback from the custom protocol (goodvibes://oauth/callback)
 */
export async function handleOAuthCallback(
  code: string | null,
  state: string | null,
  error: string | null,
  errorDescription: string | null
): Promise<void> {
  logger.info('OAuth callback received', { hasCode: !!code, hasError: !!error, state });

  if (!pendingOAuthCallback) {
    logger.warn('OAuth callback received but no pending callback');
    return;
  }

  if (state !== pendingOAuthCallback.state) {
    logger.error('OAuth state mismatch', {
      expected: pendingOAuthCallback.state,
      received: state,
    });
    pendingOAuthCallback.resolve({
      success: false,
      error: 'OAuth state mismatch. This may indicate a security issue. Please try again.',
    });
    clearTimeout(pendingOAuthCallback.timeoutId);
    pendingOAuthCallback = null;
    return;
  }

  clearTimeout(pendingOAuthCallback.timeoutId);

  if (error) {
    logger.error('OAuth callback error', { error, errorDescription });
    pendingOAuthCallback.resolve({
      success: false,
      error: errorDescription || error,
    });
    pendingOAuthCallback = null;
    return;
  }

  if (!code) {
    logger.error('OAuth callback missing code');
    pendingOAuthCallback.resolve({
      success: false,
      error: 'Authorization code not received',
    });
    pendingOAuthCallback = null;
    return;
  }

  const { clientId, clientSecret } = getOAuthCredentialsInternal();

  if (!clientId || !clientSecret) {
    pendingOAuthCallback.resolve({
      success: false,
      error: 'OAuth credentials not configured',
    });
    pendingOAuthCallback = null;
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);

    if (!tokens) {
      pendingOAuthCallback.resolve({
        success: false,
        error: 'Failed to exchange authorization code for access token',
      });
      pendingOAuthCallback = null;
      return;
    }

    const user = await fetchGitHubUser(tokens.access_token);

    if (!user) {
      pendingOAuthCallback.resolve({
        success: false,
        error: 'Failed to fetch user information',
      });
      pendingOAuthCallback = null;
      return;
    }

    // Store credentials and update state
    storeTokensAndUser(tokens, user);
    updateAuthState({
      isAuthenticated: true,
      user,
      accessToken: tokens.access_token,
      tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    });

    logger.info('GitHub authentication successful via protocol callback', { user: user.login });

    pendingOAuthCallback.resolve({
      success: true,
      user,
    });
    pendingOAuthCallback = null;
  } catch (err) {
    logger.error('OAuth callback processing failed', err);
    if (pendingOAuthCallback) {
      pendingOAuthCallback.resolve({
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error during authentication',
      });
      pendingOAuthCallback = null;
    }
  }
}

// ============================================================================
// OAUTH WINDOW
// ============================================================================

/**
 * Open a BrowserWindow for OAuth authentication
 */
export async function openOAuthWindow(authUrl: string, expectedState: string): Promise<string | null> {
  return new Promise((resolve) => {
    const authWindow = new BrowserWindow({
      width: 600,
      height: 800,
      show: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
      },
    });

    authWindow.setMenu(null);

    const handleNavigation = (url: string) => {
      try {
        const parsedUrl = new URL(url);

        if (parsedUrl.host === 'localhost' || parsedUrl.host === '127.0.0.1') {
          const code = parsedUrl.searchParams.get('code');
          const state = parsedUrl.searchParams.get('state');
          const error = parsedUrl.searchParams.get('error');

          if (error) {
            logger.error('OAuth error', { error, description: parsedUrl.searchParams.get('error_description') });
            authWindow.close();
            resolve(null);
            return;
          }

          if (state !== expectedState) {
            logger.error('OAuth state mismatch', { expected: expectedState, received: state });
            authWindow.close();
            resolve(null);
            return;
          }

          if (code) {
            authWindow.close();
            resolve(code);
            return;
          }
        }
      } catch {
        // Not a valid URL, ignore
      }
    };

    authWindow.webContents.on('will-redirect', (_event, url) => {
      handleNavigation(url);
    });

    authWindow.webContents.on('will-navigate', (_event, url) => {
      handleNavigation(url);
    });

    authWindow.on('closed', () => {
      resolve(null);
    });

    authWindow.loadURL(authUrl);
  });
}

// ============================================================================
// MAIN OAUTH FLOW
// ============================================================================

/**
 * Start OAuth flow with external browser
 */
export function startExternalBrowserOAuth(
  authUrl: URL,
  state: string,
  scopes: string[]
): Promise<GitHubAuthResult> {
  authUrl.searchParams.set('redirect_uri', OAUTH_CALLBACK_URL);

  return new Promise<GitHubAuthResult>((resolve) => {
    setPendingOAuthCallback(state, scopes, resolve);

    shell.openExternal(authUrl.toString()).catch((err) => {
      logger.error('Failed to open external browser', err);
      resolve({
        success: false,
        error: 'Failed to open browser for authentication',
      });
    });

    logger.info('OAuth flow started in external browser');
  });
}

/**
 * Start OAuth flow with in-app window
 */
export async function startWindowOAuth(
  authUrl: URL,
  state: string,
  clientId: string,
  clientSecret: string
): Promise<GitHubAuthResult> {
  const code = await openOAuthWindow(authUrl.toString(), state);

  if (!code) {
    return {
      success: false,
      error: 'OAuth flow was cancelled or failed',
    };
  }

  const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);

  if (!tokens) {
    return {
      success: false,
      error: 'Failed to exchange authorization code for access token',
    };
  }

  const user = await fetchGitHubUser(tokens.access_token);

  if (!user) {
    return {
      success: false,
      error: 'Failed to fetch user information',
    };
  }

  // Store credentials and update state
  storeTokensAndUser(tokens, user);
  updateAuthState({
    isAuthenticated: true,
    user,
    accessToken: tokens.access_token,
    tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
  });

  logger.info('GitHub authentication successful', { user: user.login });

  return {
    success: true,
    user,
  };
}

/**
 * Build the OAuth authorization URL
 */
export function buildAuthUrl(clientId: string, scopes: string[], state: string): URL {
  const authUrl = new URL(GITHUB_AUTHORIZE_URL);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('allow_signup', 'true');
  return authUrl;
}

/**
 * Generate a cryptographically secure state parameter
 */
export function generateOAuthState(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Get default scopes
 */
export function getDefaultScopes(): string[] {
  return DEFAULT_SCOPES;
}
