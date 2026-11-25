/**
 * confirmation-report.ts, telling the owner which approved purchase a store's
 * mail confirms.
 *
 * Mail on the owner's mailbox is read against the purchase ledger. When the
 * reading ties it to exactly one purchase, the owner gets a short report built
 * from OUR record plus three neutralised identifiers lifted from the mail
 * (order number, ship date, tracking). A mail that says the purchase was
 * refunded records `refundedAt` on it and gets a refund note instead. The mail
 * body never reaches the report.
 * A mail about no purchase, or about two, sends nothing: the general inbound
 * path already surfaces the mail itself.
 *
 * A purchase recorded as `submitted-unverified` (its landing page showed no
 * confirmation) is moved to `purchased` by the first mail tied to it, taking
 * the mail's order number when it has none, and that report says the order
 * went through. The move happens once, so the owner is told once.
 *
 * A refund or settlement note is owed to the owner in the same write that
 * records it, and settled once a channel took it; one that no channel took is
 * sent at the next start, so the owner is never left untold.
 *
 * Each purchase is reported once per kind of mail (confirmed, shipped,
 * delivered), worded by kind. The kind comes from the subject in code; a
 * purchase whose delivery was reported is no longer a candidate, so later shop
 * mail costs it no reading, and a kind already reported sends nothing and
 * costs no extraction.
 *
 * Without a decision model (none set, No Decision Model, or Hybrid after the
 * set model failed during this mail) what the mail says is not read. The
 * owner is asked instead, once per purchase and kind of subject: which
 * purchase it may be about, from our records, and to record an unverified
 * one's outcome in Waiting for you, under Purchases. Nothing is settled or refunded unread.
 */
import { correlatePurchaseMail, extractConfirmationFacts, readRefundMail, type InboundMailFacts } from './order-correlation.js';
import { renderConfirmationReport, renderRefundReport, renderUnreadOrderMail, type OrderMailKind } from './message.js';
import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import type { PurchaseRecord } from './purchase-record.js';
import { ownerSuppliedText, parseCurrencyCode } from './types.js';
import { logger } from '../utils/logger.js';

export type ConfirmationReportOutcome =
  | {
    readonly kind: 'reported';
    readonly purchaseId: string;
    readonly refund?: boolean | undefined;
    readonly mailKind?: OrderMailKind | undefined;
    /** True when this mail moved an unverified purchase to purchased. */
    readonly settled?: boolean | undefined;
    /** True when no decision model read the mail and the owner was asked about it instead. */
    readonly unread?: boolean | undefined;
  }
  | { readonly kind: 'not-reported'; readonly reason: 'unrelated' | 'ambiguous' | 'unreportable' | 'already-reported' };

const DELIVERED_SUBJECT = /\b(?:has been|was|got|been) delivered\b|^\s*delivered\b|\bdelivery (?:complete|confirmation)\b/i;
const SHIPPED_SUBJECT = /\b(?:shipped|dispatched|on (?:its|the) way|out for delivery|in transit|tracking)\b/i;

/**
 * The kind of order mail, read from its subject in code. A confirmation that
 * carries a tracking reference reports the shipment.
 */
export function orderMailKind(subject: string, trackingReference: string | null = null): OrderMailKind {
  if (DELIVERED_SUBJECT.test(subject)) return 'delivered';
  if (SHIPPED_SUBJECT.test(subject) || trackingReference !== null) return 'shipped';
  return 'confirmed';
}

/** What was already reported per purchase, and the write that records a new report. */
export interface OrderMailReports {
  /** Every purchase's reported kinds, read once per mail. */
  kinds(): ReadonlyMap<string, readonly OrderMailKind[]>;
  /** False when that kind was already recorded; then nothing is sent again. */
  record(purchaseId: string, kind: OrderMailKind): Promise<boolean>;
}

/** The bare address of a `From:` value: `Shop <orders@shop.example>` becomes `orders@shop.example`. */
export function mailboxAddress(from: string): string {
  const open = from.lastIndexOf('<');
  const close = from.indexOf('>', open + 1);
  return (open !== -1 && close !== -1 ? from.slice(open + 1, close) : from).trim();
}

interface ReportInput {
  readonly mail: InboundMailFacts;
  readonly purchases: readonly PurchaseRecord[];
  /**
   * Sends the report to the owner; true when a channel took it. A rejection
   * propagates so the caller can log it, except for a notice already owed.
   */
  readonly send: (message: string) => Promise<boolean>;
  /**
   * Records the refund time on the purchase, and the refund note the owner is
   * owed, in one write; false when one was already recorded, which sends
   * nothing again. Absent: refunds are not recognised.
   */
  readonly recordRefund?: ((purchaseId: string, refundedAt: string, ownerNotice: string) => Promise<boolean>) | undefined;
  /**
   * Moves an unverified purchase to `purchased` with the mail's order number,
   * and owes the owner the report saying so, in one write; true only on the
   * call that moved it. Absent: records are never upgraded.
   */
  readonly recordConfirmation?: ((purchaseId: string, orderNumber: string | null, ownerNotice: string) => Promise<boolean>) | undefined;
  /** A recorded refund or settlement notice reached a channel: it is no longer owed. */
  readonly settleNotice?: ((purchaseId: string, kind: 'refund' | 'settled') => Promise<void>) | undefined;
  /** Absent: every matching mail is reported (no memory across mails). */
  readonly reports?: OrderMailReports | undefined;
}

/**
 * Sends a notice already owed in the purchases file and settles it once a
 * channel took it. A send that fails or reaches no channel leaves it owed (it
 * is sent at the next start) and still resolves, so the mail is not read again
 * against a purchase that now reads as refunded or settled.
 */
