// ============================================================================
// SETTINGS STORE TESTS - Comprehensive test coverage for settingsStore
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useSettingsStore } from './settingsStore';
import { DEFAULT_SETTINGS, SETTINGS_VERSION } from '../../shared/types';

// Mock the toast store to verify notifications
vi.mock('./toastStore', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// Import the mocked toast for verification
import { toast } from './toastStore';

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

    // Reset the mocks to their default behavior
    vi.mocked(window.goodvibes.setSetting).mockResolvedValue(true);
    vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({});
  });

  // ============================================================================
  // INITIAL STATE TESTS
  // ============================================================================

  describe('initial state', () => {
    it('has default settings', () => {
      const { settings } = useSettingsStore.getState();

      expect(settings.theme).toBe('dark');
      expect(settings.fontSize).toBe(14);
      expect(settings.startupBehavior).toBe('empty');
      expect(settings.autoSessionWatch).toBe(true);
    });

    it('has isLoaded set to false initially', () => {
      const { isLoaded } = useSettingsStore.getState();
      expect(isLoaded).toBe(false);
    });

    it('has isUpdating set to false initially', () => {
      const { isUpdating } = useSettingsStore.getState();
      expect(isUpdating).toBe(false);
    });

    it('has no error initially', () => {
      const { error } = useSettingsStore.getState();
      expect(error).toBe(null);
    });

    it('has empty recoveredFields array initially', () => {
      const { recoveredFields } = useSettingsStore.getState();
      expect(recoveredFields).toEqual([]);
    });

    it('has all expected default setting values', () => {
      const { settings } = useSettingsStore.getState();

      // Verify all DEFAULT_SETTINGS values are present
      expect(settings).toEqual(DEFAULT_SETTINGS);
    });
  });

  // ============================================================================
  // UPDATE SETTING TESTS
  // ============================================================================

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

    it('updates boolean settings', async () => {
      const { updateSetting } = useSettingsStore.getState();

      const result = await updateSetting('autoSessionWatch', false);

      const { settings } = useSettingsStore.getState();
      expect(result).toBe(true);
      expect(settings.autoSessionWatch).toBe(false);
    });

    it('updates array settings', async () => {
      const { updateSetting } = useSettingsStore.getState();

      const result = await updateSetting('customShells', ['/bin/bash', '/bin/zsh']);

      const { settings } = useSettingsStore.getState();
      expect(result).toBe(true);
      expect(settings.customShells).toEqual(['/bin/bash', '/bin/zsh']);
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

    it('shows error toast on update failure', async () => {
      vi.mocked(window.goodvibes.setSetting).mockRejectedValue(new Error('Update failed'));

      const { updateSetting } = useSettingsStore.getState();
      await updateSetting('theme', 'light');

      expect(toast.error).toHaveBeenCalledWith(
        'Failed to save setting: theme',
        expect.objectContaining({ title: 'Settings Error' })
      );
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

    it('handles non-Error thrown values', async () => {
      vi.mocked(window.goodvibes.setSetting).mockRejectedValue('string error');

      const { updateSetting } = useSettingsStore.getState();
      const result = await updateSetting('theme', 'light');

      const state = useSettingsStore.getState();
      expect(result).toBe(false);
      expect(state.error).toBe('Unknown error');
    });

    it('preserves other settings when updating one', async () => {
      const { updateSetting } = useSettingsStore.getState();

      // Update theme
      await updateSetting('theme', 'light');
      // Update fontSize
      await updateSetting('fontSize', 18);

      const { settings } = useSettingsStore.getState();
      expect(settings.theme).toBe('light');
      expect(settings.fontSize).toBe(18);
      // Other settings should remain at defaults
      expect(settings.autoSessionWatch).toBe(true);
    });
  });

  // ============================================================================
  // LOAD SETTINGS TESTS
  // ============================================================================

  describe('loadSettings', () => {
    it('loads settings from API', async () => {
      const mockSettings = {
        theme: 'light',
        fontSize: 18,
        startupBehavior: 'last-project',
        restoreTabs: true,
        autoSessionWatch: false,
        hideAgentSessions: true,
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings } = useSettingsStore.getState();
      expect(settings.theme).toBe('light');
      expect(settings.fontSize).toBe(18);
    });

    it('sets isLoaded state after loading', async () => {
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({
        settingsVersion: SETTINGS_VERSION,
      });

      expect(useSettingsStore.getState().isLoaded).toBe(false);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      expect(useSettingsStore.getState().isLoaded).toBe(true);
    });

    it('handles load failure gracefully', async () => {
      vi.mocked(window.goodvibes.getAllSettings).mockRejectedValue(new Error('Load failed'));

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const state = useSettingsStore.getState();
      // Should still set isLoaded to true even on failure
      expect(state.isLoaded).toBe(true);
      // Should use defaults on failure
      expect(state.settings).toEqual(DEFAULT_SETTINGS);
    });

    it('shows error toast on load failure', async () => {
      vi.mocked(window.goodvibes.getAllSettings).mockRejectedValue(new Error('Load failed'));

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      expect(toast.error).toHaveBeenCalledWith(
        'Failed to load settings. Using defaults.',
        expect.objectContaining({ title: 'Settings Error' })
      );
    });

    it('sets all fields as recovered on load failure', async () => {
      vi.mocked(window.goodvibes.getAllSettings).mockRejectedValue(new Error('Load failed'));

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { recoveredFields } = useSettingsStore.getState();
      expect(recoveredFields.length).toBe(Object.keys(DEFAULT_SETTINGS).length);
    });

    it('clears error and recoveredFields at start of load', async () => {
      useSettingsStore.setState({
        error: 'Previous error',
        recoveredFields: ['theme', 'fontSize'],
      });

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({
        settingsVersion: SETTINGS_VERSION,
      });

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const state = useSettingsStore.getState();
      expect(state.error).toBe(null);
    });

    // ---- Migration Tests ----

    it('runs migration when saved version is lower than current', async () => {
      const mockSettings = {
        theme: 'light',
        fontSize: 18,
        settingsVersion: 1, // Old version, needs migration to SETTINGS_VERSION
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should save the version after migration
      expect(window.goodvibes.setSetting).toHaveBeenCalledWith('settingsVersion', SETTINGS_VERSION);
    });

    it('does not run migration when saved version equals current', async () => {
      const mockSettings = {
        theme: 'light',
        fontSize: 18,
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should not save settings version if already current
      expect(window.goodvibes.setSetting).not.toHaveBeenCalledWith(
        'settingsVersion',
        expect.anything()
      );
    });

    it('treats missing version as version 1', async () => {
      const mockSettings = {
        theme: 'light',
        fontSize: 18,
        // No settingsVersion - treated as v1
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should trigger migration from v1 to current
      expect(window.goodvibes.setSetting).toHaveBeenCalledWith('settingsVersion', SETTINGS_VERSION);
    });

    it('resets migrated keys to defaults during migration', async () => {
      const mockSettings = {
        theme: 'light',
        fontSize: 18,
        colorTheme: 'old-invalid-theme', // This will be reset during v9 migration
        settingsVersion: 8, // Version before colorTheme was added
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // colorTheme should be reset to default during v9 migration
      expect(window.goodvibes.setSetting).toHaveBeenCalledWith(
        'colorTheme',
        DEFAULT_SETTINGS.colorTheme
      );
    });

    // ---- Recovery Tests ----

    it('recovers corrupted field values to defaults', async () => {
      const mockSettings = {
        theme: 'invalid-theme', // Invalid value, should recover to 'dark'
        fontSize: 'not-a-number', // Invalid type, should recover to 14
        autoSessionWatch: 'yes', // Invalid boolean, should recover
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      // Should recover invalid values to defaults
      expect(settings.theme).toBe('dark');
      expect(settings.fontSize).toBe(14);
      expect(settings.autoSessionWatch).toBe(true);
      // Should track recovered fields
      expect(recoveredFields).toContain('theme');
      expect(recoveredFields).toContain('fontSize');
      expect(recoveredFields).toContain('autoSessionWatch');
    });

    it('preserves valid settings while recovering invalid ones', async () => {
      const mockSettings = {
        theme: 'light', // Valid
        fontSize: 'invalid', // Invalid, should recover
        autoSessionWatch: false, // Valid
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      expect(settings.theme).toBe('light'); // Preserved
      expect(settings.fontSize).toBe(14); // Recovered
      expect(settings.autoSessionWatch).toBe(false); // Preserved
      expect(recoveredFields).toContain('fontSize');
      expect(recoveredFields).not.toContain('theme');
    });

    it('shows warning toast when fields are recovered outside migration', async () => {
      const mockSettings = {
        theme: 123, // Invalid type
        settingsVersion: SETTINGS_VERSION, // Current version - not during migration
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('settings were corrupted'),
        expect.objectContaining({ title: 'Settings Recovered' })
      );
    });

    it('does not show warning toast during migration', async () => {
      const mockSettings = {
        theme: 'light',
        settingsVersion: 1, // Old version - migration mode
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should not show recovery warning during migration
      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('persists recovered fields to storage', async () => {
      const mockSettings = {
        theme: 'invalid', // Will recover to 'dark'
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should persist recovered values
      expect(window.goodvibes.setSetting).toHaveBeenCalledWith('theme', 'dark');
    });

    it('handles missing fields by using defaults', async () => {
      const mockSettings = {
        theme: 'light',
        // fontSize missing - should use default
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings } = useSettingsStore.getState();
      expect(settings.fontSize).toBe(14); // Default value
    });

    // ---- Edge Cases ----

    it('validates colorTheme against valid theme IDs', async () => {
      const mockSettings = {
        colorTheme: 'nonexistent-theme-id', // Invalid theme ID
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      expect(settings.colorTheme).toBe(DEFAULT_SETTINGS.colorTheme);
      expect(recoveredFields).toContain('colorTheme');
    });

    it('validates fontSize is within range 8-32', async () => {
      const mockSettings = {
        fontSize: 50, // Out of range (max 32)
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      expect(settings.fontSize).toBe(14); // Recovered to default
      expect(recoveredFields).toContain('fontSize');
    });

    it('validates nullable number settings', async () => {
      const mockSettings = {
        dailyBudget: -100, // Invalid (must be non-negative or null)
        monthlyBudget: 'not a number', // Invalid type
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      expect(settings.dailyBudget).toBe(null); // Recovered to default
      expect(settings.monthlyBudget).toBe(null); // Recovered to default
      expect(recoveredFields).toContain('dailyBudget');
      expect(recoveredFields).toContain('monthlyBudget');
    });

    it('accepts valid nullable number settings', async () => {
      const mockSettings = {
        dailyBudget: 100.50,
        monthlyBudget: null,
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings } = useSettingsStore.getState();
      expect(settings.dailyBudget).toBe(100.50);
      expect(settings.monthlyBudget).toBe(null);
    });

    it('validates string array settings', async () => {
      const mockSettings = {
        customShells: 'not an array', // Invalid
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      expect(settings.customShells).toEqual([]); // Recovered to default
      expect(recoveredFields).toContain('customShells');
    });

    it('validates string arrays contain only strings', async () => {
      const mockSettings = {
        customShells: ['/bin/bash', 123, null], // Contains non-strings
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings, recoveredFields } = useSettingsStore.getState();
      expect(settings.customShells).toEqual([]); // Recovered to default
      expect(recoveredFields).toContain('customShells');
    });

    it('accepts valid string array settings', async () => {
      const mockSettings = {
        customShells: ['/bin/bash', '/bin/zsh', '/usr/bin/fish'],
        settingsVersion: SETTINGS_VERSION,
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      const { settings } = useSettingsStore.getState();
      expect(settings.customShells).toEqual(['/bin/bash', '/bin/zsh', '/usr/bin/fish']);
    });

    it('handles migration error during setSetting gracefully', async () => {
      const mockSettings = {
        theme: 'light',
        settingsVersion: 1, // Needs migration
      };

      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue(mockSettings);
      // Fail some migrations
      vi.mocked(window.goodvibes.setSetting)
        .mockRejectedValueOnce(new Error('Migration failed'))
        .mockResolvedValue(true as never); // Allow others to succeed

      const { loadSettings } = useSettingsStore.getState();
      await loadSettings();

      // Should still complete loading despite migration errors
      const state = useSettingsStore.getState();
      expect(state.isLoaded).toBe(true);
    });
  });

  // ============================================================================
  // RESET SETTINGS TESTS
  // ============================================================================

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

    it('shows success toast on full reset', async () => {
      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      expect(toast.success).toHaveBeenCalledWith(
        'Settings reset to defaults',
        expect.objectContaining({ title: 'Settings Reset' })
      );
    });

    it('clears recoveredFields on successful reset', async () => {
      useSettingsStore.setState({
        recoveredFields: ['theme', 'fontSize'],
      });

      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      const { recoveredFields } = useSettingsStore.getState();
      expect(recoveredFields).toEqual([]);
    });

    it('handles partial reset failure gracefully', async () => {
      let callCount = 0;
      vi.mocked(window.goodvibes.setSetting).mockImplementation(() => {
        callCount++;
        // Fail every 5th call
        if (callCount % 5 === 0) {
          return Promise.reject(new Error('Reset failed'));
        }
        return Promise.resolve(true);
      });
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({});

      const { resetSettings } = useSettingsStore.getState();
      const result = await resetSettings();

      const state = useSettingsStore.getState();
      expect(result).toBe(false);
      expect(state.error).toContain('Failed to reset');
      expect(state.isUpdating).toBe(false);
    });

    it('shows warning toast on partial reset failure', async () => {
      let callCount = 0;
      vi.mocked(window.goodvibes.setSetting).mockImplementation(() => {
        callCount++;
        if (callCount % 5 === 0) {
          return Promise.reject(new Error('Reset failed'));
        }
        return Promise.resolve(true);
      });
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({});

      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      expect(toast.warning).toHaveBeenCalledWith(
        expect.stringContaining('settings were reset'),
        expect.objectContaining({ title: 'Partial Reset' })
      );
    });

    it('handles complete reset failure gracefully', async () => {
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

    it('clears error at start of reset', async () => {
      useSettingsStore.setState({ error: 'Previous error' });

      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      // On success, error should be null
      const { error } = useSettingsStore.getState();
      expect(error).toBe(null);
    });

    it('reloads settings from storage after partial failure', async () => {
      let callCount = 0;
      vi.mocked(window.goodvibes.setSetting).mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new Error('Reset failed'));
        }
        return Promise.resolve(true);
      });
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({
        theme: 'light',
        fontSize: 18,
      });

      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      // Should reload settings after partial failure
      expect(window.goodvibes.getAllSettings).toHaveBeenCalled();
    });

    it('shows error toast when reload also fails after partial reset', async () => {
      vi.mocked(window.goodvibes.setSetting).mockRejectedValue(new Error('Reset failed'));
      vi.mocked(window.goodvibes.getAllSettings).mockRejectedValue(new Error('Reload failed'));

      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      expect(toast.error).toHaveBeenCalledWith(
        'Failed to reset settings. Please try again.',
        expect.objectContaining({ title: 'Settings Error' })
      );
    });

    it('persists each default setting individually', async () => {
      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      // Each setting in DEFAULT_SETTINGS should be persisted
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        expect(window.goodvibes.setSetting).toHaveBeenCalledWith(key, value);
      }
    });

    it('tracks failed keys in recoveredFields after partial failure', async () => {
      // Make specific keys fail
      vi.mocked(window.goodvibes.setSetting).mockImplementation((key) => {
        if (key === 'theme' || key === 'fontSize') {
          return Promise.reject(new Error('Failed'));
        }
        return Promise.resolve(true);
      });
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({});

      const { resetSettings } = useSettingsStore.getState();
      await resetSettings();

      const { recoveredFields } = useSettingsStore.getState();
      expect(recoveredFields).toContain('theme');
      expect(recoveredFields).toContain('fontSize');
    });
  });

  // ============================================================================
  // CLEAR ERROR TESTS
  // ============================================================================

  describe('clearError', () => {
    it('clears the error state', () => {
      useSettingsStore.setState({ error: 'Some error' });

      const { clearError } = useSettingsStore.getState();
      clearError();

      expect(useSettingsStore.getState().error).toBe(null);
    });

    it('does nothing if error is already null', () => {
      useSettingsStore.setState({ error: null });

      const { clearError } = useSettingsStore.getState();
      clearError();

      expect(useSettingsStore.getState().error).toBe(null);
    });
  });

  // ============================================================================
  // STORE INTEGRATION TESTS
  // ============================================================================

  describe('store integration', () => {
    it('maintains state consistency across multiple operations', async () => {
      // Load settings
      vi.mocked(window.goodvibes.getAllSettings).mockResolvedValue({
        theme: 'light',
        settingsVersion: SETTINGS_VERSION,
      });

      const store = useSettingsStore.getState();
      await store.loadSettings();

      // Update a setting
      await useSettingsStore.getState().updateSetting('fontSize', 18);

      // Verify both changes are present
      const { settings } = useSettingsStore.getState();
      expect(settings.theme).toBe('light');
      expect(settings.fontSize).toBe(18);
    });

    it('handles concurrent updates correctly', async () => {
      const { updateSetting } = useSettingsStore.getState();

      // Start multiple updates concurrently
      const updates = await Promise.all([
        updateSetting('theme', 'light'),
        updateSetting('fontSize', 18),
        updateSetting('autoSessionWatch', false),
      ]);

      // All updates should succeed
      expect(updates).toEqual([true, true, true]);

      const { settings } = useSettingsStore.getState();
      expect(settings.theme).toBe('light');
      expect(settings.fontSize).toBe(18);
      expect(settings.autoSessionWatch).toBe(false);
    });

    it('recovers from error state on successful operation', async () => {
      // Set initial error state
      useSettingsStore.setState({ error: 'Previous error' });

      // Successful update
      const { updateSetting } = useSettingsStore.getState();
      await updateSetting('theme', 'light');

      // Error should be cleared
      expect(useSettingsStore.getState().error).toBe(null);
    });
  });
});
