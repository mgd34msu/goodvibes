/**
 * confirmation-report.ts, telling the owner which approved purchase a store's
 * mail confirms.
 *
 * Mail on the owner's mailbox is read against the purchase ledger. When the
 * reading ties it to exactly one purchase, the owner gets a short report built
 * from OUR record plus three neutralised identifiers lifted from the mail
 * (order number, ship date, tracking). The mail body never reaches the report.
 * A mail about no purchase, or about two, sends nothing: the general inbound
 * path already surfaces the mail itself.
 */
import { correlatePurchaseMail, extractConfirmationFacts, type InboundMailFacts } from './order-correlation.js';
import { renderConfirmationReport } from './message.js';
import type { PurchaseRecord } from './purchase-record.js';
import { ownerSuppliedText, parseCurrencyCode } from './types.js';

export type ConfirmationReportOutcome =
  | { readonly kind: 'reported'; readonly purchaseId: string }
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
}): Promise<ConfirmationReportOutcome> {
  const correlation = await correlatePurchaseMail(input.mail, input.purchases);
  if (correlation.kind === 'unrelated') return { kind: 'not-reported', reason: 'unrelated' };
  if (correlation.kind === 'ambiguous') return { kind: 'not-reported', reason: 'ambiguous' };
  const { record, senderDomain } = correlation;
  const item = ownerSuppliedText(record.item, 'owner-direct');
  const currency = parseCurrencyCode(record.currency);
  // A row that cannot be rendered as ours is not reported rather than reported with invented values.
  if (item === null || currency === null) return { kind: 'not-reported', reason: 'unreportable' };
  const confirmation = await extractConfirmationFacts(input.mail);
  await input.send(renderConfirmationReport({
    facts: { item, totalMinorUnits: record.totalMinorUnits, currency, cardLast4: record.cardLast4 },
    confirmation,
    senderDomain,
  }));
  return { kind: 'reported', purchaseId: record.purchaseId };
}
