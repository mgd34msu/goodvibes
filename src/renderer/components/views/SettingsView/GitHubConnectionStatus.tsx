// ============================================================================
// GITHUB CONNECTION STATUS COMPONENT
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import type { GitHubAuthState, GitHubUser, CustomOAuthConfigStatus } from '../../../../shared/types/github';
import { toast } from '../../../stores/toastStore';
import { createLogger } from '../../../../shared/logger';
import { DeviceFlowLogin } from '../../github/DeviceFlowLogin';

const logger = createLogger('SettingsView');

// ============================================================================
// TYPES
// ============================================================================

interface GitHubConnectionStatusProps {
  /** OAuth configuration status passed from parent */
  oauthStatus?: CustomOAuthConfigStatus | null;
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

function CredentialSourceBadge({ source }: { source: CustomOAuthConfigStatus['source'] }) {
  const labels: Record<CustomOAuthConfigStatus['source'], string> = {
    default: 'Built-in app',
    custom: 'Custom OAuth app',
    environment: 'Environment credentials',
  };

  const colors: Record<CustomOAuthConfigStatus['source'], string> = {
    default: 'bg-surface-700 text-surface-400',
    custom: 'bg-primary-500/15 text-primary-400',
    environment: 'bg-warning-500/15 text-warning-400',
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-2xs font-medium ${colors[source]}`}>
      {labels[source]}
    </span>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export function GitHubConnectionStatus({ oauthStatus }: GitHubConnectionStatusProps): React.JSX.Element {
  const [authState, setAuthState] = useState<GitHubAuthState>({
    isAuthenticated: false,
    user: null,
    accessToken: null,
    tokenExpiresAt: null,
  });
  const [isLoading, setIsLoading] = useState(false);
  const [showDeviceFlow, setShowDeviceFlow] = useState(false);

  useEffect(() => {
    loadAuthState();
  }, []);

  const loadAuthState = async () => {
    try {
      const state = await window.goodvibes.githubGetAuthState();
      setAuthState(state);
    } catch (err) {
      logger.error('Failed to load GitHub auth state:', err);
    }
  };

  const handleLogin = () => {
    setShowDeviceFlow(true);
  };

  const handleAuthSuccess = useCallback((user: GitHubUser) => {
    setAuthState({
      isAuthenticated: true,
      user,
      accessToken: null,
      tokenExpiresAt: null,
    });
    setShowDeviceFlow(false);
    toast.success(`Connected to GitHub as ${user.login}`);
  }, []);

  const handleAuthError = useCallback((error: string) => {
    toast.error(error || 'Failed to connect to GitHub');
    setShowDeviceFlow(false);
  }, []);

  const handleCancel = useCallback(() => {
    setShowDeviceFlow(false);
  }, []);

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

  // If showing device flow, render the device flow UI
  if (showDeviceFlow) {
    return (
      <div className="px-5 py-4 border-b border-surface-700/50">
        <DeviceFlowLogin
          onAuthSuccess={handleAuthSuccess}
          onAuthError={handleAuthError}
          onCancel={handleCancel}
          compact
        />
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
              <div className="flex items-center gap-2 mt-0.5">
                {authState.user.name && (
                  <span className="text-xs text-surface-400">{authState.user.name}</span>
                )}
                {oauthStatus && (
                  <>
                    {authState.user.name && <span className="text-xs text-surface-600">|</span>}
                    <CredentialSourceBadge source={oauthStatus.source} />
                  </>
                )}
              </div>
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
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-surface-200">GitHub Connection</span>
              {oauthStatus && <CredentialSourceBadge source={oauthStatus.source} />}
            </div>
            <div className="text-xs text-surface-500 mt-0.5">Connect to access pull requests, issues, and CI status</div>
          </div>
        </div>
        <button
          onClick={handleLogin}
          className="btn btn-primary btn-sm flex items-center gap-2"
        >
          <GitHubIcon className="w-4 h-4" />
          Connect GitHub
        </button>
      </div>
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
