// ============================================================================
// GITHUB CONNECTION STATUS COMPONENT
// ============================================================================

import { useState, useEffect } from 'react';
import type { GitHubAuthState } from '../../../../shared/types/github';
import { toast } from '../../../stores/toastStore';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('SettingsView');

export function GitHubConnectionStatus(): React.JSX.Element {
  const [authState, setAuthState] = useState<GitHubAuthState>({
    isAuthenticated: false,
    user: null,
    accessToken: null,
    tokenExpiresAt: null,
  });
  const [oauthConfig, setOauthConfig] = useState<{
    isConfigured: boolean;
    source: string;
  } | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadAuthState();
    loadOAuthConfig();
  }, []);

  const loadAuthState = async () => {
    try {
      const state = await window.goodvibes.githubGetAuthState();
      setAuthState(state);
    } catch (err) {
      logger.error('Failed to load GitHub auth state:', err);
    }
  };

  const loadOAuthConfig = async () => {
    try {
      const config = await window.goodvibes.githubGetOAuthConfig();
      setOauthConfig(config);
    } catch (err) {
      logger.error('Failed to load OAuth config:', err);
    }
  };

  const handleLogin = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await window.goodvibes.githubAuth();

      if (result.success && result.user) {
        setAuthState({
          isAuthenticated: true,
          user: result.user,
          accessToken: null,
          tokenExpiresAt: null,
        });
        toast.success(`Connected to GitHub as ${result.user.login}`);
      } else {
        setError(result.error || 'Authentication failed');
        toast.error(result.error || 'Failed to connect to GitHub');
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Authentication failed';
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleLogout = async () => {
    setIsLoading(true);

    try {
      await window.goodvibes.githubLogout();
      setAuthState({
        isAuthenticated: false,
        user: null,
        accessToken: null,
        tokenExpiresAt: null,
      });
      toast.success('Disconnected from GitHub');
    } catch (err) {
      logger.error('Logout failed:', err);
      toast.error('Failed to disconnect from GitHub');
    } finally {
      setIsLoading(false);
    }
  };

  // If OAuth is not configured, show a message for developers
  if (oauthConfig && !oauthConfig.isConfigured) {
    return (
      <div className="px-5 py-4 border-b border-surface-700/50 bg-surface-800/20">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-8 h-8 rounded-lg bg-surface-700 flex items-center justify-center">
            <GitHubIcon className="w-4 h-4 text-surface-400" />
          </div>
          <span className="text-sm font-medium text-surface-300">GitHub Connection</span>
        </div>
        <p className="text-xs text-surface-500 mb-1.5 leading-relaxed">
          GitHub integration is not configured. To enable it, the application developer needs to set up OAuth credentials.
        </p>
        <p className="text-xs text-surface-600">
          See .env.example or github-oauth.json for configuration instructions.
        </p>
      </div>
    );
  }

  // If authenticated, show user info and logout button
  if (authState.isAuthenticated && authState.user) {
    return (
      <div className="px-5 py-4 border-b border-surface-700/50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <img
              src={authState.user.avatar_url}
              alt={authState.user.login}
              className="w-10 h-10 rounded-full bg-surface-700 ring-2 ring-success-500/30"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            <div>
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-surface-100">
                  @{authState.user.login}
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-success-500/15 text-success-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-success-400"></span>
                  Connected
                </span>
              </div>
              {authState.user.name && (
                <div className="text-xs text-surface-400 mt-0.5">{authState.user.name}</div>
              )}
            </div>
          </div>
          <button
            onClick={handleLogout}
            disabled={isLoading}
            className="btn btn-secondary btn-sm"
          >
            {isLoading ? 'Disconnecting...' : 'Disconnect'}
          </button>
        </div>
      </div>
    );
  }

  // Not authenticated - show login button
  return (
    <div className="px-5 py-4 border-b border-surface-700/50">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-surface-700 flex items-center justify-center">
            <GitHubIcon className="w-5 h-5 text-surface-400" />
          </div>
          <div>
            <div className="text-sm font-medium text-surface-200">GitHub Connection</div>
            <div className="text-xs text-surface-500 mt-0.5">Connect to access pull requests, issues, and CI status</div>
          </div>
        </div>
        <button
          onClick={handleLogin}
          disabled={isLoading}
          className="btn btn-primary btn-sm flex items-center gap-2"
        >
          <GitHubIcon className="w-4 h-4" />
          {isLoading ? 'Connecting...' : 'Connect GitHub'}
        </button>
      </div>
      {error && (
        <p className="text-xs text-error-400 mt-3 flex items-center gap-1.5">
          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
}

// GitHub Icon SVG
function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12 2C6.477 2 2 6.477 2 12c0 4.42 2.865 8.17 6.839 9.49.5.092.682-.217.682-.482 0-.237-.008-.866-.013-1.7-2.782.604-3.369-1.34-3.369-1.34-.454-1.156-1.11-1.464-1.11-1.464-.908-.62.069-.608.069-.608 1.003.07 1.531 1.03 1.531 1.03.892 1.529 2.341 1.087 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.11-4.555-4.943 0-1.091.39-1.984 1.029-2.683-.103-.253-.446-1.27.098-2.647 0 0 .84-.269 2.75 1.025A9.578 9.578 0 0112 6.836c.85.004 1.705.115 2.504.337 1.909-1.294 2.747-1.025 2.747-1.025.546 1.377.203 2.394.1 2.647.64.699 1.028 1.592 1.028 2.683 0 3.842-2.339 4.687-4.566 4.935.359.309.678.919.678 1.852 0 1.336-.012 2.415-.012 2.743 0 .267.18.578.688.48C19.138 20.167 22 16.418 22 12c0-5.523-4.477-10-10-10z"
      />
    </svg>
  );
}
