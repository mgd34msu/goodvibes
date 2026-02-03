// ============================================================================
// GITHUB TOKEN MANAGER TESTS
// ============================================================================
//
// These tests verify the security-critical GitHub token management functions
// including token expiration checks, refresh logic, and race condition handling.
//
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTokenExpiringSoon,
  refreshTokenIfNeeded,
  getValidAccessToken,
} from '../token-manager.js';
import * as state from '../state.js';
import * as credentials from '../credentials.js';
import * as api from '../api.js';

// ============================================================================
// MOCKS
// ============================================================================

vi.mock('../state.js');
vi.mock('../credentials.js');
vi.mock('../api.js');
vi.mock('../../logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    error = vi.fn();
    warn = vi.fn();
  },
}));
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    getName: vi.fn(() => 'goodvibes'),
  },
}));
vi.mock('electron-store', () => ({
  default: class MockStore {
    get = vi.fn();
    set = vi.fn();
    delete = vi.fn();
    clear = vi.fn();
    has = vi.fn();
  },
}));

// ============================================================================
// TEST CONSTANTS
// ============================================================================

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes
const MOCK_ACCESS_TOKEN = 'gho_mockAccessToken123';
const MOCK_REFRESH_TOKEN = 'ghr_mockRefreshToken123';
const MOCK_CLIENT_ID = 'mock_client_id';
const MOCK_CLIENT_SECRET = 'mock_client_secret';

// ============================================================================
// isTokenExpiringSoon TESTS
// ============================================================================

describe('isTokenExpiringSoon', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('should return false for non-expiring tokens', () => {
    it('returns false for null expiry', () => {
      expect(isTokenExpiringSoon(null)).toBe(false);
    });

    it('returns false for undefined expiry', () => {
      expect(isTokenExpiringSoon(undefined)).toBe(false);
    });
  });

  describe('should correctly detect expiration timing', () => {
    it('returns false when token expires in more than 5 minutes', () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS + 1000; // 5 minutes + 1 second
      vi.setSystemTime(now);

      expect(isTokenExpiringSoon(expiresAt)).toBe(false);
    });

    it('returns true when token expires in exactly 5 minutes', () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS;
      vi.setSystemTime(now);

      expect(isTokenExpiringSoon(expiresAt)).toBe(true);
    });

    it('returns true when token expires in less than 5 minutes', () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS - 1000; // 5 minutes - 1 second
      vi.setSystemTime(now);

      expect(isTokenExpiringSoon(expiresAt)).toBe(true);
    });

    it('returns true when token is already expired', () => {
      const now = Date.now();
      const expiresAt = now - 1000; // expired 1 second ago
      vi.setSystemTime(now);

      expect(isTokenExpiringSoon(expiresAt)).toBe(true);
    });
  });

  describe('should handle edge cases', () => {
    it('returns true for expiry at epoch (0)', () => {
      expect(isTokenExpiringSoon(0)).toBe(true);
    });

    it('returns false for far future expiry', () => {
      const now = Date.now();
      const expiresAt = now + 365 * 24 * 60 * 60 * 1000; // 1 year from now
      vi.setSystemTime(now);

      expect(isTokenExpiringSoon(expiresAt)).toBe(false);
    });

    it('handles negative timestamps', () => {
      expect(isTokenExpiringSoon(-1000)).toBe(true);
    });
  });
});

// ============================================================================
// refreshTokenIfNeeded TESTS
// ============================================================================

