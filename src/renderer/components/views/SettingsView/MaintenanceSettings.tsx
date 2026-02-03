// ============================================================================
// MAINTENANCE SETTINGS SECTION
// ============================================================================

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from '../../../stores/toastStore';
import { SettingsSection, SettingRow } from './components';

export function MaintenanceSettings(): React.JSX.Element {
  return (
    <SettingsSection title="Maintenance">
      <RecalculateCostsButton />
    </SettingsSection>
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
