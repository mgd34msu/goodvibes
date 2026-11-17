import { decisionOrClassic } from '../runtime/decision-policy.js';
/**
 * order-correlation.ts, recognising the store's confirmation when it arrives.
 *
 * ══ This CORRELATES. It does not gate ═════════════════════════════════════
 *
 * An earlier design registered an expectation for the confirmation, the way a
 * signup registers one for a verification link. That was the wrong instrument
 * and it is worth saying why, because the two look alike.
 *
 * An expectation exists to AUTHORIZE. A verification link lets an agent do
 * something, click through and complete a signup, so it must have been asked
 * for in advance, correlated to an address minted for that one service, and
 * expired aggressively. `google/verification-expectations.ts` is built entirely
 * around that, and its own header names the excluded cases: a password reset
 * nobody asked for, a security alert, AN INVOICE. An order confirmation is
 * invoice-shaped, it arrives at the owner's real address rather than a minted
 * alias, and nothing is authorized by it. Adding it there would have widened
 * exactly the hole that module keeps small.
 *
 * Telling the owner that a piece of mail arrived requires no authorization at
 * all. The general inbound path already records unexpected mail and reports it.
 * All this module adds is recognition: when mail arrives from a domain we
 * bought something at moments ago, the owner should read "this is the order you
 * approved" rather than an unrelated receipt they have to place themselves.
 *
 * So: no registration, no interception, no expiry, nothing held. A lookup
 * against the purchase records that are being written anyway.
 *
 * ══ Matching is on OUR record, never on the mail's claims ═════════════════
 *
 * The mail proposes a sender domain, an arrival time and some text. The
 * candidates come from the purchase ledger: a message claiming to be from a
 * merchant we never bought from correlates to nothing, and a message from a
 * merchant we DID buy from still cannot alter what we recorded, it can only be
 * recognised as relating to it.
 *
 * The sender domain is compared as a REGISTRABLE DOMAIN computed by us from the
 * envelope, against the registrable domain we computed from the validated
 * checkout url. Stores routinely send from a different subdomain than they sell
 * from, `order-update.example.com` for a purchase at `www.example.com`, so
 * subdomains of the same registrable domain match, and a different registrable
 * domain does not, however similar it looks. Mail that arrived before the
 * purchase cannot be its confirmation, whatever it says.
 *
 * Whether a same-domain mail is ABOUT one of the purchases there (its
 * confirmation, receipt, shipping or delivery update) is read by Jev once per
 * mail (`engine.payments.order-mail`), as one selection over the recent
 * purchases at that shop. It replaces a six-hour window, which matched a
 * promotion from the same shop minutes later and missed a shipping notice the
 * next day, and a reading per past purchase, whose cost grew with every order
 * ever placed at the shop. Only purchases from the last RECENT_PURCHASE_DAYS
 * days are candidates, newest first, at most MAX_PURCHASE_CANDIDATES of them.
 *
 * ══ Which OUTCOMES are eligible, and what a match changes ════════════════
 *
 * A record only correlates when the click was actually issued: `purchased` and
 * `submitted-unverified` both mean the submit reached the driver, and only
 * those two are checked below. Every refused or cancelled outcome never
 * clicked submit, so mail from that domain arriving afterward is not that
 * purchase's confirmation, whatever it claims; it is unrelated mail, which the
 * general inbound path still records and reports on its own.
 *
 * `submitted-unverified` is deliberately INCLUDED rather than treated as not
 * yet a real purchase. It is exactly the outcome whose report already tells
 * the owner "check your order history at this merchant", and a piece of mail
 * from that same merchant about that order is the single strongest signal
 * available that it went through, so it is the case where recognition is most
 * worth doing, not least.
 *
 * This module only recognises mail; it writes nothing. A `matched` result
 * carries the record as stored. What follows from a match against a
 * `submitted-unverified` record is the reporter's step
 * (`confirmation-report.ts`): it moves that one record, and its operation, to
 * `purchased` with the mail's order number, once, unless the owner has
 * already recorded a finding of their own. The mail can settle that a
 * submission went through; it never changes an amount, a card or a merchant
 * on our record.
 *
 * ══ No card material reaches a reading ════════════════════════════════════
 *
 * The subject and body have every card-shaped span redacted
 * (`redactCardShapes`, code alone: card numbers by the Luhn checksum,
 * security codes and expiry dates where the words before them label them)
 * before any reading here sees them.
 *
 * ══ Without a decision model ══════════════════════════════════════════════
 *
 * Code still finds the candidates (same registrable domain, after the
 * purchase, within the horizon), and ties the mail to one of them when the
 * merchant's order number we recorded appears in it as a whole token. What
 * the mail says is not read, so the result is `unread`: the reporter asks the
 * owner about it (confirmation-report.ts) and settles nothing on its own. The
 * confirmation facts are then all null and a refund is never recognised.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Selector } from '@goodvibes-jev/judgment';
import { redactCardShapes } from '../security/card-shapes.js';
import { registrableDomain } from '../security/public-suffix.js';
import { sanitizeNoticeField } from '../security/notice-text.js';
import {
  clipMail,
  identifierCandidates,
  identifierContext,
  orderMail,
  orderNumber,
  refundMail,
  SHIP_DATE_ROLE,
  shipDate,
  trackingReference,
  type OrderMailCandidate,
  type OrderMailContext,
} from './batteries/confirmation.js';
import type { PurchaseRecord } from './checkout-flow.js';

/** The decision sites the confirmation readings are logged under. */
export const ORDER_MAIL_SITE = 'payments.order-mail';
export const CONFIRMATION_FACTS_SITE = 'payments.confirmation-facts';

