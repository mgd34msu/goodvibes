/** Interrupted checkout settlement. Storage evidence can disclose or settle
 * an old attempt; it never authorizes another merchant submission. All admitted
 * I/O remains owned after a reporting timeout and is drained by close(). */
import { describeInterruption, type CheckoutRegistry, type InFlightCheckout, type InterruptedVerdict } from './checkout-registry.js';
import { recoverInterruptedWindow, type WindowRecovery } from './windows.js';
import { CheckoutOwnershipError, type CheckoutOperationOwnership } from './checkout-ownership.js';
import { OwnedWork } from '../utils/owned-work.js';
import { logger } from '../utils/logger.js';
import { isDeepStrictEqual } from 'node:util';
import type { PaymentsServiceDeps } from './payments-gateway-service.js';

export type CheckoutRecoveryDeps = Pick<PaymentsServiceDeps,
  'ledger' | 'purchases' | 'notifier' | 'journal' | 'now'> & {
  /**
   * Composition-supplied cleanup for a page that outlived the process while a
   * checkout was arming the payment. Receives record identity only, never a
   * driver: the composition holds the browser authority and decides whether
   * it can still reach the page. Resolves true when the card fields were
   * cleared. Absent, recovery refuses to claim a cleanup it cannot perform.
   */
  readonly armingPageCleanup?: ((record: {
    readonly purchaseId: string;
    readonly sessionId: string;
    readonly pageId: string;
  }, options?: CheckoutOperationOwnership) => Promise<boolean>) | undefined;
  /** Override for `RECOVERY_IO_TIMEOUT_MS`; tests use it, compositions normally do not. */
  readonly recoveryIoTimeoutMs?: number | undefined;
  readonly registry: CheckoutRegistry;
  readonly isPaymentsLeader: () => boolean;
  /** Actual host execution lease; null means another process still owns it. */
  readonly retainInterrupted?: ((purchaseId: string) => { assertCurrent(): void; release(): void } | null) | undefined;
};

/**
 * Ceiling on each composition-supplied I/O call the recovery sweep makes
 * (notifier delivery, the purchases lookup, the arming-page cleanup hook).
 * Ten seconds is deliberate: long enough for a channel router doing a real
 * network send, short enough that even a journal full of records cannot make
 * verb attachment hang on one wedged dependency. A call that exceeds it is
 * reported through the audit path and the sweep continues.
 */
export const RECOVERY_IO_TIMEOUT_MS = 10_000;

function withRecoveryTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      rejectPromise(new Error(`${label} did not settle within ${ms}ms during checkout recovery.`));
    }, ms);
    work.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (error: unknown) => { clearTimeout(timer); rejectPromise(error); },
    );
  });
}

/** What one boot's recovery sweep did, for the composition's audit log. */
export interface CheckoutRecoverySweep {
  /** False when the sweep did not run at all (see `skipped`). */
  readonly swept: boolean;
  /** Why a non-swept boot skipped: this daemon is not the payments leader. */
  readonly skipped?: 'not-leader' | undefined;
  readonly settlements: readonly InterruptedCheckoutRecovery[];
}

/** One interrupted checkout settled (or deliberately held) by boot recovery. */
export interface InterruptedCheckoutRecovery {
  readonly purchaseId: string;
  readonly merchantDomain: string;
  readonly verdict: InterruptedVerdict;
  /**
   * `released`: nothing was submitted, the owner was told, the budget hold is
   * released and the record closed. `held`: the record is kept, because the
   * submit outcome is unknowable, because a `submitted` entry's purchase record
   * could not be verified on the ledger, or because the owner's notice did not
   * land yet (`notice: 'failed'`), so a later sweep settles and tells it. `closed`: the order was submitted,
   * its purchase record was verified, and only the journal entry needed
   * closing. `failed`: settling this one record threw; the message carries
   * a fixed failure description and the rest of the sweep continued.
   */
  readonly action: 'released' | 'held' | 'closed' | 'failed';
  readonly reservationReleased: boolean;
  readonly notified: boolean;
  /**
   * What happened with the owner's notice for this record: `delivered` on a
   * confirmed landing, `failed` when delivery errored, timed out, or landed
   * nowhere, and `already-notified` when an earlier boot's stamped notice
   * made a repeat unnecessary.
   */
  readonly notice: 'delivered' | 'failed' | 'already-notified';
  readonly message: string;
  /** For `action: 'failed'`: the error class that stopped settling this record. */
  readonly reason?: string | undefined;
  /**
   * Present when the record carried a persisted delivery report and the
   * delivery-keyed window rules were applied; the audit record for which
   * rule governed and which channels it named.
   */
  readonly windowRecovery?: WindowRecovery | undefined;
  /** Present only for records interrupted while arming the payment. */
  readonly armingPageCleanup?: 'done' | 'failed' | 'unavailable' | undefined;
}

