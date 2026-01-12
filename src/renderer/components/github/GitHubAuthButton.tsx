// ============================================================================
// GITHUB AUTH BUTTON COMPONENT
// ============================================================================

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import type { GitHubUser, GitHubAuthState } from '../../../shared/types/github';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('GitHubAuth');

interface GitHubAuthButtonProps {
  onAuthChange?: (isAuthenticated: boolean, user: GitHubUser | null) => void;
  className?: string;
  showUserInfo?: boolean;
}

export default function GitHubAuthButton({
  onAuthChange,
  className,
  showUserInfo = true,
}: GitHubAuthButtonProps) {
  const [authState, setAuthState] = useState<GitHubAuthState>({
    isAuthenticated: false,
    user: null,
    accessToken: null,
    tokenExpiresAt: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load auth state on mount
  useEffect(() => {
    loadAuthState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadAuthState = async () => {
    try {
      const state = await window.goodvibes.githubGetAuthState();
      setAuthState(state);
      onAuthChange?.(state.isAuthenticated, state.user);
    } catch (err) {
      logger.error('Failed to load GitHub auth state:', err);
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
          accessToken: null, // Not exposed to renderer
          tokenExpiresAt: null,
        });
        onAuthChange?.(true, result.user);
      } else {
        setError(result.error || 'Authentication failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
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
      onAuthChange?.(false, null);
    } catch (err) {
      logger.error('Logout failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  if (authState.isAuthenticated && authState.user) {
    return (
      <div className={clsx('flex items-center gap-3', className)}>
        {showUserInfo && (
          <div className="flex items-center gap-2">
            <img
              src={authState.user.avatar_url}
              alt={authState.user.login}
              className="w-6 h-6 rounded-full bg-surface-700"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
            <span className="text-sm text-surface-200">{authState.user.login}</span>
          </div>
        )}
        <button
          onClick={handleLogout}
          disabled={isLoading}
          className="btn btn-secondary btn-sm"
        >
          {isLoading ? 'Logging out...' : 'Logout'}
        </button>
      </div>
    );
  }

  return (
    <div className={clsx('flex flex-col gap-2', className)}>
      <button
        onClick={handleLogin}
        disabled={isLoading}
        className="btn btn-primary btn-sm flex items-center gap-2"
      >
        <GitHubIcon className="w-4 h-4" />
        {isLoading ? 'Connecting...' : 'Connect GitHub'}
      </button>
      {error && (
        <p className="text-xs text-error-400">{error}</p>
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
