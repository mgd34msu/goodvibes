// ============================================================================
// GITHUB SETTINGS SECTION
// ============================================================================

import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow, ToggleSwitch } from './components';
import { GitHubConnectionStatus } from './GitHubConnectionStatus';

interface GitHubSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function GitHubSettings({ settings, onChange }: GitHubSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="GitHub Integration">
      <GitHubConnectionStatus />

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
    </SettingsSection>
  );
}
