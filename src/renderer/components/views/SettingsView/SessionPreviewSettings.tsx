// ============================================================================
// SESSION PREVIEW SETTINGS SECTIONS
// ============================================================================

import type { AppSettings } from '../../../../shared/types';
import { SettingsSection, SettingRow, ToggleSwitch } from './components';

interface SessionPreviewSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function SessionPreviewVisibilitySettings({ settings, onChange }: SessionPreviewSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Session Preview">
      <div className="p-4">
        <p className="text-sm text-surface-400 mb-4">
          Control which block types are shown and their default expand/collapse state when viewing sessions.
        </p>
      </div>

      <SettingRow
        label="Show Thinking Blocks"
        description="Display Claude's thinking/reasoning process"
      >
        <ToggleSwitch
          checked={settings.showThinkingBlocks}
          onChange={(value) => onChange('showThinkingBlocks', value)}
        />
      </SettingRow>

      <SettingRow
        label="Show Tool Calls"
        description="Display tool invocations (Read, Write, Bash, etc.)"
      >
        <ToggleSwitch
          checked={settings.showToolUseBlocks}
          onChange={(value) => onChange('showToolUseBlocks', value)}
        />
      </SettingRow>

      <SettingRow
        label="Show Tool Results"
        description="Display results returned from tool executions"
      >
        <ToggleSwitch
          checked={settings.showToolResultBlocks}
          onChange={(value) => onChange('showToolResultBlocks', value)}
        />
      </SettingRow>

      <SettingRow
        label="Show System Messages"
        description="Display system-level messages"
      >
        <ToggleSwitch
          checked={settings.showSystemBlocks}
          onChange={(value) => onChange('showSystemBlocks', value)}
        />
      </SettingRow>

      <SettingRow
        label="Show Summaries"
        description="Display session summary entries"
      >
        <ToggleSwitch
          checked={settings.showSummaryBlocks}
          onChange={(value) => onChange('showSummaryBlocks', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}

export function SessionPreviewExpandSettings({ settings, onChange }: SessionPreviewSettingsProps): React.JSX.Element {
  return (
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
          onChange={(value) => onChange('expandUserByDefault', value)}
        />
      </SettingRow>

      <SettingRow
        label="Expand Assistant Responses"
        description="Claude's responses expanded by default"
      >
        <ToggleSwitch
          checked={settings.expandAssistantByDefault}
          onChange={(value) => onChange('expandAssistantByDefault', value)}
        />
      </SettingRow>

      <SettingRow
        label="Expand Thinking Blocks"
        description="Thinking/reasoning blocks expanded by default"
      >
        <ToggleSwitch
          checked={settings.expandThinkingByDefault}
          onChange={(value) => onChange('expandThinkingByDefault', value)}
        />
      </SettingRow>

      <SettingRow
        label="Expand Tool Calls"
        description="Tool invocations expanded by default"
      >
        <ToggleSwitch
          checked={settings.expandToolUseByDefault}
          onChange={(value) => onChange('expandToolUseByDefault', value)}
        />
      </SettingRow>

      <SettingRow
        label="Expand Tool Results"
        description="Tool results expanded by default"
      >
        <ToggleSwitch
          checked={settings.expandToolResultByDefault}
          onChange={(value) => onChange('expandToolResultByDefault', value)}
        />
      </SettingRow>

      <SettingRow
        label="Expand System Messages"
        description="System messages expanded by default"
      >
        <ToggleSwitch
          checked={settings.expandSystemByDefault}
          onChange={(value) => onChange('expandSystemByDefault', value)}
        />
      </SettingRow>

      <SettingRow
        label="Expand Summaries"
        description="Summary entries expanded by default"
      >
        <ToggleSwitch
          checked={settings.expandSummaryByDefault}
          onChange={(value) => onChange('expandSummaryByDefault', value)}
        />
      </SettingRow>
    </SettingsSection>
  );
}
