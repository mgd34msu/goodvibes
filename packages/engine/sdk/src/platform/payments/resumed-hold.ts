import { isDeepStrictEqual } from 'node:util';
import { BudgetLedger, type BudgetLimits } from './budget.js';
import { CheckoutOwnershipError } from './checkout-ownership.js';
import type { InFlightCheckout } from './checkout-registry.js';

/** Retain the already held money; never reserve a replacement or mutate the
 * real pool to make this purchase fit. This is bookkeeping, not authority. */
export function retainResumedCheckoutHold(ledger: BudgetLedger, record: InFlightCheckout) {
  const readState = ledger.state;
  const state = readState.call(ledger), selected = state.reservations.find(entry => entry.id === record.reservationId);
  if (!selected || selected.retainUntilSettled !== true || selected.id !== record.purchaseId || !record.draw
    || state.spend.some(entry => entry.purchaseId === record.purchaseId)
    || selected.itemMinorUnits !== record.draw.itemMinorUnits || selected.overageMinorUnits !== record.draw.overageMinorUnits
    || selected.toleranceMinorUnits !== record.draw.toleranceMinorUnits) throw new CheckoutOwnershipError();
  const reservation = Object.freeze({ ...selected });
  const release = ledger.release, commit = ledger.commit;
  let consumed = false;
  const currentState = () => {
    if (consumed || ledger.state !== readState || ledger.release !== release || ledger.commit !== commit) throw new CheckoutOwnershipError();
    const current = readState.call(ledger);
    const live = current.reservations.find(entry => entry.id === reservation.id);
    if (current.spend.some(entry => entry.purchaseId === record.purchaseId)
      || live !== selected || !isDeepStrictEqual(live, reservation)) throw new CheckoutOwnershipError();
    return current;
  };
  return Object.freeze({ reservation, assertCurrent() { currentState(); },
    release() {
      if (consumed) return false;
      currentState(); const result = release.call(ledger, reservation.id); consumed = true; return result;
    },
    commit(atMs: number) {
      currentState(); const result = commit.call(ledger, reservation.id, atMs); consumed = true; return result;
    },
    snapshot(limits: BudgetLimits, nowMs: number, timezone: string) {
      const current = currentState();
      // A temporary arithmetic view excludes exactly this verified hold. The
      // original durable ledger continues to hold the money throughout.
      return new BudgetLedger({ spend: current.spend, reservations: current.reservations.filter(entry => entry.id !== reservation.id) })
        .snapshot(limits, nowMs, timezone);
    },
  });
}
