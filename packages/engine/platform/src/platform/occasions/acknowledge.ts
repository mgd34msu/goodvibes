/**
 * acknowledge.ts, "heard you", recorded.
 *
 * ## The gap this closes
 *
 * The state file has held an `acknowledgements` array since the feature
 * shipped, the housekeeping pass has counted `expiredAcknowledgements` since
 * the same day, and the sweep has checked for an answer on every pass. All of
 * that was correct and none of it ever fired, because the only thing that could
 * WRITE an acknowledgement was the `occasions.answer` control-plane verb, a
 * CLI/webui/API call. The nudge, meanwhile, was delivered to Telegram and to
 * the agent's conversation, where the reply to it is a sentence. Nobody ever
 * turned a sentence into a record.
 *
 * So the owner could answer a nudge, and answer it again, and answer it again,
 * and every answer landed in a conversation and nowhere else. From the sweep's
 * side they had said nothing at all, and it behaved accordingly.
 *
 * ## What an acknowledgement is, and what it is not
 *
 * It is not a decline and it is not a yes. Those END the question: the open
 * item is resolved and gone. This one says only that the owner has it in hand, so:
 *
 *  - the OPEN ITEM SURVIVES, and stays enumerable. Ask "anything coming up?"
 *    and it is there, marked as acknowledged. Nothing unresolved drops.
 *  - nothing is PUSHED at the owner about this occurrence again.
 *
 * That split is the entire point. "Stop telling me" and "forget about it" are
 * different instructions, and the feature previously had no way to hear the
 * first one.
 *
 * ## Three ways in, one record, one write
 *
 * Whichever path records it, the record is identical apart from its `source`,
 * so the sweep has one thing to check and there is no "acknowledged, but only
 * via the API" class of bug. A stored `yes` or `no` is never replaced, by any
 * of the three:
 *
 *  - `conversation`, the owner replied to the nudge where it landed and
 *    engaged with the occasion. The turn records it as part of answering them.
 *  - `explicit`    , a surface's own ack verb.
 *  - `gift-flow`   , the owner is ANSWERING GIFT QUESTIONS about it. Being
 *    asked whether they have thought about a birthday while in the middle of choosing
 *    the present for it is the feature failing at its own job, so engagement
 *    with the interview acknowledges the occurrence by itself.
 */
import { nudgeItemId } from './cadence.js';
import type { IsoDate } from './dates.js';
import {
  RAISE_BOUNDARIES,
  type Occasion,
  type OccasionAckSource,
  type OccasionAcknowledgement,
  type OpenItem,
} from './types.js';

/** The one store write this path makes. Satisfied by OccasionStateStore. */
export interface AcknowledgeStore {
  acknowledge(
    entry: OccasionAcknowledgement,
    itemId: string,
    build: (existing: OpenItem | undefined) => OpenItem,
  ): Promise<{ readonly settledBy: 'yes' | 'no' | null }>;
}

export interface AcknowledgeInput {
  readonly occasion: Occasion;
  readonly occurrence: IsoDate;
  readonly now: number;
  readonly source: OccasionAckSource;
}

/** What an acknowledgement did, in terms a surface can say back to the owner. */
export interface AcknowledgeOutcome {
  readonly occasionId: string;
  readonly occurrence: IsoDate;
  readonly source: OccasionAckSource;
  /**
   * `yes` or `no` when the occurrence was already settled by that answer, in
   * which case NOTHING was written: both say more than an acknowledgement, and
   * a `yes` is what keeps a gift interview live.
   */
  readonly alreadyAnswered: 'yes' | 'no' | null;
}

/**
 * Record that the owner has this occurrence in hand.
 *
 * One store write carries the answer and the quieted open item together, and
 * it is the one place the rule "an acknowledgement never replaces a yes or a
 * no" lives, so every way in (a conversation, a surface's verb, the gift flow)
 * gets it.
 *
 * The open item is marked as having served both boundaries as well as being
 * answered. Belt and braces on purpose: the mute then survives an
 * acknowledgement being reaped early, and a surface reading only the item can
 * still see that it will not speak.
 */
export async function acknowledgeOccurrence(
  store: AcknowledgeStore,
  input: AcknowledgeInput,
): Promise<AcknowledgeOutcome> {
  const { occasion, occurrence, now } = input;
  const itemId = nudgeItemId(occasion.id, occurrence);
  const written = await store.acknowledge({
    id: `${occasion.id}@${occurrence}`,
    occasionId: occasion.id,
    occurrence,
    answer: 'acknowledged',
    answeredAt: now,
    source: input.source,
    // Expires with its occurrence exactly as every other answer does, so next
    // year asks fresh. "I know about it" was about THIS birthday.
    ...(occasion.recurrence === 'annual' ? { expiresAfter: occurrence } : {}),
  }, itemId, (existing) => existing === undefined
    // The owner acknowledged something that had not been raised yet, they got
    // there first. The item is opened anyway, and opened quiet, so the pull can
    // still show it and the sweep can never decide to introduce it to them.
    ? {
      id: itemId,
      kind: 'nudge',
      occasionId: occasion.id,
      occurrence,
      openedAt: now,
      lastRaisedAt: now,
      raiseCount: 0,
      servedBoundaries: [...RAISE_BOUNDARIES],
      dueOn: occurrence,
      expiresAfter: occurrence,
    }
    : { ...existing, servedBoundaries: [...RAISE_BOUNDARIES] });
  return {
    occasionId: occasion.id,
    occurrence,
    source: input.source,
    alreadyAnswered: written.settledBy,
  };
}

/** What to say back when the occurrence was already answered and nothing changed. */
export function alreadyAnsweredReply(occasionTitle: string, answer: 'yes' | 'no'): string {
  return answer === 'no'
    ? `You already said no for ${occasionTitle} this time, so it is already quiet. Nothing changed.`
    : `You already said yes for ${occasionTitle}, and the gift planning for it is under way. Nothing changed.`;
}

/**
 * What to say back when an acknowledgement lands.
 *
 * Names the occasion and states BOTH halves, this one is quiet, everything
 * else still runs. The second half is not filler. When the owner complained
 * about being reminded of their own birthday hourly, the answer was to switch
 * the whole feature off, which also switched off their wife's birthday; a reply that says
 * what was silenced and what was not is how that stays visible at the moment it
 * happens rather than being discovered in November.
 */
export function acknowledgementReply(occasionTitle: string): string {
  return `Noted, you have ${occasionTitle} in hand, so I will stop raising it. `
    + 'It stays on your dates and I will still answer if you ask about it. '
    + 'Nothing else has changed; your other dates are unaffected.';
}
