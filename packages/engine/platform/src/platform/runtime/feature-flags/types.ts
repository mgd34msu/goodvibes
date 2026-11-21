/**
 * Feature flag type definitions for the goodvibes-platform runtime.
 *
 * These types model a feature gate from its declaration through the settings
 * that turn it on and off. Forcing a feature off and saying why is a locked
 * managed setting's job, not a separate flag state.
 */
import type { ConfigKey } from '../../config/schema-types.js';

/**
 * The two states of a feature flag.
 *
 * - `enabled` , the feature is active
 * - `disabled`, the feature is inactive
 */
export type FlagState = 'enabled' | 'disabled';

/**
 * Why a REGISTERED capability cannot operate, regardless of how it is
 * configured.
 *
 * - `no-runtime-wiring`, the platform half exists and is tested, but no
 *   surface drives it yet. Typical while an platform capability lands ahead of the
 *   consumers that will use it, because consumers pin a published platform version
 *   and cannot compile against it until it publishes.
 * - `missing-host-dependency`, the code is wired, but something the host must
 *   provide (a library, a binary, a device) is absent.
 * - `unsupported-platform`, this operating system or runtime cannot run it.
 */
export type FeatureInoperableReason =
  | 'no-runtime-wiring'
  | 'missing-host-dependency'
  | 'unsupported-platform';

/**
 * A capability that is present in the registry but cannot do anything yet.
 *
 * This exists because the alternative already shipped and reached a user: a
 * settings row that looks like a working switch, flips cleanly, and silently
 * does nothing. A feature carrying this is refused by
 * {@link isFeatureGateEnabled} no matter what its settings key says, so no
 * half-wired path can run, and every surface that renders FEATURE_SETTINGS
 * gets `detail` to show instead of a switch that lies.
 */
export interface FeatureInoperability {
  readonly reason: FeatureInoperableReason;
  /**
   * Written for a user to read in a settings surface, at the moment they try
   * to turn the feature on. States plainly that it is not available and why,
   * never a log line nobody sees.
   */
  readonly detail: string;
}

/**
 * How a feature is turned on and off through its domain settings key.
 *
 * - boolean : the key's boolean value is the feature's enablement.
 * - enum    : the feature is active while the key's value is in enabledValues
 *             (several features can share one key, e.g. telemetry.otelMode
 *             drives both the in-process instrumentation and remote export).
 * - constant: the capability has no separate off switch; its own domain keys
 *             (its tuning keys) govern runtime activation directly.
 */
export type FeatureEnablementKind = 'boolean' | 'enum' | 'constant';

export interface FeatureEnablement {
  /** The scalar settings key that decides (or, for constant, represents) enablement. */
  readonly key: ConfigKey;
  readonly kind: FeatureEnablementKind;
  /** For kind 'enum': the key values for which the feature is active. */
  readonly enabledValues?: readonly string[];
}

/**
 * Static declaration of a feature gate.
 *
 * Registered once at startup in `flags.ts`; state transitions are tracked
 * separately by `FeatureFlagManager`.
 */
export interface FeatureFlag {
  /** Unique kebab-case identifier used as the lookup key (e.g. `fetch-sanitization`) */
  id: string;

  /** Human-readable display name */
  name: string;

  /** One-line description of what this gate controls */
  description: string;

  /** The implementation tier that introduced this flag (1-based) */
  tier: number;

  /**
   * Whether this flag supports state changes after startup.
   * Set to `false` for gates that can only be configured before the process starts.
   */
  runtimeToggleable: boolean;

  /**
   * Set when the capability cannot operate at all in this build. Absent means
   * it works when enabled, the normal case, so nothing else has to change.
   *
   * Setting this makes the gate refuse the feature regardless of configuration
   * and gives surfaces something honest to render. Remove it in the same
   * change that wires the capability up, never before.
   */
  notOperable?: FeatureInoperability | undefined;

  /** The domain settings key that turns this feature on, and how its value is read. */
  settings: FeatureEnablement;

  /**
   * The config keys that tune this feature, rendered with its enablement key as
   * one unit; absent when it has none. Typed ConfigKey, so a key that is not a
   * real config key fails typecheck.
   */
  tuningKeys?: readonly ConfigKey[] | undefined;
}

/**
 * Persisted flag overrides loaded from the user config file.
 * Overrides are applied on top of each flag's default state, which its
 * settings key's schema default gives (feature-settings.ts featureDefaultState).
 */
export interface FlagConfig {
  /** Map of flag id → desired state; missing keys fall back to the flag's default state */
  flags: Record<string, FlagState>;
}

/**
 * A single state-change record emitted to subscribers and written to the
 * in-memory audit log.
 */
export interface FlagTransition {
  /** The flag that changed */
  flagId: string;

  /** State before the transition */
  previous: FlagState;

  /** State after the transition */
  next: FlagState;

  /** Unix timestamp (ms) when the transition occurred */
  timestamp: number;
}
