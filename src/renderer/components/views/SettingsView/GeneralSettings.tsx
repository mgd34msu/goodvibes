// ============================================================================
// GENERAL SETTINGS SECTION
// ============================================================================

import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow, ToggleSwitch } from './components';

interface GeneralSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function StartupSettings({ settings, onChange }: GeneralSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Startup Behavior">
      <SettingRow
        label="On Startup"
        description="What happens when you launch the app"
      >
        <select
          value={settings.startupBehavior}
          onChange={(e) => onChange('startupBehavior', e.target.value as AppSettings['startupBehavior'])}
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
          onChange={(value) => onChange('restoreTabs', value)}
        />
      </SettingRow>

      <SettingRow
        label="Auto Session Watch"
        description="Automatically watch for subagent sessions"
      >
        <ToggleSwitch
          checked={settings.autoSessionWatch}
          onChange={(value) => onChange('autoSessionWatch', value)}
        />
      </SettingRow>

      <SettingRow
        label="Hide Agent Sessions"
        description="Hide subagent sessions from the sessions list"
      >
        <ToggleSwitch
          checked={settings.hideAgentSessions}
          onChange={(value) => onChange('hideAgentSessions', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}

export function ClaudeSettings({ settings, onChange }: GeneralSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Claude CLI Options">
      <SettingRow
        label="Claude Path"
        description="Custom path to Claude CLI executable (leave empty for default)"
      >
        <input
          type="text"
          value={settings.claudePath || ''}
          onChange={(e) => onChange('claudePath', e.target.value || null)}
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
            onChange={(e) => onChange('defaultCwd', e.target.value || null)}
            placeholder="Leave empty for current directory"
            className="input w-64"
          />
          <button
            onClick={async () => {
              const folder = await window.goodvibes.selectFolder();
              if (folder) onChange('defaultCwd', folder);
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
            onChange={(e) => onChange('projectsRoot', e.target.value || null)}
            placeholder="e.g., C:\Users\name\Documents"
            className="input w-64"
          />
          <button
            onClick={async () => {
              const folder = await window.goodvibes.selectFolder();
              if (folder) onChange('projectsRoot', folder);
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
          onChange={(value) => onChange('skipPermissions', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}

export function GitSettings({ settings, onChange }: GeneralSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Git Integration">
      <SettingRow
        label="Git Panel Position"
        description="Position of the Git sidebar"
      >
        <select
          value={settings.gitPanelPosition}
          onChange={(e) => onChange('gitPanelPosition', e.target.value as 'left' | 'right')}
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
          onChange={(value) => onChange('gitAutoRefresh', value)}
        />
      </SettingRow>

      <SettingRow
        label="Show Git Panel on Start"
        description="Show Git panel by default"
      >
        <ToggleSwitch
          checked={settings.gitShowOnStart}
          onChange={(value) => onChange('gitShowOnStart', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}

export function BudgetSettings({ settings, onChange }: GeneralSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Budget Alerts">
      <SettingRow
        label="Daily Budget Limit"
        description="Daily spending limit in dollars"
      >
        <input
          type="number"
          value={settings.dailyBudget || ''}
          onChange={(e) => onChange('dailyBudget', e.target.value ? parseFloat(e.target.value) : null)}
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
          onChange={(e) => onChange('monthlyBudget', e.target.value ? parseFloat(e.target.value) : null)}
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
          onChange={(value) => onChange('budgetNotifications', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}

export function BackupSettings({ settings, onChange }: GeneralSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Data & Backup">
      <SettingRow
        label="Auto-Backup Sessions"
        description="Automatically backup Claude sessions on startup to preserve history"
      >
        <ToggleSwitch
          checked={settings.sessionBackupEnabled}
          onChange={(value) => onChange('sessionBackupEnabled', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}
