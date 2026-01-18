// ============================================================================
// GITHUB API FUNCTIONS
// ============================================================================

import { Logger } from '../logger.js';
import { GITHUB_TOKEN_URL, GITHUB_API_URL } from './types.js';
import type { GitHubUser, GitHubOAuthTokens } from '../../../shared/types/github.js';

const logger = new Logger('GitHubAPI');

// ============================================================================
// API FUNCTIONS
// ============================================================================

/**
 * Exchange authorization code for access tokens
 */
export async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string
): Promise<GitHubOAuthTokens | null> {
  try {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
      }),
    });

    if (!response.ok) {
      logger.error('Token exchange failed', { status: response.status });
      return null;
    }

    const data = await response.json() as GitHubOAuthTokens & { error?: string };

    if (data.error) {
      logger.error('Token exchange error', { error: data.error });
      return null;
    }

    return data;
  } catch (error) {
    logger.error('Failed to exchange code for tokens', error);
    return null;
  }
}

/**
 * Fetch the current GitHub user
 */
export async function fetchGitHubUser(accessToken: string): Promise<GitHubUser | null> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GoodVibes',
      },
    });

    if (!response.ok) {
      logger.error('Failed to fetch user', { status: response.status });
      return null;
    }

    return await response.json() as GitHubUser;
  } catch (error) {
    logger.error('Failed to fetch GitHub user', error);
    return null;
  }
}

/**
 * Verify if a token is still valid
 */
export async function verifyToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GoodVibes',
      },
    });

    if (!response.ok) {
      logger.debug('Token verification failed', { status: response.status });
    }
    return response.ok;
  } catch (error) {
    // Network errors during token verification indicate connectivity issues or invalid tokens.
    // Log at debug level since this is a common scenario during offline/network transitions.
    logger.debug('Token verification error', {
      operation: 'verifyToken',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Refresh the access token
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string
): Promise<GitHubOAuthTokens | null> {
  try {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      logger.error('Token refresh failed', { status: response.status });
      return null;
    }

    const data = await response.json() as GitHubOAuthTokens & { error?: string };

    if (data.error) {
      logger.error('Token refresh error', { error: data.error });
      return null;
    }

    return data;
  } catch (error) {
    logger.error('Failed to refresh token', error);
    return null;
  }
}