/** How far back a purchase can still be the subject of a shop's mail: past any delivery horizon. */
export const RECENT_PURCHASE_DAYS = 60;
const RECENT_PURCHASE_MS = RECENT_PURCHASE_DAYS * 24 * 60 * 60 * 1000;
/** Most purchases one order-mail selection offers, newest first. */
const MAX_PURCHASE_CANDIDATES = 20;

const CORRELATABLE_OUTCOMES: ReadonlySet<string> = new Set(['purchased', 'submitted-unverified']);

export interface InboundMailFacts {
  /** The envelope sender, as the mail surface parsed it. */
  readonly senderAddress: string;
  readonly receivedAtMs: number;
  readonly subject: string;
  /** The body as text. Card-shaped spans are redacted here before any reading. */
  readonly body: string;
}

export type CorrelationResult =
  | { readonly kind: 'matched'; readonly record: PurchaseRecord; readonly senderDomain: string }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly PurchaseRecord[]; readonly senderDomain: string }
  /**
   * No decision model is in use: the mail came from a shop with recent
   * purchases, and nothing read what it says. `orderNumberMatched` when code
   * found the recorded order number in it, which ties it to that one purchase.
   */
  | { readonly kind: 'unread'; readonly candidates: readonly PurchaseRecord[]; readonly senderDomain: string; readonly orderNumberMatched: boolean }
  | { readonly kind: 'unrelated'; readonly reason: string };

/** The purchases whose recorded order number the mail carries as a whole token. */
function orderNumberMatches(records: readonly PurchaseRecord[], mail: { readonly subject: string; readonly body: string }): PurchaseRecord[] {
  const text = `${mail.subject}\n${mail.body}`.toLowerCase();
  return records.filter((record) => {
    const id = record.merchantOrderId?.trim().toLowerCase();
    if (id === undefined || id.length < 4) return false;
    let from = 0;
    for (let at = text.indexOf(id); at !== -1; at = text.indexOf(id, from)) {
      const before = text[at - 1], after = text[at + id.length];
      if ((before === undefined || !/[\p{L}\p{N}]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}]/u.test(after))) return true;
      from = at + 1;
    }
    return false;
  });
}

/** The registrable domain of an email address, or null when it has none. */
export function senderRegistrableDomain(address: string): string | null {
  const at = address.lastIndexOf('@');
  if (at === -1 || at === address.length - 1) return null;
  return registrableDomain(address.slice(at + 1).trim().toLowerCase());
}

/** The mail with card-shaped spans redacted, and its body cut to what one reading takes. */
function redactedMail(mail: Pick<InboundMailFacts, 'subject' | 'body'>): { subject: string; body: string; clipped: boolean } {
  const clipped = clipMail(redactCardShapes(mail.body));
  return { subject: redactCardShapes(mail.subject), body: clipped.text, clipped: clipped.clipped };
}

function purchaseCandidate(record: PurchaseRecord, index: number): OrderMailCandidate {
  return {
    id: `p${index}`,
    content: {
      item: record.item,
      total: `${record.totalMinorUnits} minor units of ${record.currency}`,
      placed_at: record.atUtc,
      outcome: record.outcome,
    },
  };
}

/**
 * Find the purchase this mail is about, or say it is about none of them.
 *
 * Returns `ambiguous` rather than choosing when the mail reads as about two
 * purchases at the same merchant. Naming the wrong order in a message about
 * money is worse than not naming one, and the general inbound path still
 * reports the mail either way.
 */
