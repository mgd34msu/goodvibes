/**
 * pending.ts, what is outstanding, for a surface that ASKS rather than receives.
 *
 * The pull half of the feature, and under the two-boundary cadence it carries
 * considerably more weight than it used to. A nudge now pushes twice: at the
 * top of its lead window and on the day itself. For the whole stretch between
 * those two moments the occasion is open, quiet, and reachable only through
 * here, "anything coming up?" is the way the owner finds out, and that is the
 * design rather than a gap in it. Nothing unresolved drops; it simply stops
 * shouting.
 *
 * Three things are enumerated that a push would never send the owner:
 *
 *  - Occurrences the owner has ACKNOWLEDGED. Muted for push, still listed, and
 *    listed as acknowledged so a surface can show them that they are the
 *    reason it is quiet rather than leaving them to wonder.
 *  - Occurrences about THE OWNER that they only have to remember. Never pushed
 *    at all; always here.
 *  - Occurrences between their two boundaries, which is most of them, most of
 *    the time.
 *
 * And it does not wait for a sweep: an occurrence inside its window that no
 * sweep has opened yet (a machine that was just started, or is rarely on) is
 * listed from the declarations, under the same rules the sweep opens by.
 *
 * Everything here is code. The message is composed from the subjects with no
 * model request, so the pull answers the same with or without a decision model.
 */
import { prepareNudge, composeConflictMessage, subjectFor } from './nudge.js';
import { nudgeItemId } from './cadence.js';
import { daysBetween, nextOccurrence, type IsoDate } from './dates.js';
import { isOccurrenceMirrored, occurrenceWindow, type OccasionsPolicy } from './sweep.js';
import type {
  NudgeSubject,
  Occasion,
  OccasionAcknowledgement,
  OccasionConflict,
  OccasionNudge,
  OpenItem,
  Plan,
} from './types.js';

/** Everything outstanding, for a surface that pulls rather than receives. */
export interface PendingResult {
  /** Present when decision models are off: who each date is about was taken from the line's `for me` marker only. */
  readonly provenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated';
  /** The subjects of `nudge`, listed on their own. Internal: `occasions.pending` leaves it out, since `nudge.subjects` carries the same list. */
  readonly open?: readonly NudgeSubject[];
  readonly today: IsoDate;
  /** What is coming up and has NOT been acknowledged. */
  readonly nudge: OccasionNudge | null;
  /**
   * Open occurrences the owner has already acknowledged.
   *
   * Kept out of `nudge` on purpose. The nudge is composed as something to say
   * to the owner, and saying an acknowledged occasion back at them is the
   * badgering this whole round exists to stop, but they asked what is coming
   * up, and an honest answer includes the one they told us they have in hand.
   */
  readonly acknowledged: readonly NudgeSubject[];
  readonly conflicts: readonly { readonly occasionId: string; readonly message: string }[];
}

export interface PendingInput {
  readonly today: IsoDate;
  readonly policy: Pick<OccasionsPolicy, 'enabled' | 'leadDays' | 'awayAdjust' | 'suppressMirroredNudges'>;
  readonly occasions: readonly Occasion[];
  readonly conflicts: readonly OccasionConflict[];
  readonly plans: readonly Plan[];
  readonly openItems: readonly OpenItem[];
  readonly acknowledgements: readonly OccasionAcknowledgement[];
  /** Occurrences the calendar mirror wrote (OccasionStateStore.mirroredOccurrences). */
  readonly mirroredOccurrences: ReadonlySet<string>;
}

type PreparedPending = Omit<PendingResult, 'nudge'> & { readonly nudge: Omit<OccasionNudge, 'id' | 'raisedAt'> | null };

/**
 * Compose the pull. Pure: same inputs, same answer.
 *
 * Every open item is listed until it is answered: the Agent is never pushed at,
 * so this read is the only way it hears a reminder and there is nothing to
 * de-duplicate against.
 */
export function preparePending(input: PendingInput): PreparedPending {
  const byId = new Map(input.occasions.map((entry) => [entry.id, entry]));
  const ackByKey = new Map(
    input.acknowledgements.map((entry) => [`${entry.occasionId}@${entry.occurrence}`, entry]),
  );

  const open: NudgeSubject[] = [];
  const acknowledged: NudgeSubject[] = [];
  const listed = new Set<string>();

  const place = (occasion: Occasion, occurrence: IsoDate, isAcknowledged: boolean): void => {
    const daysUntil = daysBetween(input.today, occurrence);
    const subject = subjectFor(occasion, Number.isFinite(daysUntil) ? daysUntil : input.policy.leadDays, isAcknowledged);
    if (isAcknowledged) acknowledged.push(subject);
    else open.push(subject);
  };

  for (const item of input.openItems) {
    if (item.kind !== 'nudge') continue;
    if (item.occurrence < input.today) continue;
    const occasion = byId.get(item.occasionId);
    if (occasion === undefined) continue;
    listed.add(item.id);

    // A `yes` or a `no` resolved the item and it would not be here; a `later`
    // is still an open question. Only an acknowledgement changes which list it
    // lands in.
    const isAcknowledged = ackByKey.get(`${item.occasionId}@${item.occurrence}`)?.answer === 'acknowledged';
    place(occasion, item.occurrence, isAcknowledged);
  }

  // Inside the window with nothing opened yet: listed by the rules the sweep
  // opens an item by, so the answer does not depend on a sweep having run.
  if (input.policy.enabled) {
    for (const occasion of input.occasions) {
      if (occasion.kind === 'neither') continue;
      const occurrence = nextOccurrence(occasion.date, occasion.recurrence, input.today);
      if (occurrence === null || listed.has(nudgeItemId(occasion.id, occurrence))) continue;
      if (!occurrenceWindow(occasion, occurrence, input.today, input.plans, input.policy).inside) continue;
      const answer = ackByKey.get(`${occasion.id}@${occurrence}`)?.answer;
      if (answer === 'yes' || answer === 'no') continue;
      if (answer !== 'acknowledged' && input.policy.suppressMirroredNudges && isOccurrenceMirrored(occasion, occurrence, input.mirroredOccurrences)) continue;
      place(occasion, occurrence, answer === 'acknowledged');
    }
  }

  // A conflict is read from the file on every call, so it is listed while the
  // file holds it, whether or not a sweep has raised it yet.
  const conflicts = input.conflicts
    .map((conflict) => ({ occasionId: conflict.occasionId, message: composeConflictMessage(conflict.title, conflict.dates) }));

  return {
    today: input.today,
    nudge: open.length === 0 ? null : prepareNudge(open),
    open,
    acknowledged,
    conflicts,
  };
}

/** The pull with its id and clock: what `occasions.pending` answers. */
export function composePending(input: PendingInput & { readonly now: number }): PendingResult {
  const prepared = preparePending(input);
  return { ...prepared, nudge: prepared.nudge === null ? null : { ...prepared.nudge, id: `occasions-pending-${input.today}`, raisedAt: input.now } };
}
