// ============================================================================
// GITHUB DEVICE FLOW AUTHENTICATION
// ============================================================================
//
// Implements GitHub's OAuth Device Flow for desktop applications.
// This flow is ideal because:
// - No client secret required (only client ID)
// - Works without redirect URLs
// - User authorizes in their own browser
// - Secure for native/desktop apps
//
// Flow:
// 1. Request device code from GitHub
// 2. Display user code and verification URL to user
// 3. Poll for token completion while user authorizes in browser
// 4. Exchange device code for access token once authorized
//
// ============================================================================

import { shell, BrowserWindow } from 'electron';
import { Logger } from '../logger.js';
import {
  GITHUB_DEVICE_CODE_URL,
  GITHUB_TOKEN_URL,
  DEFAULT_SCOPES,
  DEVICE_FLOW_MIN_POLL_INTERVAL_MS,
  DEVICE_FLOW_MAX_BACKOFF_MS,
} from './types.js';
import { fetchGitHubUser } from './api.js';
import { storeTokensAndUser, updateAuthState } from './state.js';
import { getCustomOAuthCredentials } from './credentials.js';
import type {
  GitHubDeviceCodeResponse,
  DeviceFlowState,
  DeviceFlowStartResult,
  GitHubOAuthTokens,
  GitHubAuthResult,
} from '../../../shared/types/github.js';

const logger = new Logger('GitHubDeviceFlow');

// ============================================================================
// DEFAULT CLIENT ID
// ============================================================================

/**
 * Default GitHub OAuth App Client ID for GoodVibes.
 * This is safe to embed in the application - device flow only needs the client ID.
 */
const DEFAULT_GITHUB_CLIENT_ID = 'Ov23lifAVInDygX73ltt';

// ============================================================================
// DEVICE FLOW STATE
// ============================================================================

interface ActiveDeviceFlow {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  interval: number;
  pollTimeoutId: NodeJS.Timeout | null;
  cancelled: boolean;
  resolve: (result: GitHubAuthResult) => void;
}

let activeFlow: ActiveDeviceFlow | null = null;

/**
 * Get the current device flow state for the renderer
 */
export function getDeviceFlowState(): DeviceFlowState {
  if (!activeFlow) {
    return {
      status: 'idle',
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      error: null,
    };
  }

  if (activeFlow.cancelled) {
    return {
      status: 'cancelled',
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      error: 'Authentication was cancelled',
    };
  }

  if (Date.now() > activeFlow.expiresAt) {
    return {
      status: 'expired',
      userCode: null,
      verificationUri: null,
      expiresAt: null,
      error: 'The authorization code has expired. Please try again.',
    };
  }

  return {
    status: 'polling',
    userCode: activeFlow.userCode,
    verificationUri: activeFlow.verificationUri,
    expiresAt: activeFlow.expiresAt,
    error: null,
  };
}

// ============================================================================
// CLIENT ID RESOLUTION
// ============================================================================

/**
 * Get the GitHub client ID for device flow authentication.
 *
 * Priority order:
 * 1. Custom credentials (user-provided via settings)
 * 2. Environment variables (GITHUB_CLIENT_ID)
 * 3. Bundled default client ID
 *
 * Device flow only needs the client ID, not the secret.
 */
export function getDeviceFlowClientId(): string {
  // Check custom credentials first (highest priority)
  const customCreds = getCustomOAuthCredentials();
  if (customCreds && customCreds.useDeviceFlow) {
    logger.debug('Using GitHub client ID from custom credentials');
    return customCreds.clientId;
  }

  // Check environment variable
  const envClientId = process.env.GITHUB_CLIENT_ID;
  if (envClientId) {
    logger.debug('Using GitHub client ID from environment');
    return envClientId;
  }

  // Fall back to default bundled client ID
  logger.debug('Using default GitHub client ID');
  return DEFAULT_GITHUB_CLIENT_ID;
}

/**
 * Check if device flow should be used based on current configuration.
 * Returns true if custom credentials are set with useDeviceFlow=true,
 * or if no custom credentials are configured (device flow is the default).
 */
export function shouldUseDeviceFlow(): boolean {
  const customCreds = getCustomOAuthCredentials();
  if (customCreds) {
    return customCreds.useDeviceFlow;
  }
  // Default to device flow when no custom credentials are set
  return true;
}

// ============================================================================
// DEVICE CODE REQUEST
// ============================================================================

/**
 * Request a device code from GitHub
 */
async function requestDeviceCode(
  clientId: string,
  scopes: string[]
): Promise<GitHubDeviceCodeResponse | null> {
  try {
    const response = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        scope: scopes.join(' '),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('Device code request failed', {
        status: response.status,
        error: errorText,
      });
      return null;
    }

    const data = (await response.json()) as GitHubDeviceCodeResponse & { error?: string; error_description?: string };

    if (data.error) {
      logger.error('Device code request error', {
        error: data.error,
        description: data.error_description,
      });
      return null;
    }

    return data;
  } catch (error) {
    logger.error('Failed to request device code', error);
    return null;
  }
}

