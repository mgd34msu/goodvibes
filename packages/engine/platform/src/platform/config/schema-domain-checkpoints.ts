/**
 * schema-domain-checkpoints.ts, the workspace checkpoint guards.
 *
 * Every product that takes automatic workspace checkpoints (the terminal app,
 * the Agent and the daemon) hands these to the platform's checkpoint manager.
 * The defaults are the checkpoint manager's own, so an unset key changes
 * nothing.
 */
import { type ConfigSettingDefinition, intRange } from './schema-shared.js';
import { DEFAULT_MAX_FIRST_SNAPSHOT_FILES } from '../workspace/checkpoint/root-guard.js';

export interface CheckpointsConfig {
  preferGitRoot: boolean;
  allowBroadRoot: boolean;
  allowLargeFirstSnapshot: boolean;
  maxFirstSnapshotFiles: number;
  autoRetention: boolean;
  /** Whether a workspace that is not registered gets checkpoints (Agent and daemon). */
  unregisteredWorkspaces: 'off' | 'guarded';
}


export const checkpointsConfigDefaults = {
  checkpoints: {
    preferGitRoot: true,
    allowBroadRoot: false,
    allowLargeFirstSnapshot: false,
    maxFirstSnapshotFiles: DEFAULT_MAX_FIRST_SNAPSHOT_FILES,
    autoRetention: true,
    unregisteredWorkspaces: 'off',
  },
} as const;

export const checkpointsConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'checkpoints.preferGitRoot',
    label: 'Save checkpoints of the whole git repository',
    type: 'boolean',
    description: 'Checkpoint the enclosing git repository (its top level) instead of only the working directory',
  },
  {
    key: 'checkpoints.allowBroadRoot',
    label: 'Allow checkpoints of your home folder or the whole disk',
    type: 'boolean',
    description: 'Allow checkpoints of a broad directory: the filesystem root, your home directory or ~/.goodvibes. Off, such a directory is not checkpointed',
  },
  {
    key: 'checkpoints.allowLargeFirstSnapshot',
    label: 'Allow a large first checkpoint',
    type: 'boolean',
    description: 'Allow the first checkpoint of a workspace to sweep more files than checkpoints.maxFirstSnapshotFiles. Off, that first checkpoint is refused with the file count',
  },
  {
    key: 'checkpoints.maxFirstSnapshotFiles',
    label: 'Most files in a first checkpoint',
    type: 'number',
    description: 'Most files the first checkpoint of a workspace may sweep before it is refused (unless checkpoints.allowLargeFirstSnapshot is on)',
    ...intRange(1, 10_000_000),
  },
  {
    key: 'checkpoints.autoRetention',
    label: 'Remove old checkpoints automatically',
    type: 'boolean',
    description: 'Prune old checkpoints automatically after each new one and once at start. Off, old checkpoints are pruned only when asked',
  },
  {
    key: 'checkpoints.unregisteredWorkspaces',
    label: "Checkpoints in folders that aren't registered",
    type: 'enum',
    enumValues: ['off', 'guarded'],
    description: 'Checkpoints in a workspace that is not registered (Agent and daemon; the terminal app checkpoints any workspace). off: automatic and explicit checkpoints are refused there until it is registered (`goodvibes-agent workspaces register`). guarded: they are taken there too, under the root and size guards above. A project settings file cannot change it',
  },
];
