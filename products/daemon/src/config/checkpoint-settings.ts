/**
 * The `checkpoints.*` settings are schema rows (validated, searchable, in the
 * settings screens and `settings set`); the one reader is the platform's.
 */
export {
  readCheckpointGuardSettings,
  readCheckpointRegistrationSetting,
  type CheckpointGuardSettings,
} from '@goodvibes/engine/platform/platform/config';
