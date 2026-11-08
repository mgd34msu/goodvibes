/** Durable payment accounting. Missing state is an unused ledger; damaged or
 * unsupported state disables budget operations without taking down the daemon.
 * Never discard accounting entries and then offer their money again.
 *
 * Checkout holds persist until a known-safe release or commit. Version 1 holds
 * upgrade conservatively because their records did not distinguish temporary
 * reservations from unresolved checkouts. New schema 2 stores that distinction.
 * A failed post-charge write keeps the spend in memory and retries persistence;
 * its on-disk checkout hold remains protected if the process dies first.
 */
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { drainOwned } from '@goodvibes-jev/judgment';
import { readFileObservation } from '../../utils/file-observation.js';
import { logger } from '../../utils/logger.js';
import { BudgetLedger } from '../budget.js';
import type {
  BudgetLimits,
  BudgetReservation,
  BudgetStateSnapshot,
  SpendRecord,
  PoolSnapshot,
} from '../budget.js';

const BUDGET_FILE_VERSION = 2;

interface BudgetFile {
  readonly version: number;
  readonly spend: readonly SpendRecord[];
  readonly reservations: readonly BudgetReservation[];
}

/**
 * Whether `value` is an exact non-negative integer amount in minor units.
 *
 * A pool total is a running sum of every entry that passes this check
 * (`BudgetLedger.snapshot`, budget.ts), so one entry that is not a real,
 * bounded number poisons the whole day's total: a negative amount inflates
 * what looks spent into what looks remaining, and `Infinity` or `NaN` (which
 * `1e999` parses to under `JSON.parse`) turns "remaining" into a value no
 * comparison against a limit can ever refuse. `typeof value === 'number'`
 * alone accepts both. Safe integer validation also rejects fractional minor
 * units and values too large to represent exactly.
 */
function isFiniteNonNegativeAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Whether `value` is a real millisecond timestamp `Date` can hold.
 *
 * The amount guard above (`isFiniteNonNegativeAmount`) never applied to
 * `atMs`/`createdAtMs`/`expiresAtMs`: those fields were only checked with a
 * bare `typeof value === 'number'`, which accepts `Infinity` and `NaN` the
 * same way an unchecked amount did. A timestamp that parses to `Infinity`
 * (`1e999`, valid JSON number syntax) or that is simply out of the range
 * `Date` can represent (`8.64e15` is `Date`'s own documented maximum) does not
 * fail loudly where an amount would: it passes `loadInitialState` and then
 * throws a `RangeError` out of `Intl.DateTimeFormat`/`Date` formatting the
 * first time `snapshot()` or `reserve()` computes a day key from it (`day.ts`),
 * on every call, forever, since nothing ever mutates the record to fix it or
 * calls `persist()` to rewrite the file. Checked the same way an amount is:
 * finite, and a whole number inside the range `Date` accepts.
 */
function isValidTimestampMs(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && Number.isInteger(value)
    && value >= 0
    && value <= 8_640_000_000_000_000;
}

function isSpendRecord(value: unknown): value is SpendRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['purchaseId'] === 'string' && record['purchaseId'].length > 0
    && isValidTimestampMs(record['atMs'])
    && isFiniteNonNegativeAmount(record['itemMinorUnits'])
    && isFiniteNonNegativeAmount(record['overageMinorUnits'])
    && isFiniteNonNegativeAmount(record['toleranceMinorUnits']);
}

function isReservation(value: unknown): value is BudgetReservation {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['id'] === 'string' && record['id'].length > 0
    && typeof record['dayKey'] === 'string' && record['dayKey'].length > 0
    && isFiniteNonNegativeAmount(record['itemMinorUnits'])
    && isFiniteNonNegativeAmount(record['overageMinorUnits'])
    && isFiniteNonNegativeAmount(record['toleranceMinorUnits'])
    && isValidTimestampMs(record['createdAtMs'])
    && isValidTimestampMs(record['expiresAtMs'])
    && (record['retainUntilSettled'] === undefined || record['retainUntilSettled'] === true);
}

