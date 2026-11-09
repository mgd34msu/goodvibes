/** Durable payment accounting. Missing state is an unused ledger; damaged or
 * unsupported state disables budget operations without taking down the daemon.
 * A native host with known purchase/operation history cannot interpret a
 * missing budget as unused. Retain the actual selected physical file across
 * awaits and writes; another owner's replacement never becomes this owner's.
 * Never discard accounting entries and then offer their money again.
 *
 * Checkout holds persist until a known-safe release or commit. Version 1 holds
 * upgrade conservatively because their records did not distinguish temporary
 * reservations from unresolved checkouts. Schema 2 stores that distinction;
 * schema 3 adds the once-only owner-reconciliation accounting receipts.
 * A failed post-charge write keeps the spend in memory and retries persistence;
 * its on-disk checkout hold remains protected if the process dies first.
 */
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { drainOwned } from '@goodvibes-jev/judgment';
import { fileObservationIdentity, readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { lstatSync } from 'node:fs';
import { logger } from '../../utils/logger.js';
import { BudgetLedger } from '../budget.js';
import type {
  BudgetLimits,
  BudgetReservation,
  BudgetStateSnapshot,
  SpendRecord,
  PoolSnapshot,
  CheckoutBudgetSettlement,
  CheckoutBudgetSettlementOwner,
} from '../budget.js';

const BUDGET_FILE_VERSION = 2;

interface BudgetFile {
  readonly version: number;
  readonly spend: readonly SpendRecord[];
  readonly reservations: readonly BudgetReservation[];
  readonly reconciliations?: readonly CheckoutBudgetSettlement[];
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
  readonly observed?: FileObservation;
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
  let observed: FileObservation;
  try {
    observed = readFileObservation(filePath);
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    return invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) return invalid();
  const file = parsed as Partial<BudgetFile>;
  if ((file.version !== 1 && file.version !== BUDGET_FILE_VERSION && file.version !== 3)
    || !Array.isArray(file.spend) || !Array.isArray(file.reservations)
    || !file.spend.every(isSpendRecord) || !file.reservations.every(isReservation)) return invalid();
  const spend = file.spend;
  const reconciliations = file.reconciliations ?? [];
  if (!Array.isArray(reconciliations) || (file.version === 3 && reconciliations.length === 0) || (file.version !== 3 && reconciliations.length > 0)
    || !reconciliations.every((entry: unknown) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const row = entry as Record<string, unknown>;
      return Object.keys(row).length === 6 && typeof row['operationId'] === 'string' && !!row['operationId']
        && typeof row['purchaseId'] === 'string' && !!row['purchaseId']
        && (row['outcome'] === 'purchased' || row['outcome'] === 'not-purchased') && isValidTimestampMs(row['atMs'])
        && (row['reservation'] === null || (isReservation(row['reservation']) && row['reservation'].id === row['purchaseId'] && row['reservation'].retainUntilSettled === true))
        && (row['spend'] === null || (isSpendRecord(row['spend']) && row['spend'].purchaseId === row['purchaseId']))
        && !(row['reservation'] !== null && row['spend'] !== null);
    }) || new Set(reconciliations.map(entry => entry.operationId)).size !== reconciliations.length) return invalid();
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
  return { observed, state: { spend, reservations, ...(reconciliations.length === 0 ? {} : { reconciliations }) }, ...(file.version === 1 ? { migrate: true as const } : {}) };
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
  private readonly beforeReconciliationWrite: (() => void) | undefined;
  private readonly retainPendingSpend: ((purchaseId: string) => boolean) | undefined;
  private readonly expectExisting: (() => boolean) | undefined;
  private observed: FileObservation | null;
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
  constructor(filePath: string, now: () => number = Date.now, beforeFormatWrite?: () => void, beforeReconciliationWrite?: () => void,
    retainPendingSpend?: (purchaseId: string) => boolean, expectExisting?: () => boolean) {
    const loaded = loadInitialState(filePath);
    super(loaded.state);
    this.filePath = filePath;
    this.beforeFormatWrite = beforeFormatWrite;
    this.beforeReconciliationWrite = beforeReconciliationWrite;
    this.retainPendingSpend = retainPendingSpend;
    this.expectExisting = expectExisting;
    this.observed = loaded.observed ?? null;
    this.unavailable = loaded.unavailable === true;
    if (this.unavailable) return;
    // An existing v2 hold can have been imported from another supported
    // installation. Admit its reader requirement before exposing accounting,
    // even when neither migration nor pruning needs to rewrite the file.
    try { this.assertAvailable(); this.declareRetainedHolds(); this.declareReconciliations(); }
    catch { this.unavailable = true; return; }
    const before = super.state().spend.length;
    try { super.prune(now(), this.retainPendingSpend); }
    catch { this.unavailable = true; return; }
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
    try {
      if (this.observed !== null) {
        // The inode/owner/mode/size/nanosecond time stamp fences the selected
        // native source. No digest or whole-ledger read on ordinary snapshots.
        if (fileObservationIdentity(this.filePath) !== this.observed.physical) throw new Error();
      } else {
        try { lstatSync(this.filePath); }
        catch (error) {
          if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
          const expected: unknown = this.expectExisting ? this.expectExisting() : false;
          if (typeof expected !== 'boolean') { drainOwned(expected); throw new Error(); }
          if (!expected) return;
          throw new Error();
        }
        // Missing on construction does not authorize replacing a later file,
        // dangling symlink, or another host's newly created accounting.
        throw new Error();
      }
    } catch {
      this.unavailable = true;
      throw new PaymentBudgetUnavailableError();
    }
  }

  override snapshot(limits: BudgetLimits, nowMs: number, timezone: string): PoolSnapshot {
    this.assertAvailable(); return super.snapshot(limits, nowMs, timezone);
  }

  override state(): BudgetStateSnapshot { this.assertAvailable(); return super.state(); }

  override flush(assertCurrent?: () => void): void { this.assertAvailable(); this.writeToDisk(assertCurrent); }

  override settleReconciliation(receipt: CheckoutBudgetSettlement, owner?: CheckoutBudgetSettlementOwner): void {
    this.assertAvailable();
    owner?.assertCurrent();
    // Declare before any incompatible accounting publication. The operation's
    // owner checkpoint has already bound this exact immutable receipt.
    const declared: unknown = this.beforeReconciliationWrite?.();
    if (declared !== undefined) { drainOwned(declared); throw new PaymentBudgetUnavailableError(); }
    owner?.assertCurrent();
    super.settleReconciliation(receipt, owner);
    this.writeToDisk(owner ? () => owner.assertCurrent() : undefined);
  }

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
    super.prune(nowMs, this.retainPendingSpend);
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

  private writeToDisk(assertCurrent?: () => void): void {
    // Ordinary spend rows are readable by v1. The incompatible fact is a
    // hold that must survive expiry/day rollover; publish its reader floor
    // before that fact can reach disk. Early compatible writes keep rollback.
    this.declareRetainedHolds();
    this.declareReconciliations();
    const current = () => { this.assertAvailable(); assertCurrent?.(); this.assertAvailable(); };
    current();
    const state = super.state();
    const contents: BudgetFile = { version: state.reconciliations?.length ? 3 : BUDGET_FILE_VERSION, ...state };
    const bytes = `${JSON.stringify(contents, null, 2)}\n`;
    atomicWriteFileSync(this.filePath, bytes, { mode: 0o600, mkdirp: true, assertCurrent: current,
      onEffect: published => {
        if (!published) return;
        try {
          const observed = readFileObservation(this.filePath);
          if (!observed.bytes.equals(Buffer.from(bytes))) throw new Error();
          this.observed = observed;
        } catch { this.unavailable = true; throw new PaymentBudgetUnavailableError(); }
      } });
    this.persistPending = false;
  }

  private declareRetainedHolds(): void {
    if (!super.state().reservations.some(reservation => reservation.retainUntilSettled === true)) return;
    const declared: unknown = this.beforeFormatWrite?.();
    if (declared !== undefined) { drainOwned(declared); throw new PaymentBudgetUnavailableError(); }
  }
  private declareReconciliations(): void {
    if (!super.state().reconciliations?.length) return;
    const declared: unknown = this.beforeReconciliationWrite?.();
    if (declared !== undefined) { drainOwned(declared); throw new PaymentBudgetUnavailableError(); }
  }
}
