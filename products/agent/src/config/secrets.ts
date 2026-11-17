export type { SecretDeleteOptions, SecretRecord, SecretScope, SecretSource, SecretStorageMedium, SecretStorageMode, SecretStorageReview, SecretWriteOptions } from '@goodvibes-jev/engine/platform/platform/config';
// The store is built only through createRuntimeSecretsManager (engine config), which requires the daemon home.
export { SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
// Keys the connected host owns are written there instead of to this local store: see daemon-credential-routing.ts. Their status is read in credential-status.ts.
export { deriveCredentialAvailability, fetchDaemonCredentialAvailability } from './credential-status.ts';
export type { CredentialAvailability, CredentialStatusConnection, CredentialStatusEntry } from './credential-status.ts';

