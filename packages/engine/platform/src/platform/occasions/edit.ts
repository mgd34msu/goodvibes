/**
 * edit.ts, changing a recorded occasion or plan in place, and removing a plan.
 *
 * An occasion's id is its normalised title, and every answer, gift record and
 * calendar mirror the machine keeps is keyed by that id. An edit therefore
 * rewrites the one profile line and keeps the id: the date, kind, person,
 * recurrence and lead can change and the history stays attached. A new title
 * that normalises to a different id would be a different occasion, so it is
 * refused with the way to do it (add the new one, remove the old).
 *
 * The same two steps as a capture: without `confirmed` the edit is proposed
 * (the exact line and the one sentence to put to the owner) and nothing is
 * written; with it the line is written.
 *
 * The write is append-then-forget. The new line lands first and the old one is
 * removed after it, so a refusal between the two leaves both lines (shown as a
 * conflict the owner can resolve) rather than neither.
 */
import type { AuthoritySurface } from '../security/untrusted-content.js';
import type { ProfileMutationOptions } from '../owner-profile/delegation.js';
import type { ProfileSurface } from '../owner-profile/types.js';
import { parseOccasionDate, renderOccasionDate } from './dates.js';
import { normalizePlanDetail, occasionIdFor, parsePlanLine, renderOccasionLine, renderPlanLine } from './grammar.js';
import { readOccasionDeclarations, readPlans, type OccasionProfileSource } from './reader.js';
import type { OccasionProfileWriter, OccasionWriteOutcome } from './capture.js';
import { isOccasionKind, OCCASIONS_SECTION, PLANS_SECTION, type Occasion, type Plan } from './types.js';

/** The fields of an occasion an edit can change; a field left out keeps its value. */
export interface OccasionChanges {
  readonly title?: string | undefined;
  readonly date?: string | undefined;
  readonly kind?: string | undefined;
  /** The person it is about; empty clears it. */
  readonly person?: string | undefined;
  readonly recurrence?: string | undefined;
  /** Days of notice; null returns to the configured default. */
  readonly leadDays?: number | null | undefined;
  readonly self?: boolean | undefined;
}

export interface UpdateOccasionInput extends OccasionChanges {
  readonly occasionId: string;
  readonly confirmed: boolean;
  readonly surface: ProfileSurface;
  readonly said: string;
  readonly authority: AuthoritySurface | 'autonomous';
}

/** What an edit would write, or why it cannot. Reads only. */
export interface OccasionEditPlan {
  readonly ok: boolean;
  readonly reason: string | null;
  /** The line the edit writes. Empty when not ok. */
  readonly line: string;
  /** The line it replaces. Empty when not ok. */
  readonly replaces: string;
  /** The one sentence to put to the owner. Empty when not ok. */
  readonly confirmation: string;
  /** True when the edit changes nothing. */
  readonly unchanged: boolean;
}

/** The answer of an occasion or plan edit. Without `confirmed`, `written` is false and `proposal` says what would be written. */
export interface OccasionEditOutcome extends OccasionWriteOutcome {
  readonly written: boolean;
  readonly proposal: OccasionEditPlan;
}

function refusePlan(reason: string): OccasionEditPlan {
  return { ok: false, reason, line: '', replaces: '', confirmation: '', unchanged: false };
}