describe('refreshTokenIfNeeded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('should skip refresh when not needed', () => {
    it('returns auth state when no refresh token available', async () => {
      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: null,
        tokenExpiresAt: null,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: null,
        user: null,
      });

      const result = await refreshTokenIfNeeded();

      expect(result).toBe(true);
      expect(api.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('returns auth state when token is not expiring soon', async () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS + 60000; // 6 minutes
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });

      const result = await refreshTokenIfNeeded();

      expect(result).toBe(true);
      expect(api.refreshAccessToken).not.toHaveBeenCalled();
    });
  });

  describe('should refresh token when needed', () => {
    it('refreshes token successfully when expiring soon', async () => {
      const now = Date.now();
      const oldExpiresAt = now + REFRESH_BUFFER_MS - 1000; // expiring soon
      const newExpiresAt = now + 3600000; // 1 hour from now
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: oldExpiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: oldExpiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: MOCK_CLIENT_ID,
        clientSecret: MOCK_CLIENT_SECRET,
      });
      vi.mocked(api.refreshAccessToken).mockResolvedValue({
        access_token: 'gho_newAccessToken',
        refresh_token: 'ghr_newRefreshToken',
        expires_in: 3600,
        token_type: 'bearer',
      });

      const result = await refreshTokenIfNeeded();

      expect(result).toBe(true);
      expect(api.refreshAccessToken).toHaveBeenCalledWith(
        MOCK_REFRESH_TOKEN,
        MOCK_CLIENT_ID,
        MOCK_CLIENT_SECRET
      );
      expect(state.updateStoredTokens).toHaveBeenCalledWith({
        access_token: 'gho_newAccessToken',
        refresh_token: 'ghr_newRefreshToken',
        expires_in: 3600,
        token_type: 'bearer',
      });
      expect(state.updateAuthState).toHaveBeenCalled();
    });

    it('updates token expiry correctly', async () => {
      const now = Date.now();
      const oldExpiresAt = now + REFRESH_BUFFER_MS - 1000;
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: oldExpiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: oldExpiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: MOCK_CLIENT_ID,
        clientSecret: MOCK_CLIENT_SECRET,
      });
      vi.mocked(api.refreshAccessToken).mockResolvedValue({
        access_token: 'gho_newAccessToken',
        expires_in: 7200, // 2 hours
        token_type: 'bearer',
      });

      await refreshTokenIfNeeded();

      const updateCall = vi.mocked(state.updateAuthState).mock.calls[0][0];
      expect(updateCall.accessToken).toBe('gho_newAccessToken');
      expect(updateCall.tokenExpiresAt).toBe(now + 7200 * 1000);
    });

    it('handles null expires_in by setting tokenExpiresAt to null', async () => {
      const now = Date.now();
      const oldExpiresAt = now + REFRESH_BUFFER_MS - 1000;
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: oldExpiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: oldExpiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: MOCK_CLIENT_ID,
        clientSecret: MOCK_CLIENT_SECRET,
      });
      vi.mocked(api.refreshAccessToken).mockResolvedValue({
        access_token: 'gho_newAccessToken',
        token_type: 'bearer',
      });

      await refreshTokenIfNeeded();

      const updateCall = vi.mocked(state.updateAuthState).mock.calls[0][0];
      expect(updateCall.tokenExpiresAt).toBe(null);
    });
  });

  describe('should handle error cases', () => {
    it('returns false when OAuth credentials not configured', async () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS - 1000;
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: null,
        clientSecret: null,
      });

      const result = await refreshTokenIfNeeded();

      expect(result).toBe(false);
      expect(api.refreshAccessToken).not.toHaveBeenCalled();
    });

    it('returns false when API refresh fails', async () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS - 1000;
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: MOCK_CLIENT_ID,
        clientSecret: MOCK_CLIENT_SECRET,
      });
      vi.mocked(api.refreshAccessToken).mockResolvedValue(null);

      const result = await refreshTokenIfNeeded();

      expect(result).toBe(false);
      expect(state.updateStoredTokens).not.toHaveBeenCalled();
      expect(state.updateAuthState).not.toHaveBeenCalled();
    });

    it('handles 401 unauthorized response', async () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS - 1000;
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: MOCK_CLIENT_ID,
        clientSecret: MOCK_CLIENT_SECRET,
      });
      vi.mocked(api.refreshAccessToken).mockRejectedValue(
        new Error('HTTP 401: Unauthorized')
      );

      await expect(refreshTokenIfNeeded()).rejects.toThrow('HTTP 401: Unauthorized');
    });
  });

  describe('should handle race conditions', () => {
    it('handles concurrent refresh requests', async () => {
      const now = Date.now();
      const expiresAt = now + REFRESH_BUFFER_MS - 1000;
      vi.setSystemTime(now);

      vi.mocked(state.getStoredCredentials).mockReturnValue({
        accessToken: MOCK_ACCESS_TOKEN,
        refreshToken: MOCK_REFRESH_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(state.getAuthStateInternal).mockReturnValue({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      });
      vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
        clientId: MOCK_CLIENT_ID,
        clientSecret: MOCK_CLIENT_SECRET,
      });
      
      // Simulate multiple API calls (no built-in deduplication)
      let apiCallCount = 0;
      vi.mocked(api.refreshAccessToken).mockImplementation(() => {
        apiCallCount++;
        return Promise.resolve({
          access_token: 'gho_newAccessToken',
          expires_in: 3600,
          token_type: 'bearer',
        });
      });

      // Make concurrent calls
      const [result1, result2, result3] = await Promise.all([
        refreshTokenIfNeeded(),
        refreshTokenIfNeeded(),
        refreshTokenIfNeeded(),
      ]);

      // All should succeed
      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(result3).toBe(true);
      
      // API should be called multiple times (no built-in deduplication)
      // This test documents current behavior - race condition exists
      expect(apiCallCount).toBe(3); // Each call triggers refresh
    });
  });
});

