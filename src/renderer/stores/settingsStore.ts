// ============================================================================
// SETTINGS STORE - Application settings with error-resilient persistence
// ============================================================================
//
// This store manages application settings with robust error recovery:
// - Field-level validation ensures individual corrupted values don't break all settings
// - Type checking prevents runtime errors from incorrectly typed persisted values
// - Migration system handles schema changes across versions
// - Partial failures are gracefully handled without losing all user data
//
// ============================================================================

import { create } from 'zustand';
import type { AppSettings } from '../../shared/types';
import { DEFAULT_SETTINGS, SETTINGS_VERSION, SETTINGS_MIGRATIONS } from '../../shared/types';
import { isThemeId } from '../../shared/types/theme-types';
import { createLogger } from '../../shared/logger';
import { toast } from './toastStore';
import {
  type PersistenceSchema,
  type RecoveryResult,
  validateAndRecover,
  validators,
} from '../utils/persistenceRecovery';

const logger = createLogger('SettingsStore');

// ============================================================================
// SETTINGS SCHEMA FOR VALIDATION
// ============================================================================

/**
 * Schema definition for AppSettings with field-level validators.
 * This ensures that even if individual fields are corrupted, other settings
 * are preserved and only the corrupted ones are reset to defaults.
 */
const settingsSchema: PersistenceSchema<AppSettings> = {
  name: 'AppSettings',
  defaults: DEFAULT_SETTINGS,
  version: SETTINGS_VERSION,
  validators: {
    theme: validators.isOneOf(['dark', 'light'] as const),
    colorTheme: (value: unknown): value is AppSettings['colorTheme'] =>
      validators.isString(value) && isThemeId(value),
    fontSize: validators.isInRange(8, 32),
    claudePath: validators.isNullable(validators.isString),
    defaultCwd: validators.isNullable(validators.isString),
    projectsRoot: validators.isNullable(validators.isString),
    startupBehavior: validators.isOneOf(['empty', 'last-project', 'folder-picker'] as const),
    restoreTabs: validators.isBoolean,
    autoSessionWatch: validators.isBoolean,
    hideAgentSessions: validators.isBoolean,
    skipPermissions: validators.isBoolean,
    gitPanelPosition: validators.isOneOf(['left', 'right'] as const),
    gitAutoRefresh: validators.isBoolean,
    gitShowOnStart: validators.isBoolean,
    dailyBudget: validators.isNullable(validators.isNonNegativeNumber),
    monthlyBudget: validators.isNullable(validators.isNonNegativeNumber),
    budgetNotifications: validators.isBoolean,
    preferredShell: validators.isNullable(validators.isString),
    customShells: validators.isStringArray,
    preferredTextEditor: validators.isNullable(validators.isString),
    showThinkingBlocks: validators.isBoolean,
    showToolUseBlocks: validators.isBoolean,
    showToolResultBlocks: validators.isBoolean,
    showSystemBlocks: validators.isBoolean,
    showSummaryBlocks: validators.isBoolean,
    expandUserByDefault: validators.isBoolean,
    expandAssistantByDefault: validators.isBoolean,
    expandThinkingByDefault: validators.isBoolean,
    expandToolUseByDefault: validators.isBoolean,
    expandToolResultByDefault: validators.isBoolean,
    expandSystemByDefault: validators.isBoolean,
    expandSummaryByDefault: validators.isBoolean,
    githubEnabled: validators.isBoolean,
    githubShowInGitPanel: validators.isBoolean,
    githubAutoLoadPRs: validators.isBoolean,
    githubAutoLoadCI: validators.isBoolean,
    sessionBackupEnabled: validators.isBoolean,
  },
};

// ============================================================================
// STORE INTERFACE
// ============================================================================

interface SettingsState {
  settings: AppSettings;
  isLoaded: boolean;
  isUpdating: boolean;
  error: string | null;
  /** Fields that were recovered to defaults on last load */
  recoveredFields: string[];

  loadSettings: () => Promise<void>;
  updateSetting: <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => Promise<boolean>;
  resetSettings: () => Promise<boolean>;
  clearError: () => void;
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Validate and merge settings from IPC with proper error recovery.
 * Returns validated settings and information about any recovered fields.
 */
function validateSettingsFromIpc(
  saved: Record<string, unknown>,
  keysToSkip: Set<string>
): RecoveryResult<AppSettings> {
  // First, filter out keys that should be skipped (due to migration)
  const filteredSaved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(saved)) {
    if (!keysToSkip.has(key)) {
      filteredSaved[key] = value;
    }
  }

  // Validate and recover
  return validateAndRecover(filteredSaved, settingsSchema);
}

/**
 * Persist recovered fields back to the database so they don't keep failing.
 */
async function persistRecoveredFields(
  recoveredFields: string[],
  settings: AppSettings
): Promise<void> {
  for (const field of recoveredFields) {
    const key = field as keyof AppSettings;
    if (key in settings) {
      try {
        await window.goodvibes.setSetting(field, settings[key]);
        logger.info(`Persisted recovered default for field '${field}'`);
      } catch (err) {
        logger.warn(`Failed to persist recovered field '${field}':`, err);
      }
    }
  }
}

