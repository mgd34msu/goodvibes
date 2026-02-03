// ============================================================================
// GITHUB TYPES AND CONSTANTS
// ============================================================================

// ============================================================================
// CONSTANTS
// ============================================================================

export const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
export const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const GITHUB_API_URL = 'https://api.github.com';

// Device flow endpoints
export const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';

// Default scopes needed for full GitHub integration
export const DEFAULT_SCOPES = ['repo', 'read:user', 'read:org', 'workflow'];

// Custom protocol callback URL
export const OAUTH_CALLBACK_URL = 'goodvibes://oauth/callback';

// OAuth timeout - if callback doesn't arrive within 5 minutes, abort
export const OAUTH_TIMEOUT_MS = 5 * 60 * 1000;

// Device flow constants
export const DEVICE_FLOW_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes max for user to complete auth
export const DEVICE_FLOW_MIN_POLL_INTERVAL_MS = 5000; // Minimum 5 seconds between polls (GitHub requirement)
export const DEVICE_FLOW_MAX_BACKOFF_MS = 30000; // Maximum backoff interval