/** Work out the rewritten line for one occasion. Writes nothing. */
export function planOccasionUpdate(
  source: Pick<OccasionProfileSource, 'importantDates'>,
  occasionId: string,
  changes: OccasionChanges,
): OccasionEditPlan {
  const read = readOccasionDeclarations(source);
  const lines = read.declarations.filter((entry) => entry.id === occasionId);
  const current = read.occasions.find((entry) => entry.id === occasionId);
  if (current === undefined || lines.length === 0) {
    return refusePlan('There is no occasion by that name, so there is nothing to change.');
  }
  if (lines.length > 1) {
    return refusePlan('This occasion is recorded more than once. Choose which date to keep first, then change it.');
  }
  const title = changes.title === undefined ? current.title : changes.title.trim();
  if (title.length === 0) return refusePlan('An occasion needs a name.');
  if (occasionIdFor(title) !== occasionId) {
    return refusePlan(
      `"${title}" would be a different occasion, and its answers and gift history would not follow it. `
      + 'Add it under the new name and remove this one instead.',
    );
  }
  let date = current.date;
  if (changes.date !== undefined) {
    const parsed = parseOccasionDate(changes.date);
    if (parsed === null) {
      return refusePlan(`"${changes.date}" is not a date I can read. Write it as MM-DD for something annual, or YYYY-MM-DD.`);
    }
    date = parsed;
  }
  let kind = current.kind;
  if (changes.kind !== undefined) {
    const word = changes.kind.trim().toLowerCase();
    if (!isOccasionKind(word)) return refusePlan('The kind must be gift-giving, remember-only or neither.');
    kind = word;
  }
  let recurrence = current.recurrence;
  if (changes.recurrence !== undefined) {
    const word = changes.recurrence.trim().toLowerCase();
    if (word !== 'once' && word !== 'annual') return refusePlan('The recurrence must be once or annual.');
    recurrence = word;
  }
  if (recurrence === 'once' && date.kind !== 'dated') {
    return refusePlan('Something that happens once needs a year: write the date as YYYY-MM-DD.');
  }
  let leadDays = current.leadDays;
  if (changes.leadDays === null) leadDays = null;
  else if (changes.leadDays !== undefined) {
    if (!Number.isFinite(changes.leadDays) || changes.leadDays < 0) return refusePlan('The lead must be zero or more days.');
    leadDays = Math.round(changes.leadDays);
  }
  const selfDeclared = changes.self ?? current.selfDeclared;
  const person = selfDeclared ? '' : (changes.person ?? current.person).trim();
  const next: Occasion = { ...current, title, date, kind, recurrence, leadDays, selfDeclared, person };
  const line = renderOccasionLine(next);
  if (line === renderOccasionLine(current)) {
    return { ok: true, reason: null, line, replaces: current.text, confirmation: `${current.title} already reads that way.`, unchanged: true };
  }
  const dateMoved = renderOccasionDate(date) !== renderOccasionDate(current.date);
  return {
    ok: true,
    reason: null,
    line,
    replaces: current.text,
    confirmation: `Changed ${title} to ${renderOccasionDate(date)}, ${kind}, right?`
      + (dateMoved ? ' A calendar entry already made for the old date is not moved.' : ''),
    unchanged: false,
  };
}

/** The fields of a plan an edit can change; a field left out keeps its value. */
export interface PlanChanges {
  readonly title?: string | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly away?: boolean | undefined;
  /** Where; empty clears it. */
  readonly destination?: string | undefined;
  /** Replaces every detail when given. */
  readonly details?: readonly string[] | undefined;
}

/** Which plan: its id, and its start date when two plans share a name. */
export interface PlanSelector {
  readonly planId: string;
  readonly planFrom?: string | undefined;
}

function selectPlan(source: Pick<OccasionProfileSource, 'plans'>, selector: PlanSelector): Plan | string {
  const matches = readPlans(source).plans.filter((plan) => plan.id === selector.planId
    && (selector.planFrom === undefined || plan.from === selector.planFrom));
  if (matches.length === 0) return 'There is no plan by that name, so there is nothing to change.';
  if (matches.length > 1) {
    return `More than one plan has that name (starting ${matches.map((plan) => plan.from).join(', ')}). Say which one by its start date.`;
  }
  return matches[0] as Plan;
}

/** Work out the rewritten line for one plan. Writes nothing. */
export function planPlanUpdate(
  source: Pick<OccasionProfileSource, 'plans'>,
  selector: PlanSelector,
  changes: PlanChanges,
): OccasionEditPlan {
  const current = selectPlan(source, selector);
  if (typeof current === 'string') return refusePlan(current);
  const title = changes.title === undefined ? current.title : changes.title.trim();
  if (title.length === 0) return refusePlan('A plan needs a name.');
  const next: Plan = {
    ...current,
    id: occasionIdFor(title),
    title,
    from: (changes.from ?? current.from).trim(),
    to: (changes.to ?? current.to).trim(),
    away: changes.away ?? current.away,
    destination: (changes.destination ?? current.destination).trim(),
    extras: changes.details === undefined ? current.extras : changes.details.map((detail) => normalizePlanDetail(detail)).filter((detail) => detail.length > 0),
  };
  const line = renderPlanLine(next);
  // The grammar owns what a range and a detail are: re-read the line rather
  // than validating it a second way.
  const reread = parsePlanLine(-1, `- ${line}`);
  if (!reread.ok) return refusePlan(`I could not read ${next.from} to ${next.to} as a range. Write both ends as YYYY-MM-DD.`);
  if (reread.plan.extras.length !== next.extras.length || next.extras.some((detail, index) => reread.plan.extras[index] !== detail)) {
    return refusePlan('I could not store those details without changing them. Write them in plainer words.');
  }
  if (line === renderPlanLine(current)) {
    return { ok: true, reason: null, line, replaces: current.text, confirmation: `${current.title} already reads that way.`, unchanged: true };
  }
  const where = reread.plan.destination.length > 0 ? ` in ${reread.plan.destination}` : '';
  return {
    ok: true,
    reason: null,
    line,
    replaces: current.text,
    confirmation: `Changed ${title} to ${reread.plan.from} to ${reread.plan.to}${where}, right?`,
    unchanged: false,
  };
}

