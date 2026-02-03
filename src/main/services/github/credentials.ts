// ============================================================================
// GITHUB OAUTH CREDENTIALS MANAGEMENT
// ============================================================================

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import Store from 'electron-store';
import { Logger } from '../logger.js';
import type { GitHubUser } from '../../../shared/types/github.js';

const logger = new Logger('GitHubCredentials');

// ============================================================================
// SECURE STORE
// ============================================================================

/**
 * Generate a machine-specific encryption key.
 * Uses hardware identifiers to create a per-installation key.
 * This is more secure than a hardcoded key, though still not perfect.
 * For production, consider using OS keychains (Keytar/safeStorage).
 */
function generateEncryptionKey(): string {
  // Combine multiple machine identifiers for uniqueness
  const machineInfo = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.homedir(),
    app.getPath('userData'),
  ].join('|');

  // Generate a stable hash
  return crypto.createHash('sha256')
    .update(`goodvibes-github-${machineInfo}`)
    .digest('hex')
    .substring(0, 32);
}

// Type for GitHub store schema
interface GitHubStoreSchema {
  accessToken?: string;
  refreshToken?: string;
  tokenExpiresAt?: number;
  user?: GitHubUser;
  clientId?: string;
  clientSecret?: string;
  // Custom OAuth credentials (user-provided)
  customClientId?: string;
  customClientSecret?: string;
  customUseDeviceFlow?: boolean;
}

// Create an encrypted store for GitHub credentials
export const githubStore = new Store<GitHubStoreSchema>({
  name: 'github-auth',
  encryptionKey: generateEncryptionKey(),
});

// ============================================================================
// CREDENTIAL LOADING
// ============================================================================

// Cached credentials (loaded once at startup)
let cachedCredentials: { clientId: string | null; clientSecret: string | null } | null = null;

/**
 * Load OAuth credentials for authorization code flow (requires client secret).
 *
 * For desktop apps like GoodVibes, embedding OAuth credentials is standard practice.
 * The developer creates ONE GitHub OAuth App for the entire GoodVibes application.
 * End users simply click "Login with GitHub" - zero setup required.
 *
 * Credential loading priority:
 * 1. Custom credentials (user-provided via settings) - if not using device flow
 * 2. Environment variables (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET)
 * 3. Bundled config file (for production builds)
 * 4. Previously saved user credentials (legacy fallback)
 */
export function loadOAuthCredentials(): { clientId: string | null; clientSecret: string | null } {
  // Check custom credentials first (highest priority)
  // Only use custom credentials for auth code flow if they have a secret and are NOT set to use device flow
  const customClientId = githubStore.get('customClientId');
  const customClientSecret = githubStore.get('customClientSecret');
  const customUseDeviceFlow = githubStore.get('customUseDeviceFlow');

  if (customClientId && customClientSecret && !customUseDeviceFlow) {
    logger.debug('Using custom OAuth credentials for authorization code flow');
    return { clientId: customClientId, clientSecret: customClientSecret };
  }

  // Try environment variables (development or custom deployment)
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
  } catch {
    logger.debug('No bundled OAuth config found');
  }

  // Legacy fallback: check electron-store for user-saved credentials
  const storedClientId = githubStore.get('clientId');
  const storedClientSecret = githubStore.get('clientSecret');

  if (storedClientId && storedClientSecret) {
    logger.debug('Using legacy user-saved OAuth credentials');
    return { clientId: storedClientId, clientSecret: storedClientSecret };
  }

  return { clientId: null, clientSecret: null };
}

/**
 * Get OAuth credentials (cached for performance)
 */
export function getOAuthCredentialsInternal(): { clientId: string | null; clientSecret: string | null } {
  if (!cachedCredentials) {
    cachedCredentials = loadOAuthCredentials();
  }
  return cachedCredentials;
}

/**
 * Clear the cached credentials (used when credentials are updated)
 */
export function clearCredentialsCache(): void {
  cachedCredentials = null;
}

/**
 * Check if OAuth is configured (either bundled, user-provided, or device flow available)
 * Device flow only needs a client ID, not a client secret.
 */
export function isOAuthConfigured(): boolean {
  // Device flow is always available since we have a hardcoded default client ID
  // This allows GitHub integration to work out of the box without any configuration
  return true;
}

// ============================================================================
// CUSTOM OAUTH CREDENTIALS
// ============================================================================

/**
 * Set custom OAuth credentials provided by the user.
 * These take priority over environment variables and bundled config.
 */
export function setCustomOAuthCredentials(
  clientId: string,
  clientSecret: string | null,
  useDeviceFlow: boolean
): void {
  logger.info('Setting custom OAuth credentials', {
    clientIdLength: clientId.length,
    hasClientSecret: !!clientSecret,
    useDeviceFlow,
  });

  githubStore.set('customClientId', clientId);
  if (clientSecret) {
    githubStore.set('customClientSecret', clientSecret);
  } else {
    githubStore.delete('customClientSecret');
  }
  githubStore.set('customUseDeviceFlow', useDeviceFlow);

  // Clear the cached credentials so they get reloaded
  clearCredentialsCache();
}

/**
 * Get custom OAuth credentials if configured.
 * Returns null if no custom credentials are set.
 */
export function getCustomOAuthCredentials(): {
  clientId: string;
  clientSecret: string | null;
  useDeviceFlow: boolean;
} | null {
  const customClientId = githubStore.get('customClientId');

  if (!customClientId) {
    return null;
  }

  return {
    clientId: customClientId,
    clientSecret: githubStore.get('customClientSecret') ?? null,
    useDeviceFlow: githubStore.get('customUseDeviceFlow') ?? true,
  };
}

/**
 * Clear custom OAuth credentials.
 * After clearing, the system falls back to environment or bundled defaults.
 */
export function clearCustomOAuthCredentials(): void {
  logger.info('Clearing custom OAuth credentials');

  githubStore.delete('customClientId');
  githubStore.delete('customClientSecret');
  githubStore.delete('customUseDeviceFlow');

  // Clear the cached credentials so they get reloaded
  clearCredentialsCache();
}

/**
 * Get the current custom OAuth configuration status.
 * This is safe to expose over IPC as it never returns the actual secret.
 */
export function getOAuthConfigStatus(): {
  isConfigured: boolean;
  source: 'default' | 'custom' | 'environment';
  clientId: string | null;
  useDeviceFlow: boolean;
  hasClientSecret: boolean;
} {
  // Check custom credentials first (highest priority)
  const customCreds = getCustomOAuthCredentials();
  if (customCreds) {
    return {
      isConfigured: true,
      source: 'custom',
      clientId: customCreds.clientId,
      useDeviceFlow: customCreds.useDeviceFlow,
      hasClientSecret: !!customCreds.clientSecret,
    };
  }

  // Check environment variables
  const envClientId = process.env.GITHUB_CLIENT_ID;
  const envClientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (envClientId) {
    return {
      isConfigured: true,
      source: 'environment',
      clientId: envClientId,
      useDeviceFlow: !envClientSecret, // Use device flow if no secret
      hasClientSecret: !!envClientSecret,
    };
  }

  // Default configuration (bundled client ID with device flow)
  return {
    isConfigured: true,
    source: 'default',
    clientId: null, // Don't expose the default client ID
    useDeviceFlow: true,
    hasClientSecret: false,
  };
}
