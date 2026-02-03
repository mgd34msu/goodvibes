// ============================================================================
// GITHUB TOKEN MANAGEMENT
// ============================================================================

import { Logger } from '../logger.js';
import { getOAuthCredentialsInternal } from './credentials.js';
import { refreshAccessToken } from './api.js';
import {
  getStoredCredentials,
  updateStoredTokens,
  updateAuthState,
  getAuthStateInternal,
} from './state.js';

const logger = new Logger('GitHubTokenManager');

// ============================================================================
// TOKEN REFRESH
// ============================================================================

/** Time buffer before expiration to trigger refresh (5 minutes) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/**
 * Check if token is expiring soon
 */
export function isTokenExpiringSoon(tokenExpiresAt: number | null | undefined): boolean {
  if (!tokenExpiresAt) {
    return false;
  }
  return Date.now() > tokenExpiresAt - REFRESH_BUFFER_MS;
}

/**
 * Refresh the access token if it's expired or about to expire
 */
export async function refreshTokenIfNeeded(): Promise<boolean> {
  const { refreshToken, tokenExpiresAt } = getStoredCredentials();
  const authState = getAuthStateInternal();

  if (!refreshToken) {
    return authState.isAuthenticated;
  }

  if (!isTokenExpiringSoon(tokenExpiresAt)) {
    return authState.isAuthenticated;
  }

  logger.info('Refreshing GitHub access token');

  const { clientId, clientSecret } = getOAuthCredentialsInternal();

  if (!clientId || !clientSecret) {
    logger.error('Cannot refresh token: OAuth credentials not configured');
    return false;
  }

  const data = await refreshAccessToken(refreshToken, clientId, clientSecret);

  if (!data) {
    return false;
  }

  // Update stored tokens
  updateStoredTokens(data);

  // Update auth state
  updateAuthState({
    accessToken: data.access_token,
    tokenExpiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : null,
  });

  logger.info('GitHub token refreshed successfully');
  return true;
}

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(): Promise<string | null> {
  await refreshTokenIfNeeded();
  return getAuthStateInternal().accessToken;
}