interface LoadedBudget {
  readonly state?: BudgetStateSnapshot;
  readonly unavailable?: true;
  readonly migrate?: true;
}
function loadInitialState(filePath: string): LoadedBudget {
  const invalid = (): LoadedBudget => {
    logger.warn('Payment budget ledger is unreadable or unsupported. Payment accounting is disabled until the original state is repaired; no amounts were discarded.', { filePath });
    return { unavailable: true };
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileObservation(filePath).bytes));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const file = parsed as Partial<BudgetFile>;
  if ((file.version !== 1 && file.version !== BUDGET_FILE_VERSION)
    || !Array.isArray(file.spend) || !Array.isArray(file.reservations)
    || !file.spend.every(isSpendRecord) || !file.reservations.every(isReservation)) return invalid();
  const spend = file.spend;
  const reservations = file.reservations.map(record => file.version === 1
    ? { ...record, retainUntilSettled: true as const } : record);
  if (new Set(spend.map(record => record.purchaseId)).size !== spend.length
    || new Set(reservations.map(record => record.id)).size !== reservations.length) return invalid();
  if (reservations.length > 0) logger.info(
    'Payment budget ledger loaded with held reservations. Checkout-owned holds require commit or known-safe release; age does not prove a charge failed.',
    { filePath, reservations: reservations.map(entry => ({ id: entry.id, dayKey: entry.dayKey,
      itemMinorUnits: entry.itemMinorUnits, overageMinorUnits: entry.overageMinorUnits,
      toleranceMinorUnits: entry.toleranceMinorUnits, expiresAtMs: entry.expiresAtMs,
      retainUntilSettled: entry.retainUntilSettled === true })) },
  );
  return { state: { spend, reservations }, ...(file.version === 1 ? { migrate: true as const } : {}) };
}

export class PaymentBudgetUnavailableError extends Error {
  override readonly name = 'PaymentBudgetUnavailableError';
  constructor() { super('Payment budget accounting is unavailable. Repair the original budget ledger before making purchases.'); }
}

/**
 * The daemon's durable `BudgetLedger`.
 *
 * Every mutating method the base class exposes is overridden to persist the
 * new state after the mutation succeeds. Damaged accounting refuses both
 * reporting and mutation rather than returning a plausible empty balance.
 */
export class DurableBudgetLedger extends BudgetLedger {
  private readonly filePath: string;
  private readonly beforeFormatWrite: (() => void) | undefined;
  /**
   * Set when a write to disk failed and was not retried at that moment.
   * Checked at the START of every mutating method below, before its own
   * write, so a disk that has come back gets the missed write on the very
   * next mutation rather than waiting for one to fail again to notice.
   */
  private persistPending = false;
  private unavailable: boolean;

  /**
   * `now` defaults to the real clock; a test passes its own so an old fixture
   * timestamp stays "recent" relative to whatever moment the test considers
   * "now", rather than being pruned out from under a scenario that has nothing
   * to do with retention.
   */
  constructor(filePath: string, now: () => number = Date.now, beforeFormatWrite?: () => void) {
    const loaded = loadInitialState(filePath);
    super(loaded.state);
    this.filePath = filePath;
    this.beforeFormatWrite = beforeFormatWrite;
    this.unavailable = loaded.unavailable === true;
    if (this.unavailable) return;
    // An existing v2 hold can have been imported from another supported
    // installation. Admit its reader requirement before exposing accounting,
    // even when neither migration nor pruning needs to rewrite the file.
    try { this.declareRetainedHolds(); }
    catch { this.unavailable = true; return; }
    const before = super.state().spend.length;
    super.prune(now());
    if (loaded.migrate || super.state().spend.length !== before) {
      try { this.persist(); }
      catch {
        this.unavailable = true;
        logger.warn('Payment budget ledger migration or pruning could not be persisted. Purchases remain disabled until accounting can be restored.', { filePath });
      }
    }
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new PaymentBudgetUnavailableError();
  }

  override snapshot(limits: BudgetLimits, nowMs: number, timezone: string): PoolSnapshot {
    this.assertAvailable(); return super.snapshot(limits, nowMs, timezone);
  }

  override state(): BudgetStateSnapshot { this.assertAvailable(); return super.state(); }

