/**
 * checkout-registry.ts, which purchase, if any, is in flight on a browser page.
 *
 * ══ What this is for ══════════════════════════════════════════════════════
 *
 * Two of the fill's refusals need an answer to "what was decided, and for
 * whom", and neither can be answered from the fill's own arguments:
 *
 *   - **Refuse a fill with no decision in flight.** The card is typed as part of
 *     an approved checkout or it is not typed. Without this, `fillCard` is a
 *     verb that types the owner's card into whatever page happens to be open,
 *     which is a strictly worse capability than the one it replaced.
 *   - **Refuse a fill into the wrong merchant.** The decision was made against
 *     one registrable domain. A page that has since navigated, or a second tab
 *     the model targeted by mistake, or a merchant page that framed someone
 *     else's form, is not that domain, and the card does not go there.
 *
 * ══ The phases exist for crash recovery ═══════════════════════════════════
 *
 * A checkout that dies partway must not leave an ambiguous state, and the only
 * genuinely ambiguous moment is the submit itself: once the request leaves, we
 * cannot tell from our side whether the merchant received it. Everything before
 * that is unambiguously "not submitted".
 *
 * So the phase is written durably as it changes, and `submit-pending` is written
 * and flushed BEFORE the submit is issued:
 *
 *   deciding        nothing has been typed. Crash ⇒ not submitted.
 *   awaiting-window the window is open, budget is reserved, no card typed.
 *                   Crash ⇒ not submitted.
 *   arming-payment  card material is on the page. Crash ⇒ not submitted, and
 *                   the material dies with the browser.
 *   submit-pending  written and flushed BEFORE the click. Crash ⇒ POSSIBLY
 *                   SUBMITTED. Reported as such and never retried.
 *   submitted       the merchant's response was seen. Crash ⇒ submitted.
 *
 * A record found in `submit-pending` at startup is the one case that needs a
 * human: the owner is told to check that merchant's order history, and nothing
 * automatic touches it. Retrying is how one order becomes two, and "it probably
 * did not go through" is not a thing this code is entitled to believe.
 */
import type { BudgetDraw } from './decide.js';
import type { ChannelDelivery } from './windows.js';
import type { CurrencyCode, MinorUnits, OwnerSuppliedText, ShippingStepDown, ShippingTier } from './types.js';

export type CheckoutPhase =
  | 'deciding'
  | 'awaiting-window'
  | 'arming-payment'
  | 'submit-pending'
  | 'submitted';

/** What a restart can conclude about a checkout it found mid-flight. */
export type InterruptedVerdict = 'not-submitted' | 'possibly-submitted' | 'submitted';

/**
 * A purchase in flight, bound to the browser page it is running on.
 *
 * `merchantDomain` is the registrable domain computed by us from the VALIDATED
 * checkout url, never a name the page supplied. It is the value the fill's
 * origin check compares against, so its provenance is the whole point.
 */
export interface InFlightCheckout {
  readonly purchaseId: string;
  readonly sessionId: string;
  readonly pageId: string;
  readonly merchantDomain: string;
  readonly cardId: string;
  readonly item: OwnerSuppliedText;
  readonly currency: CurrencyCode;
  readonly phase: CheckoutPhase;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
  /** Set once the decision layer has run. Null while still extracting. */
  readonly draw: BudgetDraw | null;
  readonly reservationId: string | null;
  readonly shippingTierRequested: ShippingTier;
  readonly shippingTierUsed: ShippingTier | null;
  readonly stepDown: ShippingStepDown | null;
  readonly totalMinorUnits: MinorUnits | null;
  /**
   * Set by boot recovery after it has told the owner about this record once.
   * A record recovery keeps (an unknowable submit, or a submitted record it
   * could not verify) would otherwise re-notify on every boot forever.
   * Optional so journals written before this field existed stay readable.
   */
  readonly recoveryNotifiedAtMs?: number | undefined;
  /**
   * The window notice's per-channel delivery report, persisted when the
   * window opens so a restart can apply `recoverInterruptedWindow`'s
   * delivery-keyed rules instead of guessing. Absent on records written
   * before these fields existed; recovery then settles conservatively.
   */
  readonly windowDeliveries?: readonly ChannelDelivery[] | undefined;
  /** The window's deadline instant, persisted alongside the deliveries. */
  readonly windowDeadlineMs?: number | undefined;
  /** Which window governed this checkout: approval (silence denies) or veto (silence proceeds). */
  readonly windowKind?: 'approval' | 'veto' | undefined;
}

/**
 * Durable storage for in-flight checkouts.
 *
 * A port rather than a file path so the flow can be exercised without a daemon
 * home, and so the flush point is explicit: `put` must not return until the
 * record would survive a power cut. An implementation that buffers turns the
 * `submit-pending` guarantee into a comment.
 */
