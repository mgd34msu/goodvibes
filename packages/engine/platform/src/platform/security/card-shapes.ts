/**
 * card-shapes.ts, find card-shaped content in untrusted text WITHOUT ever
 * handing the matched characters back (docs/decisions/2026-07-27-inbound-email-design.md §11.0).
 *
 * Two consumers, two different answers to the same detection:
 *
 *  - **Remote messaging channels** (`daemon/surface-card-gate.ts`), a message
 *    carrying card shapes is REFUSED at `authorizeSurfaceIngress`, before
 *    anything downstream can store, log or transcribe it. Design rule this
 *    enforces: card details are entered at a local terminal or in the webui,
 *    never over a remote messaging channel.
 *  - **Inbound mail** (`email/inbound/record-store.ts`), mail is REDACTED, not
 *    refused. Order confirmations legitimately carry long digit runs and they
 *    are the consumer the inbound-mail capability exists to serve; refusing
 *    them would break it. Only the digits fail to reach disk. Mail is
 *    redacted by code alone (`redactCardShapes`): no model is asked.
 *
 * The distinction a later reader will try to collapse, written in the terms
 * §11.0 asks for: approvals and vetoes for purchases DO work over remote
 * channels, that is the owner's explicit ruling and it stays. Remote surfaces
 * have authority to say yes or no about a purchase; they have no path for
 * entering the instrument. Authority over a decision is not a channel for a
 * secret. These two must not be unified.
 *
 * ## Why the finding carries no text
 *
 * This is docs/decisions/2026-07-27-inbound-email-design.md §7.3 applied to a result type rather than to a
 * constructor: `CardShapeFinding` carries POSITION and KIND, never the matched
 * characters. A refusal message composed from findings is therefore
 * *structurally* incapable of quoting a card number, the digits are not
 * something a caller must remember not to log, they are not reachable from the
 * result at all. The `@ts-expect-error` guards at the bottom of this file exist
 * so that adding a value-bearing field fails the build rather than passing
 * silently.
 *
 * ## What is code and what is read
 *
 * A card number is code: a 13 to 19 digit run that passes the Luhn checksum.
 * That is the definition of a card number's shape, and asking a model instead
 * would send the digits off the machine, which is the exposure this module
 * exists to prevent.
 *
 * Whether a bare three or four digit number is a card's security code, or an
 * `MM/YY` pair is its expiry, is a question about what the message says. Jev
 * reads it (`engine.security.card-talk`) from the message with every digit
 * replaced by `#`, in place of the card-context keyword regex this module
 * used; anything short of a confident no counts as yes.
 *
 * ## Refusal rule
 *
 * `detectCardShapes` only ever emits a `security-code` or `expiry` finding when
 * the reading says the message gives one, so the refusal rule collapses to the
 * simplest form there is: **refuse if the finding list is non-empty**. See
 * `hasRefusableCardShapes`.
 */
import { judgmentPort, runDecisionOrClassic as decisionOrClassic } from '@goodvibes-jev/engine/errors';
import { createHash } from 'node:crypto';
import { cardTalk, maskDigits } from './batteries/card-talk.js';

/** The decision site the card-talk reading is logged under. */
export const CARD_TALK_SITE = 'security.card-shapes';

/** What a finding matched. Never the characters it matched. */
export type CardShapeKind = 'pan' | 'security-code' | 'expiry';

/**
 * One card-shaped span, located but not quoted.
 *
 * `startIndex` and `length` index the ORIGINAL text (separators included), so
 * `text.slice(startIndex, startIndex + length)` reconstructs the span for a
 * caller that has the text anyway, for example the redactor below, which is
 * the only caller in the codebase that needs to. Nothing is carried across a
 * boundary that did not already hold the text.
 */
export interface CardShapeFinding {
  readonly provenance?: 'classic';
  readonly kind: CardShapeKind;
  readonly startIndex: number;
  readonly length: number;
  // Deliberately NO value, text or digits field. See the module header and the
  // compile-time guards at the bottom of this file.
}