export async function correlatePurchaseMail(
  mail: InboundMailFacts,
  records: readonly PurchaseRecord[],
): Promise<CorrelationResult> {
  const senderDomain = senderRegistrableDomain(mail.senderAddress);
  if (senderDomain === null) {
    return { kind: 'unrelated', reason: 'The sender address has no registrable domain to compare.' };
  }

  const eligible = records.filter((record) => {
    if (record.merchantDomain !== senderDomain) return false;
    if (!CORRELATABLE_OUTCOMES.has(record.outcome)) return false;
    const purchasedAtMs = Date.parse(record.atUtc);
    if (Number.isNaN(purchasedAtMs)) return false;
    // Strictly after the purchase: mail that predates the charge cannot be its
    // confirmation, however close it lands. A purchase older than any delivery
    // horizon is not what a shop's mail today is about.
    return mail.receivedAtMs >= purchasedAtMs && mail.receivedAtMs - purchasedAtMs <= RECENT_PURCHASE_MS;
  }).sort((a, b) => Date.parse(b.atUtc) - Date.parse(a.atUtc)).slice(0, MAX_PURCHASE_CANDIDATES);
  if (eligible.length === 0) {
    return {
      kind: 'unrelated',
      reason: `Nothing was bought at ${senderDomain} in the ${RECENT_PURCHASE_DAYS} days before this mail arrived.`,
    };
  }

  const redacted = redactedMail(mail);
  return decisionOrClassic(() => readOrderMail(senderDomain, eligible, mail, redacted), (): CorrelationResult => {
    const tied = orderNumberMatches(eligible, redacted);
    return { kind: 'unread', candidates: tied.length > 0 ? tied : eligible, senderDomain, orderNumberMatched: tied.length === 1 };
  });
}

async function readOrderMail(senderDomain: string, eligible: readonly PurchaseRecord[], mail: InboundMailFacts,
  redacted: { readonly subject: string; readonly body: string }): Promise<CorrelationResult> {
  const context: OrderMailContext = {
    merchant: senderDomain,
    mail: { subject: redacted.subject, body: redacted.body, received_at: new Date(mail.receivedAtMs).toISOString() },
  };
  const candidates = eligible.map(purchaseCandidate);
  const selection = await orderMail.select(judgmentPort(ORDER_MAIL_SITE), context, candidates, { site: ORDER_MAIL_SITE });
  // The mail fits two purchases when two fit readings act on yes; naming one
  // of them in a message about money would be a guess.
  const fitting = eligible.filter((_, index) => {
    const fit = selection.fits[candidates[index]?.id ?? ''];
    return fit?.verdict === 'yes' && fit.outcome === 'act';
  });
  if (fitting.length > 1) {
    selection.recordAction('about more than one purchase');
    return { kind: 'ambiguous', candidates: fitting, senderDomain };
  }
  const chosen = selection.outcome === 'act' && selection.chosen !== undefined
    ? eligible[candidates.findIndex((candidate) => candidate.id === selection.chosen)]
    : undefined;
  if (chosen === undefined) {
    selection.recordAction('not about a recorded purchase');
    return {
      kind: 'unrelated',
      reason: `This mail from ${senderDomain} is not about anything bought there.`,
    };
  }
  selection.recordAction(`about purchase ${chosen.purchaseId}`);
  return { kind: 'matched', record: chosen, senderDomain };
}

/**
 * The three facts worth lifting out of a confirmation, and nothing else.
 *
 * ── Why extraction rather than quoting ────────────────────────────────────
 *
 * The body arrives from outside at the exact moment the owner is expecting it,
 * which makes it the most attractive thing on this whole path for an attacker
 * to forge. Rendering any span of it into a message the owner reads on their
 * phone hands whoever wrote it a channel to them.
 *
 * So only three short values are lifted, each neutralised before it can be
 * rendered, and nothing else survives. Jev reads which identifier in the body
 * is the order number and which the tracking reference, from the tokens code
 * lists (`identifierCandidates`), and when the order ships or is due, as date
 * parts code assembles (batteries/confirmation.ts). A value whose reading does
 * not act is null, and the report simply carries no order number, which is a
 * strictly better outcome than quoting a line to be helpful.
 *
 * Note what is deliberately NOT extracted: the total. We have our own, computed
 * from integers we parsed, and a total taken from the email would be a number
 * an attacker chose sitting next to the words "charged to your card".
 */
