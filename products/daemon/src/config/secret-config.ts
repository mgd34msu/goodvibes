// The set of keys that route through the secret store is the engine's declared list.
export { SECRET_CONFIG_KEYS, isSecretConfigKey } from '@goodvibes/engine/platform/platform/config';

export { normalizeSecretKeyPart, buildGoodVibesSecretKey, buildGoodVibesSecretRef, isGoodVibesSecretReferenceValue as isSecretReferenceValue, isMalformedGoodVibesSecretReferenceValue, getSecretWriteMedium, buildSecretBackedConfigUpdate, defaultSecretBackedScope, persistSecretBackedConfigValue } from '@goodvibes/engine/platform/platform/config';
export type { SecretBackedConfigUpdate, SecretBackedConfigManager, SecretBackedSecretStore, DaemonCredentialWriter } from '@goodvibes/engine/platform/platform/config';
