export type { SecretDeleteOptions, SecretRecord, SecretScope, SecretSource, SecretStorageMedium, SecretStorageMode, SecretStorageReview, SecretWriteOptions } from '@goodvibes-jev/engine/platform/platform/config';
import { LiteralSecretsManager, type SecretsManagerOptions as PlatformOptions } from '@goodvibes-jev/engine/platform/platform/config';
export type SecretsManagerOptions = Omit<PlatformOptions, 'surfaceRoot'>;
import { GOODVIBES_AGENT_SURFACE_ROOT } from './surface.ts';
export { applyRawSecretLiteralHandling } from '@goodvibes-jev/engine/platform/platform/config';
// API key values remain local/env-only; daemon status is exposed separately.
export { deriveCredentialAvailability, fetchDaemonCredentialAvailability } from './credential-status.ts';
export type { CredentialAvailability, CredentialStatusConnection, CredentialStatusEntry } from './credential-status.ts';
export class SecretsManager extends LiteralSecretsManager {
  constructor(options: SecretsManagerOptions) { super({ ...options, surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT }); }
}
