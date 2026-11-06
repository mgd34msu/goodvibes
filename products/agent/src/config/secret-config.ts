import { createSecretConfigKeyRegistry, createSecretBackedConfigWriter, isGoodVibesSecretReferenceValue as isSecretReferenceValue, type ConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { routeDaemonOwnedCredentialWrite } from './daemon-credential-routing.ts';
import { routeDaemonOwnedConfigWrite } from './daemon-config-routing.ts';
export { normalizeSecretKeyPart, buildGoodVibesSecretKey, buildGoodVibesSecretRef, isGoodVibesSecretReferenceValue as isSecretReferenceValue, isMalformedGoodVibesSecretReferenceValue, getSecretWriteMedium, buildSecretBackedConfigUpdate, defaultSecretBackedScope } from '@goodvibes-jev/engine/sdk/platform/config';
export type { SecretBackedConfigUpdate, SecretBackedConfigManager, SecretBackedSecretStore } from '@goodvibes-jev/engine/sdk/platform/config';
export const { SECRET_CONFIG_KEYS, isSecretConfigKey } = createSecretConfigKeyRegistry([
  'email.passwordRef' as ConfigKey,
  'calendar.google.clientSecretRef' as ConfigKey,
  'calendar.microsoft.clientSecretRef' as ConfigKey,
]);
export const persistSecretBackedConfigValue = createSecretBackedConfigWriter(async (configKey, rawValue, update) => {
  // Explicit scopes deliberately select local storage. Otherwise a connected
  // daemon owns its credential/config pair and a refusal must propagate.
  if (isSecretReferenceValue(update.configValue) && update.secretValue === undefined) {
    return await routeDaemonOwnedConfigWrite(configKey, update.configValue) === 'daemon';
  }
  return (await routeDaemonOwnedCredentialWrite(configKey, rawValue))?.appliedBy === 'daemon';
});
