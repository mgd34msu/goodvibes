/**
 * capture.ts, proposing an occasion, confirming it once, and removing one.
 *
 * Split out of `service.ts` when that file reached the repo's 800-line cap.
 * Nothing here has state: each function takes the profile source it reads and
 * the writer it writes through, so the service keeps the sequence and this file
 * keeps the shape of a capture.
 *
 * ## Confirm once, at the time
 *
 * *"Noted your anniversary as 12 September, right?"* One line, at the moment
 * the owner can still catch a mishearing, and silent afterwards, no
 * re-confirmation at nudge time. The reason is arithmetic rather than
 * politeness: for an annual date a silent write means they discover the
 * error up to eleven months later, when it is far too late to matter.
 *
 * ## The kind is asked in the same interaction, and never inferred
 *
 * {@link confirmOccasion} refuses without one. A parent's death anniversary is
 * worth remembering, and a cheerful "you'll probably want to sort something"
 * against it would be genuinely bad; there is no rule that reads a label and
 * gets that right, so there is no rule.
 */
import type { AuthoritySurface } from '../security/untrusted-content.js';
import type { ProfileMutationOptions } from '../owner-profile/delegation.js';
import { isProfileSurface, type ProfileSurface } from '../owner-profile/types.js';
import type { AppendProfileProseInput, ForgetProfileInput } from '../owner-profile/store-types.js';
import { parseOccasionDate, renderOccasionDate } from './dates.js';
import {
  normalizePlanDetail,
  occasionIdFor,
  parsePlanLine,
  renderOccasionLine,
  renderPlanLine,
} from './grammar.js';
import { readOccasionDeclarations, type OccasionProfileSource } from './reader.js';
import {
  isOccasionKind,
  OCCASIONS_SECTION,
  PLANS_SECTION,
  type Occasion,
  type OccasionKind,
  type OccasionRecurrence,
  type Plan,
} from './types.js';

/** The profile writes capture and removal need. Satisfied by OwnerProfileStore. */
export interface OccasionProfileWriter {
  append(input: {
    readonly section: string;
    readonly text: string;
    readonly surface: ProfileSurface;
    readonly said: string;
    readonly authority: AuthoritySurface | 'autonomous';
  }, options?: ProfileMutationOptions): Promise<import('../owner-profile/types.js').ProfileWriteResult>;
  forget(input: {
    readonly section?: string | undefined;
    readonly text?: string | undefined;
    readonly authority: AuthoritySurface | 'autonomous';
  }, options?: ProfileMutationOptions): Promise<import('../owner-profile/types.js').ProfileWriteResult>;
}

export type OccasionProfileMutation =
  | { readonly method: 'profile.append'; readonly input: AppendProfileProseInput }
  | { readonly method: 'profile.forget'; readonly input: ForgetProfileInput };

/** Project the exact profile effect using the same formatters as the actual operation. */
export function projectOccasionProfileMutation(source: OccasionProfileSource, method: string, request: Readonly<Record<string, unknown>>): OccasionProfileMutation | undefined {
  const authority = request.authority;
  if (authority !== 'autonomous' && authority !== 'owner-direct' && authority !== 'web-page' && authority !== 'email'
    && authority !== 'channel-message' && authority !== 'document') return undefined;
  if (method === 'occasions.remove') {
    if (typeof request.occasionId !== 'string' || request.confirmed !== true) return undefined;
    const occasion = readOccasionDeclarations(source).occasions.find(entry => entry.id === request.occasionId);
    return occasion ? { method: 'profile.forget', input: { section: OCCASIONS_SECTION, text: occasion.text, authority } } : undefined;
  }
  if (method === 'occasions.conflict.resolve') {
    if (typeof request.occasionId !== 'string' || typeof request.keep !== 'string') return undefined;
    const plan = planConflictResolution(source, request.occasionId, request.keep);
    // One admitted effect removes one line, the ordinary two-date conflict.
    const only = plan.remove.length === 1 ? plan.remove[0] : undefined;
    return only ? { method: 'profile.forget', input: { section: OCCASIONS_SECTION, text: only.text, authority } } : undefined;
  }
  const surface = request.surface;
  if (typeof surface !== 'string' || !isProfileSurface(surface) || typeof request.said !== 'string') return undefined;
  const identity: Pick<AppendProfileProseInput, 'surface' | 'said' | 'authority'> = { surface, said: authority === 'autonomous' ? '' : request.said, authority };
  if (method === 'occasions.confirm') {
    const { title, date, kind, person, recurrence, leadDays, self } = request;
    if (typeof title !== 'string' || typeof date !== 'string' || typeof kind !== 'string') return undefined;
    const proposal = proposeOccasion(source, { title, date, kind,
      ...(typeof person === 'string' ? { person } : {}), ...(typeof recurrence === 'string' ? { recurrence } : {}),
      ...(typeof leadDays === 'number' ? { leadDays } : {}), ...(self === true ? { self: true } : {}),
    });
    return proposal.ok && !proposal.needsKind
      ? { method: 'profile.append', input: { section: OCCASIONS_SECTION, text: proposal.line, ...identity } } : undefined;
  }
  if (method === 'occasions.plans.confirm') {
    const { title, from, to, away, destination, details } = request;
    if (typeof title !== 'string' || typeof from !== 'string' || typeof to !== 'string') return undefined;
    const proposal = proposePlan({ title, from, to, ...(away === undefined ? {} : { away: away === true }),
      ...(typeof destination === 'string' ? { destination } : {}),
      ...(Array.isArray(details) ? { details: details.filter((detail): detail is string => typeof detail === 'string') } : {}),
    });
    return proposal.ok ? { method: 'profile.append', input: { section: PLANS_SECTION, text: proposal.line, ...identity } } : undefined;
  }
  return undefined;
}

