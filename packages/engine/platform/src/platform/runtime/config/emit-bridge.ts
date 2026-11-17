/**
 * Config emit-bridge, turns in-process `ConfigManager.subscribe` callbacks
 * into poll-free key-level events on the runtime event bus `config` domain.
 *
 * ── Why a bridge rather than a new hook on ConfigManager ────────────────────
 *
 * The manager already has exactly the seam this needs. `subscribe(key, cb)`
 * fires on an in-process `set`/`setDynamic` AND on an external file edit the
 * watcher picked up (`reloadFromDiskAndNotify` diffs precisely the keys
 * something subscribed to). Subscribing every known path therefore gets both
 * paths for free, and, not incidentally, is what makes the external-edit case
 * work at all: that diff walks the SUBSCRIBED keys, so a key nobody subscribed
 * to was never compared and never fired. Attaching this bridge widens that walk
 * to the whole declared surface as a side effect of doing its own job.
 *
 * ── What is subscribed ──────────────────────────────────────────────────────
 *
 * Every scalar key in CONFIG_SCHEMA, plus the daemon-owned paths that are not
 * scalar schema keys (`email.passwordRef`, `cluster.peers`, …) and the declared
 * secret-bearing paths. A path that no store ever holds simply never fires.
 *
 * The domain is not filtered down to daemon-owned keys, deliberately. A client
 * subscribing to this stream is watching the DAEMON's settings, and which of
 * them the daemon considers client-owned is a fact the subscriber may want to
 * see rather than one the emitter should decide for it, each notice carries
 * its `scope`, so a consumer that only cares about daemon-owned keys filters on
 * a field instead of losing the others silently.
 *
 * ── What never crosses ──────────────────────────────────────────────────────
 *
 * A secret-bearing key's value. The notice names the key and sets
 * `secret: true`; `value` is omitted entirely. See events/config.ts.
 *
 * Whether a key is secret-bearing is declared in code, never read by a model,
 * so a notice is emitted at once: a key on the declared SECRET_BEARING list
 * is, and any other CONFIG_SCHEMA key is not (the pre-commit credential-scope
 * check compares every schema key's stored reading against that list, so the
 * list is whole for the schema). Each daemon-owned non-schema path is classified
 * in {@link NON_SCHEMA_PATH_SECRET}, typed over the declared list, so a new path
 * does not compile until it is classified. A product's additional key carries
 * its own `secret` declaration.
 * Declared structured reference arrays carry only their detached validated
 * fields. Malformed structured values are omitted without invoking accessors.
 */

import { randomUUID } from 'node:crypto';
import type { RuntimeEventBus } from '../events/index.js';
import type { EmitterContext } from '../emitters/index.js';
import { emitConfigKeyChanged } from '../emitters/config.js';
import type { ConfigEventValue } from '../../../events/config.js';
import { CONFIG_SCHEMA } from '../../config/schema.js';
import {
  DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
  configKeyScope,
  type DaemonOwnedNonSchemaConfigPath,
} from '../../config/config-ownership.js';
import {
  SECRET_BEARING_CONFIG_PATHS,
  isSecretBearingConfigKey,
} from '../../config/secret-bearing-config-keys.js';
import { isStructuredCredentialReferenceConfigKey, captureStructuredCredentialReferenceConfigValue } from '../../config/structured-credential-config.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/**
 * The narrow config surface this needs: one subscription per key, and nothing
 * else. Structural so a test supplies four lines instead of a whole manager.
 */
export interface ConfigChangeSource {
  subscribe(key: string, callback: (newValue: unknown, previousValue: unknown) => void): () => void;
}

/** A product's own config path and whether its value is a credential (a credential's value never crosses). */
export interface AdditionalConfigKey {
  readonly key: string;
  readonly secret: boolean;
}

/**
 * Whether each daemon-owned path that is not a scalar schema key holds a
 * credential. Keyed by the declared list's own type, so adding a path to it
 * fails to compile here until someone says whether it is a secret.
 */
const NON_SCHEMA_PATH_SECRET: Readonly<Record<DaemonOwnedNonSchemaConfigPath, boolean>> = {
  'cluster.groupMaterial': true,
  'google.oauth.refreshToken': true,
  'email.passwordRef': true,
  'email.smtpPasswordRef': true,
};