const MIN_PAN_DIGITS = 13;
const MAX_PAN_DIGITS = 19;

/**
 * A maximal run of digits joined only by SPACES and HYPHENS, starting and
 * ending on a digit, `4111 1111 1111 1111`, `4111-1111-1111-1111`,
 * `4111111111111111`.
 *
 * Newlines and tabs are deliberately not separators. A card number is not
 * typed across lines, and treating a newline as a join would weld unrelated
 * numbers from adjacent lines into one run, which is how a shape detector
 * starts refusing ordinary messages.
 */
const PAN_RUN = /\d[\d -]*\d/g;

/**
 * A bare three- or four-digit run. The word boundaries make this "a run of
 * EXACTLY three or four digits" rather than "any three digits", so it does not
 * fire inside a longer number. A candidate only; it becomes a finding when the
 * reading says the message gives a card's security code.
 */
const BARE_SHORT_DIGIT_RUN = /\b\d{3,4}\b/g;

/**
 * `MM/YY` and `MM/YYYY`, with `-` accepted alongside `/` and optional spaces.
 * The month is range-checked (01-12) so ordinary fractions and ratios do not
 * match. A candidate only; it becomes a finding when the reading says the
 * message gives a card's expiry.
 */
const EXPIRY_PAIR = /\b(?:0[1-9]|1[0-2])\s*[/-]\s*(?:\d{4}|\d{2})\b/g;

