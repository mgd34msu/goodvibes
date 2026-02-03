// ============================================================================
// GITHUB SETTINGS SECTION
// ============================================================================

import { useState } from 'react';
import { Key } from 'lucide-react';
import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow, ToggleSwitch } from './components';
import { GitHubConnectionStatus } from './GitHubConnectionStatus';
import { GitHubOAuthConfigModal } from '../../github/GitHubOAuthConfigModal';
import { useGitHubOAuthConfig } from '../../../hooks/useGitHubOAuthConfig';

interface GitHubSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function GitHubSettings({ settings, onChange }: GitHubSettingsProps): React.JSX.Element {
  const [showOAuthModal, setShowOAuthModal] = useState(false);
  const { oauthStatus, refresh } = useGitHubOAuthConfig();

  const isCustomConfigured = oauthStatus?.source === 'custom';

  return (
    <SettingsSection title="GitHub Integration">
      <GitHubConnectionStatus oauthStatus={oauthStatus} />

      <SettingRow
        label="Enable GitHub Integration"
        description="Show GitHub features in the Git panel"
      >
        <ToggleSwitch
          checked={settings.githubEnabled}
          onChange={(value) => onChange('githubEnabled', value)}
        />
      </SettingRow>

      <SettingRow
        label="Show in Git Panel"
        description="Display GitHub info alongside local git status"
      >
        <ToggleSwitch
          checked={settings.githubShowInGitPanel}
          onChange={(value) => onChange('githubShowInGitPanel', value)}
        />
      </SettingRow>

      <SettingRow
        label="Auto-load Pull Requests"
        description="Automatically fetch open PRs when opening Git panel"
      >
        <ToggleSwitch
          checked={settings.githubAutoLoadPRs}
          onChange={(value) => onChange('githubAutoLoadPRs', value)}
        />
      </SettingRow>

      <SettingRow
        label="Auto-load CI Status"
        description="Automatically fetch CI/CD status for current branch"
      >
        <ToggleSwitch
          checked={settings.githubAutoLoadCI}
          onChange={(value) => onChange('githubAutoLoadCI', value)}
        />
      </SettingRow>

      <SettingRow
        label="Custom OAuth App"
        description="Use your own GitHub OAuth app credentials instead of the built-in app"
      >
        <div className="flex items-center gap-2">
          {isCustomConfigured && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium bg-primary-500/15 text-primary-400">
              <span className="w-1.5 h-1.5 rounded-full bg-primary-400"></span>
              Active
            </span>
          )}
          <button
            onClick={() => setShowOAuthModal(true)}
            className="btn btn-secondary btn-sm flex items-center gap-1.5"
          >
            <Key className="w-3.5 h-3.5" />
            Configure
          </button>
        </div>
      </SettingRow>

      <GitHubOAuthConfigModal
        isOpen={showOAuthModal}
        onClose={() => setShowOAuthModal(false)}
        onSave={() => refresh()}
      />
    </SettingsSection>
  );
}
