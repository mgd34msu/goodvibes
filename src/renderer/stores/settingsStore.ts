// ============================================================================
// SETTINGS STORE - Application settings
// ============================================================================

import { create } from 'zustand';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, SETTINGS_MIGRATIONS } from '../../shared/types';
import { createLogger } from '../../shared/logger';

const logger = createLogger('SettingsStore');

interface SettingsState {
  settings: AppSettings;
  isLoaded: boolean;

  loadSettings: () => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<void>;
  resetSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  isLoaded: false,

  loadSettings: async () => {
    try {
      const saved = await window.goodvibes.getAllSettings();
      const merged = { ...DEFAULT_SETTINGS };

      // Check settings version for migrations
      const savedVersion = (saved._settingsVersion as number) || 1;
      const needsMigration = savedVersion < SETTINGS_VERSION;

      // Collect keys that need to be reset due to version migration
      const keysToReset = new Set<string>();
      if (needsMigration) {
        for (let v = savedVersion + 1; v <= SETTINGS_VERSION; v++) {
          const migratedKeys = SETTINGS_MIGRATIONS[v];
          if (migratedKeys) {
            migratedKeys.forEach(key => keysToReset.add(key));
          }
        }
      }

      // Merge saved settings, but only if the value is not null/undefined
      // Skip keys that need migration reset - they'll use DEFAULT_SETTINGS values
      for (const [key, value] of Object.entries(saved)) {
        if (key in DEFAULT_SETTINGS && value !== null && value !== undefined) {
          // Skip keys that need to be reset due to migration
          if (keysToReset.has(key)) {
            continue;
          }
          // Type-safe assignment using key narrowing
          const settingsKey = key as keyof AppSettings;
          // We've verified the key exists in DEFAULT_SETTINGS, so we can safely assign
          // The value type from the saved settings should match the expected type
          (merged as Record<keyof AppSettings, AppSettings[keyof AppSettings]>)[settingsKey] = value as AppSettings[keyof AppSettings];
        }
      }

      // If migration occurred, save the migrated settings FIRST, then the version
      // This ensures that if the app crashes mid-migration, the version won't be
      // updated without the settings being reset (which would skip the migration on next run)
      if (needsMigration) {
        // Save the reset keys with their new default values
        // Use individual try-catch to ensure we attempt all keys even if some fail
        for (const key of keysToReset) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const defaultValue = (DEFAULT_SETTINGS as any)[key];
            await window.goodvibes.setSetting(key, defaultValue);
          } catch (err) {
            logger.error(`Failed to migrate setting ${key}:`, err);
          }
        }

        // Always save version to prevent re-running migration endlessly
        // Even if some keys failed, we don't want to retry the whole migration
        try {
          await window.goodvibes.setSetting('_settingsVersion', SETTINGS_VERSION);
        } catch (err) {
          logger.error('Failed to save settings version:', err);
        }
      }

      set({ settings: merged, isLoaded: true });
    } catch (error) {
      logger.error('Failed to load settings:', error);
      set({ isLoaded: true });
    }
  },

  updateSetting: async (key, value) => {
    try {
      await window.goodvibes.setSetting(key, value);
      set((state) => ({
        settings: { ...state.settings, [key]: value },
      }));
    } catch (error) {
      logger.error(`Failed to update setting ${key}:`, error);
      throw error;
    }
  },

  resetSettings: async () => {
    try {
      for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        await window.goodvibes.setSetting(key, value);
      }
      set({ settings: DEFAULT_SETTINGS });
    } catch (error) {
      logger.error('Failed to reset settings:', error);
      throw error;
    }
  },
}));
