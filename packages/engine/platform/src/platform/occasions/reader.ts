/**
 * reader.ts, the profile, read as occasions and plans.
 *
 * One direction only. This module reads the owner's file and types what it
 * finds; nothing here writes, and nothing here takes a date from anywhere other
 * than the owner's file. That is the §6 rule made structural: a calendar entry is a
 * single occurrence of an ephemeral thing, and sourcing an occasion from one
 * would give the wrong recurrence and lose the fact the moment the event passed.
 * There is no calendar-shaped input to this module, so there is no path to get
 * it wrong later.
 *
 * The reader is also where CONFLICTS are found. The profile already preserves
 * every line the owner wrote, so two different dates for the same thing are both
 * sitting in the document; taking the newer one silently would be the one
 * behaviour explicitly ruled out. Both are reported, and the conflict becomes an
 * open item that is raised now and raised again if it is ignored.
 */
import type { ProfileLine } from '../owner-profile/types.js';
import type { ProfilePersonReadingOptions } from '../owner-profile/person-reading.js';
import { renderOccasionDate, type IsoDate } from './dates.js';
import { occasionIdFor, parseOccasionLine, parsePlanLine, splitSegments } from './grammar.js';
import { declaredSubject } from './subject.js';
import type {
  Occasion,
  OccasionSubject,
  OccasionConflict,
  Plan,
  UnparsedOccasionLine,
  UnparsedPlanLine,
} from './types.js';

/**
 * The narrow read surface this module needs from the owner-profile store.
 *
 * Three named methods, no generic section reader: the store deliberately has no
 * "give me any closed section" call and this interface must not become one by
 * accident.
 */
export interface OccasionProfileSource {
  /** Raw prose lines under `## Important dates`. */
  importantDates(): readonly ProfileLine[];
  /** Raw prose lines under `## Plans`. */
  plans(): readonly ProfileLine[];
  /** Profile lines mentioning one person, by name. Opens the interview. */
  person(name: string, options?: ProfilePersonReadingOptions): readonly ProfileLine[] | Promise<readonly ProfileLine[]>;
  /** Captures the actual profile incarnation without exposing closed content. */
  captureRead?(): { readonly assertCurrent: () => void };
  /**
   * What the owner calls THEMSELVES: `identity.name` and `identity.goesBy`.
   *
   * The linkage that lets an entry using the owner's own name be recognised as
   * being about the person whose file this is, without any name literal living
   * in the code. Values they have not declared are simply absent from the list.
   *
   * OPTIONAL, and absent means "no names known" rather than "no match". A
   * narrow embed that does not supply it gets `unattributed` for everything,
   * which is the ordinary cadence, the failure direction that costs the owner a
   * nudge they did not need rather than one they did.
   */
  ownerNames?(): readonly string[];
}

/** Everything the dates section holds, including what did not parse. */
export interface OccasionReadResult {
  readonly occasions: readonly Occasion[];
  readonly unparsed: readonly UnparsedOccasionLine[];
  readonly conflicts: readonly OccasionConflict[];
  /**
   * Every parsed declaration, in document order, including later lines for an
   * id already seen. What a conflict resolution removes from.
   */
  readonly declarations: readonly Occasion[];
  /**
   * The id of every line under the heading that has a title, parsed or not.
   * State for these is kept: a line the parser cannot read today is still the
   * owner's line, and a typo must not cost its answers.
   */
  readonly declaredIds: ReadonlySet<string>;
}

/** Everything the plans section holds. */
export interface PlanReadResult {
  readonly plans: readonly Plan[];
  readonly unparsed: readonly UnparsedPlanLine[];
}

/**
 * Read every occasion, in document order.
 *
 * The FIRST line for an id is the active occasion, matching the profile's own
 * rule for a duplicated mechanical field. A later line for the same id is not
 * dropped: it is a conflict, whatever date it names. A same-date duplicate is
 * not harmless: its kind, person, lead time or recurrence can differ, and
 * removing the first line would quietly make the second one the occasion.
 */
export function readOccasionDeclarations(
  source: Pick<OccasionProfileSource, 'importantDates'>,
  subjectOf: (occasion: Occasion) => OccasionSubject = declaredSubject,
): OccasionReadResult {
  const occasions: Occasion[] = [];
  const declarations: Occasion[] = [];
  const unparsed: UnparsedOccasionLine[] = [];
  const declaredIds = new Set<string>();
  const byId = new Map<string, Occasion[]>();

  for (const line of source.importantDates()) {
    const result = parseOccasionLine(line.lineIndex, line.text);
    if (!result.ok) {
      unparsed.push(result.unparsed);
      const title = splitSegments(line.text).title;
      if (title.length > 0) declaredIds.add(occasionIdFor(title));
      continue;
    }
    const parsed: Occasion = { ...result.occasion, subject: declaredSubject(result.occasion) };
    const occasion: Occasion = { ...parsed, subject: subjectOf(parsed) };
    declaredIds.add(occasion.id);
    declarations.push(occasion);
    const seen = byId.get(occasion.id);
    if (seen === undefined) {
      byId.set(occasion.id, [occasion]);
      occasions.push(occasion);
    } else {
      seen.push(occasion);
    }
  }

  const conflicts: OccasionConflict[] = [];
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    const dates = [...new Set(group.map((entry) => renderOccasionDate(entry.date)))];
    conflicts.push({
      occasionId: id,
      title: group[0]?.title ?? id,
      dates,
      lineIndexes: group.map((entry) => entry.lineIndex),
    });
  }

  return { occasions, unparsed, conflicts, declarations, declaredIds };
}

/**
 * The same read, with the subject the service resolved for each line (stored
 * readings, see subject.ts). Synchronous: nothing here asks anything.
 */
export function readOccasions(
  source: Pick<OccasionProfileSource, 'importantDates'>,
  subjectOf?: (occasion: Occasion) => OccasionSubject,
): OccasionReadResult {
  return readOccasionDeclarations(source, subjectOf);
}

/** Read every plan, in document order. */
export function readPlans(source: Pick<OccasionProfileSource, 'plans'>): PlanReadResult {
  const plans: Plan[] = [];
  const unparsed: UnparsedPlanLine[] = [];
  for (const line of source.plans()) {
    const result = parsePlanLine(line.lineIndex, line.text);
    if (result.ok) plans.push(result.plan);
    else unparsed.push(result.unparsed);
  }
  return { plans, unparsed };
}

/** The plan covering `date` that takes the owner away from home, if there is one. */
export function awayPlanOn(plans: readonly Plan[], date: IsoDate): Plan | undefined {
  return plans.find((plan) => plan.away && plan.from <= date && date <= plan.to);
}

/**
 * The next away plan that STARTS on or after `date`, if there is one.
 *
 * Used to move a nudge earlier so it reaches the owner before they leave rather
 * than while they are standing in an airport. Ordered by start date because two
 * overlapping trips would otherwise resolve by document order, which is the
 * order they happened to type them in.
 */
export function nextAwayPlanFrom(plans: readonly Plan[], date: IsoDate): Plan | undefined {
  return plans
    .filter((plan) => plan.away && plan.from >= date)
    .sort((left, right) => (left.from < right.from ? -1 : left.from > right.from ? 1 : 0))[0];
}

/** True when the owner is away on `date`. */
export function isAwayOn(plans: readonly Plan[], date: IsoDate): boolean {
  return awayPlanOn(plans, date) !== undefined;
}