/** Write a planned edit: the new line first, then the old one removed. */
async function writeEdit(
  writer: OccasionProfileWriter,
  section: string,
  id: string,
  plan: OccasionEditPlan,
  input: { readonly confirmed: boolean; readonly surface: ProfileSurface; readonly said: string; readonly authority: AuthoritySurface | 'autonomous' },
  options: ProfileMutationOptions,
): Promise<OccasionEditOutcome> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const base = { occasionId: id, disclosure: '', droppedRecords: 0, proposal: plan };
  if (!plan.ok) return { ...base, ok: false, reason: plan.reason, written: false };
  if (plan.unchanged) return { ...base, ok: true, reason: null, written: false };
  if (!input.confirmed) {
    return { ...base, ok: false, reason: `${plan.confirmation} Nothing is changed until you confirm.`, written: false };
  }
  const added = await writer.append({ section, text: plan.line, surface: input.surface, said: input.said, authority: input.authority }, options);
  assertCurrent();
  if (!added.ok) return { ...base, ok: false, reason: added.reason ?? 'The profile refused the change. Nothing was changed.', written: false };
  // An admitted effect covers the one write that adds the line; removing the
  // old line is a write of its own under the caller's authority.
  const removed = await writer.forget({ section, text: plan.replaces, authority: input.authority }, { ...options, admittedMutation: undefined });
  assertCurrent();
  if (!removed.ok) {
    return {
      ...base,
      ok: false,
      written: true,
      disclosure: added.disclosure,
      reason: `The new line was written but the old one was not removed (${removed.reason ?? 'the profile refused'}). Both are recorded now; remove the old one.`,
    };
  }
  return { ...base, ok: true, reason: null, written: true, disclosure: [added.disclosure, removed.disclosure].filter(Boolean).join(' ') };
}

/** Change one occasion in place, keeping its id and so its history. */
export async function updateOccasion(
  source: OccasionProfileSource,
  writer: OccasionProfileWriter,
  input: UpdateOccasionInput,
  options: ProfileMutationOptions = {},
): Promise<OccasionEditOutcome> {
  return writeEdit(writer, OCCASIONS_SECTION, input.occasionId, planOccasionUpdate(source, input.occasionId, input), input, options);
}

export interface UpdatePlanInput extends PlanSelector, PlanChanges {
  readonly confirmed: boolean;
  readonly surface: ProfileSurface;
  readonly said: string;
  readonly authority: AuthoritySurface | 'autonomous';
}

/** Change one plan in place. */
export async function updatePlan(
  source: OccasionProfileSource,
  writer: OccasionProfileWriter,
  input: UpdatePlanInput,
  options: ProfileMutationOptions = {},
): Promise<OccasionEditOutcome> {
  return writeEdit(writer, PLANS_SECTION, input.planId, planPlanUpdate(source, input, input), input, options);
}

/** Remove one plan by id. One confirmation, like an occasion removal. */
export async function removePlan(
  source: OccasionProfileSource,
  writer: OccasionProfileWriter,
  input: PlanSelector & { readonly confirmed: boolean; readonly authority: AuthoritySurface | 'autonomous' },
  options: ProfileMutationOptions = {},
): Promise<OccasionWriteOutcome> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const plan = selectPlan(source, input);
  const base = { occasionId: input.planId, disclosure: '', droppedRecords: 0 };
  if (typeof plan === 'string') return { ...base, ok: false, reason: plan };
  if (!input.confirmed) {
    return { ...base, ok: false, reason: `Removing ${plan.title} (${plan.from} to ${plan.to}) takes it out of your profile. Confirm to go ahead.` };
  }
  const result = await writer.forget({ section: PLANS_SECTION, text: plan.text, authority: input.authority }, options);
  assertCurrent();
  return { ...base, ok: result.ok, reason: result.ok ? null : result.reason ?? 'The profile refused the change.', disclosure: result.disclosure };
}

/** The line a plan removal forgets, for the admission projection. */
export function planRemovalText(source: Pick<OccasionProfileSource, 'plans'>, selector: PlanSelector): string | undefined {
  const plan = selectPlan(source, selector);
  return typeof plan === 'string' ? undefined : plan.text;
}
