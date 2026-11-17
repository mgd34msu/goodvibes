/**
 * feature-settings.ts, the binding layer between domain settings keys and the
 * internal capability gates, plus the per-feature settings metadata surfaces
 * render.
 *
 * Every platform capability is configured through a first-class settings key
 * in its natural domain (behavior.compactionStrategy, sandbox.enabled,
 * notifications.adaptiveSuppression, ...). There is no separate enablement
 * namespace: at boot the runtime derives each internal gate's state from its
 * bound settings key, and the live bridge keeps them in sync afterwards.
 * The internal gate registry (flags.ts) and its manager survive as
 * implementation detail only, surfaces render FEATURE_SETTINGS, never that
 * registry as a category of its own.
 *
 * Binding kinds:
 * - boolean : the key's boolean value is the feature's enablement.
 * - enum    : the feature is active while the key's value is in enabledValues
 *             (several features can share one key, e.g. telemetry.otelMode
 *             drives both the in-process instrumentation and remote export).
 * - constant: the capability has no separate off switch; its own domain keys
 *             (its tuning keys) govern runtime activation directly.
 *
 * Each binding is declared on its FEATURE_FLAGS entry (`settings`), with the
 * keys that tune the feature (`tuningKeys`); everything here is derived.
 */
import type { ConfigKey } from '../../config/schema-types.js';
import type { ConfigManager } from '../../config/manager.js';
import { logger } from '../../utils/logger.js';
import { FEATURE_FLAGS, FEATURE_FLAG_MAP } from './flags.js';
import type { FeatureFlagManager } from './manager.js';
import type { FeatureEnablement, FeatureEnablementKind, FlagState } from './types.js';

export type { FeatureEnablementKind } from './types.js';

/** A feature's enablement binding, as declared on its FEATURE_FLAGS entry. */
export interface FeatureSettingsBinding extends FeatureEnablement {
  readonly featureId: string;
}

/** Every capability's enablement binding, one entry per registry id, read off FEATURE_FLAGS. */
export const FEATURE_SETTINGS_BINDINGS: readonly FeatureSettingsBinding[] = FEATURE_FLAGS.map(
  (flag) => ({ featureId: flag.id, ...flag.settings }),
);

const BINDINGS_BY_ID: ReadonlyMap<string, FeatureSettingsBinding> = new Map(
  FEATURE_SETTINGS_BINDINGS.map((b) => [b.featureId, b]),
);

export function getFeatureSettingsBinding(featureId: string): FeatureSettingsBinding | null {
  return BINDINGS_BY_ID.get(featureId) ?? null;
}

/**
 * Registry-membership check: composition fails LOUDLY when a gate id it
 * references has no FEATURE_SETTINGS binding. This is the defect class where
 * a never-registered id silently reads as "disabled" forever, no settings
 * key could ever turn it on, so the gated capability ships dead. Called by
 * the gates helpers (gates.ts) on every referenced id.
 */
export function assertFeatureGateIdRegistered(flagId: string, context: string): void {
  if (BINDINGS_BY_ID.has(flagId)) return;
  throw new Error(
    `[feature-settings] unknown feature gate id "${flagId}" referenced by ${context}: ` +
    `it is not in FEATURE_SETTINGS, so no setting could ever enable it and the gated ` +
    `capability would ship dead. Register the flag in flags.ts with its settings ` +
    `binding, or remove the reference.`,
  );
}

/** Derive one feature's state from a settings value per its binding. */
export function deriveFeatureState(binding: FeatureSettingsBinding, value: unknown): FlagState {
  // A capability that cannot operate never derives to 'enabled', so the gate
  // manager, the gate itself, and any state readout all agree it is not
  // running. The user's CONFIG value is left untouched, their intent is kept
  // for the release that wires the capability up, and the surface explains
  // the gap with FeatureSetting.inoperableDetail rather than showing "on" for
  // something that is doing nothing.
  if (FEATURE_FLAG_MAP.get(binding.featureId)?.notOperable !== undefined) return 'disabled';
  switch (binding.kind) {
    case 'constant':
      return 'enabled';
    case 'boolean':
      return value === true ? 'enabled' : 'disabled';
    case 'enum':
      return typeof value === 'string' && (binding.enabledValues ?? []).includes(value)
        ? 'enabled'
        : 'disabled';
  }
}

/**
 * Derive every feature's desired state from the live config. Used at boot to
 * seed the gate manager; because each settings default matches the registry
 * default (enforced by test), deriving on a fresh config is a no-op.
 */