/** The Luhn check digit algorithm. The sole discriminator for a `pan`. */
export function passesLuhn(digits: string): boolean {
  if (digits.length === 0) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    const code = digits.charCodeAt(index) - 48;
    if (code < 0 || code > 9) return false;
    let value = code;
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

interface Span {
  readonly startIndex: number;
  readonly length: number;
}

function overlaps(span: Span, others: readonly Span[]): boolean {
  const end = span.startIndex + span.length;
  return others.some((other) => {
    const otherEnd = other.startIndex + other.length;
    return span.startIndex < otherEnd && other.startIndex < end;
  });
}

/** One unbroken block of digits inside a separator-joined run. */
interface DigitGroup {
  readonly startIndex: number;
  readonly digits: string;
}

/** Smallest and largest group a card is ever WRITTEN in: `4111 1111 1111 1111` (4), amex `3782 822463 10005` (6, then 5). */
const MIN_GROUPED_PAN_GROUP = 4;
const MAX_GROUPED_PAN_GROUP = 6;

interface PanCandidate {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly digits: string;
}

/**
 * Candidate PAN spans inside one separator-joined run, as group windows.
 *
 * Taking the whole maximal run and nothing else was the first implementation
 * here and it is wrong in the most ordinary case there is: `4111111111111111
 * 07/29` welds the sixteen-digit card to the `07` that follows it, giving an
 * eighteen-digit string that fails Luhn, so a card number pasted with its
 * expiry right after it went undetected entirely. A separator-joined run is not
 * one number; it is a sequence of groups that happen to be adjacent.
 *
 * Sliding a window at DIGIT granularity is the opposite error and is worse: any
 * sixteen-digit window of arbitrary digits passes Luhn about one time in ten,
 * so long order and tracking numbers would start being refused. Three candidate
 * forms, at GROUP granularity, cover how cards are actually written without
 * paying that:
 *
 *  1. **A single group** of 13-19 digits, a card pasted solid, by far the most
 *     common form, and the one the weld destroyed.
 *  2. **The whole run**, when it is 13-19 digits, `4111 1111 1111 1111`.
 *  3. **A contiguous window of two or more groups** totalling 13-19 digits
 *     where EVERY group is 4-6 digits, the grouped forms (4-4-4-4, amex 4-6-5,
 *     diners 4-6-4) sitting in surrounding text. The 4-digit floor is what
 *     keeps a row of space-separated phone numbers (`555 123 4567 555 987
 *     6543`, groups of 3 and 4) from producing any candidate at all; without it
 *     that row yields six windows and refuses the message about half the time.
 */
function panCandidates(groups: readonly DigitGroup[]): PanCandidate[] {
  const candidates: PanCandidate[] = [];
  const push = (from: number, to: number): void => {
    const first = groups[from];
    const last = groups[to];
    if (!first || !last) return;
    let digits = '';
    for (let index = from; index <= to; index += 1) digits += groups[index]?.digits ?? '';
    if (digits.length < MIN_PAN_DIGITS || digits.length > MAX_PAN_DIGITS) return;
    candidates.push({ startIndex: first.startIndex, endIndex: last.startIndex + last.digits.length, digits });
  };

  for (let index = 0; index < groups.length; index += 1) push(index, index);
  if (groups.length > 1) push(0, groups.length - 1);

  for (let from = 0; from < groups.length; from += 1) {
    let digitCount = groups[from]?.digits.length ?? 0;
    for (let to = from + 1; to < groups.length; to += 1) {
      const group = groups[to];
      const start = groups[from];
      if (!group || !start) break;
      if (start.digits.length < MIN_GROUPED_PAN_GROUP || start.digits.length > MAX_GROUPED_PAN_GROUP) break;
      if (group.digits.length < MIN_GROUPED_PAN_GROUP || group.digits.length > MAX_GROUPED_PAN_GROUP) break;
      digitCount += group.digits.length;
      // Longer windows can never be PANs; avoid building every suffix of a
      // large input while the pre-judgment guard scans the complete text.
      if (digitCount > MAX_PAN_DIGITS) break;
      push(from, to);
    }
  }
  return candidates;
}

/**
 * Primary account numbers: 13-19 digits once internal spaces and hyphens are
 * stripped, passing Luhn.
 *
 * Luhn alone is the discriminator. A known issuer prefix is deliberately NOT
 * additionally required, because that would miss valid cards from less common
 * networks. The trade is asymmetric and §11.0 decides it accordingly: a false
 * positive costs one refused message with a clear explanation, while a false
 * negative puts a real card number into a third party's message history
 * permanently.
 *
 * Overlapping candidates are resolved longest-first from the left, so a card
 * number is reported once as its longest matching span rather than several
 * times as nested fragments. A card number buried inside a LONGER unbroken
 * digit string is deliberately not caught: the threat model here is the owner
 * pasting their own card, not an adversary evading the check.
 */
export function findCardNumberShapes(text: string, maxFindings = Number.POSITIVE_INFINITY): CardShapeFinding[] {
  const accepted: CardShapeFinding[] = [];
  let identifiers: readonly Span[] | undefined;
  PAN_RUN.lastIndex = 0;
  for (let match = PAN_RUN.exec(text); match !== null; match = PAN_RUN.exec(text)) {
    const runStart = match.index;
    // Identifiers are not prose: a run glued to identifier characters
    // (`job-1731667200000`, `bg_...`, `...abc`) or inside a UUID-shaped token
    // is an id, never a pasted card. Settled before any Luhn work, and the UUID
    // scan runs only once a run long enough to be a card number exists.
    if (match[0].replace(/[ -]/g, '').length < MIN_PAN_DIGITS || gluedToIdentifier(text, runStart, runStart + match[0].length)) continue;
    identifiers ??= uuidSpans(text);
    if (overlaps({ startIndex: runStart, length: match[0].length }, identifiers)) continue;
    const groups: DigitGroup[] = [];
    const groupPattern = /\d+/g;
    for (let group = groupPattern.exec(match[0]); group !== null; group = groupPattern.exec(match[0])) {
      groups.push({ startIndex: runStart + group.index, digits: group[0] });
    }
    const hits = panCandidates(groups)
      .filter((candidate) => passesLuhn(candidate.digits))
      .sort((a, b) => (a.startIndex - b.startIndex) || ((b.endIndex - b.startIndex) - (a.endIndex - a.startIndex)));
    for (const hit of hits) {
      const span: Span = { startIndex: hit.startIndex, length: hit.endIndex - hit.startIndex };
      if (overlaps(span, accepted)) continue;
      accepted.push({ kind: 'pan', ...span });
      // A refusing caller needs only existence, not every possible span.
      if (accepted.length >= maxFindings) return accepted;
    }
  }
  return accepted.sort((a, b) => a.startIndex - b.startIndex);
}

/** Words that say a nearby number is a payment card's (`cardNumber` and `credit` match inside longer words on purpose). */
const CARD_CONTEXT = /card|credit|debit|visa|master\s?card|amex|american express|discover|\bpan\b|\bcvv2?\b|\bcvc2?\b|\bcsc\b|expir|\bexp\b|security code/i;
const CARD_CONTEXT_REACH = 40;

/**
 * Card numbers that are written as one: a Luhn-valid run that is grouped the
 * way cards are written (`4111 1111 1111 1111`, `5500-0000-0000-0004`) or
 * that has a card word within 40 characters (`card`, `visa`, `cvv`, `exp`,
 * `cardNumber`, ...). A bare Luhn-valid digit run is not enough: about one in
 * ten long ids (a message or channel snowflake, a nanosecond timestamp, an
 * order number) passes the checksum. This is the decision tool calls are
 * refused on before anything is sent to a decision model; a bare number goes
 * on to the model's `cardDetails` reading with the rest of the call.
 */
export function findCardNumbersInContext(text: string, maxFindings = Number.POSITIVE_INFINITY): CardShapeFinding[] {
  const found: CardShapeFinding[] = [];
  for (const finding of findCardNumberShapes(text)) {
    const end = finding.startIndex + finding.length;
    const grouped = /[ -]/.test(text.slice(finding.startIndex, end));
    const near = text.slice(Math.max(0, finding.startIndex - CARD_CONTEXT_REACH), finding.startIndex)
      + ' ' + text.slice(end, end + CARD_CONTEXT_REACH);
    if (grouped || CARD_CONTEXT.test(near)) {
      found.push(finding);
      if (found.length >= maxFindings) break;
    }
  }
  return found;
}

/** A UUID (8-4-4-4-12 hex) anywhere in the text. */
const UUID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function uuidSpans(text: string): readonly Span[] {
  const spans: Span[] = [];
  UUID_TOKEN.lastIndex = 0;
  for (let match = UUID_TOKEN.exec(text); match !== null; match = UUID_TOKEN.exec(text)) spans.push({ startIndex: match.index, length: match[0].length });
  return spans;
}

const IDENTIFIER_CHAR = /[A-Za-z_]/;
const IDENTIFIER_JOIN = /[-_./]/;
/** A word that names a card or its number: a run glued to it is a card, not an id (`cc4111...`, `Visa-4111 ...`, `No.4111 ...`, `/pay/4111...`). */
const CARD_WORD = /^(?:cards?|cc|pan|visa|master\s?card|amex|discover|credit|debit|no|nr|num|number|pay|payment)$/i;
/** A currency code after an amount-like run (`4111111111111111USD`): not an identifier suffix. */
const CURRENCY_SUFFIX = /^[A-Z]{3}(?![A-Za-z0-9_])/;

/** The letters that end immediately before `end` (the word a run is glued to). */
function wordEndingAt(text: string, end: number): string {
  let start = end;
  while (start > 0 && /[A-Za-z]/.test(text[start - 1] ?? '')) start -= 1;
  return text.slice(start, end);
}

/**
 * Whether the run is grouped the way a card is written: split by spaces or
 * hyphens into groups of 4-6 digits (`4111 1111 1111 1111`, amex 4-6-5). Ids
 * are not (`cp-17316672000001-2` has a 14-digit and a 1-digit group, and
 * `job-1731667200000 2 minutes` a 13-digit one).
 */
function writtenAsCard(run: string): boolean {
  const groups = run.split(/[ -]+/);
  return groups.length > 1 && groups.every((group) => group.length >= MIN_GROUPED_PAN_GROUP && group.length <= MAX_GROUPED_PAN_GROUP);
}

/**
 * Whether a digit run is part of an identifier token: a letter or underscore
 * touches it on either side, or it hangs off a word by `-`, `_`, `.` or `/`.
 * A card number in prose stands apart, after a space, a colon or a quote.
 * Never for a run written as a card (spaces, card grouping), nor for one glued
 * to a card word or followed by a currency code: those are card numbers
 * however they are attached.
 */
function gluedToIdentifier(text: string, start: number, end: number): boolean {
  if (writtenAsCard(text.slice(start, end))) return false;
  const before = text[start - 1] ?? '', after = text[end] ?? '';
  const letterBefore = IDENTIFIER_CHAR.test(before);
  if (letterBefore && !CARD_WORD.test(wordEndingAt(text, start))) return true;
  if (IDENTIFIER_CHAR.test(after) && !CURRENCY_SUFFIX.test(text.slice(end, end + 4))) return true;
  if (letterBefore) return false;
  if (!IDENTIFIER_JOIN.test(before) || !/[A-Za-z0-9_]/.test(text[start - 2] ?? '')) return false;
  return !CARD_WORD.test(wordEndingAt(text, start - 1));
}

function findMatches(pattern: RegExp, text: string, kind: CardShapeKind, exclude: readonly Span[]): CardShapeFinding[] {
  const findings: CardShapeFinding[] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const span: Span = { startIndex: match.index, length: match[0].length };
    if (overlaps(span, exclude)) continue;
    findings.push({ kind, ...span });
  }
  return findings;
}

