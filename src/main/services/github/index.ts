// ============================================================================
// GITHUB SERVICE - Main exports
// ============================================================================

// Re-export credentials functions
export {
  isOAuthConfigured,
  setCustomOAuthCredentials,
  getCustomOAuthCredentials,
  clearCustomOAuthCredentials,
  getOAuthConfigStatus,
} from './credentials.js';

// Re-export auth functions (includes re-exports from other modules)
export {
  initializeGitHub,
  authenticateWithGitHub,
  handleOAuthCallback,
  setPendingOAuthCallback,
  // Device flow exports
  startDeviceFlow,
  waitForDeviceFlowCompletion,
  cancelDeviceFlow,
  getDeviceFlowState,
  isDeviceFlowAvailable,
  authenticateWithDeviceFlow,
  getDeviceFlowClientId,
  // Auth state
  logout,
  refreshTokenIfNeeded,
  getAccessToken,
  isAuthenticated,
  getCurrentUser,
  getAuthState,
  setOAuthCredentials,
  getOAuthConfig,
  clearOAuthCredentials,
  clearStoredCredentials,
} from './auth.js';

// Re-export types
export type { AuthenticateOptions } from './auth.js';
export type { OAuthCredentialSource, OAuthConfigStatus } from './oauth-config.js';
