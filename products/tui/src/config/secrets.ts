export type { SecretDeleteOptions, SecretRecord, SecretScope, SecretSource, SecretStorageMedium, SecretStorageMode, SecretStorageReview, SecretWriteOptions } from '@goodvibes-jev/engine/sdk/platform/config';
import { LiteralSecretsManager, type SecretsManagerOptions as PlatformOptions } from '@goodvibes-jev/engine/sdk/platform/config';
export type SecretsManagerOptions = Omit<PlatformOptions, 'surfaceRoot'>;
export class SecretsManager extends LiteralSecretsManager {
  constructor(options: SecretsManagerOptions) { super({ ...options, surfaceRoot: 'tui' }); }
}
