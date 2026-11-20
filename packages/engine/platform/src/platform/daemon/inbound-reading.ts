/**
 * The one decision-model reading of an inbound channel message.
 *
 * Before this, a message could be read up to five times, one request after
 * another, by modules that did not know the others had run: card talk, the
 * answer to a pending proposal, the answer to a pending permission ask, and
 * work-versus-conversation intent. Code now decides which of those questions
 * apply, from facts it holds (a short number beside card words, a proposal or ask
 * pending on this conversation for this sender, a gated surface), and asks
 * them together: at most one request per message, none when nothing applies.
 *
 * The request has the decision deadline and a fallback, so a slow or missing
 * model never holds a message: an unsure or missing answer is `unsure`, and
 * each caller says what `unsure` means for it (a conversational reply, an
 * answer left pending, a message not refused).
 */
import type { JsonValue } from '@goodvibes/judgment';
import { inboundMessage } from './batteries/inbound-message.js';
import { judgeSome } from '../runtime/judge.js';
import { withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { maskDigits } from '../security/batteries/card-talk.js';
import { findCardNumberShapes } from '../security/card-shapes.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';

const SITE = 'daemon.inbound-message';

/** What code found worth asking about one message. */
export interface InboundQuestions {
  /** The complete message as the sender wrote it. */
  readonly message: string;
  /** Ask whether it requests work: the surface's messages are gated. */
  readonly intent?: boolean | undefined;
  /** The one delivered work proposal pending on this conversation for this sender. */
  readonly proposal?: { readonly task: string; readonly summary: string } | undefined;
  /** The one permission ask delivered to this conversation, when the sender is the channel's owner. */
  readonly approval?: JsonValue | undefined;
}

export type ProposalAnswer = 'approve' | 'steer' | 'reject' | 'message';
export type ApprovalAnswer = 'approve' | 'reject' | 'amend' | 'unclear';

export interface InboundReading {
  /** Set when intent was asked. */
  readonly intent?: 'work' | 'conversation' | 'unsure' | undefined;
  /** Set when a proposal was offered. */
  readonly proposal?: ProposalAnswer | 'unsure' | undefined;
  /** Set when an ask was offered. */
  readonly approval?: ApprovalAnswer | 'unsure' | undefined;
  /**
   * Card details the message gives, read with confidence (`securityCode`,
   * `expiry`), and the card questions code found worth asking that no answer
   * settled (`unsure`): the model was unsure, slow, absent or switched off.
   */
  readonly card: {
    readonly securityCode: boolean;
    readonly expiry: boolean;
    readonly unsure: { readonly securityCode: boolean; readonly expiry: boolean };
  };
  /** `none`: nothing applied and nothing was asked. */
  readonly source: 'model' | 'cache' | 'fallback' | 'none';
  readonly why?: string | undefined;
  readonly decisionId?: string | undefined;
}

/** A bare three- or four-digit run: a possible security code. */
const SHORT_DIGIT_RUN = /\b\d{3,4}\b/g;
/** `MM/YY` or `MM/YYYY` with a real month: a possible expiry. */
const EXPIRY_PAIR = /\b(?:0[1-9]|1[0-2])\s*[/-]\s*(?:\d{4}|\d{2})\b/g;

function anyOutside(pattern: RegExp, text: string, taken: readonly { startIndex: number; length: number }[]): boolean {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const start = match.index, end = start + match[0].length;
    if (!taken.some(span => start < span.startIndex + span.length && span.startIndex < end)) return true;
  }
  return false;
}

/**
 * Words a message giving card details uses. A time, a price, a year or an
 * order number with none of them around it is not read as a card detail:
 * that is nearly every chat message with a number in it.
 */
const CARD_VOCABULARY = /\b(?:card|credit|debit|visa|master\s?card|amex|american\s+express|cvv2?|cvc2?|csc|cid|security\s+code|card\s+code|verification\s+(?:code|value|number)|exp|expiry|expiration|expires|valid\s+(?:thru|through|until))\b/i;

/**
 * Whether the card questions are worth asking: the message uses card words
 * and has a short number or a month/year pair outside a card number (a card
 * number itself is refused by code, by its checksum, before anything is read;
 * a short number typed while a purchase waits for its security code is
 * handled by that wait, surface-card-gate.ts).
 */
