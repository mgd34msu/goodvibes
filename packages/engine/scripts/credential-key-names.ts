// credential-key-names.ts
//
// Schema keys with no explicit credential storage contract, and the name rule
// that decides whether one of them must have one. Shared by the offline
// credential-scope check and its tests.

import { CONFIG_SCHEMA } from '../platform/src/platform/config/schema.ts';
import { isDeclaredSecretBearingConfigKey } from '../platform/src/platform/config/secret-bearing-config-keys.ts';
import { isStructuredCredentialReferenceConfigKey, isScalarCredentialReferenceConfigKey } from '../platform/src/platform/config/structured-credential-config.ts';

/** Every schema key without an explicit credential storage contract, sorted by key. */
export function undeclaredSchemaKeys(): { readonly key: string; readonly description: string }[] {
  return CONFIG_SCHEMA
    .filter((setting) => !isDeclaredSecretBearingConfigKey(setting.key) && !isStructuredCredentialReferenceConfigKey(setting.key) && !isScalarCredentialReferenceConfigKey(setting.key))
    .map((setting) => ({ key: setting.key, description: setting.description ?? '' }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

// A secret word (optionally a `...Ref` pointer to a stored secret; plural for most),
// or a URL that is itself the secret (webhook and private ICS-feed URLs).
// `tokens` is not matched as a plural: it names token budgets (`maxTokens`).
const SECRET_NAME = /(?:token|bearer|material)(?:ref)?$|(?:secret|password|passphrase|apikey|privatekey|secretkey|credential)s?(?:ref)?$|(?:webhook|ics)url$/i;

/**
 * Declared secret-bearing keys whose name says nothing about being secret.
 * A generic `*Url` / `*Target` cannot be matched by name without flagging
 * ordinary endpoints, so these stay declared by hand.
 */
export const NAME_OPAQUE_SECRET_KEYS: readonly string[] = ['surfaces.webhook.defaultTarget'];

/** True when a key's last path segment names a secret (`foo.apiKey`, `bar.authToken`). */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_NAME.test(key.split('.').pop() ?? '');
}