export interface ConfirmationFacts {
  readonly orderNumber: string | null;
  /** When the order ships or is due, as YYYY-MM-DD. */
  readonly shipDate: string | null;
  readonly trackingReference: string | null;
}

/**
 * The candidate `selector` picks, or null. A pick that does not act is no
 * pick: the report goes out without that identifier rather than not at all.
 * The selector itself offers a long candidate list in groups.
 */
async function pickIdentifier(
  selector: Selector,
  candidates: readonly { readonly id: string; readonly content: { readonly token: string; readonly around: string } }[],
  context: { readonly subject: string; readonly source: string },
): Promise<string | null> {
  if (candidates.length === 0) return null;
  const selection = await selector.select(judgmentPort(CONFIRMATION_FACTS_SITE), context, candidates, { site: CONFIRMATION_FACTS_SITE });
  const chosen = selection.outcome === 'act' && selection.chosen !== undefined
    ? candidates.find((candidate) => candidate.id === selection.chosen)
    : undefined;
  selection.recordAction(chosen === undefined ? 'none' : 'picked');
  return chosen?.content.token ?? null;
}

/** YYYY-MM-DD of a millisecond time, in UTC. */
const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/**
 * Pull the structured facts out of a confirmation.
 *
 * Takes the raw text and returns only neutralised short values. The caller must
 * never pass the body itself onward; there is deliberately no field on the
 * result that could carry it. `receivedAtMs` anchors relative dates such as
 * "arriving tomorrow".
 */
export async function extractConfirmationFacts(mail: Pick<InboundMailFacts, 'subject' | 'body' | 'receivedAtMs'>): Promise<ConfirmationFacts> {
  const none: ConfirmationFacts = { orderNumber: null, shipDate: null, trackingReference: null };
  const { subject, body, clipped } = redactedMail(mail);
  // A body longer than one reading takes may hold its references past the
  // cut; the report goes out with our own record and no identifiers rather
  // than with a reference read from part of the mail.
  if (clipped) return none;
  // Without a decision model nothing is lifted: the report carries our record alone.
  return decisionOrClassic(() => readConfirmationFacts(subject, body, mail.receivedAtMs), () => none);
}

async function readConfirmationFacts(subject: string, body: string, receivedAtMs: number): Promise<ConfirmationFacts> {
  const candidates = identifierCandidates(body);
  const context = identifierContext(subject);
  const [order, tracking, date] = await Promise.all([
    pickIdentifier(orderNumber, candidates, context),
    pickIdentifier(trackingReference, candidates, context),
    shipDate.extract(judgmentPort(CONFIRMATION_FACTS_SITE), body, SHIP_DATE_ROLE, utcDay(receivedAtMs), { site: CONFIRMATION_FACTS_SITE }),
  ]);
  const clean = (value: string | null, max: number): string | null => {
    if (value === null) return null;
    // A token longer than any real reference is left out, not allowed to sink the report.
    if (value.length > max) return null;
    const neutralised = sanitizeNoticeField(value, max);
    return neutralised.length === 0 ? null : neutralised;
  };
  const shipDateValue = date.outcome === 'act' ? date.date : null;
  date.recordAction(shipDateValue === null ? 'no ship date' : 'ship date taken');
  return {
    orderNumber: clean(order, 40),
    shipDate: clean(shipDateValue, 40),
    trackingReference: clean(tracking, 60),
  };
}

/** The decision site the refund reading is logged under. */
export const REFUND_MAIL_SITE = 'payments.refund-mail';

/**
 * Whether a mail already matched to `record` says that purchase was refunded.
 * Only a reading that acts on yes counts; without a decision model nothing
 * reads it, so it is false and the reporter asks the owner instead.
 */
export async function readRefundMail(mail: Pick<InboundMailFacts, 'subject' | 'body'>, record: PurchaseRecord): Promise<boolean> {
  return decisionOrClassic(() => readRefund(mail, record), () => false);
}

async function readRefund(mail: Pick<InboundMailFacts, 'subject' | 'body'>, record: PurchaseRecord): Promise<boolean> {
  const { subject, body } = redactedMail(mail);
  const run = await refundMail.run(judgmentPort(REFUND_MAIL_SITE), {
    mail: { subject, body },
    purchase: { item: record.item, total: `${record.totalMinorUnits} minor units of ${record.currency}` },
  }, { site: REFUND_MAIL_SITE });
  const reading = run.readings.refunded;
  const refunded = reading.verdict === 'yes' && reading.outcome === 'act';
  run.recordAction(refunded ? `refund of purchase ${record.purchaseId}` : 'not a refund');
  return refunded;
}
