/**
 * FeatureFlagManager, runtime feature gate controller.
 *
 * Responsibilities:
 *   - Initialises all flags from the registry with their default states.
 *   - Applies config-layer values (`loadFromConfig` at boot, `applyConfigState`
 *     for a live change). Settings own a flag's state; there is no other way
 *     to set it.
 *   - Records a live change to a flag marked `runtimeToggleable: false` as
 *     pending a restart instead of applying it.
 *   - Maintains an in-process audit log of all transitions.
 *   - Notifies subscribers synchronously on every state change.
 */
import { FEATURE_FLAG_MAP } from './flags.js';
import { featureDefaultState } from './feature-settings.js';
import type { FlagConfig, FlagState, FlagTransition, FeatureFlag } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import { revisionSource, type RevisionSource } from '../../utils/revision.js';

/** Most recent transitions kept in the in-process audit log. */
const MAX_RECORDED_TRANSITIONS = 1000;

/** Subscriber callback type for flag state changes */
export type FlagSubscriber = (
  flagId: string,
  state: FlagState,
  previous: FlagState,
) => void;

/**
 * Manages the runtime state of all registered feature flags.
 *
 */
class FeatureFlagManagerImpl {
  private _publicationRevision = 0;

  /** Bumped on every flag transition; a reader that must re-check compares this integer. */
  public getPublicationRevision(): number { return this._publicationRevision; }
  public readonly revisionSource: RevisionSource = revisionSource('feature flags', () => this._publicationRevision);
  /** Current state for each registered flag */
  private readonly _states: Map<string, FlagState> = new Map();

  /** In-process ordered audit log of the most recent state transitions (capped) */
  private readonly _transitions: FlagTransition[] = [];

  /** Active subscriber callbacks */
  private readonly _subscribers: Set<FlagSubscriber> = new Set();

  /**
   * Persisted config values for startup-gated (runtimeToggleable: false) flags
   * whose value differs from the current effective state. Populated by
   * `applyConfigState()` when a live config change targets a flag that cannot
   * be applied without a restart; cleared once the persisted and effective
   * values agree again (including at the next process start, when
   * `loadFromConfig()` seeds the effective state from the same value).
   */
  private readonly _pendingRestart: Map<string, FlagState> = new Map();

  constructor() {
    // Seed all flags with their defaults, derived from their settings keys' schema defaults.
    for (const id of FEATURE_FLAG_MAP.keys()) {
      this._states.set(id, featureDefaultState(id));
    }
  }

  // ── Read API ────────────────────────────────────────────────────────────

  /**
   * Returns `true` only if the flag is in the `'enabled'` state.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  isEnabled(flagId: string): boolean {
    return this._states.get(flagId) === 'enabled';
  }

  /**
   * Returns the current `FlagState` for the given flag.
   * Throws if the flag id is not registered.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  getState(flagId: string): FlagState {
    const state = this._states.get(flagId);
    if (state === undefined) {
      throw new Error(`[FeatureFlagManager] Unknown flag: "${flagId}"`);
    }
    return state;
  }

  /**
   * Returns a new snapshot Map of all flags with their current state.
   * Changes to the returned map do not affect the manager's internal state.
   *
   * `state` is the live effective state. `persistedState` is the last known
   * config-layer value; for a startup-gated flag with a pending restart these
   * two differ, which `pendingRestart` calls out explicitly rather than
   * leaving a caller to infer it, see `applyConfigState()`.
   */
  getAll(): Map<string, { flag: FeatureFlag; state: FlagState; persistedState: FlagState; pendingRestart: boolean }> {
    const result = new Map<string, { flag: FeatureFlag; state: FlagState; persistedState: FlagState; pendingRestart: boolean }>();
    for (const [id, state] of this._states) {
      const flag = FEATURE_FLAG_MAP.get(id);
      if (flag !== undefined) {
        const pending = this._pendingRestart.get(id);
        result.set(id, {
          flag,
          state,
          persistedState: pending ?? state,
          pendingRestart: pending !== undefined,
        });
      }
    }
    return result;
  }

  /**
   * True when a startup-gated flag has a persisted config value that differs
   * from its current effective state, i.e. a process restart is required
   * before the persisted value takes effect.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  hasPendingRestart(flagId: string): boolean {
    return this._pendingRestart.has(flagId);
  }

  /**
   * The persisted-but-not-yet-effective state recorded for a startup-gated
   * flag, or `null` when no restart is pending for it.
   *
   * @param flagId - The flag's kebab-case identifier.
   */
  getPendingRestartState(flagId: string): FlagState | null {
    return this._pendingRestart.get(flagId) ?? null;
  }

  /**
   * Every startup-gated flag whose saved value is not the running one yet,
   * with both states. Walks only the pending set, so it costs nothing while
   * no restart is owed.
   */
  listPendingRestarts(): Array<{ flagId: string; running: FlagState; saved: FlagState }> {
    const pending: Array<{ flagId: string; running: FlagState; saved: FlagState }> = [];
    for (const [flagId, saved] of this._pendingRestart) {
      pending.push({ flagId, running: this._states.get(flagId) as FlagState, saved });
    }
    return pending;
  }

