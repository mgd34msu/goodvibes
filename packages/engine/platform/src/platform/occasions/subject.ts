/**
 * subject.ts, who a date line is about.
 *
 * The line's own `for me` marker is authoritative and read by the parser. The
 * one case the marker does not cover and the answer changes behaviour is a
 * `remember-only` line without it: if it is about the owner, it is never pushed
 * (see {@link pushableSubject}). Only that case is read by a model, once per
 * line, and the answer is stored against a key over the title, the person and
 * the owner's declared names, so the reading is taken again only when one of
 * those changes. Every other line is decided here without a request.
 */
import { createHash } from 'node:crypto';
import { occasionSubject, occasionEntry } from './readings.js';
import { normalizeProfileKey } from '../owner-profile/fields.js';
import { judge } from '../runtime/judge.js';
import { JudgmentInputError, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { EntryType } from '@goodvibes/judgment';
import type { Occasion, OccasionSubject } from './types.js';

/**
 * The words that mark a line as being about the owner themselves.
 *
 * Accepted both bare (`· mine ·`) and behind `for` (`· for me ·`), because both
 * are things a person writes and neither is ambiguous with a person's name.
 */
const SELF_WORDS: readonly string[] = ['me', 'myself', 'mine', 'self'];

/** True when a segment, with or without its `for`, declares the owner. */
export function isSelfAttribution(value: string): boolean {
  return SELF_WORDS.includes(normalizeProfileKey(value));
}

/** The decision-log site for the one attribution reading. */
export const OCCASION_SUBJECT_SITE = 'engine.occasions.subject';

/**
 * Whether this line's subject is decided by a stored reading.
 *
 * False for a line that says `for me` (the marker decides) and for every kind
 * but `remember-only`, where who it is about changes nothing.
 */
export function needsSubjectReading(occasion: Pick<Occasion, 'selfDeclared' | 'kind'>): boolean {
  return !occasion.selfDeclared && occasion.kind === 'remember-only';
}

/** The subject decided from the line alone: `owner` with the marker, otherwise `unattributed`. */
export function declaredSubject(occasion: Pick<Occasion, 'selfDeclared'>): OccasionSubject {
  return occasion.selfDeclared ? 'owner' : 'unattributed';
}

/**
 * The stored-reading key for one line: a digest of exactly what the reading is
 * taken over. No line text or date goes into the state file.
 */
export function attributionKey(occasion: Pick<Occasion, 'title' | 'person'>, declaredNames: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([occasion.title.trim(), occasion.person.trim(), declaredNames.map((name) => name.trim())]))
    .digest('hex')
    .slice(0, 32);
}

/**
 * Ask once who a `remember-only` line is about.
 *
 * `store` is false when nothing was learned (no model, decision models off, the
 * deadline passed or the model was unreachable): the line is treated as
 * `unattributed` for now, the ordinary cadence, and read again later. An
 * answer the model gave, including one it could not settle, is stored: asking
 * the same question again would get the same answer. `requestFailed` is true
 * when a request was made and came back with nothing (a missed deadline or an
 * unreachable model): the caller holds off asking again for a while, so an
 * outage does not slow every read.
 */
/** One attribution reading: the subject, whether it is kept, and whether a request failed to produce it. */
export interface OccasionSubjectReading {
  readonly subject: OccasionSubject;
  readonly store: boolean;
  readonly requestFailed: boolean;
}

export async function readOccasionSubject(
  occasion: Pick<Occasion, 'title' | 'person'>,
  declaredNames: readonly string[],
  signal?: AbortSignal,
): Promise<OccasionSubjectReading> {
  let state: EntryType;
  try {
    state = occasionEntry(snapshotJudgmentInput({ title: occasion.title, person: occasion.person, declaredNames: [...declaredNames] }) as object);
  } catch (error) {
    // Credential or card material in a title is never sent to a model. The line
    // keeps the ordinary cadence, and that is a settled fact for this key.
    if (error instanceof JudgmentInputError) return { subject: 'unattributed', store: true, requestFailed: false };
    throw error;
  }
  const outcome = await judge({
    site: OCCASION_SUBJECT_SITE,
    battery: occasionSubject,
    state,
    settle: (readings): OccasionSubject | undefined => {
      const reading = readings.subject;
      if (reading.outcome !== 'act') return undefined;
      return reading.choice === 'owner' ? 'owner' : reading.choice === 'other' ? 'other' : reading.choice === 'unknown' ? 'unattributed' : undefined;
    },
    fallback: (): OccasionSubject => 'unattributed',
    describe: (subject) => `attributed occasion subject: ${subject}`,
    ...(signal === undefined ? {} : { signal }),
  });
  const store = outcome.source !== 'fallback' || outcome.why === 'unsure';
  return { subject: outcome.value, store, requestFailed: !store && outcome.requested === true };
}

/**
 * Whether this occasion may ever be PUSHED at the owner.
 *
 * One rule, and it is narrow on purpose: something about the owner that they
 * only have to remember is something they already know. Their own birthday,
 * their own anniversary of anything. They do not need a message about it,
 * least of all an hourly one, so nothing is sent, and it stays visible to
 * anything that ASKS what is coming up.
 *
 * The narrowness is the load-bearing part. An occasion about the owner that
 * wants an ACTION, `Renew passport · 2026-11-02 · once · gift-giving` is the
 * shape, and the kind is the thing that says an action is wanted, is not
 * covered, and keeps the ordinary two-boundary cadence. They do not know when
 * their passport expires. They do know when they were born.
 */
export function pushableSubject(
  occasion: Pick<Occasion, 'subject' | 'kind'>,
): boolean {
  return !(occasion.subject === 'owner' && occasion.kind === 'remember-only');
}

/** Why an occasion is not pushed, in words a surface can show the owner. */
export function selfOccasionReason(occasion: Pick<Occasion, 'title'>): string {
  return `${occasion.title} is about you and is one to remember rather than act on, `
    + 'so it is kept and answerable but never sent to you.';
}
