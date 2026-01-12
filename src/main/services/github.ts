// ============================================================================
// GITHUB OAUTH SERVICE
// ============================================================================

import { BrowserWindow, app, shell } from 'electron';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import Store from 'electron-store';
import { Logger } from './logger.js';
import type {
  GitHubUser,
  GitHubAuthState,
  GitHubOAuthTokens,
  GitHubAuthResult,
} from '../../shared/types/github.js';

const logger = new Logger('GitHub');

// ============================================================================
// CONSTANTS
// ============================================================================

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_API_URL = 'https://api.github.com';

// Default scopes needed for full GitHub integration
const DEFAULT_SCOPES = ['repo', 'read:user', 'read:org', 'workflow'];

// ============================================================================
// BUNDLED OAUTH CREDENTIALS
// ============================================================================

/**
 * Load OAuth credentials from environment or bundled config.
 *
 * For desktop apps like GoodVibes, embedding OAuth credentials is standard practice.
 * The developer creates ONE GitHub OAuth App for the entire GoodVibes application.
 * End users simply click "Login with GitHub" - zero setup required.
 *
 * Credential loading priority:
 * 1. Environment variables (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
 * 2. Bundled config file (for production builds)
 * 3. Previously saved user credentials (legacy fallback)
 */
function loadOAuthCredentials(): { clientId: string | null; clientSecret: string | null } {
  // Try environment variables first (development or custom deployment)
  const envClientId = process.env.GITHUB_CLIENT_ID;
  const envClientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (envClientId && envClientSecret) {
    logger.debug('Using OAuth credentials from environment variables');
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // Try bundled config file (for production builds)
  try {
    const configPaths = [
      // Production: alongside the executable
      path.join(path.dirname(app.getPath('exe')), 'github-oauth.json'),
      // Development: in project root
      path.join(app.getAppPath(), 'github-oauth.json'),
      // Alternative: in resources
      path.join(process.resourcesPath || '', 'github-oauth.json'),
    ];

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.clientId && config.clientSecret) {
          logger.debug('Using OAuth credentials from bundled config', { path: configPath });
          return { clientId: config.clientId, clientSecret: config.clientSecret };
        }
      }
    }
  } catch (error) {
    logger.debug('No bundled OAuth config found');
  }

  // Legacy fallback: check electron-store for user-saved credentials
  // This maintains backward compatibility with older installations
  const storedClientId = githubStore.get('clientId');
  const storedClientSecret = githubStore.get('clientSecret');

  if (storedClientId && storedClientSecret) {
    logger.debug('Using legacy user-saved OAuth credentials');
    return { clientId: storedClientId, clientSecret: storedClientSecret };
  }

  return { clientId: null, clientSecret: null };
}

// Cached credentials (loaded once at startup)
let cachedCredentials: { clientId: string | null; clientSecret: string | null } | null = null;

/**
 * Get OAuth credentials (cached for performance)
 */
function getOAuthCredentialsInternal(): { clientId: string | null; clientSecret: string | null } {
  if (!cachedCredentials) {
    cachedCredentials = loadOAuthCredentials();
  }
  return cachedCredentials;
}

/**
 * Check if OAuth is configured (either bundled or user-provided)
 */
export function isOAuthConfigured(): boolean {
  const creds = getOAuthCredentialsInternal();
  return !!(creds.clientId && creds.clientSecret);
}

// ============================================================================
// SECURE STORE
// ============================================================================

// Type for GitHub store schema
interface GitHubStoreSchema {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  user?: GitHubUser;
  clientId?: string;
  clientSecret?: string;
}

// Create an encrypted store for GitHub credentials
const githubStore = new Store<GitHubStoreSchema>({
  name: 'github-auth',
  encryptionKey: 'goodvibes-github-store',
});

// ============================================================================
// STATE
// ============================================================================

let authState: GitHubAuthState = {
  isAuthenticated: false,
  user: null,
  accessToken: null,
  tokenExpiresAt: null,
};

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

// OAuth timeout - if callback doesn't arrive within 5 minutes, abort
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Set pending OAuth callback (called when opening external browser for OAuth)
 * This is exported so that the main process can set it up before opening the browser
 */