/**
 * When a sweep could not tell the owner about a record, the record is kept and
 * the sweep runs again after each of these waits (then at the next start).
 * Each later sweep reads the journal once and sends only the notices still owed.
 */
const NOTICE_RETRY_DELAYS_MS: readonly number[] = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000, 60 * 60_000];

export class CheckoutRecovery {
  private readonly work = new OwnedWork();
  private readonly abort = new AbortController();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Settlement failures whose record's notice already landed this sweep; the owner is not told twice. */
  private readonly announced = new WeakSet<object>();
  private retryAttempt = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private sweep: Promise<CheckoutRecoverySweep> | undefined;
  private readonly retirementErrors: unknown[] = [];
  private readonly deps: CheckoutRecoveryDeps;
  constructor(deps: CheckoutRecoveryDeps) { this.deps = { ...deps }; }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.closing = new Promise<void>((done, failed) => { resolve = done; reject = failed; });
    this.closed = true;
    if (this.retryTimer !== undefined) { clearTimeout(this.retryTimer); this.retryTimer = undefined; }
    this.abort.abort(new CheckoutOwnershipError());
    void this.work.join().then(() => {
      if (this.retirementErrors.length) reject(new AggregateError(this.retirementErrors, 'Checkout recovery ownership did not retire cleanly'));
      else resolve();
    }, reject);
    return this.closing;
  }

  private current(): void {
    this.abort.signal.throwIfAborted();
    if (this.closed || !this.deps.isPaymentsLeader()) throw new CheckoutOwnershipError();
    this.abort.signal.throwIfAborted();
  }

  private io<T>(operation: () => Promise<T>, label: string, current: () => void, owned: OwnedWork): Promise<T> {
    const pending = this.work.run(() => owned.run(async () => {
      current();
      const result = await operation();
      current();
      return result;
    }));
    return withRecoveryTimeout(pending, this.deps.recoveryIoTimeoutMs ?? RECOVERY_IO_TIMEOUT_MS, label);
  }

  recoverInterruptedCheckouts(): Promise<CheckoutRecoverySweep> {
    if (this.closed) return Promise.reject(new CheckoutOwnershipError());
    if (this.sweep) return this.sweep;
    // A reporting timeout does not retire the dependency's real work. Do not
    // start another sweep over the same evidence until that work has drained.
    if (!this.work.idle) return Promise.reject(new CheckoutOwnershipError());
    let resolve!: (result: CheckoutRecoverySweep) => void, reject!: (error: unknown) => void;
    const pending = new Promise<CheckoutRecoverySweep>((done, failed) => { resolve = done; reject = failed; });
    this.sweep = pending;
    void this.work.run(() => this.recover()).then(resolve, reject);
    const settled = () => { if (this.sweep === pending) this.sweep = undefined; };
    void pending.then((sweep) => { settled(); this.scheduleNoticeRetry(sweep); }, settled);
    return pending;
  }

  /**
   * A record whose notice did not land was kept, so the owner can still be
   * told before it closes. Sweep again later, a bounded number of times; the
   * next start sweeps too.
   */
  private scheduleNoticeRetry(sweep: CheckoutRecoverySweep): void {
    if (this.closed || this.retryTimer !== undefined) return;
    // Only records kept for their notice are worth another sweep soon.
    if (!sweep.settlements.some((settlement) => settlement.notice === 'failed' && settlement.action === 'held')) { this.retryAttempt = 0; return; }
    const delay = NOTICE_RETRY_DELAYS_MS[this.retryAttempt];
    if (delay === undefined) {
      logger.warn('Interrupted purchases still owe the owner a notice; the next daemon start will try again', {
        owed: sweep.settlements.filter((settlement) => settlement.notice === 'failed').length,
      });
      return;
    }
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (this.closed) return;
      if (!this.work.idle) { this.retryAttempt -= 1; this.scheduleNoticeRetry(sweep); return; }
      this.recoverInterruptedCheckouts().then((next) => {
        logger.info('Interrupted purchase notices retried', {
          delivered: next.settlements.filter((settlement) => settlement.notice === 'delivered').length,
          owed: next.settlements.filter((settlement) => settlement.notice === 'failed').length,
        });
      }, (error: unknown) => {
        logger.warn('Interrupted purchase notices could not be retried', { error: error instanceof Error ? error.name : 'unknown' });
      });
    }, delay);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Settle every checkout a restart interrupted, before new checkouts run.
   *
   * The journal is the restart's only witness, and records live in this
   * process are running, not interrupted; the registry filters them out.
   * Each record settles by its phase verdict. Nothing submitted releases its
   * budget hold and closes, and the owner's message follows the actual
   * release result. An unknowable submit keeps its hold and its record. A
   * `submitted` record is closed only after the purchase record is verified
   * on the ledger; when it is missing, or this composition cannot look, the
   * record is kept and the owner is told exactly what is and is not known.
   * A record interrupted inside a window reaches this sweep only when the
   * native restorer did not take it back (`recoverInterruptedWindow` states
   * the order); it settles by refusal with the window's own sentence.
   *
   * A record is closed only after the owner was told: when the notice does not
   * land, the record and its hold stay for the next sweep, which runs again a
   * few times on a backoff and at the next start. A kept record notifies the
   * owner at most once: the first delivered notice stamps
   * `recoveryNotifiedAtMs` back through the journal. One
   * record's failure never abandons the rest; it is reported in the results
   * as `action: 'failed'`. Recovery also cannot clear card material from a
   * browser page that outlived the process (attach-based compositions): the
   * composition that owns the page owns that cleanup, including for records
   * interrupted in the arming phase.
   */
  private async recover(): Promise<CheckoutRecoverySweep> {
    // Leadership gates the sweep exactly as it gates every verb: a non-leader
    // daemon must not settle records, release holds, or message the owner
    // about checkouts another instance owns. The skip is reported, not
    // silent, so the audit log shows which boot deferred and why.
    if (!this.deps.isPaymentsLeader()) {
      return { swept: false, skipped: 'not-leader', settlements: [] };
    }
    this.current();
    const interrupted = await this.deps.registry.interrupted();
    this.current();
    const results: InterruptedCheckoutRecovery[] = [];
    for (const { record, verdict } of interrupted) {
      this.current();
      let lease: { assertCurrent(): void; release(): void } | null | undefined;
      let active = true;
      const io = new OwnedWork();
      const current = () => { this.current(); if (!active) throw new CheckoutOwnershipError(); lease?.assertCurrent(); };
      try {
        if (this.deps.retainInterrupted) {
          lease = this.deps.retainInterrupted(record.purchaseId);
          if (lease === null) continue;
          current();
          const actual = (await this.deps.journal.list()).find(entry => entry.purchaseId === record.purchaseId);
          current();
          if (actual === undefined) continue;
          if (!isDeepStrictEqual(actual, record)) throw new CheckoutOwnershipError();
        }
        results.push(await this.settleInterrupted(record, verdict, current, io));
      } catch (error) {
        results.push(await this.reportFailedSettlement(record, verdict, error, io));
      } finally {
        // A reporting timeout retires the record guard immediately, but an
        // ignored cancellation cannot hand its real execution lease to a new
        // process until every admitted dependency has actually drained.
        active = false;
        if (lease) {
          const retained = lease;
          const retirement = this.work.run(async () => { await io.join(); retained.release(); });
          void retirement.catch(error => { this.retirementErrors.push(error); });
        }
      }
    }
    this.current();
    return { swept: true, settlements: results };
  }

  /**
   * One record could not be settled. The cause is logged (error class and
   * message only, never payment evidence) and carried in the result as
   * `reason`; the owner is told once, as for a kept record, unless the sweep
   * stopped because this daemon lost the payments lease or is closing.
   */
  private async reportFailedSettlement(
    record: InFlightCheckout,
    verdict: InterruptedVerdict,
    error: unknown,
    io: OwnedWork,
  ): Promise<InterruptedCheckoutRecovery> {
    const reason = error instanceof Error && error.name !== 'Error' ? error.name : 'settlement-error';
    logger.error('Checkout recovery could not settle an interrupted purchase', {
      purchaseId: record.purchaseId,
      verdict,
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
    const message = `Recovery failed for this purchase (${reason}). Its remaining payment evidence requires inspection.`;
    let notified = false;
    let notice: InterruptedCheckoutRecovery['notice'] = 'failed';
    const announced = typeof error === 'object' && error !== null && this.announced.has(error);
    if (record.recoveryNotifiedAtMs !== undefined) {
      notice = 'already-notified';
    } else if (announced || (!(error instanceof CheckoutOwnershipError) && !this.closed && this.deps.isPaymentsLeader() && !this.abort.signal.aborted)) {
      // An ownership error means the record changed hands or was rewritten since this sweep read it;
      // telling the owner about a snapshot that is no longer the record would be wrong. A record
      // whose notice already landed this sweep is not announced again, only stamped.
      const stillOurs = () => this.current();
      if (announced) notified = true;
      else try {
        const deliveries = await this.io(
          () => this.deps.notifier.deliver({ kind: 'notice', message, signal: this.abort.signal, assertCurrent: stillOurs }),
          'The recovery failure notice delivery', stillOurs, io,
        );
        notified = deliveries.some((delivery) => delivery.delivered);
      } catch { notified = false; }
      notice = notified ? 'delivered' : 'failed';
      if (notified) {
        // The record is kept (it was not settled), so stamp it as a kept record is.
        try {
          // Stamp only the record as it was read: a stale snapshot written back would rewind a
          // journal entry that has moved on, or resurrect one that closed meanwhile.
          const latest = (await this.deps.journal.list()).find(entry => entry.purchaseId === record.purchaseId);
          if (latest !== undefined && isDeepStrictEqual(latest, record)) {
            await this.deps.journal.put({ ...record, recoveryNotifiedAtMs: (this.deps.now ?? Date.now)() });
          }
        } catch { /* the next boot repeats the notice */ }
      }
    }
    return {
      purchaseId: record.purchaseId,
      merchantDomain: record.merchantDomain,
      verdict,
      action: 'failed',
      reservationReleased: false,
      notified,
      notice,
      message,
      reason,
    };
  }

  /**
   * Tell first, settle second. A record this sweep would close (nothing was
   * submitted, or the submitted purchase is verified on the ledger) is closed
   * only after the owner's notice landed or an earlier boot already delivered
   * it; when the send fails the record and its hold stay exactly as they were,
   * so the next sweep settles it and tells the owner then. A record that is
   * kept anyway is stamped once its notice lands, so it is told about once.
   */
  private async settleInterrupted(
    record: InFlightCheckout,
    verdict: InterruptedVerdict,
    current: () => void,
    io: OwnedWork,
  ): Promise<InterruptedCheckoutRecovery> {
    const now = this.deps.now ?? Date.now;
    let action: InterruptedCheckoutRecovery['action'];
    let reservationReleased = false;
    let message: string;
    let windowRecovery: WindowRecovery | undefined;
    let armingPageCleanup: InterruptedCheckoutRecovery['armingPageCleanup'];
    let settle: (() => Promise<void>) | undefined;

    if (verdict === 'not-submitted') {
      current();
      // The release follows the notice; the sentence names the hold as it
      // stands, which is what the release will give back.
      const holdId = record.reservationId;
      const holdPresent = holdId !== null && this.deps.ledger.state().reservations.some((entry) => entry.id === holdId);
      message = describeInterruption(record, verdict, { reservationReleased: holdPresent });
      if (record.phase === 'awaiting-window') {
        message += ` ${this.settleWindowSentence(record, now, (recovery) => { windowRecovery = recovery; })}`;
      }
      if (record.phase === 'arming-payment') {
        armingPageCleanup = await this.runArmingPageCleanup(record, current, io);
        current();
        message += armingPageCleanup === 'done'
          ? ' The card fields this checkout had started filling were cleared from the page.'
          : ' This checkout was typing card details when it stopped; I cannot reach that page from'
            + ' here, so if the browser window is still open, close it or clear the form yourself.';
      }
      action = 'released';
      settle = async () => {
        current();
        // In-memory reservations do not survive the restart; releasing is the
        // honest no-op then, and the real release when recovery runs in-process.
        if (holdId !== null) reservationReleased = this.deps.ledger.release(holdId);
        current();
        await this.deps.registry.close(record.purchaseId);
        current();
      };
    } else {
      // `possibly-submitted` is the crash-between-record-and-flush case: the
      // purchase record may already be on the ledger even though the journal
      // never saw the submitted flush. `submitted` is only closed once the
      // purchase record is verified on the ledger too: journals written under
      // the old flush ordering can carry `submitted` entries whose crash landed
      // before the record was written. When the lookup proves it, the order
      // completed and the record closes honestly instead of holding forever.
      // Anything less certain stays deliberately untouched, because releasing
      // the hold or the record is what makes a restart buy the thing twice.
      const verified = await this.verifyPurchaseRecord(record.purchaseId, current, io);
      current();
      message = describeInterruption(record, verdict, { recordVerified: verified });
      if (verified === true) {
        action = 'closed';
        settle = async () => {
          this.settleRecordedBudget(record, current);
          await this.deps.registry.close(record.purchaseId);
          current();
        };
      } else {
        action = 'held';
      }
    }

    let notified = false;
    // True when no notice channel is configured at all: there is nothing a
    // later sweep could deliver on, and the operation status is the record.
    let noChannels = false;
    let notice: InterruptedCheckoutRecovery['notice'];
    if (record.recoveryNotifiedAtMs !== undefined) {
      notice = 'already-notified';
    } else {
      try {
        const deliveries = await this.io(
          () => this.deps.notifier.deliver({ kind: 'notice', message, signal: this.abort.signal, assertCurrent: () => current() }),
          'The recovery notice delivery', current, io,
        );
        current();
        notified = deliveries.some((delivery) => delivery.delivered);
        noChannels = deliveries.length === 0;
      } catch {
        notified = false;
      }
      notice = notified ? 'delivered' : 'failed';
    }
    if (settle !== undefined && (notice !== 'failed' || noChannels)) {
      try { await settle(); }
      catch (error) {
        if (notified && typeof error === 'object' && error !== null) this.announced.add(error);
        throw error;
      }
    } else if (settle !== undefined) {
      // Not settled: the owner has not been told. The record stays for the next sweep.
      action = 'held';
    } else if (notified) {
      current();
      // Stamp kept records so the next boot does not repeat the notice.
      await this.deps.journal.put({ ...record, recoveryNotifiedAtMs: now() });
      current();
    }
    current();
    return {
      purchaseId: record.purchaseId,
      merchantDomain: record.merchantDomain,
      verdict,
      action,
      reservationReleased,
      notified,
      notice,
      message,
      ...(windowRecovery !== undefined ? { windowRecovery } : {}),
      ...(armingPageCleanup !== undefined ? { armingPageCleanup } : {}),
    };
  }

  private async verifyPurchaseRecord(
    purchaseId: string,
    current: () => void,
    io: OwnedWork,
  ): Promise<boolean | undefined> {
    const has = this.deps.purchases.has;
    if (has === undefined) return undefined;
    return this.io(
      () => has.call(this.deps.purchases, purchaseId),
      'The purchases lookup', current, io,
    );
  }

  /** A merchant receipt may have reached disk while commit() still had a
   * failed durable write pending. Finish exactly its original hold before
   * removing the crash journal. Never mint a replacement reservation. */
  private settleRecordedBudget(record: InFlightCheckout, current: () => void): void {
    current();
    const ledger = this.deps.ledger, state = ledger.state();
    const hold = state.reservations.find(entry => entry.id === record.reservationId);
    const spent = state.spend.find(entry => entry.purchaseId === record.purchaseId);
    if (hold) {
      if (spent || hold.id !== record.purchaseId || hold.retainUntilSettled !== true || !record.draw
        || hold.itemMinorUnits !== record.draw.itemMinorUnits || hold.overageMinorUnits !== record.draw.overageMinorUnits
        || hold.toleranceMinorUnits !== record.draw.toleranceMinorUnits) throw new CheckoutOwnershipError();
      current();
      if (!ledger.commit(hold.id, record.updatedAtMs)) throw new CheckoutOwnershipError();
    }
    current(); ledger.flush(current); current();
  }

  /**
   * The window sentence for an interrupted-window record this sweep settles,
   * from the persisted delivery report and `recoverInterruptedWindow`'s order.
   * A window the native restorer resumed never reaches here (its lease is
   * held); one that should have resumed and did not ends unbought.
   */
  private settleWindowSentence(
    record: InFlightCheckout,
    now: () => number,
    report: (recovery: WindowRecovery) => void,
  ): string {
    const deliveries = record.windowDeliveries ?? [];
    if (deliveries.length === 0) {
      // Genuinely no delivery report: honest and narrow, settle by refusal.
      return 'It stopped inside its approval or veto window, and I could not verify that the'
        + ' window notice ever reached you, so it settles as refused rather than charged.';
    }
    const recovery = recoverInterruptedWindow({
      deliveries,
      deadlinePassed: record.windowDeadlineMs === undefined ? true : now() > record.windowDeadlineMs,
    });
    report(recovery);
    const windowName = record.windowKind === 'approval'
      ? 'approval window'
      : record.windowKind === 'veto' ? 'veto window' : 'approval or veto window';
    if (recovery.outcome === 'not-delivered') {
      return `Its ${windowName} notice never reached you on any channel, so it settles as refused rather than charged.`;
    }
    if (recovery.outcome === 'end') {
      return `Its ${windowName} notice reached you on ${recovery.unreadableChannels.join(', ')}, which keeps no replies across a restart, `
        + 'so a reply there may have been missed. Nothing was charged and it will not be retried; start it again if you still want it.';
    }
    return `Its ${windowName} notice reached you before the restart, but the purchase could not be resumed afterwards `
      + '(its browser page, pairing, payment settings or saved replies were not available as they were), so nothing was '
      + 'charged and it will not be retried; start it again if you still want it.';
  }

  private async runArmingPageCleanup(
    record: InFlightCheckout,
    current: () => void,
    io: OwnedWork,
  ): Promise<'done' | 'failed' | 'unavailable'> {
    const cleanup = this.deps.armingPageCleanup;
    if (cleanup === undefined) return 'unavailable';
    try {
      const cleared = await this.io(
        () => cleanup({
          purchaseId: record.purchaseId,
          sessionId: record.sessionId,
          pageId: record.pageId,
        }, { signal: this.abort.signal, assertCurrent: () => current() }),
        'The arming-page cleanup hook', current, io,
      );
      return cleared ? 'done' : 'failed';
    } catch {
      return 'failed';
    }
  }

}
