/**
 * config-read.ts, read `cluster.*` out of a ConfigManager, from inside the platform.
 *
 * Why this exists rather than every caller doing `getCategory('cluster')`:
 * the config schema is assembled from domain modules that each declare their
 * slice of `GoodVibesConfig` with `declare module`. Those augmentations are in
 * scope while the platform itself compiles, but they do NOT survive into the
 * published type surface, a consumer importing `ConfigManager` from
 * `@goodvibes-jev/engine/platform/platform/config` finds that `getCategory('cluster')`
 * does not typecheck, and neither does `getCategory('fleet')` or
 * `getCategory('conversationGate')`. That is a pre-existing gap in how the
 * schema domains are published, not something the cluster domain introduced.
 *
 * Rather than have every consumer cast around it, the read happens HERE, where
 * the augmentation is genuinely in scope, and callers receive resolved
 * `ClusterSettings`, a plain, fully-typed value with no augmentation
 * dependency at all.
 */
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { isSecretReferenceValue } from '../config/secret-bearing-config-keys.js';
import { normalizeSecretRef } from '../config/secret-refs.js';
import { logger } from '../utils/logger.js';
import { resolveClusterSettings } from './settings.js';
import type { ClusterSettings } from './types.js';

/** Where `cluster.secret` is read from when the setting holds its secret-store reference. */
export type ClusterSecretSource = Pick<SecretsManager, 'resolveLocalSecretSync'>;

/**
 * `cluster.secret` is a credential, so the settings file holds a
 * `goodvibes://secrets/` reference and the phrase lives in the secret store.
 * Read it here, once, so the election never signs with the reference text.
 */
function resolveClusterSecret(value: string, secrets: ClusterSecretSource | undefined): string {
  if (!isSecretReferenceValue(value)) return value;
  const ref = normalizeSecretRef(value.trim());
  if (secrets && ref?.source === 'goodvibes') {
    const stored = secrets.resolveLocalSecretSync(ref.id);
    if (stored.state === 'resolved') return stored.value;
  }
  logger.warn('cluster.secret names a stored secret that could not be read; election traffic outside a group runs unsigned', {
    next: 'store the phrase with /secrets set and point cluster.secret at it, or clear cluster.secret',
  });
  return '';
}

/**
 * Resolved cluster settings for this host.
 *
 * A host whose config predates the cluster domain simply gets the defaults:
 * an absent section is not a misconfiguration, and refusing to start over one
 * would take inbound messaging down for an install that never opted in.
 */
export function readClusterSettings(configManager: Pick<ConfigManager, 'getCategory'>, secrets?: ClusterSecretSource): ClusterSettings {
  let settings: ClusterSettings;
  try {
    settings = resolveClusterSettings(configManager.getCategory('cluster'));
  } catch {
    settings = resolveClusterSettings(undefined);
  }
  const secret = resolveClusterSecret(settings.secret, secrets);
  return secret === settings.secret ? settings : { ...settings, secret };
}