export function setPendingOAuthCallback(
  state: string,
  scopes: string[],
  resolve: (result: GitHubAuthResult) => void
): void {
  // Clear any existing pending callback
  if (pendingOAuthCallback) {
    clearTimeout(pendingOAuthCallback.timeoutId);
    pendingOAuthCallback.resolve({
      success: false,
      error: 'OAuth flow was superseded by a new authentication attempt',
    });
  }

  // Set up timeout to abort if callback doesn't arrive
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
 * Called by the main process when it receives a protocol URL
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

  // Validate state matches
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

  // Clear timeout since we got a response
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

  // Get OAuth credentials
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
    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);

    if (!tokens) {
      pendingOAuthCallback.resolve({
        success: false,
        error: 'Failed to exchange authorization code for access token',
      });
      pendingOAuthCallback = null;
      return;
    }

    // Get user info
    const user = await fetchGitHubUser(tokens.access_token);

    if (!user) {
      pendingOAuthCallback.resolve({
        success: false,
        error: 'Failed to fetch user information',
      });
      pendingOAuthCallback = null;
      return;
    }

    // Store credentials securely
    githubStore.set('accessToken', tokens.access_token);
    if (tokens.refresh_token) {
      githubStore.set('refreshToken', tokens.refresh_token);
    }
    if (tokens.expires_in) {
      const expiresAt = Date.now() + tokens.expires_in * 1000;
      githubStore.set('tokenExpiresAt', expiresAt);
    }
    githubStore.set('user', user);

    // Update state
    authState = {
      isAuthenticated: true,
      user,
      accessToken: tokens.access_token,
      tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
    };

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
// INITIALIZATION
// ============================================================================

/**
 * Initialize the GitHub service by loading any stored credentials
 */