/** What a capture proposes, before anything is written. */
export interface OccasionProposal {
  readonly ok: boolean;
  /** Why the proposal cannot be confirmed as it stands. */
  readonly reason: string | null;
  /** The line that would be written, exactly. */
  readonly line: string;
  /** The one-line confirmation to put to the owner. Empty when `ok` is false. */
  readonly confirmation: string;
  /** True when the owner still has to choose the kind. Never guessed. */
  readonly needsKind: boolean;
  /** Dates already recorded for this title that disagree with the new one. */
  readonly conflictsWith: readonly string[];
}

/** The result of a confirmed capture or a removal. */
export interface OccasionWriteOutcome {
  readonly ok: boolean;
  readonly reason: string | null;
  readonly occasionId: string;
  readonly disclosure: string;
  /** Records dropped because their occasion is gone. Removals only. */
  readonly droppedRecords: number;
}

export interface ProposeOccasionInput {
  readonly title: string;
  readonly date: string;
  readonly kind?: string | undefined;
  readonly person?: string | undefined;
  readonly recurrence?: string | undefined;
  readonly leadDays?: number | undefined;
  /**
   * True when the occasion is about the OWNER's own occasion.
   *
   * Written onto the line as `for me`, and the reason it is captured rather
   * than worked out later: the owner knows when their own birthday is, so an
   * occasion about them that they only have to remember is never pushed at
   * them. Stating it at capture is the reliable path; the reader can also
   * resolve a possessive title against the owner's declared name, but only
   * they can settle the ambiguous ones.
   */
  readonly self?: boolean | undefined;
}

export interface ConfirmOccasionInput extends ProposeOccasionInput {
  readonly kind: string;
  readonly surface: ProfileSurface;
  readonly said: string;
  readonly authority: AuthoritySurface | 'autonomous';
}

function readRecurrenceWord(value: string | undefined, dated: boolean): OccasionRecurrence {
  const word = (value ?? '').trim().toLowerCase();
  if (word === 'once') return 'once';
  if (word === 'annual') return 'annual';
  // A bare `YYYY-MM-DD` with no recurrence word is a single dated thing; a bare
  // `MM-DD` has no year and can only mean every year.
  return dated ? 'once' : 'annual';
}

/**
 * Work out what would be written, and the one line to put to the owner.
 *
 * Nothing is written. A conflict with something already recorded is REPORTED
 * here rather than resolved: the owner said two different things, only they
 * know which was right, and silently taking the newer value is the one
 * behaviour ruled out.
 */
