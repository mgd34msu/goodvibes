/**
 * Policy-as-Code registry.
 *
 * Manages versioned policy bundles with promote/rollback semantics.
 * Enforces the rule that no bundle may move to enforcement without
 * prior simulation evidence and a passing divergence gate.
 *
 * Bundle lifecycle (declared once in `policyBundleLifecycle` below):
 *   loaded → simulating → promoting (gate check) → active (enforced)
 *   A failed simulation returns the candidate to `loaded`; a candidate with
 *   evidence can be simulated again. An active bundle becomes `superseded`
 *   when another is promoted (and can be restored by rollback) or
 *   `rolled-back` when rollback replaces it.
 *
 * At any time:
 *   - `current`  , the bundle whose rules are actively enforced
 *   - `candidate`, a loaded bundle awaiting simulation before promotion
 *   - `history`  , previous active bundles, kept for rollback
 */

import type { PolicyRule } from './types.js';
import type { SignedPolicyBundle } from './policy-signer.js';
import type { PolicyBundlePayload, BundleProvenance, PolicyLoadResult, PolicyLoaderOptions } from './policy-loader.js';
import { loadPolicyBundle } from './policy-loader.js';
import type { DivergenceReport, SimulationMode } from './types.js';
import type { EnforceGateResult } from './divergence-dashboard.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import { revisionSource, type RevisionSource } from '../../utils/revision.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { writeDocument } from '../../utils/atomic-json-store.js';
import { summarizeError } from '../../utils/error-display.js';

// ── Registry types ─────────────────────────────────────────────────────────────

/**
 * Lifecycle state of a policy bundle version.
 *
 * - `loaded`    , Bundle loaded as candidate; not yet simulated.
 * - `simulating`, Simulation pipeline is active; divergence being collected.
 * - `promoting` , Gate check in progress; simulation evidence collected.
 * - `active`    , Bundle is the enforced policy.
 * - `superseded`, Bundle was enforced until another was promoted; rollback can restore it.
 * - `rolled-back`: Bundle was replaced by a rollback operation.
 */
export type BundleLifecycleState =
  | 'loaded'
  | 'simulating'
  | 'promoting'
  | 'active'
  | 'superseded'
  | 'rolled-back';

const policyBundleLifecycle = defineLifecycle<BundleLifecycleState>('Policy bundle', {
  loaded: ['simulating'],
  simulating: ['promoting', 'loaded'],
  promoting: ['simulating', 'active'],
  active: ['superseded', 'rolled-back'],
  superseded: ['active'],
  'rolled-back': [],
});

/**
 * A versioned policy bundle entry in the registry.
 */
export interface PolicyBundleVersion {
  /** The signed bundle as loaded from disk/inline. */
  bundle: SignedPolicyBundle<PolicyBundlePayload>;
  /** Provenance record from the loader. */
  provenance: BundleProvenance;
  /** The extracted rules (only populated when load succeeded). */
  rules: PolicyRule[];
  /** Lifecycle state for this version. */
  state: BundleLifecycleState;
  /** ISO 8601 timestamp when this version was loaded. */
  loadedAt: string;
  /** ISO 8601 timestamp when this version became active, if ever. */
  activatedAt?: string | undefined;
  /** ISO 8601 timestamp when this version was rolled back, if applicable. */
  rolledBackAt?: string | undefined;
  /** Simulation report collected before promotion, if any. */
  simulationReport?: DivergenceReport | undefined;
  /** The gate result that was evaluated at promotion time, if any. */
  gateResult?: EnforceGateResult | undefined;
}

/**
 * Result of a diff between two policy bundle versions.
 */
export interface PolicyDiffResult {
  /** ID of the "from" bundle (current or named). */
  fromBundleId: string;
  /** ID of the "to" bundle (candidate or named). */
  toBundleId: string;
  /** Rules present in `from` but not in `to` (removed). */
  removed: PolicyRule[];
  /** Rules present in `to` but not in `from` (added). */
  added: PolicyRule[];
  /** Rules whose `id` matches but whose payload differs. */
  changed: Array<{ ruleId: string; from: PolicyRule; to: PolicyRule }>;
  /** Rules identical in both bundles. */
  unchanged: PolicyRule[];
  /** Total count of changed rules (added + removed + modified). */
  totalChanges: number;
}

