export type { SecretDeleteOptions, SecretRecord, SecretScope, SecretSource, SecretStorageMedium, SecretStorageMode, SecretStorageReview, SecretWriteOptions } from '@goodvibes-jev/engine/platform/platform/config';
import { SecretsManager as PlatformSecretsManager, type SecretsManagerOptions as PlatformOptions } from '@goodvibes-jev/engine/platform/platform/config';
export type SecretsManagerOptions = Omit<PlatformOptions, 'surfaceRoot'>;
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.ts';
// Keys the connected host owns are written there instead of to this local store: see daemon-credential-routing.ts. Their status is read in credential-status.ts.
export { deriveCredentialAvailability, fetchDaemonCredentialAvailability } from './credential-status.ts';
export type { CredentialAvailability, CredentialStatusConnection, CredentialStatusEntry } from './credential-status.ts';
export class SecretsManager extends PlatformSecretsManager {
  constructor(options: SecretsManagerOptions) { super({ ...options, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT }); }
}