export interface CheckoutJournal {
  put(record: InFlightCheckout): Promise<void>;
  remove(purchaseId: string): Promise<void>;
  list(): Promise<readonly InFlightCheckout[]>;
}

/** An in-memory journal. Durable across nothing; for tests and for a dry run. */
export class MemoryCheckoutJournal implements CheckoutJournal {
  private readonly records = new Map<string, InFlightCheckout>();

  async put(record: InFlightCheckout): Promise<void> {
    this.records.set(record.purchaseId, record);
  }

  async remove(purchaseId: string): Promise<void> {
    this.records.delete(purchaseId);
  }

  async list(): Promise<readonly InFlightCheckout[]> {
    return [...this.records.values()];
  }
}

export class CheckoutRegistryError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
    this.name = 'CheckoutRegistryError';
  }
}

/** Retain owned records: neither a caller nor a journal may later retarget a
 * purchase/page or mutate the budget and window evidence visible to a fill. */
function ownCheckout(record: InFlightCheckout): InFlightCheckout {
  return Object.freeze({ ...record,
    draw: record.draw === null ? null : Object.freeze({ ...record.draw }),
    stepDown: record.stepDown === null ? null : Object.freeze({ ...record.stepDown }),
    ...(record.windowDeliveries === undefined ? {} : {
      windowDeliveries: Object.freeze(record.windowDeliveries.map(delivery => Object.freeze({ ...delivery }))),
    }),
  });
}


/**
 * The live map of page → purchase, backed by a journal.
 *
 * One checkout per page, enforced: a second `open` for a page already running
 * one throws rather than replacing it. Two purchases driving one page would
 * interleave their fills and their submits, and the cheapest way to guarantee
 * that cannot happen is to make it unrepresentable.
 */

export class CheckoutRegistry {
  readonly #byPage = new Map<string, Map<string, InFlightCheckout>>();
  readonly #byPurchase = new Map<string, InFlightCheckout>();
  readonly #writing = new Set<string>();

  constructor(private readonly journal: CheckoutJournal) {}

  private assertWritable(purchaseId: string): void {
    if (this.#writing.has(purchaseId)) throw new CheckoutRegistryError(
      'This purchase has a journal write in progress.', 'Wait for the current checkout operation to finish.');
  }