/**
 * Result of a promote operation.
 */
export interface PromoteResult {
  /** Whether the promotion succeeded. */
  ok: boolean;
  /** The gate result evaluated at promotion time. */
  gate?: EnforceGateResult | undefined;
  /** Human-readable explanation when promotion is blocked. */
  error?: string | undefined;
  /** The bundle that was promoted, if successful. */
  bundleId?: string | undefined;
  /** Set when the promotion holds now but was not recorded for the next start. */
  notice?: string | undefined;
}

/**
 * Result of a rollback operation.
 */
/** What the activation record keeps about the active bundle. */
interface ActivationRecord {
  readonly bundleId: string;
  readonly payloadHash: string;
  readonly activatedAt: string;
}

/** A hash of a bundle's payload, so a changed file is told apart from the one promoted. */
function payloadHash(bundle: SignedPolicyBundle<PolicyBundlePayload>): string {
  return createHash('sha256').update(JSON.stringify(bundle.payload)).digest('hex');
}

export interface RollbackResult {
  /** Whether the rollback succeeded. */
  ok: boolean;
  /** The bundle ID restored to active state. */
  restoredBundleId?: string | undefined;
  /** Human-readable error when rollback fails. */
  error?: string | undefined;
  /** Set when the rollback holds now but was not recorded for the next start. */
  notice?: string | undefined;
}

/**
 * Configuration for the PolicyRegistry.
 */
export interface PolicyRegistryConfig {
  /**
   * Maximum number of historical (non-active) bundle versions to retain.
   * Oldest entries are dropped when the limit is exceeded.
   * Defaults to 10.
   */
  maxHistorySize?: number | undefined;
  /**
   * Options forwarded to `loadPolicyBundle()` for every bundle load.
   */
  loaderOptions?: PolicyLoaderOptions | undefined;
}

// ── PolicyRegistry ─────────────────────────────────────────────────────────────

/**
 * PolicyRegistry, Versioned policy bundle manager.
 *
 * Maintains the full bundle lifecycle: loaded → simulating → promoting → active.
 * Enforces that promotion to `active` (enforcement mode) requires:
 *   1. A simulation report to have been attached (evidence of simulation).
 *   2. The divergence gate to be passing (rate below threshold).
 *
 * Usage:
 * ```ts
 * const registry = new PolicyRegistry();
 *
 * // Load a new candidate bundle
 * const loadResult = registry.loadCandidate(signedBundle);
 *
 * // After simulation, attach the report
 * registry.attachSimulationReport(divergenceReport, gateResult);
 *
 * // Promote when gate passes
 * const promoteResult = registry.promote();
 *
 * // Rollback if something goes wrong
 * registry.rollback();
 * ```
 */
export class PolicyRegistry {
  private _current: PolicyBundleVersion | null = null;
  private _candidate: PolicyBundleVersion | null = null;
  private _history: PolicyBundleVersion[] = [];
  private _publicationRevision = 0;
  private _activationRecordPath: string | undefined;

  public readonly DEFAULT_HISTORY_SIZE = 10;

  private readonly _maxHistorySize: number;
  private readonly _loaderOptions: PolicyLoaderOptions;

  constructor(config: PolicyRegistryConfig = {}) {
    this._maxHistorySize = config.maxHistorySize ?? this.DEFAULT_HISTORY_SIZE;
    this._loaderOptions = config.loaderOptions ?? {};
  }

  // ── Loading ──────────────────────────────────────────────────────────────────

  /**
   * loadCandidate, Load a signed policy bundle as the pending candidate.
   *
   * Replaces any existing candidate. The candidate must be simulated and
   * have its gate checked before it can be promoted to active.
   *
   * @param bundle , The signed bundle to load.
   * @returns `PolicyLoadResult` indicating success or validation failure.
   */
  public loadCandidate(
    bundle: SignedPolicyBundle<PolicyBundlePayload>,
  ): PolicyLoadResult {
    const result = loadPolicyBundle(bundle, this._loaderOptions);

    if (!result.ok) {
      return result;
    }

    const version: PolicyBundleVersion = {
      bundle,
      provenance: result.provenance,
      rules: result.rules ?? [],
      state: 'loaded',
      loadedAt: new Date().toISOString(),
    };

    this._publicationRevision++;
    this._candidate = version;
    return result;
  }

