// ============================================================================
// SETTINGS STORE TESTS
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { DEFAULT_SETTINGS } from '../../shared/types';

describe('useSettingsStore', () => {
  beforeEach(() => {
    // Reset store state using the actual store structure
    useSettingsStore.setState({
      settings: { ...DEFAULT_SETTINGS },
      isLoaded: false,
      isUpdating: false,
      error: null,
      recoveredFields: [],
    });
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('has default settings', () => {
      const { settings } = useSettingsStore.getState();

      expect(settings.theme).toBe('dark');
      expect(settings.fontSize).toBe(14);
      expect(settings.startupBehavior).toBe('empty');
      expect(settings.autoSessionWatch).toBe(true);
    });
  });

  describe('updateSetting', () => {
    it('updates a single setting', async () => {
      const { updateSetting } = useSettingsStore.getState();

      const result = await updateSetting('theme', 'light');

      const { settings } = useSettingsStore.getState();
      expect(result).toBe(true);
      expect(settings.theme).toBe('light');
      expect(window.goodvibes.setSetting).toHaveBeenCalledWith('theme', 'light');
    });

    it('updates numeric settings', async () => {
      const { updateSetting } = useSettingsStore.getState();

      const result = await updateSetting('fontSize', 16);

      const { settings } = useSettingsStore.getState();
      expect(result).toBe(true);
      expect(settings.fontSize).toBe(16);
    });

    it('updates nullable settings', async () => {
      const { updateSetting } = useSettingsStore.getState();

      const result = await updateSetting('claudePath', '/usr/bin/claude');

      const { settings } = useSettingsStore.getState();
      expect(result).toBe(true);
      expect(settings.claudePath).toBe('/usr/bin/claude');
    });

    it('handles update failure gracefully without throwing', async () => {
      vi.mocked(window.goodvibes.setSetting).mockRejectedValue(new Error('Update failed'));

      const { updateSetting } = useSettingsStore.getState();
      const result = await updateSetting('theme', 'light');

      const state = useSettingsStore.getState();
      expect(result).toBe(false);
      expect(state.error).toBe('Update failed');
      expect(state.isUpdating).toBe(false);
      // Setting should NOT be updated on failure
      expect(state.settings.theme).toBe('dark');
    });

    it('sets isUpdating during update operation', async () => {
      let resolveUpdate: () => void;
      const updatePromise = new Promise<void>((resolve) => {
        resolveUpdate = resolve;
      });
      vi.mocked(window.goodvibes.setSetting).mockReturnValue(updatePromise);

      const { updateSetting } = useSettingsStore.getState();
      const updateCall = updateSetting('theme', 'light');

      // Should be updating while the promise is pending
      expect(useSettingsStore.getState().isUpdating).toBe(true);

      resolveUpdate!();
      await updateCall;

      // Should no longer be updating after completion
      expect(useSettingsStore.getState().isUpdating).toBe(false);
    });

    it('clears previous error on new update', async () => {
      useSettingsStore.setState({ error: 'Previous error' });

      const { updateSetting } = useSettingsStore.getState();
      await updateSetting('theme', 'light');

      expect(useSettingsStore.getState().error).toBe(null);
    });
  });

  describe('loadSettings', () => {
    it('loads settings from API', async () => {
      const mockSettings = {
        theme: 'light',
        fontSize: 18,
        startupBehavior: 'last-project',
        restoreTabs: true,
        autoSessionWatch: false,
        hideAgentSessions: true,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings } = useSettingsStore.getState();
      expect(settings.theme).toBe('light');
      expect(settings.fontSize).toBe(18);
    });

    it('sets isLoaded state after loading', async () => {
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({});

      expect(useSettingsStore.getState().isLoaded).toBe(false);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      expect(useSettingsStore.getState().isLoaded).toBe(true);
    });

    it('handles load failure gracefully', async () => {
      vi.mocked(window.goodvibes.getAllSettings).mockRejectedValue(new Error('Load failed'));

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should still set isLoaded to true even on failure
      expect(useSettingsStore.getState().isLoaded).toBe(true);
    });
  });

  describe('resetSettings', () => {
    it('resets all settings to defaults', async () => {
      // First modify a setting
      useSettingsStore.setState({
        settings: { ...DEFAULT_SETTINGS, theme: 'light', fontSize: 20 },
      });

      const { resetSettings } = useSettingsStore.getState();
      const result = await resetSettings();

      const { settings } = useSettingsStore.getState();
      expect(result).toBe(true);
      expect(settings.theme).toBe('dark');
      expect(settings.fontSize).toBe(14);
    });

    it('handles reset failure gracefully without throwing', async () => {
      vi.mocked(window.goodvibes.setSetting).mockRejectedValue(new Error('Reset failed'));
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({});

      const { resetSettings } = useSettingsStore.getState();
      const result = await resetSettings();

      const state = useSettingsStore.getState();
      expect(result).toBe(false);
      // Error message describes partial failure with count and sample of failed keys
      expect(state.error).toContain('Failed to reset');
      expect(state.error).toContain('settings');
      expect(state.isUpdating).toBe(false);
    });

    it('sets isUpdating during reset operation', async () => {
      let resolveReset: () => void;
      const resetPromise = new Promise<void>((resolve) => {
        resolveReset = resolve;
      });
      vi.mocked(window.goodvibes.setSetting).mockReturnValue(resetPromise);

      const { resetSettings } = useSettingsStore.getState();
      const resetCall = resetSettings();

      // Should be updating while the promise is pending
      expect(useSettingsStore.getState().isUpdating).toBe(true);

      resolveReset!();
      await resetCall;

      // Should no longer be updating after completion
      expect(useSettingsStore.getState().isUpdating).toBe(false);
    });
  });

  describe('clearError', () => {
    it('clears the error state', () => {
      useSettingsStore.setState({ error: 'Some error' });

      const { clearError } = useSettingsStore.getState();
      clearError();

      expect(useSettingsStore.getState().error).toBe(null);
    });
  });
});