// ============================================================================
// TOKEN POLLING
// ============================================================================

interface TokenPollResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

/**
 * Poll GitHub for the access token
 */
async function pollForToken(
  clientId: string,
  deviceCode: string
): Promise<{ tokens: GitHubOAuthTokens | null; error: string | null; shouldRetry: boolean; newInterval?: number }> {
  try {
    const response = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    if (!response.ok) {
      logger.error('Token poll request failed', { status: response.status });
      return { tokens: null, error: 'Network error during token poll', shouldRetry: true };
    }

    const data = (await response.json()) as TokenPollResponse;

    // Handle various error states
    if (data.error) {
      switch (data.error) {
        case 'authorization_pending':
          // User hasn't authorized yet, keep polling
          return { tokens: null, error: null, shouldRetry: true };

        case 'slow_down':
          // GitHub is asking us to slow down, increase interval
          const newInterval = data.interval
            ? data.interval * 1000
            : DEVICE_FLOW_MIN_POLL_INTERVAL_MS * 2;
          logger.debug('GitHub requested slow down', { newInterval });
          return { tokens: null, error: null, shouldRetry: true, newInterval };

        case 'expired_token':
          // Device code has expired
          return {
            tokens: null,
            error: 'The authorization code has expired. Please try again.',
            shouldRetry: false,
          };

        case 'access_denied':
          // User denied access
          return {
            tokens: null,
            error: 'Access was denied. Please try again and authorize the application.',
            shouldRetry: false,
          };

        case 'unsupported_grant_type':
          // Device flow not enabled for this OAuth app
          return {
            tokens: null,
            error: 'Device flow is not enabled for this GitHub OAuth App. Please contact the application developer.',
            shouldRetry: false,
          };

        default:
          logger.error('Unknown token poll error', { error: data.error, description: data.error_description });
          return {
            tokens: null,
            error: data.error_description || data.error,
            shouldRetry: false,
          };
      }
    }

    // Success! We got the token
    if (data.access_token) {
      return {
        tokens: {
          access_token: data.access_token,
          token_type: data.token_type || 'bearer',
          scope: data.scope || '',
        },
        error: null,
        shouldRetry: false,
      };
    }

    // Unexpected response
    return {
      tokens: null,
      error: 'Unexpected response from GitHub',
      shouldRetry: false,
    };
  } catch (error) {
    logger.error('Token poll failed', error);
    return {
      tokens: null,
      error: error instanceof Error ? error.message : 'Network error',
      shouldRetry: true,
    };
  }
}

// ============================================================================
// DEVICE FLOW ORCHESTRATION
// ============================================================================

/**
 * Start the device flow polling loop
 */
function startPolling(clientId: string, flow: ActiveDeviceFlow): void {
  let currentInterval = flow.interval;
  let backoffMultiplier = 1;

  const poll = async (): Promise<void> => {
    if (flow.cancelled) {
      logger.debug('Polling cancelled');
      return;
    }

    if (Date.now() > flow.expiresAt) {
      logger.info('Device code expired during polling');
      flow.resolve({
        success: false,
        error: 'The authorization code has expired. Please try again.',
      });
      cleanupFlow();
      return;
    }

    const result = await pollForToken(clientId, flow.deviceCode);

    if (flow.cancelled) {
      return;
    }

    if (result.tokens) {
      // Success! Fetch user info and complete auth
      logger.info('Device flow token received, fetching user info');

      const user = await fetchGitHubUser(result.tokens.access_token);

      if (!user) {
        flow.resolve({
          success: false,
          error: 'Failed to fetch user information after authentication',
        });
        cleanupFlow();
        return;
      }

      // Store credentials and update state
      storeTokensAndUser(result.tokens, user);
      updateAuthState({
        isAuthenticated: true,
        user,
        accessToken: result.tokens.access_token,
        tokenExpiresAt: null, // Device flow tokens don't expire
      });

      logger.info('GitHub device flow authentication successful', { user: user.login });

      flow.resolve({
        success: true,
        user,
      });
      cleanupFlow();
      return;
    }

    if (!result.shouldRetry) {
      flow.resolve({
        success: false,
        error: result.error || 'Authentication failed',
      });
      cleanupFlow();
      return;
    }

    // Handle slow_down response
    if (result.newInterval) {
      currentInterval = Math.min(result.newInterval, DEVICE_FLOW_MAX_BACKOFF_MS);
      backoffMultiplier = 1;
    }

    // Schedule next poll with exponential backoff on network errors
    const nextInterval = result.error
      ? Math.min(currentInterval * backoffMultiplier, DEVICE_FLOW_MAX_BACKOFF_MS)
      : currentInterval;

    if (result.error) {
      backoffMultiplier = Math.min(backoffMultiplier * 1.5, 4);
    } else {
      backoffMultiplier = 1;
    }

    flow.pollTimeoutId = setTimeout(poll, nextInterval);
  };

  // Start polling after initial interval
  flow.pollTimeoutId = setTimeout(poll, currentInterval);
}

