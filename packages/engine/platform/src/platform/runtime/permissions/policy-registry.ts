/**
 * Policy-as-Code registry.
 *
 * Manages versioned policy bundles with promote/rollback semantics.
 * Enforces the rule that no bundle moves to enforcement before the operator
 * has seen what it changes: the rule diff and the recorded calls it decides
 * differently (`/security simulate-policy`), confirmed by promoting.
 *
 * Bundle lifecycle (declared once in `policyBundleLifecycle` below):
 *   loaded → simulating → promoting (impact shown) → active (enforced)
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
import type { SimulationMode } from './types.js';
import type { PolicyImpact } from './policy-impact.js';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import { revisionSource, type RevisionSource } from '../../utils/revision.js';
import { contentDigest } from '../../utils/target-ref.js';
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
  /** What the candidate would decide differently on this installation's recorded calls, from `/security simulate-policy`. */
  impact?: PolicyImpact | undefined;
  /** The absolute path the bundle was read from, when it came from a file: the activation record names it. */
  sourcePath?: string | undefined;
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
  /** Rules found at a different position (rules are evaluated in order, so a move can change which one decides). */
  moved: Array<{ ruleId: string; from: number; to: number }>;
  /** Ids used by more than one rule in a bundle: each copy is compared at its own position, never collapsed. */
  duplicateIds: Array<{ ruleId: string; bundle: 'from' | 'to'; count: number }>;
  /** Total count of changed rules (added + removed + modified). */
  totalChanges: number;
}

/**
 * Result of a promote operation.
 */
