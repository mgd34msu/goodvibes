// ============================================================================
// GITHUB OAUTH CONFIGURATION
// ============================================================================

import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { Logger } from '../logger.js';
import { githubStore, clearCredentialsCache } from './credentials.js';

const logger = new Logger('GitHubOAuthConfig');

// ============================================================================
// CONFIGURATION TYPES
// ============================================================================

export type OAuthCredentialSource = 'environment' | 'bundled' | 'user' | 'none';

export interface OAuthConfigStatus {
  isConfigured: boolean;
  source: OAuthCredentialSource;
  clientId: string | null;
}

// ============================================================================
// CONFIGURATION MANAGEMENT
// ============================================================================

/**
 * Get OAuth configuration status
 */
export function getOAuthConfig(): OAuthConfigStatus {
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
    const configPaths = getBundledConfigPaths();

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
  } catch (error) {
    // Bundled config read/parse errors are logged at debug level since this
    // is a fallback configuration source and may not exist in all deployments.
    logger.debug('Failed to read bundled OAuth config', {
      operation: 'getOAuthConfig',
      errorMessage: error instanceof Error ? error.message : String(error),
    });
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
 * Get possible paths for bundled OAuth config
 */
function getBundledConfigPaths(): string[] {
  return [
    // Production: alongside the executable
    path.join(path.dirname(app.getPath('exe')), 'github-oauth.json'),
    // Development: in project root
    path.join(app.getAppPath(), 'github-oauth.json'),
    // Alternative: in resources
    path.join(process.resourcesPath || '', 'github-oauth.json'),
  ];
}

// ============================================================================
// LEGACY CREDENTIAL MANAGEMENT
// ============================================================================

/**
 * Set OAuth credentials (legacy support only)
 * @deprecated Use environment variables or bundled config instead
 */
export function setOAuthCredentials(clientId: string, clientSecret: string): void {
  githubStore.set('clientId', clientId);
  githubStore.set('clientSecret', clientSecret);
  clearCredentialsCache();
  logger.info('GitHub OAuth credentials updated (legacy mode)');
}

/**
 * Clear legacy user-saved OAuth credentials
 */
export function clearOAuthCredentials(): void {
  githubStore.delete('clientId');
  githubStore.delete('clientSecret');
  clearCredentialsCache();
  logger.info('Legacy GitHub OAuth credentials cleared');
}
