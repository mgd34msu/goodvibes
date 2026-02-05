// ============================================================================
// MAINTENANCE SETTINGS SECTION
// ============================================================================

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '../../../stores/toastStore';
import { SettingsSection, SettingRow } from './components';
import type { AppSettings } from '../../../../shared/types/settings-types';

interface MaintenanceSettingsProps {
  settings: AppSettings;
  onChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void;
}

export function MaintenanceSettings({ settings, onChange }: MaintenanceSettingsProps): React.JSX.Element {
  return (
    <SettingsSection title="Maintenance">
      <RecalculateCostsButton />
      <ClipboardImageSettings settings={settings} onChange={onChange} />
    </SettingsSection>
  );
}

function ClipboardImageSettings({ settings, onChange }: MaintenanceSettingsProps) {
  const maxAgeOptions = [
    { value: 1, label: '1 day' },
    { value: 3, label: '3 days' },
    { value: 7, label: '7 days' },
    { value: 14, label: '14 days' },
    { value: 30, label: '30 days' },
    { value: 90, label: '90 days' },
    { value: 365, label: '1 year' },
  ];

  return (
    <>
      <SettingRow
        label="Auto-clean Clipboard Images"
        description="Automatically remove old pasted images from the temp directory"
      >
        <label className="toggle-switch">
          <input
            type="checkbox"
            checked={settings.clipboardImageCleanupEnabled}
            onChange={(e) => onChange('clipboardImageCleanupEnabled', e.target.checked)}
          />
          <span className="toggle-track">
            <span className="toggle-thumb" />
          </span>
        </label>
      </SettingRow>
      {settings.clipboardImageCleanupEnabled && (
        <SettingRow
          label="Image Retention Period"
          description="How long to keep pasted clipboard images before cleanup"
        >
          <select
            value={settings.clipboardImageMaxAgeDays}
            onChange={(e) => onChange('clipboardImageMaxAgeDays', Number(e.target.value))}
            className="select select-sm"
          >
            {maxAgeOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </SettingRow>
      )}
    </>
  );
}

function RecalculateCostsButton() {
  const [isRecalculating, setIsRecalculating] = useState(false);
  const queryClient = useQueryClient();

  const handleRecalculate = async () => {
    setIsRecalculating(true);

    try {
      const result = await window.goodvibes.recalculateSessionCosts();

      if (result.success) {
        await queryClient.invalidateQueries({ queryKey: ['analytics'] });
        await queryClient.invalidateQueries({ queryKey: ['sessions'] });
        await queryClient.invalidateQueries({ queryKey: ['tool-usage'] });
        toast.success(`Recalculated costs for ${result.count} sessions`);
      } else {
        toast.error(result.error || 'Failed to recalculate costs');
      }
    } catch {
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

export function DangerZoneSettings({
  isResetting,
  onReset,
}: {
  isResetting: boolean;
  onReset: () => void;
}) {
  return (
    <SettingsSection title="Danger Zone">
      <SettingRow
        label="Reset All Settings"
        description="Restore all settings to their default values"
      >
        <button
          onClick={onReset}
          disabled={isResetting}
          className="btn btn-danger btn-sm"
        >
          {isResetting ? 'Resetting...' : 'Reset Settings'}
        </button>
      </SettingRow>
    </SettingsSection>
  );
}
