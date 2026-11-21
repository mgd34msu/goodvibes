import { installedDataWriter } from '../runtime/native-data-writer.ts';
import { ConfigManager, type ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { NOTIFICATIONS_METADATA_ONLY_KEY, NOTIFICATIONS_METADATA_ONLY_SETTING } from '@goodvibes/engine/platform/platform/runtime/notification-privacy';
import { MEMORY_SHOW_PROVENANCE_SETTING } from '../core/memory-provenance.ts';
import { TUI_EXTENSION_SETTINGS } from './tui-extension-settings.ts';

export const TUI_NOTIFICATIONS_METADATA_ONLY_KEY = NOTIFICATIONS_METADATA_ONLY_KEY;

/**
 * Register TUI-owned settings without changing the shared platform schema or
 * defaults. They are registered before the first load, so the loader knows them
 * (no "not a setting this build knows" notice), validates and defaults them,
 * Settings lists them from the manager's host schema, and a read always
 * resolves to an accepted value.
 */
export class TuiConfigManager extends ConfigManager {
  constructor(options: ConstructorParameters<typeof ConfigManager>[0]) {
    super({ ...options, nativeDataWriter: options.nativeDataWriter ?? installedDataWriter, hostSettings: [...(options.hostSettings ?? []), NOTIFICATIONS_METADATA_ONLY_SETTING, MEMORY_SHOW_PROVENANCE_SETTING, ...TUI_EXTENSION_SETTINGS] });
  }
}

/** Live host consent; an unregistered or unavailable owner remains restrictive. */
export function readTuiNotificationsMetadataOnly(config: Pick<ConfigManager, 'getHostBooleanSetting'>): boolean {
  try { return config.getHostBooleanSetting(TUI_NOTIFICATIONS_METADATA_ONLY_KEY).get() !== false; }
  catch { return true; }
}

/** Product composition facade for legacy string-key notification consumers. */
export function readTuiConfigValue(config: Pick<ConfigManager, 'get' | 'getHostBooleanSetting'>, key: string): unknown {
  if (key === TUI_NOTIFICATIONS_METADATA_ONLY_KEY) return readTuiNotificationsMetadataOnly(config);
  return config.get(key as ConfigKey);
}

export function subscribeTuiConfigValue(
  config: Pick<ConfigManager, 'subscribe' | 'getHostBooleanSetting'>,
  key: string,
  callback: (...args: unknown[]) => void,
): () => void {
  if (key === TUI_NOTIFICATIONS_METADATA_ONLY_KEY) return config.getHostBooleanSetting(key).subscribe(callback);
  return config.subscribe(key as ConfigKey, callback);
}
