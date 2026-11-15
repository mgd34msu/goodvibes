/**
 * One answer to "can this payment host take a purchase right now".
 *
 * Each payment store stops itself when a write could not be confirmed or its
 * file changed underneath it, and stays stopped until the daemon restarts and
 * reads its files again. Each store reports that through `stopped()`; this
 * module reads them in one place, so purchase status, budget status and a new
 * purchase all name the same store, the same reason and the same next step.
 * A read is a few boolean checks (the purchase ledger re-reads its file).
 */
export interface PaymentStoreStop {
  /** Which store stopped, in the owner's terms. */
  readonly store: string;
  /** Why it stopped. */
  readonly reason: string;
  /** The file or directory to look at before restarting. */
  readonly path?: string | undefined;
}

export type PaymentStoreHealth = () => PaymentStoreStop | null;

/** The first store that has stopped itself, or null when every store is serving. */
export function paymentHostStop(stores: readonly PaymentStoreHealth[]): PaymentStoreStop | null {
  for (const store of stores) {
    let stop: PaymentStoreStop | null;
    try { stop = store(); } catch { stop = { store: 'a payment store', reason: 'its state could not be read' }; }
    if (stop) return stop;
  }
  return null;
}

/** The one sentence a stopped payment host answers with: what stopped, that nothing was lost, and the step. */
export function paymentHostStopSentence(stop: PaymentStoreStop): string {
  return `New purchases are paused: the ${stop.store} stopped itself because ${stop.reason}. `
    + 'Nothing already recorded was lost and no approval was spent. '
    + `Restart the daemon${stop.path ? ` after checking ${stop.path}` : ''}; it reads the payment files again when it starts.`;
}

/** How a status response shows a stopped store. */
export function paymentHostStopView(stop: PaymentStoreStop): { readonly store: string; readonly reason: string; readonly path?: string; readonly message: string } {
  return { store: stop.store, reason: stop.reason, ...(stop.path ? { path: stop.path } : {}), message: paymentHostStopSentence(stop) };
}

export class PaymentHostStoppedError extends Error {
  override readonly name = 'PaymentHostStoppedError';
  constructor(readonly stop: PaymentStoreStop) { super(paymentHostStopSentence(stop)); }
}