export function proposeOccasion(
  source: OccasionProfileSource,
  input: ProposeOccasionInput,
): OccasionProposal {
  const title = input.title.trim();
  if (title.length === 0) {
    return refuse('An occasion needs a name, what should it be called?');
  }
  const date = parseOccasionDate(input.date);
  if (date === null) {
    return refuse(
      `"${input.date}" is not a date I can read. Write it as MM-DD for something annual, or YYYY-MM-DD.`,
    );
  }
  const kindValue = (input.kind ?? '').trim().toLowerCase();
  const kind: OccasionKind | null = isOccasionKind(kindValue) ? kindValue : null;
  const id = occasionIdFor(title);
  const written = renderOccasionDate(date);
  const conflictsWith = readOccasionDeclarations(source).occasions
    .filter((entry) => entry.id === id)
    .map((entry) => renderOccasionDate(entry.date))
    .filter((value) => value !== written);

  const occasion: Occasion = {
    id,
    title,
    date,
    recurrence: readRecurrenceWord(input.recurrence, date.kind === 'dated'),
    // Rendered with the kind the owner has chosen so they see exactly what
    // will be written. When they have not chosen one, `needsKind` is true and
    // `confirm` refuses rather than writing this placeholder.
    kind: kind ?? 'remember-only',
    person: input.self === true ? '' : (input.person ?? '').trim(),
    selfDeclared: input.self === true,
    // The proposal is not read back through the reader, so nothing here can
    // resolve a possessive title against the owner's name. `for me` is the only
    // attribution a capture settles by itself; everything else resolves the
    // first time the written line is read.
    subject: input.self === true ? 'owner' : 'unattributed',
    leadDays: typeof input.leadDays === 'number' && Number.isFinite(input.leadDays)
      ? Math.max(0, Math.round(input.leadDays))
      : null,
    mirrored: false,
    extras: [],
    lineIndex: -1,
    text: '',
  };

  const confirmation = kind === null
    ? `Noted ${title} as ${written}, right? And is that one you'll want to sort something for, `
      + 'one to just remember, or neither?'
    : `Noted ${title} as ${written}, right?`;

  return {
    ok: true,
    reason: null,
    line: renderOccasionLine(occasion),
    confirmation,
    needsKind: kind === null,
    conflictsWith,
  };
}

/** Write the confirmed occasion. Refuses without a kind rather than choosing one. */
export async function confirmOccasion(
  source: OccasionProfileSource,
  writer: OccasionProfileWriter,
  input: ConfirmOccasionInput,
  options: ProfileMutationOptions = {},
): Promise<OccasionWriteOutcome> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const proposal = proposeOccasion(source, input);
  const id = occasionIdFor(input.title);
  if (!proposal.ok) return failed(id, proposal.reason ?? 'Refused.');
  if (proposal.needsKind) {
    return failed(
      id,
      'Which kind is this, something to sort a gift for, something to just remember, or neither? '
      + 'Nothing is recorded until you say, because that is not something to guess at.',
    );
  }
  assertCurrent();
  const result = await writer.append({
    section: OCCASIONS_SECTION,
    text: proposal.line,
    surface: input.surface,
    said: input.said,
    authority: input.authority,
  }, options);
  assertCurrent();
  return {
    ok: result.ok,
    reason: result.reason,
    occasionId: id,
    disclosure: result.disclosure,
    droppedRecords: 0,
  };
}

export interface ProposePlanInput {
  readonly title: string;
  readonly from: string;
  readonly to: string;
  readonly away?: boolean | undefined;
  readonly destination?: string | undefined;
  /**
   * Everything else the owner said about it, one detail per entry: a
   * confirmation number, a flight and its times, who is travelling, why
   * they are going.
   *
   * Kept because a trip stripped to its dates answers "am I away" and nothing
   * else, and the itinerary was pasted precisely so the details would be
   * there later. Each entry is normalised to survive the line grammar
   * (`normalizePlanDetail`) and then the whole line is re-read to prove it
   * round-trips before anything is written.
   */
  readonly details?: readonly string[] | undefined;
}

export interface ConfirmPlanInput extends ProposePlanInput {
  readonly surface: ProfileSurface;
  readonly said: string;
  readonly authority: AuthoritySurface | 'autonomous';
}

/** The same two-step capture, for a plan. Plans never prompt; they are known. */
export function proposePlan(input: ProposePlanInput): OccasionProposal {
  const title = input.title.trim();
  if (title.length === 0) return refuse('A plan needs a name.');
  const details = (input.details ?? [])
    .map((detail) => normalizePlanDetail(detail))
    .filter((detail) => detail.length > 0);
  const line = renderPlanLine({
    id: occasionIdFor(title),
    title,
    from: input.from.trim(),
    to: input.to.trim(),
    away: input.away === true,
    destination: (input.destination ?? '').trim(),
    extras: details,
    lineIndex: -1,
    text: '',
  });
  const reread = readPlanLineStrict(line);
  if (reread === null) {
    return refuse(`I could not read ${input.from} to ${input.to} as a range. Write both ends as YYYY-MM-DD.`);
  }
  // The details are the point of recording the trip, so prove they survived
  // rather than assuming it. A detail that came back changed or missing means
  // the line grammar ate it, and writing the line anyway would lose the very
  // thing the owner pasted while reporting success.
  if (reread.extras.length !== details.length
    || details.some((detail, index) => reread.extras[index] !== detail)) {
    return refuse(
      'I could not store those details without changing them, so I have not written the plan. '
      + 'Tell me the trip again with the details in plainer words and I will record it.',
    );
  }
  const where = reread.destination.length > 0 ? ` in ${reread.destination}` : '';
  return {
    ok: true,
    reason: null,
    line,
    confirmation: `Noted ${title}, ${reread.from} to ${reread.to}${where}, right?`,
    needsKind: false,
    conflictsWith: [],
  };
}

