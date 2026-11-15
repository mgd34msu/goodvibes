import { createSecretConfigKeyRegistry } from '@goodvibes-jev/engine/platform/platform/config';

// The set of keys that route through the secret store is the engine's alone; this binary adds none.
const registry = createSecretConfigKeyRegistry([]);
export const SECRET_CONFIG_KEYS = registry.SECRET_CONFIG_KEYS;
export const isSecretConfigKey = registry.isSecretConfigKey;

export { normalizeSecretKeyPart, buildGoodVibesSecretKey, buildGoodVibesSecretRef, isGoodVibesSecretReferenceValue as isSecretReferenceValue, isMalformedGoodVibesSecretReferenceValue, getSecretWriteMedium, buildSecretBackedConfigUpdate, defaultSecretBackedScope, persistSecretBackedConfigValue } from '@goodvibes-jev/engine/platform/platform/config';
export type { SecretBackedConfigUpdate, SecretBackedConfigManager, SecretBackedSecretStore, DaemonCredentialWriter } from '@goodvibes-jev/engine/platform/platform/config';