export interface PromoteResult {
  /** Whether the promotion succeeded. */
  ok: boolean;
  /** The impact the operator confirmed. */
  impact?: PolicyImpact | undefined;
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
/** Which bundle is active, as promote and rollback record it for the next start. */
export interface PolicyActivationRecord {
  readonly bundleId: string;
  readonly payloadHash: string;
  readonly activatedAt: string;
  /** The file the active bundle was read from; the next start reads this one, not the configured path, when they differ. */
  readonly bundlePath?: string | undefined;
}

/** A hash of a bundle's payload, so a changed file is told apart from the one promoted. */
function payloadHash(bundle: SignedPolicyBundle<PolicyBundlePayload>): string {
  return contentDigest(bundle.payload);
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
 * Enforces that promotion to `active` (enforcement mode) requires the
 * candidate's impact on this installation's recorded calls to have been
 * attached and shown.
 *
 * Usage:
 * ```ts
 * const registry = new PolicyRegistry();
 *
 * // Load a new candidate bundle
 * const loadResult = registry.loadCandidate(signedBundle);
 *
 * // After review, attach what it would change
 * registry.attachImpact(policyImpact({ currentRules, candidateRules, projectRoot, calls }));
 *
 * // Promote: the operator confirms that list
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
    options: { readonly sourcePath?: string | undefined } = {},
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
      ...(options.sourcePath !== undefined ? { sourcePath: options.sourcePath } : {}),
    };

    this._publicationRevision++;
    this._candidate = version;
    return result;
  }

  // ── Simulation evidence ───────────────────────────────────────────────────────

  /**
   * markSimulating, Transition candidate to `simulating` state.
   *
   * Called by the `/security simulate-policy` command when a simulation pipeline
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
    this._candidate = { ...this._candidate, state: 'simulating', impact: undefined };
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
   * Attach what the candidate would change (the recorded calls it decides
   * differently) and move it to `promoting`, the state promotion requires.
   */
  public attachImpact(impact: PolicyImpact): boolean {
    if (!this._candidate || this._candidate.state !== 'simulating') {
      return false;
    }
    this._publicationRevision++;
    this._candidate = { ...this._candidate, state: 'promoting', impact };
    return true;
  }

  // ── Promotion ─────────────────────────────────────────────────────────────────

  /**
   * promote, Promote the candidate bundle to active enforcement.
   *
   * Requires a candidate in `promoting` state: `/security simulate-policy` showed the
   * operator the rule diff and the recorded calls it decides differently, and
   * the operator confirms that list by promoting. There is no threshold: a
   * bundle exists to decide differently.
   *
   * On success, the previous active bundle moves to history.
   */
  public promote(): PromoteResult {
    if (!this._candidate) {
      return { ok: false, error: 'No candidate bundle loaded.' };
    }

    if (this._candidate.state === 'loaded') {
      return {
        ok: false,
        error:
          'The candidate has not been reviewed. "See what the candidate policy changes" (Permissions and safety, Policy) shows which recorded calls it would decide differently first.',
      };
    }

    if (this._candidate.state === 'simulating') {
      return {
        ok: false,
        error:
          'The candidate is still being reviewed. Enforce it once "See what the candidate policy changes" has finished.',
      };
    }

    const check = policyBundleLifecycle.check(this._candidate.state, 'active');
    if (!check.ok) {
      return { ok: false, error: `${check.reason}.` };
    }

    const impact = this._candidate.impact;
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
      ...(impact ? { impact } : {}),
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
    const record = this.readActivationRecord();
    if (record === 'unreadable') {
      return { restored: false, reason: `the record of which policy bundle was active (${path}) could not be read, so "${candidate.bundle.bundleId}" is loaded as a candidate only. To enforce it, "See what the candidate policy changes", then "Enforce the candidate policy" (Permissions and safety, Policy).` };
    }
    if (!record) return { restored: false };
    if (record.bundleId !== candidate.bundle.bundleId) {
      return { restored: false, reason: `policy bundle "${record.bundleId}" was the active one${record.bundlePath ? ` (${record.bundlePath})` : ''}, but "${candidate.bundle.bundleId}" was loaded at start; it is a candidate only and "${record.bundleId}" is not enforced. Load and promote the bundle you want enforced.` };
    }
    if (record.payloadHash !== payloadHash(candidate.bundle)) {
      return { restored: false, reason: `policy bundle "${record.bundleId}" was promoted, but its rules changed on disk since; it is loaded as a candidate only. To enforce it again, "See what the candidate policy changes", then "Enforce the candidate policy" (Permissions and safety, Policy).` };
    }
    this._current = { ...candidate, state: 'active', activatedAt: typeof record.activatedAt === 'string' ? record.activatedAt : new Date().toISOString() };
    this._candidate = null;
    this._publicationRevision++;
    return { restored: true };
  }

  /**
   * A program's copy of the one activation record (the daemon's, every program follows it): when the record names a
   * bundle other than the one in force here, that bundle, read from the file the record names and unchanged since,
   * becomes the one this registry enforces. The candidate and the history are the daemon's and are not touched. Read
   * at start and again each time the daemon announces a change; nothing waits on a clock. Answers whether the bundle
   * in force changed, and a sentence when the record could not be followed (the bundle in force stays as it was).
   */
  public followActivation(): { readonly changed: boolean; readonly problem?: string | undefined } {
    const path = this._activationRecordPath;
    if (!path) return { changed: false };
    const record = this.readActivationRecord();
    if (record === null) return { changed: false };
    if (record === 'unreadable') return { changed: false, problem: `the record of which policy is in force (${path}) could not be read; the policy in force here is unchanged` };
    const current = this._current;
    if (current && current.bundle.bundleId === record.bundleId && payloadHash(current.bundle) === record.payloadHash) return { changed: false };
    if (!record.bundlePath) return { changed: false, problem: `policy bundle "${record.bundleId}" is in force, but the record names no file to read it from; the policy in force here is unchanged` };
    let bundle: SignedPolicyBundle<PolicyBundlePayload>;
    try {
      bundle = JSON.parse(readFileSync(record.bundlePath, 'utf-8')) as SignedPolicyBundle<PolicyBundlePayload>;
    } catch (error) {
      return { changed: false, problem: `policy bundle "${record.bundleId}" is in force, but its file ${record.bundlePath} could not be read (${summarizeError(error)}); the policy in force here is unchanged` };
    }
    if (bundle?.bundleId !== record.bundleId || payloadHash(bundle) !== record.payloadHash) {
      return { changed: false, problem: `policy bundle "${record.bundleId}" is in force, but its file ${record.bundlePath} changed since it was enforced; the policy in force here is unchanged` };
    }
    const loaded = loadPolicyBundle(bundle, this._loaderOptions);
    if (!loaded.ok) return { changed: false, problem: `policy bundle "${record.bundleId}" could not be loaded here (${loaded.error ?? 'no reason given'}); the policy in force here is unchanged` };
    this._current = {
      bundle, provenance: loaded.provenance, rules: loaded.rules ?? [], state: 'active', loadedAt: new Date().toISOString(),
      activatedAt: typeof record.activatedAt === 'string' ? record.activatedAt : new Date().toISOString(), sourcePath: record.bundlePath,
    };
    this._publicationRevision++;
    return { changed: true };
  }

  /**
   * The activation record as written, null when there is none, 'unreadable'
   * when one is there and cannot be read. The host reads it at start to load
   * the bundle that was active (its path) before the configured one.
   */
  public readActivationRecord(): PolicyActivationRecord | null | 'unreadable' {
    const path = this._activationRecordPath;
    if (!path) return null;
    let text: string;
    try { text = readFileSync(path, 'utf-8'); }
    catch (error) { return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? null : 'unreadable'; }
    try {
      const parsed = JSON.parse(text) as Partial<PolicyActivationRecord> | null;
      if (parsed && typeof parsed.bundleId === 'string' && typeof parsed.payloadHash === 'string') return parsed as PolicyActivationRecord;
    } catch { /* falls through */ }
    return 'unreadable';
  }

  /** Write the activation record; returns a sentence when it could not be kept. */
  private _recordActivation(): string | undefined {
    const path = this._activationRecordPath;
    const current = this._current;
    if (!path || !current) return undefined;
    try {
      writeDocument(path, { bundleId: current.bundle.bundleId, payloadHash: payloadHash(current.bundle), activatedAt: current.activatedAt ?? new Date().toISOString(),
        ...(current.sourcePath !== undefined ? { bundlePath: current.sourcePath } : {}) } satisfies PolicyActivationRecord);
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

    // Rules are matched by (id, occurrence): the n-th rule with an id in one
    // bundle against the n-th with that id in the other. A duplicated id is
    // reported as such, and each copy is compared; nothing collapses into one.
    const keyed = (rules: readonly PolicyRule[]): Map<string, { rule: PolicyRule; position: number }> => {
      const seen = new Map<string, number>();
      const out = new Map<string, { rule: PolicyRule; position: number }>();
      rules.forEach((rule, position) => {
        const occurrence = seen.get(rule.id) ?? 0;
        seen.set(rule.id, occurrence + 1);
        out.set(`${rule.id}\u0000${occurrence}`, { rule, position });
      });
      return out;
    };
    const duplicates = (rules: readonly PolicyRule[], bundle: 'from' | 'to'): Array<{ ruleId: string; bundle: 'from' | 'to'; count: number }> => {
      const counts = new Map<string, number>();
      for (const rule of rules) counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1);
      return [...counts].filter(([, count]) => count > 1).map(([ruleId, count]) => ({ ruleId, bundle, count }));
    };
    const fromMap = keyed(from);
    const toMap = keyed(to);

    const removed: PolicyRule[] = [];
    const added: PolicyRule[] = [];
    const changed: Array<{ ruleId: string; from: PolicyRule; to: PolicyRule }> = [];
    const unchanged: PolicyRule[] = [];
    const moved: Array<{ ruleId: string; from: number; to: number }> = [];

    for (const [key, entry] of fromMap) {
      const toEntry = toMap.get(key);
      if (!toEntry) {
        removed.push(entry.rule);
      } else if (contentDigest(entry.rule) !== contentDigest(toEntry.rule)) {
        changed.push({ ruleId: entry.rule.id, from: entry.rule, to: toEntry.rule });
      } else {
        unchanged.push(entry.rule);
      }
      if (toEntry && toEntry.position !== entry.position) moved.push({ ruleId: entry.rule.id, from: entry.position, to: toEntry.position });
    }

    for (const [key, entry] of toMap) {
      if (!fromMap.has(key)) {
        added.push(entry.rule);
      }
    }

    return {
      fromBundleId: fromId,
      toBundleId: toId,
      removed,
      added,
      changed,
      unchanged,
      moved,
      duplicateIds: [...duplicates(from, 'from'), ...duplicates(to, 'to')],
      totalChanges: added.length + removed.length + changed.length + moved.length,
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