  override reserve(input: {
    readonly id: string;
    readonly itemMinorUnits: number;
    readonly overageMinorUnits: number;
    readonly toleranceMinorUnits: number;
    readonly limits: BudgetLimits;
    readonly nowMs: number;
    readonly timezone: string;
    readonly ttlMs?: number;
    readonly retainUntilSettled?: true;
  }): BudgetReservation | null {
    this.assertAvailable();
    this.retryPendingPersist();
    const result = super.reserve(input);
    if (result !== null) {
      try {
        this.persist();
      } catch (error) {
        // Unlike `commit` (below), a reservation that never reached disk
        // represents nothing that has happened yet: no money left this
        // process's control, nothing downstream saw it succeed. Holding it in
        // memory anyway would mean a caller that saw this throw and treated
        // the reservation as never made would nonetheless have it tie up
        // budget after a failed reservation. Roll the in-memory mutation back before
        // the caller sees the failure, so a failed reserve leaves `remaining`
        // exactly where it was, the same as if `super.reserve` itself had
        // refused.
        super.release(result.id);
        throw error;
      }
    }
    return result;
  }

  /**
   * Commit is different from every other mutation below: by the time this
   * runs, the checkout flow has already told the merchant to charge the card
   * (checkout-flow.ts, step 9, before step 10 calls this). A write failure
   * here must never un-happen a charge that already happened at the
   * merchant, so unlike every other method here it does not throw: the
   * failure is logged loudly, the in-memory commit `super.commit` already
   * made stands, and the write is retried on the next mutation
   * (`retryPendingPersist`, above), whichever method that turns out to be.
   */
  override commit(reservationId: string, atMs: number): SpendRecord | null {
    this.assertAvailable();
    this.retryPendingPersist();
    const result = super.commit(reservationId, atMs);
    if (result !== null) this.persistAfterCommit();
    return result;
  }

  override release(reservationId: string): boolean {
    this.assertAvailable();
    this.retryPendingPersist();
    const result = super.release(reservationId);
    if (result) this.persist();
    return result;
  }

  override sweep(nowMs: number): readonly BudgetReservation[] {
    this.assertAvailable();
    this.retryPendingPersist();
    const result = super.sweep(nowMs);
    if (result.length > 0) this.persist();
    return result;
  }

  override prune(nowMs: number): void {
    this.assertAvailable();
    this.retryPendingPersist();
    const before = super.state().spend.length;
    super.prune(nowMs);
    if (super.state().spend.length !== before) this.persist();
  }

  /** Retries a write a prior mutation could not make land, before this one's own. Silent: a still-down disk just stays pending. */
  private retryPendingPersist(): void {
    if (!this.persistPending) return;
    try {
      this.writeToDisk();
    } catch {
      // Still down. Stays pending; tried again on the next mutation.
    }
  }

  /** The commit-only path: never throws, logs instead, and leaves the write pending for a later retry. */
  private persistAfterCommit(): void {
    try {
      this.writeToDisk();
    } catch (error) {
      this.persistPending = true;
      logger.warn(
        'Budget ledger could not be written to disk after a committed spend. The spend is kept in memory and '
        + 'reported correctly for the rest of this process, and the write will be retried on the next budget '
        + 'change. But if this process dies before that retry lands, the file on disk still holds the OLD '
        + 'reservation, not this commit. A checkout-owned hold remains reserved across restart until recovery '
        + 'can reconcile it; its TTL cannot make that uncertain amount spendable again.',
        { filePath: this.filePath, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  /** Every mutation but commit: a write failure here throws, unchanged from before this class had a retry path. */
  private persist(): void {
    this.writeToDisk();
  }

  private writeToDisk(): void {
    // Ordinary spend rows are readable by v1. The incompatible fact is a
    // hold that must survive expiry/day rollover; publish its reader floor
    // before that fact can reach disk. Early compatible writes keep rollback.
    this.declareRetainedHolds();
    const contents: BudgetFile = { version: BUDGET_FILE_VERSION, ...super.state() };
    atomicWriteFileSync(this.filePath, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600, mkdirp: true });
    this.persistPending = false;
  }

  private declareRetainedHolds(): void {
    if (!super.state().reservations.some(reservation => reservation.retainUntilSettled === true)) return;
    const declared: unknown = this.beforeFormatWrite?.();
    if (declared !== undefined) { drainOwned(declared); throw new PaymentBudgetUnavailableError(); }
  }
}