async function tellOwed(input: ReportInput, purchaseId: string, kind: 'refund' | 'settled', message: string): Promise<void> {
  try {
    if (await input.send(message)) await input.settleNotice?.(purchaseId, kind);
  } catch (error) {
    logger.warn('A purchase notice from shop mail was not delivered; it stays owed and is sent at the next start', { kind, error: error instanceof Error ? error.name : 'unknown' });
  }
}

/** One mail is one decision-model operation: a model that fails partway leaves the rest of it unread. */
export function reportOrderConfirmation(input: ReportInput): Promise<ConfirmationReportOutcome> {
  return withConfiguredDecisionModelPolicy(() => reportOwned(input));
}

/**
 * The owner's question about a mail no decision model read, once per purchase
 * and subject kind; nothing is recorded on the purchase but that it was asked.
 */
async function askAboutUnreadMail(input: ReportInput, candidates: readonly PurchaseRecord[], senderDomain: string,
  orderNumberMatched: boolean): Promise<ConfirmationReportOutcome> {
  const kind = orderMailKind(input.mail.subject);
  const reportedKinds = input.reports?.kinds();
  const purchases = candidates.flatMap((record) => {
    const item = ownerSuppliedText(record.item, 'owner-direct');
    const currency = parseCurrencyCode(record.currency);
    if (item === null || currency === null || reportedKinds?.get(record.purchaseId)?.includes(kind)) return [];
    return [{ record, facts: { item, totalMinorUnits: record.totalMinorUnits, currency, cardLast4: record.cardLast4 },
      orderNumber: record.merchantOrderId, unverified: record.outcome === 'submitted-unverified' }];
  }).slice(0, 3);
  if (purchases.length === 0) return { kind: 'not-reported', reason: 'already-reported' };
  await input.send(renderUnreadOrderMail({ senderDomain, receivedAtMs: input.mail.receivedAtMs, purchases, orderNumberMatched }));
  if (input.reports !== undefined) for (const { record } of purchases) await input.reports.record(record.purchaseId, kind);
  const first = purchases[0]!;
  return { kind: 'reported', purchaseId: first.record.purchaseId, mailKind: kind, unread: true };
}

async function reportOwned(input: ReportInput): Promise<ConfirmationReportOutcome> {
  const reports = input.reports;
  const reportedKinds = reports?.kinds();
  // A purchase whose delivery was reported has nothing left to report.
  const open = reportedKinds === undefined ? input.purchases
    : input.purchases.filter(record => !reportedKinds.get(record.purchaseId)?.includes('delivered'));
  const correlation = await correlatePurchaseMail(input.mail, open);
  if (correlation.kind === 'unrelated') return { kind: 'not-reported', reason: 'unrelated' };
  if (correlation.kind === 'ambiguous') return { kind: 'not-reported', reason: 'ambiguous' };
  if (correlation.kind === 'unread') return askAboutUnreadMail(input, correlation.candidates, correlation.senderDomain, correlation.orderNumberMatched);
  const { record, senderDomain } = correlation;
  const item = ownerSuppliedText(record.item, 'owner-direct');
  const currency = parseCurrencyCode(record.currency);
  // A row that cannot be rendered as ours is not reported rather than reported with invented values.
  if (item === null || currency === null) return { kind: 'not-reported', reason: 'unreportable' };
  const facts = { item, totalMinorUnits: record.totalMinorUnits, currency, cardLast4: record.cardLast4 };
  if (input.recordRefund !== undefined && record.refundedAt === null) {
    const refunded = await readRefundMail(input.mail, record);
    // The set model failed on this mail (Hybrid): what it says is unread, so nothing is recorded from it.
    if (isClassicOperation()) return askAboutUnreadMail(input, [record], senderDomain, false);
    if (refunded) {
      const notice = renderRefundReport({ facts, senderDomain });
      const recorded = await input.recordRefund(record.purchaseId, new Date(input.mail.receivedAtMs).toISOString(), notice);
      if (recorded) await tellOwed(input, record.purchaseId, 'refund', notice);
      return { kind: 'reported', purchaseId: record.purchaseId, refund: true };
    }
  }
  const reported = reportedKinds?.get(record.purchaseId) ?? [];
  // An unverified purchase is read even when this kind was reported: the mail
  // is what settles it, and the move itself happens only once.
  const recordConfirmation = record.outcome === 'submitted-unverified' ? input.recordConfirmation : undefined;
  const unverified = recordConfirmation !== undefined;
  const subjectKind = orderMailKind(input.mail.subject);
  if (!unverified && reported.includes(subjectKind) && subjectKind !== 'confirmed') return { kind: 'not-reported', reason: 'already-reported' };
  if (!unverified && subjectKind === 'confirmed' && reported.includes('confirmed') && reported.includes('shipped')) {
    return { kind: 'not-reported', reason: 'already-reported' };
  }
  const confirmation = await extractConfirmationFacts(input.mail);
  if (isClassicOperation()) return askAboutUnreadMail(input, [record], senderDomain, false);
  const kind = orderMailKind(input.mail.subject, confirmation.trackingReference);
  const settledNotice = renderConfirmationReport({ facts, confirmation, senderDomain, kind, settled: true });
  const settled = recordConfirmation !== undefined && await recordConfirmation(record.purchaseId, confirmation.orderNumber, settledNotice);
  if (settled) await tellOwed(input, record.purchaseId, 'settled', settledNotice);
  else if (reported.includes(kind)) return { kind: 'not-reported', reason: 'already-reported' };
  else await input.send(renderConfirmationReport({ facts, confirmation, senderDomain, kind, settled: false }));
  if (reports !== undefined) await reports.record(record.purchaseId, kind);
  return { kind: 'reported', purchaseId: record.purchaseId, mailKind: kind, ...(settled ? { settled: true } : {}) };
}
