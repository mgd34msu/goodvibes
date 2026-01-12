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

      await updateSetting('theme', 'light');

      const { settings } = useSettingsStore.getState();
      expect(settings.theme).toBe('light');
      expect(window.goodvibes.setSetting).toHaveBeenCalledWith('theme', 'light');
    });

    it('updates numeric settings', async () => {
      const { updateSetting } = useSettingsStore.getState();

      await updateSetting('fontSize', 16);

      const { settings } = useSettingsStore.getState();
      expect(settings.fontSize).toBe(16);
    });

    it('updates nullable settings', async () => {
      const { updateSetting } = useSettingsStore.getState();

      await updateSetting('claudePath', '/usr/bin/claude');

      const { settings } = useSettingsStore.getState();
      expect(settings.claudePath).toBe('/usr/bin/claude');
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
});