  // ── Simulation evidence ───────────────────────────────────────────────────────

  /**
   * markSimulating, Transition candidate to `simulating` state.
   *
   * Called by the `/policy simulate` command when a simulation pipeline
   * is started. A `loaded` candidate starts its first simulation; a
   * `promoting` candidate is simulated again and its earlier evidence is
   * dropped, so promotion always reads the newest run.
   *
   * @returns true if the state was successfully advanced.
   */
  public markSimulating(): boolean {
    if (!this._candidate || !policyBundleLifecycle.can(this._candidate.state, 'simulating')) {
      return false;
    }
    this._publicationRevision++;
    this._candidate = { ...this._candidate, state: 'simulating', simulationReport: undefined, gateResult: undefined };
    return true;
  }

  /**
   * abandonSimulation, Return a `simulating` candidate to `loaded` when its
   * simulation failed or its results were discarded, so it can be simulated
   * again instead of staying stuck.
   *
   * @returns true if the candidate was returned to `loaded`.
   */
  public abandonSimulation(): boolean {
    if (!this._candidate || this._candidate.state !== 'simulating') {
      return false;
    }
    this._publicationRevision++;
    this._candidate = { ...this._candidate, state: 'loaded' };
    return true;
  }

  /**
   * Why the candidate cannot move to `to` right now, in the lifecycle's own
   * words ("Policy bundle is X and cannot become Y; from X it can become …"),
   * or null when the move is legal.
   */
  public describeCandidateRefusal(to: BundleLifecycleState): string | null {
    if (!this._candidate) return null;
    const check = policyBundleLifecycle.check(this._candidate.state, to);
    return check.ok ? null : check.reason;
  }

  /**
   * attachSimulationReport, Attach divergence report and gate result to candidate.
   *
   * Advances the candidate to `promoting` state, which is a prerequisite for
   * calling `promote()`.
   *
   * @param report    , The divergence report from the simulation run.
   * @param gateResult, The gate evaluation at report time.
   * @returns true if the evidence was attached.
   */
  public attachSimulationReport(
    report: DivergenceReport,
    gateResult: EnforceGateResult,
  ): boolean {
    if (!this._candidate || this._candidate.state !== 'simulating') {
      return false;
    }
    this._publicationRevision++;
    this._candidate = {
      ...this._candidate,
      state: 'promoting',
      simulationReport: report,
      gateResult,
    };
    return true;
  }

  // ── Promotion ─────────────────────────────────────────────────────────────────

  /**
   * promote, Promote the candidate bundle to active enforcement.
   *
   * Blocked unless:
   *   - A candidate exists in `promoting` state (simulation evidence attached).
   *   - The attached gate result is `passing`.
   *
   * On success, the previous active bundle moves to history.
   *
   * @param force, Skip gate check. Use only for testing; not for production use.
   */
  public promote(force = false): PromoteResult {
    if (!this._candidate) {
      return { ok: false, error: 'No candidate bundle loaded.' };
    }

    if (this._candidate.state === 'loaded') {
      return {
        ok: false,
        error:
          'Candidate has not been simulated. Run `/policy simulate` first to collect divergence evidence.',
      };
    }

    if (this._candidate.state === 'simulating') {
      return {
        ok: false,
        error:
          'Simulation is in progress. Wait for `/policy simulate` to finish, then promote.',
      };
    }

    const check = policyBundleLifecycle.check(this._candidate.state, 'active');
    if (!check.ok) {
      return { ok: false, error: `${check.reason}.` };
    }

    const gateResult = this._candidate.gateResult;
    if (!gateResult) {
      throw new Error(
        'Invariant violation: candidate is in "promoting" state but gateResult is missing. ' +
        'attachSimulationReport() must be called before promote().',
      );
    }

    if (!force && gateResult.status === 'blocked') {
      const rateStr = gateResult.divergenceRate !== undefined
        ? `${(gateResult.divergenceRate * 100).toFixed(1)}%`
        : 'unknown';
      return {
        ok: false,
        gate: gateResult,
        error:
          `Promotion blocked: divergence gate is "${gateResult.status}" ` +
          `(rate ${rateStr} exceeds threshold ` +
          `${(gateResult.threshold * 100).toFixed(1)}%). ` +
          `Change the candidate's rules and load it again, run \`/policy simulate\` again, ` +
          `or promote with --force to override the gate.`,
      };
    }

    const now = new Date().toISOString();

    // Archive the current active bundle; rollback can restore it.
    if (this._current) {
      this._archiveVersion({ ...this._current, state: 'superseded' });
    }

    // Promote candidate to active
    this._current = {
      ...this._candidate,
      state: 'active',
      activatedAt: now,
    };

    this._candidate = null;
    this._publicationRevision++;
    const recorded = this._recordActivation();

    return {
      ok: true,
      gate: gateResult,
      bundleId: this._current.bundle.bundleId,
      ...(recorded ? { notice: recorded } : {}),
    };
  }