/**
 * Clean up the active flow
 */
function cleanupFlow(): void {
  if (activeFlow?.pollTimeoutId) {
    clearTimeout(activeFlow.pollTimeoutId);
  }
  activeFlow = null;
}

/**
 * Start the GitHub device flow authentication
 */
export async function startDeviceFlow(options?: {
  scopes?: string[];
  openBrowser?: boolean;
}): Promise<DeviceFlowStartResult> {
  // Cancel any existing flow
  if (activeFlow) {
    logger.info('Cancelling existing device flow');
    activeFlow.cancelled = true;
    activeFlow.resolve({
      success: false,
      error: 'A new authentication flow was started',
    });
    cleanupFlow();
  }

  const clientId = getDeviceFlowClientId();
  const scopes = options?.scopes || DEFAULT_SCOPES;

  logger.info('Starting GitHub device flow', { scopes });

  // Request device code
  const deviceCodeResponse = await requestDeviceCode(clientId, scopes);

  if (!deviceCodeResponse) {
    return {
      success: false,
      error: 'Failed to initiate device flow. Please check your internet connection and try again.',
    };
  }

  logger.info('Device code received', {
    userCode: deviceCodeResponse.user_code,
    verificationUri: deviceCodeResponse.verification_uri,
    expiresIn: deviceCodeResponse.expires_in,
  });

  // Create the auth result promise (stored in activeFlow.resolve for later access)
  new Promise<GitHubAuthResult>((resolve) => {
    activeFlow = {
      deviceCode: deviceCodeResponse.device_code,
      userCode: deviceCodeResponse.user_code,
      verificationUri: deviceCodeResponse.verification_uri,
      expiresAt: Date.now() + deviceCodeResponse.expires_in * 1000,
      interval: Math.max(deviceCodeResponse.interval * 1000, DEVICE_FLOW_MIN_POLL_INTERVAL_MS),
      pollTimeoutId: null,
      cancelled: false,
      resolve,
    };

    // Start polling
    startPolling(clientId, activeFlow);
  });

  // Optionally open the verification URL in the browser
  if (options?.openBrowser !== false) {
    try {
      await shell.openExternal(deviceCodeResponse.verification_uri);
      logger.debug('Opened verification URL in browser');
    } catch (error) {
      logger.warn('Failed to open browser automatically', error);
    }
  }

  // Don't await the auth promise - return immediately with the user code
  // The caller can subscribe to the completion via a separate method

  return {
    success: true,
    userCode: deviceCodeResponse.user_code,
    verificationUri: deviceCodeResponse.verification_uri,
    expiresIn: deviceCodeResponse.expires_in,
  };
}

/**
 * Wait for the device flow to complete
 * Returns when user authorizes or the flow times out/is cancelled
 */
export async function waitForDeviceFlowCompletion(): Promise<GitHubAuthResult> {
  if (!activeFlow) {
    return {
      success: false,
      error: 'No device flow in progress. Call startDeviceFlow first.',
    };
  }

  // Create a new promise that will resolve when the flow completes
  return new Promise<GitHubAuthResult>((resolve) => {
    if (!activeFlow) {
      resolve({
        success: false,
        error: 'Device flow was cancelled',
      });
      return;
    }

    // Replace the resolve function to also call the new one
    const originalResolve = activeFlow.resolve;
    activeFlow.resolve = (result) => {
      originalResolve(result);
      resolve(result);
    };
  });
}

/**
 * Cancel any active device flow
 */
export function cancelDeviceFlow(): void {
  if (activeFlow) {
    logger.info('Cancelling device flow');
    activeFlow.cancelled = true;
    activeFlow.resolve({
      success: false,
      error: 'Authentication was cancelled',
    });
    cleanupFlow();
  }
}

/**
 * Check if device flow is available (client ID is configured)
 */
export function isDeviceFlowAvailable(): boolean {
  return true; // Always available since we have a default client ID
}

/**
 * Convenience method to run the complete device flow and wait for result
 */
export async function authenticateWithDeviceFlow(options?: {
  scopes?: string[];
  openBrowser?: boolean;
}): Promise<GitHubAuthResult> {
  const startResult = await startDeviceFlow(options);

  if (!startResult.success) {
    return {
      success: false,
      error: startResult.error,
    };
  }

  return waitForDeviceFlowCompletion();
}

/**
 * Notify the main window about device flow state changes
 * (Call this to send updates to the renderer)
 */
export function notifyDeviceFlowState(mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const state = getDeviceFlowState();
  mainWindow.webContents.send('github-device-flow-state', state);
}