  private forget(record: InFlightCheckout): void {
    const pages = this.#byPage.get(record.sessionId);
    if (pages?.get(record.pageId) === record) {
      pages.delete(record.pageId);
      if (pages.size === 0) this.#byPage.delete(record.sessionId);
    }
    if (this.#byPurchase.get(record.purchaseId) === record) this.#byPurchase.delete(record.purchaseId);
  }

  async open(record: InFlightCheckout): Promise<InFlightCheckout> {
    const owned = ownCheckout(record);
    this.assertWritable(owned.purchaseId);
    const pages = this.#byPage.get(owned.sessionId) ?? new Map<string, InFlightCheckout>();
    const existing = pages.get(owned.pageId);
    if (existing !== undefined) {
      throw new CheckoutRegistryError(
        `A purchase is already in flight on this page (${existing.purchaseId}).`,
        'Finish or abandon that purchase before starting another on the same page.',
      );
    }
    if (this.#byPurchase.has(owned.purchaseId)) throw new CheckoutRegistryError(
      'This purchase is already in flight on another page.', 'Use the original purchase and page.');
    // Reserve both exact identities before yielding, but current() cannot grant
    // a fill against an unflushed record. Recovery also skips this owned write.
    this.#byPage.set(owned.sessionId, pages);
    pages.set(owned.pageId, owned);
    this.#byPurchase.set(owned.purchaseId, owned);
    this.#writing.add(owned.purchaseId);
    try {
      await this.journal.put(owned);
      return owned;
    } catch (error) {
      this.forget(owned);
      throw error;
    } finally { this.#writing.delete(owned.purchaseId); }
  }

  /** The durably published checkout on this exact page, or null while changing. */
  current(sessionId: string, pageId: string): InFlightCheckout | null {
    const record = this.#byPage.get(sessionId)?.get(pageId);
    return record === undefined || this.#writing.has(record.purchaseId) ? null : record;
  }

  /** Flush every phase before publishing it to card-fill or submission readers.
   * A failed write leaves the last durable phase intact. Concurrent writers
   * refuse rather than let an older write overwrite a later phase/close. */
  async advance(
    purchaseId: string,
    phase: CheckoutPhase,
    patch: Partial<Omit<InFlightCheckout, 'purchaseId' | 'sessionId' | 'pageId' | 'phase'>> = {},
    nowMs: number = Date.now(),
  ): Promise<InFlightCheckout> {
    this.assertWritable(purchaseId);
    const record = this.#byPurchase.get(purchaseId);
    if (record === undefined) {
      throw new CheckoutRegistryError(
        `No purchase with id ${purchaseId} is in flight.`,
        'Start a checkout before advancing it.',
      );
    }
    const pages = this.#byPage.get(record.sessionId);
    if (pages === undefined || pages.get(record.pageId) !== record) throw new CheckoutRegistryError(
      'The purchase page owner is unavailable.', 'Inspect the purchase before trying again.');
    const next = ownCheckout({ ...record, ...patch,
      purchaseId: record.purchaseId, sessionId: record.sessionId, pageId: record.pageId,
      phase, updatedAtMs: nowMs });
    this.#writing.add(purchaseId);
    try {
      await this.journal.put(next);
      this.#byPurchase.set(purchaseId, next);
      pages.set(record.pageId, next);
      return next;
    } finally { this.#writing.delete(purchaseId); }
  }

  /** Keep the page reserved until removal finishes; a failed removal keeps its owner. */
  async close(purchaseId: string): Promise<void> {
    this.assertWritable(purchaseId);
    const record = this.#byPurchase.get(purchaseId);
    this.#writing.add(purchaseId);
    try {
      await this.journal.remove(purchaseId);
      if (record !== undefined) this.forget(record);
    } finally { this.#writing.delete(purchaseId); }
  }

  /** Journal entries already owned by this process, including pending durable
   * writes, are never interrupted purchases for a recovery sweep to release. */
  async interrupted(): Promise<readonly { record: InFlightCheckout; verdict: InterruptedVerdict }[]> {
    const records = await this.journal.list();
    return records
      .filter(record => !this.#byPurchase.has(record.purchaseId) && !this.#writing.has(record.purchaseId))
      .map(record => ({ record, verdict: verdictFor(record.phase) }));
  }
}

/**
 * What a restart may conclude from a phase.
 *
 * `submit-pending` is the honest answer to a question we cannot answer, and it
 * is deliberately not called "failed". A checkout that reached this phase had
 * everything ready and a submit issued or about to be; treating it as failed is
 * what makes a restart buy the same thing twice.
 */
export function verdictFor(phase: CheckoutPhase): InterruptedVerdict {
  switch (phase) {
    case 'submitted':
      return 'submitted';
    case 'submit-pending':
      return 'possibly-submitted';
    default:
      return 'not-submitted';
  }
}

/**
 * What the owner is told about a checkout that a crash interrupted.
 *
 * Rendered from the record's own typed fields, never from anything the merchant
 * page said, for the same reason every other payment notice is
 * (message.ts), a page that can write this text writes what the owner reads.
 */
export function describeInterruption(
  record: InFlightCheckout,
  verdict: InterruptedVerdict,
  options: {
    /** Whether the budget hold was actually released; the sentence follows the fact. */
    readonly reservationReleased?: boolean | undefined;
    /**
     * `true`: the purchase record was found on the ledger. `false`: it was
     * looked for and is missing. `undefined`: this composition cannot look.
     */
    readonly recordVerified?: boolean | undefined;
  } = {},
): string {
  if (verdict === 'submitted') {
    if (options.recordVerified === true) {
      return `The order at ${record.merchantDomain} was submitted before the restart and its purchase record is on the ledger.`;
    }
    if (options.recordVerified === false) {
      return (
        `The journal says an order at ${record.merchantDomain} was submitted before the restart, but no `
        + 'purchase record exists for it. The card may have been charged without the ledger seeing it. '
        + 'I am keeping the journal entry and any budget hold; check your order history at that merchant.'
      );
    }
    return (
      `The journal says an order at ${record.merchantDomain} was submitted before the restart. This `
      + 'setup cannot verify the purchase record, so I am keeping the journal entry; check your order '
      + 'history at that merchant.'
    );
  }
  if (verdict === 'not-submitted') {
    // The budget sentence follows what actually happened to the hold, and a
    // record that never took one gets no hold sentence at all.
    const budgetSentence = record.reservationId === null
      ? 'Nothing was charged.'
      : options.reservationReleased === true
        ? 'Nothing was charged and the budget it was holding has been released.'
        : 'Nothing was charged. The hold it took did not survive the restart, so the daily pool no longer holds it.';
    return (
      `A checkout at ${record.merchantDomain} was interrupted before anything was submitted. `
      + budgetSentence
    );
  }
  if (options.recordVerified === true) {
    return (
      `A checkout at ${record.merchantDomain} stopped at the point of submitting, but its purchase `
      + 'record is on the ledger: the order completed and is recorded. Its journal entry is closed.'
    );
  }
  return (
    `A checkout at ${record.merchantDomain} stopped at the point of submitting, either the process `
    + 'ended there or the merchant was still verifying the order. I cannot tell whether the order '
    + 'went through, so I am keeping its record and its budget hold and will not retry it. Check '
    + `your order history at ${record.merchantDomain}; the purchase list here only shows it if it `
    + 'completed before the stop.'
  );
}
