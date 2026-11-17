/**
 * The `checkpoints.*` settings as every product that takes workspace
 * checkpoints hands them to the platform's checkpoint manager. The schema
 * (schema-domain-checkpoints.ts) validates them and puts them in settings
 * search, the settings screens and `settings set`; this only reads them.
 */
import type { ConfigManager } from './manager.js';

/** The checkpoint manager's root and retention guard options. */
export interface CheckpointGuardSettings {
  readonly preferGitRoot: boolean;
  readonly allowBroadRoot: boolean;
  readonly allowLargeFirstSnapshot: boolean;
  readonly maxFirstSnapshotFiles: number;
  readonly autoRetention: boolean;
}

/** The guard settings in effect (an unset key holds the checkpoint manager's own default). */
export function readCheckpointGuardSettings(configManager: Pick<ConfigManager, 'get'>): CheckpointGuardSettings {
  return {
    preferGitRoot: configManager.get('checkpoints.preferGitRoot'),
    allowBroadRoot: configManager.get('checkpoints.allowBroadRoot'),
    allowLargeFirstSnapshot: configManager.get('checkpoints.allowLargeFirstSnapshot'),
    maxFirstSnapshotFiles: configManager.get('checkpoints.maxFirstSnapshotFiles'),
    autoRetention: configManager.get('checkpoints.autoRetention'),
  };
}

/**
 * Whether an unregistered workspace gets checkpoints: `off` (the default)
 * refuses automatic and explicit checkpoints there until it is registered;
 * `guarded` takes them under the root and size guards only. Kept apart from
 * the guard options because it is an admission rule, not a manager option.
 */
export function readCheckpointRegistrationSetting(configManager: Pick<ConfigManager, 'get'>): 'off' | 'guarded' {
  return configManager.get('checkpoints.unregisteredWorkspaces') === 'guarded' ? 'guarded' : 'off';
}
