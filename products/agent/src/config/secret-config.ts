import { createSecretBackedConfigWriter, isGoodVibesSecretReferenceValue as isSecretReferenceValue } from '@goodvibes-jev/engine/platform/platform/config';
import { routeDaemonOwnedCredentialWrite } from './daemon-credential-routing.ts';
import { routeDaemonOwnedConfigWrite } from './daemon-config-routing.ts';
export { normalizeSecretKeyPart, buildGoodVibesSecretKey, buildGoodVibesSecretRef, isGoodVibesSecretReferenceValue as isSecretReferenceValue, isMalformedGoodVibesSecretReferenceValue, getSecretWriteMedium, buildSecretBackedConfigUpdate, defaultSecretBackedScope } from '@goodvibes-jev/engine/platform/platform/config';
export type { SecretBackedConfigUpdate, SecretBackedConfigManager, SecretBackedSecretStore } from '@goodvibes-jev/engine/platform/platform/config';
// The set of keys that route through the secret store is the engine's declared list.
export { SECRET_CONFIG_KEYS, isSecretConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
export const persistSecretBackedConfigValue = createSecretBackedConfigWriter(async (configKey, rawValue, update) => {
  // Explicit scopes deliberately select local storage. Otherwise a connected
  // daemon owns its credential/config pair and a refusal must propagate.
  if (isSecretReferenceValue(update.configValue) && update.secretValue === undefined) {
    return await routeDaemonOwnedConfigWrite(configKey, update.configValue) === 'daemon';
  }
  return (await routeDaemonOwnedCredentialWrite(configKey, rawValue))?.appliedBy === 'daemon';
});