  // ── Activation across restarts ──────────────────────────────────────────────────

  /**
   * Where promote and rollback record which bundle is active (its id, a hash of
   * its payload and when it became active), so the next start restores the same
   * enforcement. Bound by the host that loads the configured bundle.
   */
  public bindActivationRecord(path: string): void {
    this._activationRecordPath = path;
  }

  /**
   * At start, after the configured bundle was loaded as the candidate: make it
   * active again when it is the bundle promoted before, unchanged. A record for
   * the same bundle id whose payload differs is not restored and says why.
   */
  public restoreActivation(): { readonly restored: boolean; readonly reason?: string | undefined } {
    const path = this._activationRecordPath;
    const candidate = this._candidate;
    if (!path || !candidate || this._current) return { restored: false };
    let record: ActivationRecord | null = null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ActivationRecord> | null;
      if (parsed && typeof parsed.bundleId === 'string' && typeof parsed.payloadHash === 'string') record = parsed as ActivationRecord;
    } catch { return { restored: false }; }
    if (!record || record.bundleId !== candidate.bundle.bundleId) return { restored: false };
    if (record.payloadHash !== payloadHash(candidate.bundle)) {
      return { restored: false, reason: `policy bundle "${record.bundleId}" was promoted, but its rules changed on disk since; it is loaded as a candidate only. Run /policy simulate, then /policy promote, to enforce it again.` };
    }
    this._current = { ...candidate, state: 'active', activatedAt: typeof record.activatedAt === 'string' ? record.activatedAt : new Date().toISOString() };
    this._candidate = null;
    this._publicationRevision++;
    return { restored: true };
  }

  /** Write the activation record; returns a sentence when it could not be kept. */
  private _recordActivation(): string | undefined {
    const path = this._activationRecordPath;
    const current = this._current;
    if (!path || !current) return undefined;
    try {
      writeDocument(path, { bundleId: current.bundle.bundleId, payloadHash: payloadHash(current.bundle), activatedAt: current.activatedAt ?? new Date().toISOString() } satisfies ActivationRecord);
      return undefined;
    } catch (error) {
      return `The active policy could not be recorded (${summarizeError(error)}); after a restart the bundle is loaded as a candidate and must be promoted again.`;
    }
  }

  // ── Rollback ──────────────────────────────────────────────────────────────────

  /**
   * rollback, Restore the previous active bundle.
   *
   * Moves the current active bundle to history and restores the most recent
   * previously-active bundle from history.
   *
   * @returns `RollbackResult` indicating success or failure.
   */
  public rollback(): RollbackResult {
    const previous = this._history.findLast((v) => v.state === 'superseded');

    if (!previous) {
      return {
        ok: false,
        error: 'No previous bundle version available for rollback.',
      };
    }

    const now = new Date().toISOString();

    // Archive current active bundle as rolled-back
    if (this._current) {
      this._archiveVersion({ ...this._current, state: 'rolled-back', rolledBackAt: now });
    }

    // Remove the restored version from history and set as current
    this._history = this._history.filter((v) => v !== previous);
    this._current = { ...previous, state: 'active', activatedAt: now };
    this._publicationRevision++;
    const recorded = this._recordActivation();

    return {
      ok: true,
      restoredBundleId: this._current.bundle.bundleId,
      ...(recorded ? { notice: recorded } : {}),
    };
  }

  // ── Diff ──────────────────────────────────────────────────────────────────────

  /**
   * diff, Produce a structural diff between two bundle rule sets.
   *
   * Compares `from` (defaults to current active) and `to` (defaults to candidate).
   * Rules are matched by `id` field.
   *
   * @param fromRules, Override the "from" rule set (defaults to current active).
   * @param toRules  , Override the "to" rule set (defaults to candidate).
   */
  public diff(
    fromRules?: PolicyRule[],
    toRules?: PolicyRule[],
  ): PolicyDiffResult | null {
    const from = fromRules ?? this._current?.rules;
    const to = toRules ?? this._candidate?.rules;

    if (!from || !to) {
      return null;
    }

    const fromId = this._current?.bundle.bundleId ?? 'unknown';
    const toId = this._candidate?.bundle.bundleId ?? 'unknown';

    const fromMap = new Map(from.map((r) => [r.id, r]));
    const toMap = new Map(to.map((r) => [r.id, r]));

    const removed: PolicyRule[] = [];
    const added: PolicyRule[] = [];
    const changed: Array<{ ruleId: string; from: PolicyRule; to: PolicyRule }> = [];
    const unchanged: PolicyRule[] = [];

    for (const [id, fromRule] of fromMap) {
      const toRule = toMap.get(id);
      if (!toRule) {
        removed.push(fromRule);
      // Safe: PolicyRule objects are constructed uniformly with consistent key ordering
      // (all shapes extend BaseRule and are created only through controlled factory paths),
      // so JSON.stringify produces a stable, deterministic representation for deep equality.
      } else if (JSON.stringify(fromRule) !== JSON.stringify(toRule)) {
        changed.push({ ruleId: id, from: fromRule, to: toRule });
      } else {
        unchanged.push(fromRule);
      }
    }

    for (const [id, toRule] of toMap) {
      if (!fromMap.has(id)) {
        added.push(toRule);
      }
    }

    return {
      fromBundleId: fromId,
      toBundleId: toId,
      removed,
      added,
      changed,
      unchanged,
      totalChanges: added.length + removed.length + changed.length,
    };
  }

  // ── Accessors ─────────────────────────────────────────────────────────────────

  /** Returns the currently active bundle version, or null if none loaded. */
  public getCurrent(): PolicyBundleVersion | null {
    return this._current;
  }

  /** Only successful enforcement publications advance this lifetime. */
  public getPublicationRevision(): number { return this._publicationRevision; }

  /** The publication revision as a revision source: load, simulate, promote and rollback move it. */
  public get revisionSource(): RevisionSource { return this.#revisionSource; }
  readonly #revisionSource = revisionSource('policy bundle', () => this._publicationRevision);

  /** Returns the candidate bundle version, or null if none loaded. */
  public getCandidate(): PolicyBundleVersion | null {
    return this._candidate;
  }

  /** Returns the bundle history (previous active bundles), oldest first. */
  public getHistory(): PolicyBundleVersion[] {
    return [...this._history];
  }

  /**
   * getSimulationMode, Returns the recommended simulation mode based on
   * whether the candidate has simulation evidence.
   *
   * This is a hint for the command handler; callers choose the actual mode.
   */
  public getSimulationMode(): SimulationMode {
    if (!this._candidate) return 'simulation-only';
    if (this._candidate.state === 'loaded') return 'simulation-only';
    return 'warn-on-divergence';
  }

  // ── Private helpers ───────────────────────────────────────────────────────────

  private _archiveVersion(version: PolicyBundleVersion): void {
    this._history.push(version);
    // Trim to max history size (keep most recent)
    if (this._history.length > this._maxHistorySize) {
      this._history = this._history.slice(-this._maxHistorySize);
    }
  }
}