export async function initializeGitHub(): Promise<void> {
  logger.info('Initializing GitHub service');

  try {
    const storedToken = githubStore.get('accessToken');
    const storedUser = githubStore.get('user');
    const tokenExpiresAt = githubStore.get('tokenExpiresAt');

    if (storedToken && storedUser) {
      // Verify the token is still valid
      const isValid = await verifyToken(storedToken);

      if (isValid) {
        authState = {
          isAuthenticated: true,
          user: storedUser,
          accessToken: storedToken,
          tokenExpiresAt: tokenExpiresAt ?? null,
        };
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

// Custom protocol callback URL
const OAUTH_CALLBACK_URL = 'goodvibes://oauth/callback';

/**
 * Authenticate with GitHub using OAuth flow
 * Opens the system's default browser for authentication and handles callback via custom protocol.
 *
 * OAuth credentials are automatically loaded from:
 * 1. Environment variables (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
 * 2. Bundled config file (github-oauth.json)
 * 3. Legacy user-saved credentials (for backward compatibility)
 *
 * End users simply click "Login with GitHub" - no configuration required.
 */
export async function authenticateWithGitHub(options?: {
  scopes?: string[];
  useExternalBrowser?: boolean;
}): Promise<GitHubAuthResult> {
  logger.info('Starting GitHub OAuth flow');

  // Get OAuth credentials from bundled config or environment
  const { clientId, clientSecret } = getOAuthCredentialsInternal();

  if (!clientId || !clientSecret) {
    return {
      success: false,
      error: 'GitHub integration is not configured. The application developer needs to set up GitHub OAuth credentials.',
    };
  }

  const scopes = options?.scopes || DEFAULT_SCOPES;
  const useExternalBrowser = options?.useExternalBrowser ?? true; // Default to external browser

  try {
    // Generate state for CSRF protection
    const state = crypto.randomBytes(16).toString('hex');

    // Build authorization URL
    const authUrl = new URL(GITHUB_AUTHORIZE_URL);
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('scope', scopes.join(' '));
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('allow_signup', 'true');

    if (useExternalBrowser) {
      // Use custom protocol callback URL for external browser flow
      authUrl.searchParams.set('redirect_uri', OAUTH_CALLBACK_URL);

      // Create a promise that will be resolved when the callback is received
      return new Promise<GitHubAuthResult>((resolve) => {
        // Set up the pending callback
        setPendingOAuthCallback(state, scopes, resolve);

        // Open the authorization URL in the system's default browser
        shell.openExternal(authUrl.toString()).catch((err) => {
          logger.error('Failed to open external browser', err);
          resolve({
            success: false,
            error: 'Failed to open browser for authentication',
          });
        });

        logger.info('OAuth flow started in external browser');
      });
    } else {
      // Fall back to BrowserWindow approach (for cases where protocol isn't working)
      const code = await openOAuthWindow(authUrl.toString(), state);

      if (!code) {
        return {
          success: false,
          error: 'OAuth flow was cancelled or failed',
        };
      }

      // Exchange code for tokens
      const tokens = await exchangeCodeForTokens(code, clientId, clientSecret);

      if (!tokens) {
        return {
          success: false,
          error: 'Failed to exchange authorization code for access token',
        };
      }

      // Get user info
      const user = await fetchGitHubUser(tokens.access_token);

      if (!user) {
        return {
          success: false,
          error: 'Failed to fetch user information',
        };
      }

      // Store credentials securely
      githubStore.set('accessToken', tokens.access_token);
      if (tokens.refresh_token) {
        githubStore.set('refreshToken', tokens.refresh_token);
      }
      if (tokens.expires_in) {
        const expiresAt = Date.now() + tokens.expires_in * 1000;
        githubStore.set('tokenExpiresAt', expiresAt);
      }
      githubStore.set('user', user);

      // Update state
      authState = {
        isAuthenticated: true,
        user,
        accessToken: tokens.access_token,
        tokenExpiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null,
      };

      logger.info('GitHub authentication successful', { user: user.login });

      return {
        success: true,
        user,
      };
    }
  } catch (error) {
    logger.error('GitHub OAuth flow failed', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error during authentication',
    };
  }
}

/**
 * Open a BrowserWindow for OAuth authentication
 */
async function openOAuthWindow(authUrl: string, expectedState: string): Promise<string | null> {
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

    // Handle navigation to callback URL
    const handleNavigation = (url: string) => {
      try {
        const parsedUrl = new URL(url);

        // GitHub redirects to localhost with code and state
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

    // Listen for redirects
    authWindow.webContents.on('will-redirect', (event, url) => {
      handleNavigation(url);
    });

    authWindow.webContents.on('will-navigate', (event, url) => {
      handleNavigation(url);
    });

    // Handle window close
    authWindow.on('closed', () => {
      resolve(null);
    });

    // Load the authorization URL
    authWindow.loadURL(authUrl);
  });
}

/**
 * Exchange authorization code for access tokens
 */
async function exchangeCodeForTokens(
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
async function fetchGitHubUser(accessToken: string): Promise<GitHubUser | null> {
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
async function verifyToken(accessToken: string): Promise<boolean> {
  try {
    const response = await fetch(`${GITHUB_API_URL}/user`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'GoodVibes',
      },
    });

    return response.ok;
  } catch {
    return false;
  }
}

// ============================================================================
// LOGOUT & TOKEN MANAGEMENT
// ============================================================================

/**
 * Logout from GitHub and clear stored credentials
 */
export async function logout(): Promise<void> {
  logger.info('Logging out from GitHub');

  // Revoke the token if possible (GitHub doesn't provide a standard revoke endpoint)
  // The token will naturally expire or can be revoked from GitHub settings

  await clearStoredCredentials();

  authState = {
    isAuthenticated: false,
    user: null,
    accessToken: null,
    tokenExpiresAt: null,
  };

  logger.info('GitHub logout complete');
}

/**
 * Clear all stored credentials
 */
async function clearStoredCredentials(): Promise<void> {
  githubStore.delete('accessToken');
  githubStore.delete('refreshToken');
  githubStore.delete('tokenExpiresAt');
  githubStore.delete('user');
}

/**
 * Refresh the access token if it's expired or about to expire
 */
export async function refreshTokenIfNeeded(): Promise<boolean> {
  const refreshToken = githubStore.get('refreshToken');
  const tokenExpiresAt = githubStore.get('tokenExpiresAt');

  // If no refresh token or no expiry, we can't refresh
  if (!refreshToken) {
    return authState.isAuthenticated;
  }

  // Check if token is expired or about to expire (within 5 minutes)
  const fiveMinutes = 5 * 60 * 1000;
  const isExpiringSoon = tokenExpiresAt && Date.now() > tokenExpiresAt - fiveMinutes;

  if (!isExpiringSoon) {
    return authState.isAuthenticated;
  }

  logger.info('Refreshing GitHub access token');

  // Get OAuth credentials from bundled config or environment
  const { clientId, clientSecret } = getOAuthCredentialsInternal();

  if (!clientId || !clientSecret) {
    logger.error('Cannot refresh token: OAuth credentials not configured');
    return false;
  }

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
      return false;
    }

    const data = await response.json() as GitHubOAuthTokens & { error?: string };

    if (data.error) {
      logger.error('Token refresh error', { error: data.error });
      return false;
    }

    // Update stored tokens
    githubStore.set('accessToken', data.access_token);
    if (data.refresh_token) {
      githubStore.set('refreshToken', data.refresh_token);
    }
    if (data.expires_in) {
      const expiresAt = Date.now() + data.expires_in * 1000;
      githubStore.set('tokenExpiresAt', expiresAt);
    }

    // Update state
    authState.accessToken = data.access_token;
    authState.tokenExpiresAt = data.expires_in ? Date.now() + data.expires_in * 1000 : null;

    logger.info('GitHub token refreshed successfully');
    return true;
  } catch (error) {
    logger.error('Failed to refresh token', error);
    return false;
  }
}

// ============================================================================
// GETTERS
// ============================================================================

/**
 * Get the current access token (refreshing if needed)
 */
export function getAccessToken(): string | null {
  return authState.accessToken;
}

/**
 * Check if the user is authenticated
 */
export function isAuthenticated(): boolean {
  return authState.isAuthenticated;
}

/**
 * Get the current authenticated user
 */
export function getCurrentUser(): GitHubUser | null {
  return authState.user;
}

/**
 * Get the full auth state
 */
export function getAuthState(): GitHubAuthState {
  return { ...authState };
}

// ============================================================================
// OAUTH CONFIGURATION
// ============================================================================

/**
 * Set OAuth credentials (legacy support only)
 *
 * @deprecated This is maintained for backward compatibility only.
 * New installations should use environment variables or bundled config.
 * This function will clear the credential cache to pick up new values.
 */
export function setOAuthCredentials(clientId: string, clientSecret: string): void {
  githubStore.set('clientId', clientId);
  githubStore.set('clientSecret', clientSecret);
  // Clear cache so new credentials are picked up
  cachedCredentials = null;
  logger.info('GitHub OAuth credentials updated (legacy mode)');
}

/**
 * Get OAuth configuration status
 *
 * Returns information about whether OAuth is configured and the source of credentials.
 * The clientId is included as it is public information in OAuth (only the secret is private).
 */
export function getOAuthConfig(): {
  isConfigured: boolean;
  source: 'environment' | 'bundled' | 'user' | 'none';
  clientId: string | null;
} {
  const envClientId = process.env.GITHUB_CLIENT_ID;
  const envClientSecret = process.env.GITHUB_CLIENT_SECRET;

  if (envClientId && envClientSecret) {
    return {
      isConfigured: true,
      source: 'environment',
      clientId: envClientId,
    };
  }

  // Check bundled config
  try {
    const configPaths = [
      path.join(path.dirname(app.getPath('exe')), 'github-oauth.json'),
      path.join(app.getAppPath(), 'github-oauth.json'),
      path.join(process.resourcesPath || '', 'github-oauth.json'),
    ];

    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.clientId && config.clientSecret) {
          return {
            isConfigured: true,
            source: 'bundled',
            clientId: config.clientId,
          };
        }
      }
    }
  } catch {
    // Ignore errors
  }

  // Check legacy user-saved credentials
  const storedClientId = githubStore.get('clientId');
  const storedClientSecret = githubStore.get('clientSecret');

  if (storedClientId && storedClientSecret) {
    return {
      isConfigured: true,
      source: 'user',
      clientId: storedClientId,
    };
  }

  return {
    isConfigured: false,
    source: 'none',
    clientId: null,
  };
}

/**
 * Clear legacy user-saved OAuth credentials
 *
 * This only clears user-saved credentials. Environment variables and
 * bundled config cannot be cleared at runtime.
 */
export function clearOAuthCredentials(): void {
  githubStore.delete('clientId');
  githubStore.delete('clientSecret');
  // Clear cache so we fall back to other sources
  cachedCredentials = null;
  logger.info('Legacy GitHub OAuth credentials cleared');
}
