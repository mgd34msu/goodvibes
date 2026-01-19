// ============================================================================
// GITHUB OAUTH SERVICE - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular github/ directory.
//
// ============================================================================

export {
  isOAuthConfigured,
  initializeGitHub,
  authenticateWithGitHub,
  handleOAuthCallback,
  setPendingOAuthCallback,
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
  // Device flow exports
  startDeviceFlow,
  waitForDeviceFlowCompletion,
  cancelDeviceFlow,
  getDeviceFlowState,
  isDeviceFlowAvailable,
  authenticateWithDeviceFlow,
  getDeviceFlowClientId,
  // Custom OAuth credentials
  setCustomOAuthCredentials,
  getCustomOAuthCredentials,
  clearCustomOAuthCredentials,
  getOAuthConfigStatus,
} from './github/index.js';

// Re-export types for backward compatibility
export type { AuthenticateOptions, OAuthCredentialSource, OAuthConfigStatus } from './github/index.js';