export interface ConfigEmitBridgeDeps {
  /** The live ConfigManager, only its per-key subscription is used. */
  readonly config: ConfigChangeSource;
  /** The runtime event bus the config events are emitted onto. */
  readonly bus: Pick<RuntimeEventBus, 'emit'>;
  /**
   * Extra config paths a product knows about that the platform set does not
   * name, each with whether its value is a credential. Merged with the platform
   * set; duplicates are collapsed, and a platform declaration wins.
   */
  readonly additionalKeys?: readonly AdditionalConfigKey[] | undefined;
  /**
   * Trace id source for the emitted envelopes. A settings change is not born of
   * a single caller turn, so absent a real trace a fresh id per event is honest
   * (default). Injected in tests for determinism.
   */
  readonly traceId?: (() => string) | undefined;
  /** Clock seam for `changedAt`; injected in tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * Every config path this bridge watches: the declared scalar schema keys, the
 * daemon-owned non-scalar paths, and the declared secret-bearing paths.
 */
export function listWatchableConfigPaths(additionalKeys: readonly AdditionalConfigKey[] = []): readonly string[] {
  return [...new Set<string>([
    ...CONFIG_SCHEMA.map((setting) => setting.key),
    ...DAEMON_OWNED_NON_SCHEMA_CONFIG_PATHS,
    ...SECRET_BEARING_CONFIG_PATHS,
    ...additionalKeys.map((entry) => entry.key),
  ])];
}

/** Whether a watched path's value is a credential, from declarations only. */
function isDeclaredSecret(key: string, additional: ReadonlyMap<string, boolean>): boolean {
  if (isSecretBearingConfigKey(key)) return true;
  if (Object.hasOwn(NON_SCHEMA_PATH_SECRET, key)) return NON_SCHEMA_PATH_SECRET[key as DaemonOwnedNonSchemaConfigPath];
  return additional.get(key) ?? false;
}

/**
 * A config value in the JSON shape the wire carries, or undefined when it is
 * not representable.
 *
 * A value that cannot survive a JSON round trip (a function, a class instance,
 * a cyclic object) is dropped rather than coerced into something that reads as
 * the setting: an event saying `value: "[object Object]"` is worse than one
 * saying only that the key changed, and the subscriber's fallback, re-read the
 * key, is correct in both cases.
 */
export function toConfigEventValue(value: unknown): ConfigEventValue | undefined {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value)) as ConfigEventValue;
  } catch {
    return undefined;
  }
}

/**
 * Attach the bridge. Returns a function that detaches every subscription.
 *
 * Safe to call once at composition time. Detaching matters: the subscriptions
 * are held by the ConfigManager, so a bridge that outlived its bus would keep
 * emitting into a torn-down graph, the same reason the push event sources are
 * registered with the disposal registry.
 */
export function attachConfigEmitBridge(deps: ConfigEmitBridgeDeps): () => void {
  const nextTraceId = deps.traceId ?? ((): string => randomUUID());
  const clock = deps.now ?? ((): number => Date.now());
  const unsubscribes: (() => void)[] = [];
  const additional = new Map((deps.additionalKeys ?? []).map((entry) => [entry.key, entry.secret]));

  for (const key of listWatchableConfigPaths(deps.additionalKeys ?? [])) {
    const declaredSecret = isDeclaredSecret(key, additional);
    const structuredReference = isStructuredCredentialReferenceConfigKey(key);
    const scope = configKeyScope(key);
    try {
      unsubscribes.push(deps.config.subscribe(key, (newValue) => {
        // A settings change belongs to no conversation, so the envelope's
        // required sessionId carries the emitter's own name rather than a
        // borrowed one, the same sentinel shape the fleet bridge uses for a
        // node with no session.
        const ctx: EmitterContext = {
          traceId: nextTraceId(),
          source: 'config-emit-bridge',
          sessionId: 'config-manager',
        };
        let value: ConfigEventValue | undefined;
        let invalidStructuredReference = false;
        if (structuredReference) {
          try { value = toConfigEventValue(captureStructuredCredentialReferenceConfigValue(key, newValue)); }
          catch { invalidStructuredReference = true; }
        } else {
          value = toConfigEventValue(newValue);
        }
        const secret = declaredSecret || invalidStructuredReference;
        try {
          emitConfigKeyChanged(deps.bus as RuntimeEventBus, ctx, {
            key,
            scope,
            secret,
            // Omitted, never nulled, for a credential: the absence IS the
            // contract, and a null would read as "the credential was cleared".
            ...(secret ? {} : { value }),
            changedAt: clock(),
          });
        } catch (error) {
          // A failed emit must never break the write that triggered it.
          logger.warn('Config event bridge: emitting a change notice failed', {
            key,
            error: summarizeError(error),
          });
        }
      }));
    } catch (error) {
      // A manager that refuses one key must not cost the other several hundred.
      logger.warn('Config event bridge: could not watch a config key', {
        key,
        error: summarizeError(error),
      });
    }
  }

  return (): void => {
    for (let index = unsubscribes.length - 1; index >= 0; index -= 1) {
      try {
        unsubscribes[index]!();
      } catch {
        // Detaching is best-effort; a listener set that is already gone is fine.
      }
    }
    unsubscribes.length = 0;
  };
}