export function cardTalkCandidates(text: string): { readonly securityCode: boolean; readonly expiry: boolean } {
  if (!CARD_VOCABULARY.test(text)) return { securityCode: false, expiry: false };
  const pans = findCardNumberShapes(text);
  return { securityCode: anyOutside(SHORT_DIGIT_RUN, text, pans), expiry: anyOutside(EXPIRY_PAIR, text, pans) };
}

const settledChoice = <C extends string>(reading: { readonly choice: C; readonly outcome: string } | undefined): C | 'unsure' =>
  reading !== undefined && reading.outcome === 'act' ? reading.choice : 'unsure';
const confidentYes = (reading: { readonly verdict: string; readonly outcome: string } | undefined): boolean =>
  reading !== undefined && reading.verdict === 'yes' && reading.outcome === 'act';
const settled = (reading: { readonly outcome: string } | undefined): boolean =>
  reading !== undefined && reading.outcome === 'act';

/** Ask the questions that apply, in one request; resolves `source: 'none'` without a request when none does. */
export async function readInboundMessage(questions: InboundQuestions, options: { readonly signal?: AbortSignal | undefined } = {}): Promise<InboundReading> {
  const candidates = cardTalkCandidates(questions.message);
  type Item = keyof typeof inboundMessage.items;
  const only: Item[] = [];
  if (questions.intent === true) only.push('intent');
  if (questions.proposal !== undefined) only.push('proposal_reply');
  if (questions.approval !== undefined) only.push('approval_reply');
  if (candidates.securityCode) only.push('security_code');
  if (candidates.expiry) only.push('expiry');
  const unsure: InboundReading = {
    ...(questions.intent === true ? { intent: 'unsure' as const } : {}),
    ...(questions.proposal !== undefined ? { proposal: 'unsure' as const } : {}),
    ...(questions.approval !== undefined ? { approval: 'unsure' as const } : {}),
    // Nothing answered the card questions code found worth asking.
    card: { securityCode: false, expiry: false, unsure: candidates },
    source: 'none',
  };
  if (only.length === 0) return unsure;
  // A message that may give card details is read with every digit masked, by every question.
  const message = snapshotJudgmentInput(candidates.securityCode || candidates.expiry ? maskDigits(questions.message) : questions.message) as string;
  const state = {
    message,
    ...(questions.proposal !== undefined ? { proposal: snapshotJudgmentInput({ task: questions.proposal.task, summary: questions.proposal.summary }) as JsonValue } : {}),
    ...(questions.approval !== undefined ? { approval: questions.approval } : {}),
  };
  const outcome = await withConfiguredDecisionModelPolicy(() => judgeSome({
    site: SITE,
    battery: inboundMessage,
    state,
    only,
    settle: (readings): InboundReading => ({
      ...(questions.intent === true ? { intent: settledChoice(readings.intent) } : {}),
      ...(questions.proposal !== undefined ? { proposal: settledChoice(readings.proposal_reply) } : {}),
      ...(questions.approval !== undefined ? { approval: settledChoice(readings.approval_reply) } : {}),
      card: {
        securityCode: candidates.securityCode && confidentYes(readings.security_code),
        expiry: candidates.expiry && confidentYes(readings.expiry),
        unsure: {
          securityCode: candidates.securityCode && !settled(readings.security_code),
          expiry: candidates.expiry && !settled(readings.expiry),
        },
      },
      source: 'model',
    }),
    fallback: () => unsure,
    describe: (reading) => [
      reading.intent && `intent ${reading.intent}`,
      reading.proposal && `proposal ${reading.proposal}`,
      reading.approval && `approval ${reading.approval}`,
      (reading.card.securityCode || reading.card.expiry) && 'card details',
    ].filter(Boolean).join('; ') || 'nothing to act on',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }));
  return {
    ...outcome.value,
    source: outcome.source,
    ...(outcome.why === undefined ? {} : { why: outcome.why }),
    ...(outcome.decisionId === undefined ? {} : { decisionId: outcome.decisionId }),
  };
}