/**
 * Locate card-shaped spans in `text`.
 *
 * `security-code` and `expiry` are never emitted on shape alone: three or four
 * bare digits and a bare `MM/YY` are far too common, and refusing them would
 * make the channel unusable. When the text has such candidates, Jev reads the
 * digit-masked message (`engine.security.card-talk`) and they are emitted
 * unless it is a confident no that the message gives a card's security code
 * or expiry. Text with no candidates asks nothing.
 *
 * Findings are returned in ascending `startIndex` order and never overlap.
 */
export async function detectCardShapes(text: string): Promise<readonly CardShapeFinding[]> {
  return decisionOrClassic(() => detectDecisionCardShapes(text),
    () => findLabelledCardShapes(text).map(finding => Object.freeze({ ...finding, provenance: 'classic' as const })));
}

const EXPIRY_LABEL = /\b(?:exp(?:iry|iration)?(?:\s+date)?|valid\s+thru)\s*(?:is\s*)?[:=]?\s*$/iu;
const SECURITY_CODE_LABEL = /\b(?:cvv2?|cvc2?|csc|cid|security\s+code|card\s+code|card\s+verification\s+(?:code|value|number))\s*(?:is\s*)?[:=]?\s*$/iu;

/**
 * Card-shaped spans by code alone: card numbers by their checksum, and a
 * month/year pair or a three or four digit number only where the words just
 * before it label it as an expiry or a security code. No model is asked.
 *
 * This is what stored and displayed mail is redacted by: every order
 * confirmation carries a year, a price or an order number, and a model
 * request per mail field to learn that those are not card details buys
 * nothing for an excerpt of someone else's message. It is also what
 * `detectCardShapes` falls back to when decision models are off.
 */