  /**
   * Returns a copy of the ordered audit log of flag state transitions
   * recorded in this process lifetime; once more than
   * {@link MAX_RECORDED_TRANSITIONS} have happened, only the latest are kept.
   */
  getTransitions(): readonly FlagTransition[] {
    return [...this._transitions];
  }

  // ── Config integration ──────────────────────────────────────────────────

  /**
   * Applies flag state overrides from the user config layer.
   *
   * - Unknown flag ids are rejected so stale configs cannot hide misspelled gates.
   *
   * This is the boot-time path, called once, before the runtime event loop
   * begins, so it applies EVERY flag's desired state directly regardless of
   * `runtimeToggleable` (a startup-only flag may only be seeded this way).
   * For a config change arriving after boot, use `applyConfigState()`
   * instead, which respects `runtimeToggleable` and never fakes a live apply
   * for a startup-gated flag.
   *
   * @param config - Parsed flag config block from the user config file.
   */
  loadFromConfig(config: FlagConfig): void {
    for (const [id, desiredState] of Object.entries(config.flags)) {
      const flag = FEATURE_FLAG_MAP.get(id);
      if (flag === undefined) {
        throw new Error(`[FeatureFlagManager] Unknown flag in config: "${id}"`);
      }
      this._applyPersistedState(id, desiredState);
    }
  }

  /**
   * Applies a single flag's config-layer value from a LIVE config change
   * (i.e. `configManager.set('featureFlags.<id>', ...)` firing after boot,
   * see `bindFeatureFlagConfigBridge`), honoring `runtimeToggleable`:
   *
   * - Runtime-toggleable flags apply immediately, and subscribers fire.
   * - Startup-gated flags are never faked live: the effective state is left
   *   untouched and the persisted value is recorded as pending a restart
   *   (see `getAll()` / `hasPendingRestart()` / `getPendingRestartState()`)
   *   instead of silently doing nothing.
   *
   * @param flagId - The flag's kebab-case identifier.
   * @param persistedState - The new value read from config.
   */
  applyConfigState(flagId: string, persistedState: FlagState): void {
    const flag = this._requireFlag(flagId);
    const current = this._states.get(flagId) as FlagState;

    if (!flag.runtimeToggleable) {
      if (persistedState === current) {
        this._pendingRestart.delete(flagId);
      } else {
        this._pendingRestart.set(flagId, persistedState);
      }
      return;
    }

    this._pendingRestart.delete(flagId);
    this._applyPersistedState(flagId, persistedState);
  }

  /**
   * Shared transition logic for a single flag's desired config-layer state,
   * used by both `loadFromConfig()` (every flag, at boot) and
   * `applyConfigState()` (one flag, already gated on `runtimeToggleable` by
   * its caller). Idempotent.
   */
  private _applyPersistedState(id: string, desiredState: FlagState): void {
    const current = this._states.get(id) as FlagState;
    if (current === desiredState) return; // already correct, skip
    this._transition(id, current, desiredState);
  }

  // ── Subscriptions ───────────────────────────────────────────────────────

  /**
   * Subscribes to flag state changes.
   *
   * The callback fires synchronously when a flag transitions state.
   * Callbacks must not throw, errors are caught and logged to stderr.
   *
   * @param callback - Called with `(flagId, newState, previousState)`.
   * @returns An unsubscribe function; call it to remove the subscription.
   */
  subscribe(callback: FlagSubscriber): () => void {
    this._subscribers.add(callback);
    return () => {
      this._subscribers.delete(callback);
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Validates that a flag exists and returns its declaration.
   * Throws a clear error if the id is unknown.
   */
  private _requireFlag(flagId: string): FeatureFlag {
    const flag = FEATURE_FLAG_MAP.get(flagId);
    if (flag === undefined) {
      throw new Error(`[FeatureFlagManager] Unknown flag: "${flagId}"`);
    }
    return flag;
  }

  /**
   * Records a state transition, updates `_states`, writes the audit log entry,
   * and notifies all subscribers.
   */
  private _transition(
    flagId: string,
    previous: FlagState,
    next: FlagState,
  ): void {
    this._publicationRevision++;
    this._states.set(flagId, next);

    const entry: FlagTransition = {
      flagId,
      previous,
      next,
      timestamp: Date.now(),
    };
    this._transitions.push(entry);
    if (this._transitions.length > MAX_RECORDED_TRANSITIONS) this._transitions.shift();

    for (const subscriber of this._subscribers) {
      try {
        subscriber(flagId, next, previous);
      } catch (err) {
        process.stderr.write(
          `[FeatureFlagManager] Subscriber error for flag "${flagId}": ${
            summarizeError(err)
          }\n`,
        );
      }
    }
  }
}

/**
 * Construct a fresh feature-flag manager.
 *
 * Keeping this factory in the same module as the class avoids test-runner
 * namespace quirks around cross-module construction while preserving the same
 * runtime behavior.
 */
export { FeatureFlagManagerImpl as FeatureFlagManager };

export function createFeatureFlagManager(): FeatureFlagManagerImpl {
  return new FeatureFlagManagerImpl();
}
