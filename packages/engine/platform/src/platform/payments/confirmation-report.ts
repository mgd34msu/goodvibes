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
 */
import { correlatePurchaseMail, extractConfirmationFacts, readRefundMail, type InboundMailFacts } from './order-correlation.js';
import { renderConfirmationReport, renderRefundReport } from './message.js';
import type { PurchaseRecord } from './purchase-record.js';
import { ownerSuppliedText, parseCurrencyCode } from './types.js';

export type ConfirmationReportOutcome =
  | { readonly kind: 'reported'; readonly purchaseId: string; readonly refund?: boolean | undefined }
  | { readonly kind: 'not-reported'; readonly reason: 'unrelated' | 'ambiguous' | 'unreportable' };

/** The bare address of a `From:` value: `Shop <orders@shop.example>` becomes `orders@shop.example`. */
export function mailboxAddress(from: string): string {
  const open = from.lastIndexOf('<');
  const close = from.indexOf('>', open + 1);
  return (open !== -1 && close !== -1 ? from.slice(open + 1, close) : from).trim();
}

export async function reportOrderConfirmation(input: {
  readonly mail: InboundMailFacts;
  readonly purchases: readonly PurchaseRecord[];
  /** Sends the report to the owner; a rejection propagates so the caller can log it. */
  readonly send: (message: string) => Promise<unknown>;
  /**
   * Records the refund time on the purchase; false when one was already
   * recorded, which sends nothing again. Absent: refunds are not recognised.
   */
  readonly recordRefund?: ((purchaseId: string, refundedAt: string) => Promise<boolean>) | undefined;
}): Promise<ConfirmationReportOutcome> {
  const correlation = await correlatePurchaseMail(input.mail, input.purchases);
  if (correlation.kind === 'unrelated') return { kind: 'not-reported', reason: 'unrelated' };
  if (correlation.kind === 'ambiguous') return { kind: 'not-reported', reason: 'ambiguous' };
  const { record, senderDomain } = correlation;
  const item = ownerSuppliedText(record.item, 'owner-direct');
  const currency = parseCurrencyCode(record.currency);
  // A row that cannot be rendered as ours is not reported rather than reported with invented values.
  if (item === null || currency === null) return { kind: 'not-reported', reason: 'unreportable' };
  const facts = { item, totalMinorUnits: record.totalMinorUnits, currency, cardLast4: record.cardLast4 };
  if (input.recordRefund !== undefined && record.refundedAt === null && await readRefundMail(input.mail, record)) {
    const recorded = await input.recordRefund(record.purchaseId, new Date(input.mail.receivedAtMs).toISOString());
    if (recorded) await input.send(renderRefundReport({ facts, senderDomain }));
    return { kind: 'reported', purchaseId: record.purchaseId, refund: true };
  }
  const confirmation = await extractConfirmationFacts(input.mail);
  await input.send(renderConfirmationReport({
    facts,
    confirmation,
    senderDomain,
  }));
  return { kind: 'reported', purchaseId: record.purchaseId };
}
