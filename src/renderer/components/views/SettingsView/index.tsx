// ============================================================================
// SETTINGS VIEW COMPONENT
// ============================================================================

import { useSettings } from './hooks';
import { AppearanceSettings } from './AppearanceSettings';
import { StartupSettings, ClaudeSettings, GitSettings, BudgetSettings, BackupSettings } from './GeneralSettings';
import { TerminalSettings } from './TerminalSettings';
import { TimezoneSettings } from './TimezoneSettings';
import { GitHubSettings } from './GitHubSettings';
import { SessionPreviewVisibilitySettings, SessionPreviewExpandSettings } from './SessionPreviewSettings';
import { KeyboardSettings } from './KeyboardSettings';
import { MaintenanceSettings, DangerZoneSettings } from './MaintenanceSettings';
import { TagSettings } from './TagSettings';

export default function SettingsView() {
  const {
    settings,
    isResetting,
    handleChange,
    handleResetSettings,
    ResetConfirmDialog,
  } = useSettings();

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
        <AppearanceSettings settings={settings} onChange={handleChange} />

        {/* Timezone */}
        <TimezoneSettings settings={settings} onChange={handleChange} />

        {/* Startup Behavior */}
        <StartupSettings settings={settings} onChange={handleChange} />

        {/* Claude CLI Options */}
        <ClaudeSettings settings={settings} onChange={handleChange} />

        {/* Terminal Settings */}
        <TerminalSettings settings={settings} onChange={handleChange} />

        {/* Git Integration */}
        <GitSettings settings={settings} onChange={handleChange} />

        {/* GitHub Integration */}
        <GitHubSettings settings={settings} onChange={handleChange} />

        {/* Budget Alerts */}
        <BudgetSettings settings={settings} onChange={handleChange} />

        {/* Session Preview */}
        <SessionPreviewVisibilitySettings settings={settings} onChange={handleChange} />

        {/* Default Expand States */}
        <SessionPreviewExpandSettings settings={settings} onChange={handleChange} />

        {/* Tag Settings */}
        <TagSettings settings={settings} onChange={handleChange} />

        {/* Data & Backup */}
        <BackupSettings settings={settings} onChange={handleChange} />

        {/* Maintenance */}
        <MaintenanceSettings settings={settings} onChange={handleChange} />

        {/* Keyboard Shortcuts */}
        <KeyboardSettings />

        {/* Danger Zone */}
        <DangerZoneSettings isResetting={isResetting} onReset={handleResetSettings} />
      </div>

      {/* Confirmation Modal */}
      <ResetConfirmDialog />
    </div>
  );
}