// ============================================================================
// getValidAccessToken TESTS
// ============================================================================

describe('getValidAccessToken', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns access token after successful refresh', async () => {
    const now = Date.now();
    const expiresAt = now + REFRESH_BUFFER_MS - 1000;
    vi.setSystemTime(now);

    vi.mocked(state.getStoredCredentials).mockReturnValue({
      accessToken: MOCK_ACCESS_TOKEN,
      refreshToken: MOCK_REFRESH_TOKEN,
      tokenExpiresAt: expiresAt,
      user: null,
    });
    vi.mocked(state.getAuthStateInternal)
      .mockReturnValueOnce({
        isAuthenticated: true,
        accessToken: MOCK_ACCESS_TOKEN,
        tokenExpiresAt: expiresAt,
        user: null,
      })
      .mockReturnValueOnce({
        isAuthenticated: true,
        accessToken: 'gho_newAccessToken',
        tokenExpiresAt: now + 3600000,
        user: null,
      });
    vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
    });
    vi.mocked(api.refreshAccessToken).mockResolvedValue({
      access_token: 'gho_newAccessToken',
      expires_in: 3600,
      token_type: 'bearer',
    });

    const token = await getValidAccessToken();

    expect(token).toBe('gho_newAccessToken');
  });

  it('returns null when no token available', async () => {
    vi.mocked(state.getStoredCredentials).mockReturnValue({
      accessToken: null,
      refreshToken: null,
      tokenExpiresAt: null,
      user: null,
    });
    vi.mocked(state.getAuthStateInternal).mockReturnValue({
      isAuthenticated: false,
      accessToken: null,
      tokenExpiresAt: null,
      user: null,
    });

    const token = await getValidAccessToken();

    expect(token).toBe(null);
  });

  it('returns current token when not expiring', async () => {
    const now = Date.now();
    const expiresAt = now + REFRESH_BUFFER_MS + 60000;
    vi.setSystemTime(now);

    vi.mocked(state.getStoredCredentials).mockReturnValue({
      accessToken: MOCK_ACCESS_TOKEN,
      refreshToken: MOCK_REFRESH_TOKEN,
      tokenExpiresAt: expiresAt,
      user: null,
    });
    vi.mocked(state.getAuthStateInternal).mockReturnValue({
      isAuthenticated: true,
      accessToken: MOCK_ACCESS_TOKEN,
      tokenExpiresAt: expiresAt,
      user: null,
    });

    const token = await getValidAccessToken();

    expect(token).toBe(MOCK_ACCESS_TOKEN);
    expect(api.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('handles refresh failure gracefully', async () => {
    const now = Date.now();
    const expiresAt = now + REFRESH_BUFFER_MS - 1000;
    vi.setSystemTime(now);

    vi.mocked(state.getStoredCredentials).mockReturnValue({
      accessToken: MOCK_ACCESS_TOKEN,
      refreshToken: MOCK_REFRESH_TOKEN,
      tokenExpiresAt: expiresAt,
      user: null,
    });
    vi.mocked(state.getAuthStateInternal).mockReturnValue({
      isAuthenticated: true,
      accessToken: MOCK_ACCESS_TOKEN,
      tokenExpiresAt: expiresAt,
      user: null,
    });
    vi.mocked(credentials.getOAuthCredentialsInternal).mockReturnValue({
      clientId: MOCK_CLIENT_ID,
      clientSecret: MOCK_CLIENT_SECRET,
    });
    vi.mocked(api.refreshAccessToken).mockResolvedValue(null);

    const token = await getValidAccessToken();

    // Returns old token even though refresh failed
    expect(token).toBe(MOCK_ACCESS_TOKEN);
  });
});