export function findLabelledCardShapes(text: string): readonly CardShapeFinding[] {
  const pans = findCardNumberShapes(text);
  const expiries = findMatches(EXPIRY_PAIR, text, 'expiry', pans);
  const codes = findMatches(BARE_SHORT_DIGIT_RUN, text, 'security-code', [...pans, ...expiries]);
  const labelled = (finding: CardShapeFinding, label: RegExp) => label.test(text.slice(Math.max(0, finding.startIndex - 80), finding.startIndex));
  return [...pans,
    ...expiries.filter(finding => labelled(finding, EXPIRY_LABEL)),
    ...codes.filter(finding => labelled(finding, SECURITY_CODE_LABEL)),
  ].sort((a, b) => a.startIndex - b.startIndex);
}

/** Settled card-talk answers by digest of the masked text; bounded, oldest first out. */
const cardTalkAnswers = new Map<string, { readonly expiry: boolean; readonly securityCode: boolean }>();
const MAX_CARD_TALK_ANSWERS = 512;

async function detectDecisionCardShapes(text: string): Promise<readonly CardShapeFinding[]> {
  if (text.length === 0) return [];
  const pans = findCardNumberShapes(text);
  const expiries = findMatches(EXPIRY_PAIR, text, 'expiry', pans);
  const securityCodes = findMatches(BARE_SHORT_DIGIT_RUN, text, 'security-code', [...pans, ...expiries]);
  if (expiries.length === 0 && securityCodes.length === 0) return pans;

  const asked: ('security_code' | 'expiry')[] = [];
  if (securityCodes.length > 0) asked.push('security_code');
  if (expiries.length > 0) asked.push('expiry');
  const masked = maskDigits(text);
  // The reading depends only on the digit-masked text and what was asked, so
  // the same text (a subject redacted for the record and shown in the notice)
  // is read once. Keyed by a digest, so the cache never holds message text.
  const memoKey = createHash('sha256').update(asked.join(',')).update('\n').update(masked).digest('base64');
  let answer = cardTalkAnswers.get(memoKey);
  if (answer === undefined) {
    const run = await cardTalk.runSome(judgmentPort(CARD_TALK_SITE), masked, asked, { site: CARD_TALK_SITE });
    const gives = (item: 'security_code' | 'expiry'): boolean => {
      const reading = run.readings[item];
      // A question not asked has no candidates; one asked whose reading is absent keeps its numbers as card details.
      if (reading === undefined) return asked.includes(item);
      return !(reading.verdict === 'no' && reading.outcome === 'act');
    };
    answer = { expiry: gives('expiry'), securityCode: gives('security_code') };
    run.recordAction(answer.expiry || answer.securityCode ? 'short numbers treated as card details' : 'short numbers left as they are');
    cardTalkAnswers.set(memoKey, answer);
    if (cardTalkAnswers.size > MAX_CARD_TALK_ANSWERS) cardTalkAnswers.delete(cardTalkAnswers.keys().next().value!);
  }
  const kept = [...pans, ...(answer.expiry ? expiries : []), ...(answer.securityCode ? securityCodes : [])];
  return kept.sort((a, b) => a.startIndex - b.startIndex);
}