// ============================================================================
// STORE IMPLEMENTATION
// ============================================================================

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: DEFAULT_SETTINGS,
  isLoaded: false,
  isUpdating: false,
  error: null,
  recoveredFields: [],

  loadSettings: async () => {
    set({ error: null, recoveredFields: [] });
    try {
      const saved = await window.goodvibes.getAllSettings();

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
        logger.info(`Settings migration needed: v${savedVersion} -> v${SETTINGS_VERSION}`, {
          keysToReset: Array.from(keysToReset),
        });
      }

      // Validate and recover settings with field-level error handling
      const recovery = validateSettingsFromIpc(saved, keysToReset);

      // Log recovery information
      if (recovery.recovered) {
        logger.info('Settings recovered with field-level defaults', {
          recoveredFields: recovery.recoveredFields,
          error: recovery.error,
        });
      }

      // If migration occurred, save the migrated settings FIRST, then the version
      // This ensures that if the app crashes mid-migration, the version won't be
      // updated without the settings being reset (which would skip the migration on next run)
      if (needsMigration) {
        // Save the reset keys with their new default values
        // Use individual try-catch to ensure we attempt all keys even if some fail
        for (const key of keysToReset) {
          try {
            // Safe to access since keysToReset only contains keys from SETTINGS_MIGRATIONS
            // which are guaranteed to be valid AppSettings keys
            const settingsKey = key as keyof AppSettings;
            const defaultValue = DEFAULT_SETTINGS[settingsKey];
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

      // Persist recovered fields so they don't keep failing on subsequent loads
      if (recovery.recoveredFields.length > 0 && !needsMigration) {
        // Only persist if not during migration (migration handles its own persistence)
        await persistRecoveredFields(recovery.recoveredFields, recovery.data);
      }

      // Notify user if recovery was needed (but not during migration)
      if (recovery.recovered && recovery.recoveredFields.length > 0 && !needsMigration) {
        toast.warning(
          `Some settings were corrupted and reset to defaults: ${recovery.recoveredFields.slice(0, 3).join(', ')}${recovery.recoveredFields.length > 3 ? ` and ${recovery.recoveredFields.length - 3} more` : ''}`,
          {
            title: 'Settings Recovered',
            duration: 6000,
          }
        );
      }

      set({
        settings: recovery.data,
        isLoaded: true,
        recoveredFields: recovery.recoveredFields,
      });
    } catch (error) {
      logger.error('Failed to load settings:', error);
      toast.error('Failed to load settings. Using defaults.', {
        title: 'Settings Error',
        duration: 6000,
      });
      set({
        isLoaded: true,
        recoveredFields: Object.keys(DEFAULT_SETTINGS),
      });
    }
  },

  updateSetting: async (key, value) => {
    set({ isUpdating: true, error: null });
    try {
      await window.goodvibes.setSetting(key, value);
      set((state) => ({
        settings: { ...state.settings, [key]: value },
        isUpdating: false,
      }));
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to update setting ${key}:`, error);
      toast.error(`Failed to save setting: ${String(key)}`, {
        title: 'Settings Error',
        duration: 5000,
      });
      set({ isUpdating: false, error: errorMessage });
      return false;
    }
  },

  resetSettings: async () => {
    set({ isUpdating: true, error: null });

    // Track which settings failed to reset
    const failedKeys: string[] = [];
    const succeededKeys: string[] = [];

    // Attempt to reset each setting individually for partial success
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
      try {
        await window.goodvibes.setSetting(key, value);
        succeededKeys.push(key);
      } catch (err) {
        logger.warn(`Failed to reset setting '${key}':`, err);
        failedKeys.push(key);
      }
    }

    // All succeeded
    if (failedKeys.length === 0) {
      set({
        settings: DEFAULT_SETTINGS,
        isUpdating: false,
        recoveredFields: [],
      });
      toast.success('Settings reset to defaults', {
        title: 'Settings Reset',
        duration: 3000,
      });
      return true;
    }

    // Partial failure - load the current state with validation
    const errorMessage = `Failed to reset ${failedKeys.length} settings: ${failedKeys.slice(0, 3).join(', ')}${failedKeys.length > 3 ? '...' : ''}`;
    logger.error('Partial settings reset failure:', { failedKeys });

    try {
      const saved = await window.goodvibes.getAllSettings();
      const recovery = validateSettingsFromIpc(saved, new Set());

      set({
        settings: recovery.data,
        isUpdating: false,
        error: errorMessage,
        recoveredFields: failedKeys,
      });

      toast.warning(
        `${succeededKeys.length} settings were reset, but ${failedKeys.length} failed. Your settings have been partially restored.`,
        {
          title: 'Partial Reset',
          duration: 6000,
        }
      );
    } catch {
      // If reload also fails, use defaults for succeeded keys
      set({ isUpdating: false, error: errorMessage });
      toast.error('Failed to reset settings. Please try again.', {
        title: 'Settings Error',
        duration: 6000,
      });
    }
    return false;
  },

  clearError: () => set({ error: null }),
}));