export function deriveFeatureStates(
  configManager: Pick<ConfigManager, 'get'>,
): Record<string, FlagState> {
  const states: Record<string, FlagState> = {};
  for (const binding of FEATURE_SETTINGS_BINDINGS) {
    states[binding.featureId] = deriveFeatureState(binding, configManager.get(binding.key));
  }
  return states;
}

/**
 * Live bridge from domain settings changes to the in-process gate manager.
 * Subscribes each bound key once and forwards the derived state for every
 * feature bound to it. Runtime-toggleable gates apply immediately; startup
 * gates record an honest pending-restart marker (see
 * FeatureFlagManager.applyConfigState). Constant bindings need no
 * subscription, their domain keys act directly on the subsystems that read
 * them.
 */
export function bindFeatureSettingsBridge(
  configManager: Pick<ConfigManager, 'subscribe'>,
  featureFlags: Pick<FeatureFlagManager, 'applyConfigState'>,
): () => void {
  const byKey = new Map<ConfigKey, FeatureSettingsBinding[]>();
  for (const binding of FEATURE_SETTINGS_BINDINGS) {
    if (binding.kind === 'constant') continue;
    const list = byKey.get(binding.key) ?? [];
    list.push(binding);
    byKey.set(binding.key, list);
  }
  const unsubs: Array<() => void> = [];
  for (const [key, bindings] of byKey) {
    unsubs.push(configManager.subscribe(key, (newValue: unknown) => {
      for (const binding of bindings) {
        try {
          featureFlags.applyConfigState(binding.featureId, deriveFeatureState(binding, newValue));
        } catch (err) {
          logger.warn('[feature-settings] failed to apply settings change to gate', {
            featureId: binding.featureId,
            key,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }));
  }
  return () => {
    for (const unsub of unsubs.splice(0)) unsub();
  };
}

/** One feature as the settings surfaces render it. */
export interface FeatureSetting {
  readonly id: string;
  readonly name: string;
  /** Real description of behavior and options (feeds under-cursor docs). */
  readonly description: string;
  /** Top-level settings domain the feature lives in (its config category). */
  readonly domain: string;
  /** How the feature is turned on/off. */
  readonly enablement: {
    readonly key: ConfigKey;
    readonly kind: FeatureEnablementKind;
    readonly enabledValues?: readonly string[];
  };
  /** Every scalar settings key that configures this feature (enablement key first). */
  readonly settings: readonly ConfigKey[];
  /** True when enablement changes only take effect after a process restart. */
  readonly restartRequired: boolean;
  /** Whether a stock configuration has the feature active. */
  readonly defaultEnabled: boolean;
  /**
   * False when the capability cannot operate in this build at all, the gate
   * refuses it regardless of its settings key.
   *
   * A surface rendering `operable: false` must SAY SO where the control is,
   * rather than drawing a switch that flips cleanly and does nothing. The
   * reason to show is {@link inoperableDetail}.
   */
  readonly operable: boolean;
  /** Why it cannot operate, written for a user; null when it can. */
  readonly inoperableDetail: string | null;
}

function buildFeatureSetting(binding: FeatureSettingsBinding): FeatureSetting {
  const flag = FEATURE_FLAG_MAP.get(binding.featureId);
  if (!flag) {
    throw new Error(`[feature-settings] binding references unknown feature "${binding.featureId}"`);
  }
  const settings: ConfigKey[] = [binding.key];
  for (const key of flag.tuningKeys ?? []) {
    if (!settings.includes(key)) settings.push(key);
  }
  return {
    id: flag.id,
    name: flag.name,
    description: flag.description,
    domain: binding.key.split('.')[0] ?? '',
    enablement: {
      key: binding.key,
      kind: binding.kind,
      ...(binding.enabledValues !== undefined ? { enabledValues: binding.enabledValues } : {}),
    },
    settings,
    restartRequired: !flag.runtimeToggleable,
    defaultEnabled: flag.defaultState === 'enabled',
    operable: flag.notOperable === undefined,
    inoperableDetail: flag.notOperable?.detail ?? null,
  };
}

/**
 * The per-feature settings metadata surfaces consume: domain, option shapes
 * (enablement key + associated tuning keys, each described in CONFIG_SCHEMA),
 * and real behavior descriptions. Ordered by the registry declaration order.
 */
export const FEATURE_SETTINGS: readonly FeatureSetting[] = FEATURE_FLAGS.map((flag) => {
  const binding = BINDINGS_BY_ID.get(flag.id);
  if (!binding) {
    throw new Error(`[feature-settings] feature "${flag.id}" has no settings binding`);
  }
  return buildFeatureSetting(binding);
});