export async function confirmPlan(
  writer: OccasionProfileWriter,
  input: ConfirmPlanInput,
  options: ProfileMutationOptions = {},
): Promise<OccasionWriteOutcome> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const proposal = proposePlan(input);
  const id = occasionIdFor(input.title);
  if (!proposal.ok) return failed(id, proposal.reason ?? 'Refused.');
  assertCurrent();
  const result = await writer.append({
    section: PLANS_SECTION,
    text: proposal.line,
    surface: input.surface,
    said: input.said,
    authority: input.authority,
  }, options);
  assertCurrent();
  return {
    ok: result.ok,
    reason: result.reason,
    occasionId: id,
    disclosure: result.disclosure,
    droppedRecords: 0,
  };
}

/**
 * Remove an occasion, and everything the machine remembered about it.
 *
 * One confirmation, carried by the caller. Not unquestioned and not an argument:
 * people divorce and people die, and removing an occasion should take one
 * sentence and one confirm.
 *
 * The profile line goes first and the machine state second. That order matters,
 * if the state drop failed after the line was gone, the next sweep reaps it as
 * an orphan anyway, whereas the other order could leave the line in place with
 * its history removed and nothing to explain why.
 */
export async function removeOccasion(
  source: OccasionProfileSource,
  writer: OccasionProfileWriter,
  dropState: (occasionId: string) => Promise<number>,
  input: { readonly occasionId: string; readonly confirmed: boolean; readonly authority: AuthoritySurface | 'autonomous' },
  options: ProfileMutationOptions = {},
): Promise<OccasionWriteOutcome> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  if (!input.confirmed) {
    return failed(
      input.occasionId,
      'Removing this drops the date and everything recorded against it. Confirm to go ahead.',
    );
  }
  const occasion = readOccasionDeclarations(source).occasions.find((entry) => entry.id === input.occasionId);
  if (occasion === undefined) {
    // Still drop any state, so a line the owner deleted by hand does not leave the
    // machine holding an answer about something that is no longer there.
    assertCurrent();
    const dropped = await dropState(input.occasionId);
    assertCurrent();
    return {
      ok: dropped > 0,
      reason: dropped > 0 ? null : 'There is no occasion by that name, so there was nothing to remove.',
      occasionId: input.occasionId,
      disclosure: '',
      droppedRecords: dropped,
    };
  }
  assertCurrent();
  const result = await writer.forget({
    section: OCCASIONS_SECTION,
    text: occasion.text,
    authority: input.authority,
  }, options);
  assertCurrent();
  if (!result.ok) return failed(input.occasionId, result.reason ?? 'Refused.');
  const dropped = await dropState(input.occasionId);
  assertCurrent();
  return {
    ok: true,
    reason: null,
    occasionId: input.occasionId,
    disclosure: result.disclosure,
    droppedRecords: dropped,
  };
}

/** What resolving one date conflict would remove, and what the owner can choose from. */
export interface ConflictResolutionPlan {
  /** Every distinct date recorded for the occasion, as written, in document order. */
  readonly dates: readonly string[];
  /** The date to keep, normalised, or null when none (or none recorded) was given. */
  readonly keep: string | null;
  /** The declarations that carry another date. Empty when there is nothing to resolve. */
  readonly remove: readonly Occasion[];
}

/** Work out which declarations a resolution keeping `keep` removes. Reads only; writes nothing. */
export function planConflictResolution(
  source: Pick<OccasionProfileSource, 'importantDates'>,
  occasionId: string,
  keep: string | undefined,
): ConflictResolutionPlan {
  const lines = readOccasionDeclarations(source).declarations.filter((entry) => entry.id === occasionId);
  const dates = [...new Set(lines.map((entry) => renderOccasionDate(entry.date)))];
  const parsed = keep === undefined ? null : parseOccasionDate(keep);
  const wanted = parsed === null ? null : renderOccasionDate(parsed);
  if (wanted === null || !dates.includes(wanted)) return { dates, keep: null, remove: [] };
  return { dates, keep: wanted, remove: lines.filter((entry) => renderOccasionDate(entry.date) !== wanted) };
}

