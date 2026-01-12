// ============================================================================
// SETTINGS VIEW COMPONENT
// ============================================================================

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';
import { useQueryClient } from '@tanstack/react-query';
import { useSettingsStore } from '../../stores/settingsStore';
import type { AppSettings } from '../../../shared/types';
import { toast } from '../../stores/toastStore';
import type { GitHubAuthState } from '../../../shared/types/github';
import { useConfirm } from '../overlays/ConfirmModal';

export default function SettingsView() {
  const settings = useSettingsStore((s) => s.settings);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const [isResetting, setIsResetting] = useState(false);

  const { confirm: confirmReset, ConfirmDialog: ResetConfirmDialog } = useConfirm({
    title: 'Reset All Settings',
    message: 'Are you sure you want to reset all settings to their default values? This cannot be undone.',
    confirmText: 'Reset Settings',
    cancelText: 'Cancel',
    variant: 'danger',
  });

  const handleChange = async <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    try {
      await updateSetting(key, value);
      toast.success('Setting updated');
    } catch {
      toast.error('Failed to update setting');
    }
  };

  const handleResetSettings = async () => {
    const confirmed = await confirmReset();
    if (confirmed) {
      setIsResetting(true);
      try {
        await resetSettings();
        toast.success('Settings reset to defaults');
      } catch {
        toast.error('Failed to reset settings');
      } finally {
        setIsResetting(false);
      }
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-8">
        <div className="page-header">
          <div>
            <h1 className="text-xl font-semibold text-surface-100">Settings</h1>
            <p className="text-sm text-surface-500 mt-1">Customize your experience</p>
          </div>
        </div>

        {/* Appearance */}
        <SettingsSection title="Appearance">
          <SettingRow
            label="Theme"
            description="Choose your preferred color scheme"
          >
            <select
              value={settings.theme}
              onChange={(e) => handleChange('theme', e.target.value as 'dark' | 'light')}
              className="select w-40"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>
          </SettingRow>

          <SettingRow
            label="Font Size"
            description="Terminal font size in pixels"
          >
            <div className="flex items-center gap-3">
              <input
                type="range"
                min="10"
                max="20"
                value={settings.fontSize}
                onChange={(e) => handleChange('fontSize', parseInt(e.target.value))}
                className="w-32"
              />
              <span className="text-sm text-surface-400 w-12">{settings.fontSize}px</span>
            </div>
          </SettingRow>
        </SettingsSection>

        {/* Startup Behavior */}
        <SettingsSection title="Startup Behavior">
          <SettingRow
            label="On Startup"
            description="What happens when you launch the app"
          >
            <select
              value={settings.startupBehavior}
              onChange={(e) => handleChange('startupBehavior', e.target.value as AppSettings['startupBehavior'])}
              className="select w-48"
            >
              <option value="empty">Show empty state</option>
              <option value="last-project">Open last project</option>
              <option value="folder-picker">Show folder picker</option>
            </select>
          </SettingRow>

          <SettingRow
            label="Restore Tabs"
            description="Restore previous terminal tabs on startup"
          >
            <ToggleSwitch
              checked={settings.restoreTabs}
              onChange={(value) => handleChange('restoreTabs', value)}
            />
          </SettingRow>

          <SettingRow
            label="Auto Session Watch"
            description="Automatically watch for subagent sessions"
          >
            <ToggleSwitch
              checked={settings.autoSessionWatch}
              onChange={(value) => handleChange('autoSessionWatch', value)}
            />
          </SettingRow>

          <SettingRow
            label="Hide Agent Sessions"
            description="Hide subagent sessions from the sessions list"
          >
            <ToggleSwitch
              checked={settings.hideAgentSessions}
              onChange={(value) => handleChange('hideAgentSessions', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* Claude CLI Options */}
        <SettingsSection title="Claude CLI Options">
          <SettingRow
            label="Claude Path"
            description="Custom path to Claude CLI executable (leave empty for default)"
          >
            <input
              type="text"
              value={settings.claudePath || ''}
              onChange={(e) => handleChange('claudePath', e.target.value || null)}
              placeholder="Leave empty for default"
              className="input w-64"
            />
          </SettingRow>

          <SettingRow
            label="Default Working Directory"
            description="Default directory for new sessions"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.defaultCwd || ''}
                onChange={(e) => handleChange('defaultCwd', e.target.value || null)}
                placeholder="Leave empty for current directory"
                className="input w-64"
              />
              <button
                onClick={async () => {
                  const folder = await window.goodvibes.selectFolder();
                  if (folder) handleChange('defaultCwd', folder);
                }}
                className="btn btn-secondary btn-sm"
              >
                Browse
              </button>
            </div>
          </SettingRow>

          <SettingRow
            label="Projects Root"
            description="Used to display clean project names"
          >
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={settings.projectsRoot || ''}
                onChange={(e) => handleChange('projectsRoot', e.target.value || null)}
                placeholder="e.g., C:\Users\name\Documents"
                className="input w-64"
              />
              <button
                onClick={async () => {
                  const folder = await window.goodvibes.selectFolder();
                  if (folder) handleChange('projectsRoot', folder);
                }}
                className="btn btn-secondary btn-sm"
              >
                Browse
              </button>
            </div>
          </SettingRow>

          <SettingRow
            label="Skip Permission Prompts"
            description="Run Claude with --dangerously-skip-permissions"
          >
            <ToggleSwitch
              checked={settings.skipPermissions}
              onChange={(value) => handleChange('skipPermissions', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* Git Integration */}
        <SettingsSection title="Git Integration">
          <SettingRow
            label="Git Panel Position"
            description="Position of the Git sidebar"
          >
            <select
              value={settings.gitPanelPosition}
              onChange={(e) => handleChange('gitPanelPosition', e.target.value as 'left' | 'right')}
              className="select w-32"
            >
              <option value="right">Right</option>
              <option value="left">Left</option>
            </select>
          </SettingRow>

          <SettingRow
            label="Auto-refresh Git"
            description="Refresh Git status when terminal gains focus"
          >
            <ToggleSwitch
              checked={settings.gitAutoRefresh}
              onChange={(value) => handleChange('gitAutoRefresh', value)}
            />
          </SettingRow>

          <SettingRow
            label="Show Git Panel on Start"
            description="Show Git panel by default"
          >
            <ToggleSwitch
              checked={settings.gitShowOnStart}
              onChange={(value) => handleChange('gitShowOnStart', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* GitHub Integration */}
        <SettingsSection title="GitHub Integration">
          <GitHubConnectionStatus />

          <SettingRow
            label="Enable GitHub Integration"
            description="Show GitHub features in the Git panel"
          >
            <ToggleSwitch
              checked={settings.githubEnabled}
              onChange={(value) => handleChange('githubEnabled', value)}
            />
          </SettingRow>

          <SettingRow
            label="Show in Git Panel"
            description="Display GitHub info alongside local git status"
          >
            <ToggleSwitch
              checked={settings.githubShowInGitPanel}
              onChange={(value) => handleChange('githubShowInGitPanel', value)}
            />
          </SettingRow>

          <SettingRow
            label="Auto-load Pull Requests"
            description="Automatically fetch open PRs when opening Git panel"
          >
            <ToggleSwitch
              checked={settings.githubAutoLoadPRs}
              onChange={(value) => handleChange('githubAutoLoadPRs', value)}
            />
          </SettingRow>

          <SettingRow
            label="Auto-load CI Status"
            description="Automatically fetch CI/CD status for current branch"
          >
            <ToggleSwitch
              checked={settings.githubAutoLoadCI}
              onChange={(value) => handleChange('githubAutoLoadCI', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* Budget Alerts */}
        <SettingsSection title="Budget Alerts">
          <SettingRow
            label="Daily Budget Limit"
            description="Daily spending limit in dollars"
          >
            <input
              type="number"
              value={settings.dailyBudget || ''}
              onChange={(e) => handleChange('dailyBudget', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder="0.00"
              step="0.01"
              min="0"
              className="input w-32"
            />
          </SettingRow>

          <SettingRow
            label="Monthly Budget Limit"
            description="Monthly spending limit in dollars"
          >
            <input
              type="number"
              value={settings.monthlyBudget || ''}
              onChange={(e) => handleChange('monthlyBudget', e.target.value ? parseFloat(e.target.value) : null)}
              placeholder="0.00"
              step="0.01"
              min="0"
              className="input w-32"
            />
          </SettingRow>

          <SettingRow
            label="Budget Notifications"
            description="Show notifications when approaching budget limits"
          >
            <ToggleSwitch
              checked={settings.budgetNotifications}
              onChange={(value) => handleChange('budgetNotifications', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* Session Preview */}
        <SettingsSection title="Session Preview">
          <div className="p-4">
            <p className="text-sm text-surface-400 mb-4">
              Control which block types are shown and their default expand/collapse state when viewing sessions.
            </p>
          </div>

          {/* Visibility Settings */}
          <SettingRow
            label="Show Thinking Blocks"
            description="Display Claude's thinking/reasoning process"
          >
            <ToggleSwitch
              checked={settings.showThinkingBlocks}
              onChange={(value) => handleChange('showThinkingBlocks', value)}
            />
          </SettingRow>

          <SettingRow
            label="Show Tool Calls"
            description="Display tool invocations (Read, Write, Bash, etc.)"
          >
            <ToggleSwitch
              checked={settings.showToolUseBlocks}
              onChange={(value) => handleChange('showToolUseBlocks', value)}
            />
          </SettingRow>

          <SettingRow
            label="Show Tool Results"
            description="Display results returned from tool executions"
          >
            <ToggleSwitch
              checked={settings.showToolResultBlocks}
              onChange={(value) => handleChange('showToolResultBlocks', value)}
            />
          </SettingRow>

          <SettingRow
            label="Show System Messages"
            description="Display system-level messages"
          >
            <ToggleSwitch
              checked={settings.showSystemBlocks}
              onChange={(value) => handleChange('showSystemBlocks', value)}
            />
          </SettingRow>

          <SettingRow
            label="Show Summaries"
            description="Display session summary entries"
          >
            <ToggleSwitch
              checked={settings.showSummaryBlocks}
              onChange={(value) => handleChange('showSummaryBlocks', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* Default Expand States */}
        <SettingsSection title="Default Expand States">
          <div className="p-4">
            <p className="text-sm text-surface-400 mb-4">
              Choose which block types are expanded by default when viewing a session.
            </p>
          </div>

          <SettingRow
            label="Expand User Messages"
            description="User input messages expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandUserByDefault}
              onChange={(value) => handleChange('expandUserByDefault', value)}
            />
          </SettingRow>

          <SettingRow
            label="Expand Assistant Responses"
            description="Claude's responses expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandAssistantByDefault}
              onChange={(value) => handleChange('expandAssistantByDefault', value)}
            />
          </SettingRow>

          <SettingRow
            label="Expand Thinking Blocks"
            description="Thinking/reasoning blocks expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandThinkingByDefault}
              onChange={(value) => handleChange('expandThinkingByDefault', value)}
            />
          </SettingRow>

          <SettingRow
            label="Expand Tool Calls"
            description="Tool invocations expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandToolUseByDefault}
              onChange={(value) => handleChange('expandToolUseByDefault', value)}
            />
          </SettingRow>

          <SettingRow
            label="Expand Tool Results"
            description="Tool results expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandToolResultByDefault}
              onChange={(value) => handleChange('expandToolResultByDefault', value)}
            />
          </SettingRow>

          <SettingRow
            label="Expand System Messages"
            description="System messages expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandSystemByDefault}
              onChange={(value) => handleChange('expandSystemByDefault', value)}
            />
          </SettingRow>

          <SettingRow
            label="Expand Summaries"
            description="Summary entries expanded by default"
          >
            <ToggleSwitch
              checked={settings.expandSummaryByDefault}
              onChange={(value) => handleChange('expandSummaryByDefault', value)}
            />
          </SettingRow>
        </SettingsSection>

        {/* Keyboard Shortcuts */}
        <SettingsSection title="Keyboard Shortcuts">
          <div className="space-y-2">
            <ShortcutRow action="New Terminal" shortcut="Ctrl+N" />
            <ShortcutRow action="Close Tab" shortcut="Ctrl+W" />
            <ShortcutRow action="Next Tab" shortcut="Ctrl+Tab" />
            <ShortcutRow action="Previous Tab" shortcut="Ctrl+Shift+Tab" />
            <ShortcutRow action="Quick Switcher" shortcut="Ctrl+K" />
            <ShortcutRow action="Command Palette" shortcut="Ctrl+Shift+P" />
            <ShortcutRow action="Search Terminal" shortcut="Ctrl+F" />
            <ShortcutRow action="Zoom In" shortcut="Ctrl++" />
            <ShortcutRow action="Zoom Out" shortcut="Ctrl+-" />
            <ShortcutRow action="Reset Zoom" shortcut="Ctrl+0" />
          </div>
        </SettingsSection>

        {/* Danger Zone */}
        <SettingsSection title="Danger Zone">
          <SettingRow
            label="Reset All Settings"
            description="Restore all settings to their default values"
          >
            <button
              onClick={handleResetSettings}
              disabled={isResetting}
              className="btn btn-danger btn-sm"
            >
              {isResetting ? 'Resetting...' : 'Reset Settings'}
            </button>
          </SettingRow>
        </SettingsSection>

        {/* Maintenance */}
        <SettingsSection title="Maintenance">
          <RecalculateCostsButton />
        </SettingsSection>
      </div>

      {/* Confirmation Modal */}
      <ResetConfirmDialog />
    </div>
  );
}

// ============================================================================
// SETTINGS SECTION
// ============================================================================

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-xs font-semibold text-surface-400 uppercase tracking-wider">{title}</h2>
        <div className="flex-1 h-px bg-gradient-to-r from-surface-700 to-transparent" />
      </div>
      <div className="card-elevated rounded-xl divide-y divide-surface-700/50 overflow-hidden">
        {children}
      </div>
    </div>
  );
}

// ============================================================================
// SETTING ROW
// ============================================================================

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between px-5 py-4 hover:bg-surface-800/30 transition-colors">
      <div className="flex-1 min-w-0 pr-4">
        <div className="text-sm font-medium text-surface-100">{label}</div>
        {description && (
          <div className="text-xs text-surface-500 mt-0.5 leading-relaxed">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

// ============================================================================
// TOGGLE SWITCH
// ============================================================================

function ToggleSwitch({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    onChange(!checked);
  };

  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={handleClick}
      className={clsx(
        'relative inline-flex flex-shrink-0 w-11 h-6 rounded-full transition-all duration-200 cursor-pointer',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-800',
        checked ? 'bg-primary-500 shadow-md shadow-primary-500/30' : 'bg-surface-600'
      )}
    >
      <span
        aria-hidden="true"
        className={clsx(
          'pointer-events-none absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200',
          checked ? 'translate-x-5 shadow-md' : 'translate-x-0.5'
        )}
      />
    </button>
  );
}

// ============================================================================
// SHORTCUT ROW
// ============================================================================

function ShortcutRow({ action, shortcut }: { action: string; shortcut: string }) {
  return (
    <div className="flex items-center justify-between py-2.5 px-1 hover:bg-surface-800/20 rounded-lg transition-colors -mx-1">
      <span className="text-sm text-surface-300">{action}</span>
      <kbd className="px-2.5 py-1 text-xs font-medium bg-surface-800 border border-surface-700 rounded-md text-surface-300 shadow-sm">{shortcut}</kbd>
    </div>
  );
}

// ============================================================================
// RECALCULATE COSTS BUTTON
// ============================================================================

function RecalculateCostsButton() {
  const [isRecalculating, setIsRecalculating] = useState(false);
  const queryClient = useQueryClient();

  const handleRecalculate = async () => {
    setIsRecalculating(true);

    try {
      const result = await window.goodvibes.recalculateSessionCosts();

      if (result.success) {
        // Invalidate analytics queries to refresh data
        await queryClient.invalidateQueries({ queryKey: ['analytics'] });
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        await queryClient.invalidateQueries({ queryKey: ['tool-usage'] });
        toast.success(`Recalculated costs for ${result.count} sessions`);
      } else {
        toast.error(result.error || 'Failed to recalculate costs');
      }
    } catch (err) {
      toast.error('Failed to recalculate costs');
    } finally {
      setIsRecalculating(false);
    }
  };

  return (
    <SettingRow
      label="Recalculate Session Costs"
      description="Re-parse all sessions with updated pricing (model-specific rates + cache tokens)"
    >
      <button
        onClick={handleRecalculate}
        disabled={isRecalculating}
        className="btn btn-secondary btn-sm"
      >
        {isRecalculating ? 'Recalculating...' : 'Recalculate'}
      </button>
    </SettingRow>
  );
}

// ============================================================================
// GITHUB CONNECTION STATUS
// ============================================================================

function GitHubConnectionStatus() {
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

  // Load auth state and OAuth config on mount
  useEffect(() => {
    loadAuthState();
    loadOAuthConfig();
  }, []);

  const loadAuthState = async () => {
    try {
      const state = await window.goodvibes.githubGetAuthState();
      setAuthState(state);
    } catch (err) {
      console.error('Failed to load GitHub auth state:', err);
    }
  };

  const loadOAuthConfig = async () => {
    try {
      const config = await window.goodvibes.githubGetOAuthConfig();
      setOauthConfig(config);
    } catch (err) {
      console.error('Failed to load OAuth config:', err);
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
      console.error('Logout failed:', err);
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