/**
 * Whether these findings refuse the message. Non-empty IS the rule: a
 * `security-code` or `expiry` finding only exists when it was already in card
 * context, so there is no second condition to forget.
 */
export function hasRefusableCardShapes(findings: readonly CardShapeFinding[]): boolean {
  return findings.length > 0;
}

const KIND_LABELS: Readonly<Record<CardShapeKind, string>> = {
  pan: 'card number',
  'security-code': 'security code',
  expiry: 'expiry date',
};

/** Stable, human-readable names for the distinct shapes matched, shapes only. */
export function describeCardShapes(findings: readonly CardShapeFinding[]): readonly string[] {
  const order: readonly CardShapeKind[] = ['pan', 'security-code', 'expiry'];
  return order.filter((kind) => findings.some((f) => f.kind === kind)).map((kind) => KIND_LABELS[kind]);
}

/** The distinct kinds matched, in a stable order, for a decision reason string. */
export function cardShapeKinds(findings: readonly CardShapeFinding[]): readonly CardShapeKind[] {
  const order: readonly CardShapeKind[] = ['pan', 'security-code', 'expiry'];
  return order.filter((kind) => findings.some((f) => f.kind === kind));
}

/**
 * The reply the owner gets on the channel they sent from.
 *
 * Composed entirely from `describeCardShapes`, which reads only `kind`, so it
 * cannot quote the digits even if someone later edits this string carelessly.
 * It contains no numerals at all, deliberately, so that "does the reply leak
 * any part of the card" is answerable by looking at it.
 *
 * It says the veto still works, because the message being refused may have BEEN
 * a veto (§11.0): silence here is the one silence that does harm, since an
 * unheard objection inside a veto window elapses into a completed purchase.
 */
