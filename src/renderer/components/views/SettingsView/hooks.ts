// ============================================================================
// SETTINGS VIEW - CUSTOM HOOKS
// ============================================================================

import { useState } from 'react';
import { useSettingsStore } from '../../../stores/settingsStore';
import type { AppSettings } from '../../../../shared/types';
import { toast } from '../../../stores/toastStore';
import { useConfirm } from '../../overlays/ConfirmModal';

export interface UseSettingsReturn {
  settings: AppSettings;
  handleChange: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  handleResetSettings: () => Promise<void>;
  isResetting: boolean;
  ResetConfirmDialog: React.FC;
}

export function useSettings(): UseSettingsReturn {
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

  return {
    settings,
    isResetting,
    handleChange,
    handleResetSettings,
    ResetConfirmDialog,
  };
}
