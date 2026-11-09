/** Interrupted checkout settlement. Storage evidence can disclose or settle
 * an old attempt; it never authorizes another merchant submission. All admitted
 * I/O remains owned after a reporting timeout and is drained by close(). */
import { describeInterruption, type CheckoutRegistry, type InFlightCheckout, type InterruptedVerdict } from './checkout-registry.js';
import { recoverInterruptedWindow, type WindowRecovery } from './windows.js';
import { CheckoutOwnershipError } from './checkout-ownership.js';
import { OwnedWork } from '../utils/owned-work.js';
import { isDeepStrictEqual } from 'node:util';
import type { PaymentsServiceDeps } from './payments-gateway-service.js';

export type CheckoutRecoveryDeps = Pick<PaymentsServiceDeps,
  'ledger' | 'purchases' | 'notifier' | 'journal' | 'now' | 'armingPageCleanup' | 'recoveryIoTimeoutMs'> & {
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
   * `released`: nothing was submitted, the budget hold is released and the
   * record closed. `held`: the record is kept, either because the submit
   * outcome is unknowable or because a `submitted` entry's purchase record
   * could not be verified on the ledger. `closed`: the order was submitted,
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
  /**
   * Present when the record carried a persisted delivery report and the
   * delivery-keyed window rules were applied; the audit record for which
   * rule governed and which channels it named.
   */
  readonly windowRecovery?: WindowRecovery | undefined;
  /** Present only for records interrupted while arming the payment. */
  readonly armingPageCleanup?: 'done' | 'failed' | 'unavailable' | undefined;
}

export class CheckoutRecovery {
  private readonly work = new OwnedWork();
  private readonly abort = new AbortController();
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
    void pending.then(settled, settled);
    return pending;
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
   * A record interrupted inside a window settles conservatively by refusal,
   * because delivery of the window's notice cannot be verified after a
   * restart; the delivery-keyed rules in `recoverInterruptedWindow` apply
   * once deliveries are persisted.
   *
   * A kept record notifies the owner at most once, ever: the first delivered
   * notice stamps `recoveryNotifiedAtMs` back through the journal. One
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
      } catch {
        results.push({
          purchaseId: record.purchaseId,
          merchantDomain: record.merchantDomain,
          verdict,
          action: 'failed',
          reservationReleased: false,
          notified: false,
          notice: 'failed',
          message: 'Recovery failed for this purchase. Its remaining payment evidence requires inspection.',
        });
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

    if (verdict === 'not-submitted') {
      current();
      if (record.reservationId !== null) {
        // In-memory reservations do not survive the restart; releasing is the
        // honest no-op then, and the real release when recovery runs in-process.
        reservationReleased = this.deps.ledger.release(record.reservationId);
      }
      message = describeInterruption(record, verdict, { reservationReleased });
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
      current();
      await this.deps.registry.close(record.purchaseId);
      current();
      action = 'released';
    } else if (verdict === 'possibly-submitted') {
      // The crash-between-record-and-flush case: the purchase record may
      // already be on the ledger even though the journal never saw the
      // submitted flush. When the lookup proves it, the order completed;
      // close honestly instead of holding forever. Anything less certain
      // stays deliberately untouched, because releasing the hold or the
      // record is what makes a restart buy the thing twice.
      const verified = await this.verifyPurchaseRecord(record.purchaseId, current, io);
      current();
      message = describeInterruption(record, verdict, { recordVerified: verified });
      if (verified === true) {
        this.settleRecordedBudget(record, current);
        await this.deps.registry.close(record.purchaseId);
        current();
        action = 'closed';
      } else {
        action = 'held';
      }
    } else {
      // `submitted` is only closed once the purchase record is verified on
      // the ledger. Journals written under the old flush ordering can carry
      // `submitted` entries whose crash landed before the record was written.
      const verified = await this.verifyPurchaseRecord(record.purchaseId, current, io);
      current();
      message = describeInterruption(record, verdict, { recordVerified: verified });
      if (verified === true) {
        this.settleRecordedBudget(record, current);
        await this.deps.registry.close(record.purchaseId);
        current();
        action = 'closed';
      } else {
        action = 'held';
      }
    }

    let notified = false;
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
      } catch {
        notified = false;
      }
      notice = notified ? 'delivered' : 'failed';
      if (notified && action === 'held') {
        current();
        // Stamp kept records so the next boot does not repeat the notice.
        await this.deps.journal.put({ ...record, recoveryNotifiedAtMs: now() });
        current();
      }
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
   * The window sentence for an interrupted-window record, keyed on the
   * PERSISTED delivery report when one exists. The purchase itself can never
   * resume after a restart (the page and the in-flight call are gone), so
   * every branch settles with the hold released and nothing charged; what the
   * delivery-keyed rules decide is what the owner is told about the notice
   * and which channels still owe a read.
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
    if (recovery.outcome === 'undeliverable-rule') {
      return `Its ${windowName} notice never reached you on any channel, so it settles as refused rather than charged.`;
    }
    if (recovery.outcome === 'reopen') {
      const channels = recovery.reopenChannels.join(', ');
      return `Its ${windowName} notice reached you, but I cannot re-read ${channels} for the span I was down, `
        + 'so a reply there may have been missed. The purchase could not resume after the restart, nothing '
        + 'was charged, and it will not be retried; start it again if you still want it.';
    }
    const backfill = recovery.backfillChannels.length > 0
      ? ` Any reply you sent on ${recovery.backfillChannels.join(', ')} while I was down can still be read there.`
      : '';
    return `Its ${windowName} notice reached you before the restart. The purchase could not resume `
      + `afterwards, so nothing was charged and it will not be retried; start it again if you still want it.${backfill}`;
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
