export type {
  SecretDeleteOptions,
  SecretRecord,
  SecretScope,
  SecretSource,
  SecretStorageMedium,
  SecretStorageMode,
  SecretStorageReview,
  SecretWriteOptions,
} from '@goodvibes-jev/engine/platform/platform/config';

// The store is built only through createRuntimeSecretsManager (engine config), which requires the daemon home.
export { SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