export function renderCardShapeRefusal(findings: readonly CardShapeFinding[]): string {
  const shapes = describeCardShapes(findings);
  const listed = shapes.length > 0 ? shapes.join(', ') : 'card details';
  return [
    `Refused, that message looks like it carries card details (${listed}), so it was dropped without being stored, logged or transcribed.`,
    'Card details are only ever entered at the local terminal or in the webui, never over a messaging channel where they would land in a third party\'s history that nobody can erase.',
    'Approving or vetoing a purchase still works here as it always has, send that again without the digits.',
  ].join('\n');
}

/**
 * Replace every card-shaped span with a marker naming only its kind. Code
 * alone (`findLabelledCardShapes`): redacting mail never asks a model.
 *
 * Applied back-to-front so earlier spans keep their indices. The replacement is
 * longer than a three-digit security code, so callers with a length budget must
 * bound the result AFTER redacting, not before, see `record-store.ts`, which
 * redacts a slightly over-long window and then trims, so that a card number
 * straddling the excerpt boundary is redacted whole rather than truncated into
 * a still-readable prefix.
 */
export function redactCardShapes(text: string): string {
  const findings = findLabelledCardShapes(text);
  if (findings.length === 0) return text;
  let result = text;
  for (let index = findings.length - 1; index >= 0; index -= 1) {
    const finding = findings[index];
    if (!finding) continue;
    const end = finding.startIndex + finding.length;
    result = `${result.slice(0, finding.startIndex)}[redacted:${finding.kind}]${result.slice(end)}`;
  }
  return result;
}

/**
 * Compile-time guards on the one property of `CardShapeFinding` that matters.
 *
 * Same reasoning as the brand guards in `platform/email/inbound-notice.ts`:
 * nothing else in the build notices if this degrades. Should someone add a
 * `value`, `text` or `digits` field to `CardShapeFinding`, plausibly while
 * chasing an unrelated need, with no idea this line existed, every test still
 * passes and `tsc` is still clean apart from here, while the structural
 * guarantee that a refusal cannot quote a card number is silently gone.
 * `@ts-expect-error` fails the build the moment the error it expects STOPS
 * occurring, which is exactly the event worth hearing about.
 *
 * `_CardShapeFindingHasNoValueKey` is the stronger of the two forms: it fails
 * even for an addition that excess-property checking would not catch.
 */
type _CardShapeFindingHasNoValueKey =
  [Extract<keyof CardShapeFinding, 'value' | 'text' | 'digits' | 'matched'>] extends [never] ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _cardShapeFindingHasNoValueKey: _CardShapeFindingHasNoValueKey = true;

// @ts-expect-error, a finding must never carry the matched characters; adding a `value` field to CardShapeFinding is the regression this line exists to catch.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _findingCannotCarryValue: CardShapeFinding = { kind: 'pan', startIndex: 0, length: 16, value: 'REDACTED' };
// @ts-expect-error, nor under the name `text`.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _findingCannotCarryText: CardShapeFinding = { kind: 'pan', startIndex: 0, length: 16, text: 'REDACTED' };
// @ts-expect-error, nor under the name `digits`, which is the name someone reaching for it would most likely pick.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _findingCannotCarryDigits: CardShapeFinding = { kind: 'pan', startIndex: 0, length: 16, digits: 'REDACTED' };