/** What `occasions.conflict.resolve` answers. */
export interface ConflictResolution {
  readonly occasionId: string;
  /** True when the profile now holds one date for this occasion. */
  readonly resolved: boolean;
  /** Why it is not resolved, and what to do; null when it is. */
  readonly reason: string | null;
  /** Every date that was recorded before this call. */
  readonly dates: readonly string[];
  /** The dates whose lines were removed. */
  readonly removed: readonly string[];
  /** The profile's own account of the write, to say to the owner. */
  readonly disclosure: string;
}

/**
 * Resolve a date conflict with the date the owner says is right.
 *
 * The other declarations of that title are removed from the profile through the
 * ordinary write gate, one line at a time by its exact text, so a line the owner
 * edited meanwhile is not removed by mistake. Answers, gift history and open
 * items are machine state keyed by the title and stay as they are; the conflict
 * reminder is closed. With no date, or one that is not recorded, nothing is
 * changed and the recorded dates come back so the owner can choose.
 */
export async function resolveOccasionConflict(
  source: Pick<OccasionProfileSource, 'importantDates'>,
  writer: OccasionProfileWriter,
  closeReminder: () => Promise<boolean>,
  input: { readonly occasionId: string; readonly keep?: string | undefined; readonly authority?: AuthoritySurface | 'autonomous' | undefined },
  options: ProfileMutationOptions = {},
): Promise<ConflictResolution> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const plan = planConflictResolution(source, input.occasionId, input.keep);
  const base = { occasionId: input.occasionId, dates: plan.dates, removed: [] as string[], disclosure: '' };
  if (plan.dates.length === 0) {
    return { ...base, resolved: false, reason: 'There is no occasion by that name, so there was no conflict to resolve.' };
  }
  if (plan.dates.length === 1) {
    // The file already agrees with itself (the owner fixed it by hand), so
    // the only thing left is the reminder.
    await closeReminder();
    assertCurrent();
    return { ...base, resolved: true, reason: null };
  }
  if (plan.keep === null) {
    return {
      ...base,
      resolved: false,
      reason: `Say which date to keep: ${plan.dates.join(' or ')}. Nothing was changed.`,
    };
  }
  if (input.authority === undefined) {
    return { ...base, resolved: false, reason: 'Keeping one date removes the others from the profile, so the write needs an authority. Nothing was changed.' };
  }
  const authority = input.authority;
  const removed: string[] = [];
  const disclosures: string[] = [];
  let first = true;
  for (const line of plan.remove) {
    assertCurrent();
    // An admitted effect covers one removal; any further line is a write of
    // its own under the caller's authority.
    const result = await writer.forget({ section: OCCASIONS_SECTION, text: line.text, authority },
      first ? options : { ...options, admittedMutation: undefined });
    first = false;
    if (!result.ok) {
      return {
        ...base,
        removed,
        disclosure: disclosures.join(' '),
        resolved: false,
        reason: `${result.reason ?? 'The profile refused the change.'}`
          + (removed.length > 0 ? ` The line${removed.length === 1 ? '' : 's'} dated ${removed.join(', ')} ${removed.length === 1 ? 'was' : 'were'} removed before that.` : ' Nothing was changed.'),
      };
    }
    removed.push(renderOccasionDate(line.date));
    if (result.disclosure) disclosures.push(result.disclosure);
  }
  await closeReminder();
  assertCurrent();
  return { ...base, removed: [...new Set(removed)], disclosure: disclosures.join(' '), resolved: true, reason: null };
}

/**
 * Re-read a rendered plan line through the one grammar that defines one.
 *
 * Render-then-reparse rather than a second validator: the grammar owns what a
 * range is, and a second opinion here is how two definitions of "a valid range"
 * end up in one codebase disagreeing about the end points.
 */
function readPlanLineStrict(line: string): Plan | null {
  const result = parsePlanLine(-1, `- ${line}`);
  return result.ok ? result.plan : null;
}

function refuse(reason: string): OccasionProposal {
  return { ok: false, reason, line: '', confirmation: '', needsKind: false, conflictsWith: [] };
}

function failed(occasionId: string, reason: string): OccasionWriteOutcome {
  return { ok: false, reason, occasionId, disclosure: '', droppedRecords: 0 };
}
