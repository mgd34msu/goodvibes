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

import {
  SecretsManager as PlatformSecretsManager,
  type SecretsManagerOptions as PlatformSecretsManagerOptions,
} from '@goodvibes-jev/engine/platform/platform/config';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from './surface.ts';

export type SecretsManagerOptions = Omit<PlatformSecretsManagerOptions, 'surfaceRoot'>;

export class SecretsManager extends PlatformSecretsManager {
  constructor(options: SecretsManagerOptions) {
    super({
      ...options,
      surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT,
    });
  }
}
