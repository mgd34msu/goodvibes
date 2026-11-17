/** One service sequences occasion capture, acknowledgements, interviews and
 * sweeps over the shared profile and machine state. Delivery records belong to
 * each configured destination, so a failed push remains available to pull.
 *
 * Each operation reads the profile, the owner's names and the policy ONCE, into
 * one value it decides from. The profile's own read lease and the settings
 * revision are compared once, immediately before a sweep writes or delivers; a
 * delivery that a destination accepted is recorded whatever changed meanwhile.
 * No step on the sweep, list or pull path asks a model, except reading who a new
 * or changed `remember-only` line is about, which is stored (subject.ts).
 */
import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';
import type { OccasionMutationOptions } from './operation.js';
import { captureOccasionOperation, captureSettingsRevision, retainOccasionStateReceipts } from './operation.js';
import { OccasionReadingWork, OccasionReadingHeldError } from './readings.js';
import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assertCurrent as assertRevisionsCurrent } from '../utils/revision.js';
import type { AuthoritySurface } from '../security/untrusted-content.js';
import { isIsoDate, nextOccurrence, todayInZone, minutesOfDayInZone, type IsoDate } from './dates.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import { conflictItemId, interviewItemId, laterReturnDate, nudgeItemId } from './cadence.js';
import {
  answerStep,
  completeInterview,
  giftRecordFor,
  interviewIdFor,
  nextStep,
  prepareInterview,
} from './interview.js';
import {
  acknowledgeOccurrence,
  acknowledgementReply,
  alreadyAnsweredReply,
  type AcknowledgeOutcome,
} from './acknowledge.js';
import { resolveNudgeDestinations } from './destinations.js';
import { composeConflictMessage, composeInterviewResumeMessage, prepareNudge, subjectFor } from './nudge.js';
import { pushNudge, type OccasionNudgeDeliverer } from './push.js';
import { storedGiftEvidence } from './stored-reading-evidence.js';
import { removePlan, updateOccasion, updatePlan, type OccasionEditOutcome, type UpdateOccasionInput, type UpdatePlanInput } from './edit.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { preparePending } from './pending.js';
import { readOccasionsPolicy, readOccasionsTimezone, type OccasionsConfigAccess } from './policy.js';
import { readOccasionDeclarations, readPlans, type OccasionProfileSource, type OccasionReadResult } from './reader.js';
import { attributionKey, needsSubjectReading, readOccasionSubject } from './subject.js';
import type { OccasionStateStore } from './state-store.js';
import { decideSweep, effectiveLead, occurrenceWindow, type OccasionsPolicy } from './sweep.js';
import {
  confirmOccasion,
  confirmPlan,
  proposeOccasion,
  proposePlan,
  removeOccasion,
  resolveOccasionConflict,
  type ConfirmOccasionInput,
  type ConfirmPlanInput,
  type ConflictResolution,
  type OccasionProfileWriter,
  type OccasionProposal,
  type OccasionWriteOutcome,
  type ProposeOccasionInput,
  type ProposePlanInput,
} from './capture.js';
import type {
  GiftRecord,
  OccasionAckSource,
  OccasionAcknowledgement,
  OccasionAttribution,
  Interview,
  Occasion,
  OccasionAnswer,
  OccasionStateDisclosure,
  OccasionSubject,
  Plan,
} from './types.js';

/**
 * The delivery seam and its per-destination result, re-exported at the seam
 * every consumer already imports from. They live in push.ts; a caller wiring up
 * a deliverer should not have to know which file the sweep was split into.
 */
export type { NudgeDelivery, OccasionNudgeDeliverer } from './push.js';

/**
 * Writing an occasion out to a calendar. Optional, and one-directional.
 *
 * There is no read counterpart and there never will be: a calendar entry is a
 * single occurrence of an ephemeral thing, and feed content from outside the
 * owner is untrusted content. Sourcing a durable fact about their life from one
 * would be wrong twice over.
 *
 * Implementations must be idempotent for a given `(occasionId, occurrence)`.
 * This service also remembers the external id it was handed, so the ordinary
 * path does not call the implementation twice for the same occurrence at all.
 */
export interface OccasionCalendarMirror {
  mirror(input: {
    readonly occasion: Occasion;
    readonly occurrence: IsoDate;
    /** The id previously returned for this occurrence, when there is one. */
    readonly existingExternalId?: string | undefined;
  }): Promise<string | null>;
}

export interface OccasionsServiceDeps {
  readonly signal?: AbortSignal | undefined;
  readonly profile: OccasionProfileSource;
  readonly writer: OccasionProfileWriter;
  readonly state: OccasionStateStore;
  readonly config: OccasionsConfigAccess;
  readonly deliverer?: OccasionNudgeDeliverer | undefined;
  readonly calendar?: OccasionCalendarMirror | undefined;
  readonly now?: (() => number) | undefined;
}

import type { OccasionView, OccasionListResult, PlanListResult, SweepOutcome, InterviewProgress, PendingResult } from './service-views.js';
export type { OccasionView, OccasionListResult, PlanListResult, SweepOutcome, InterviewProgress, PendingResult } from './service-views.js';

/** What one operation decides from: read once at its start, never re-read. */
interface OccasionsReading {
  readonly now: number;
  readonly today: IsoDate;
  readonly timezone: string;
  readonly policy: OccasionsPolicy;
  readonly declarations: OccasionReadResult;
  readonly plans: readonly Plan[];
  /** True when decision models are off: subjects come from the `for me` marker only. */
  readonly classic: boolean;
}

/** The two restrictions an operation carries. */
interface OccasionsOperation {
  readonly signal: AbortSignal;
  /** The caller's own restriction and lifetime. Enough for a read or an answer. */
  readonly admitted: () => void;
  /**
   * `admitted`, plus the profile's read lease and the settings revision taken at
   * entry: what a sweep compares once before it writes or delivers.
   */
  readonly assertCurrent: () => void;
  /** No freshness check: records what already happened (an accepted delivery). */
  readonly record: () => void;
}

const CLASSIC_PROVENANCE = { provenance: 'classic', semanticAssessment: 'not-evaluated' } as const;

export class OccasionsService {
  private readonly answerOwners = new Map<string, AbortController>();
  /** One reading in flight per attribution key, shared by concurrent callers. */
  private readonly attributionReads = new Map<string, Promise<{ readonly subject: OccasionSubject; readonly store: boolean }>>();
  constructor(private readonly deps: OccasionsServiceDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private timezone(): string {
    return readOccasionsTimezone(this.deps.config);
  }

  private today(): IsoDate {
    return todayInZone(this.now(), this.timezone());
  }

  /** The effective policy, read live on every call. */
  policy(): OccasionsPolicy {
    return readOccasionsPolicy(this.deps.config);
  }

  /** Capture the operation's restrictions once, before any asynchronous step. */
  private operation(options: OccasionMutationOptions = {}): OccasionsOperation {
    const signal = AbortSignal.any([...(this.deps.signal ? [this.deps.signal] : []), ...(options.signal ? [options.signal] : [])]);
    const lease = this.deps.profile.captureRead?.();
    const settings = captureSettingsRevision(this.deps.config);
    const admitted = (): void => {
      signal.throwIfAborted();
      assertSynchronousJudgmentGuard(() => options.assertCurrent?.(), () => new OccasionReadingHeldError());
    };
    const assertCurrent = (): void => {
      admitted();
      lease?.assertCurrent();
      assertRevisionsCurrent(settings);
    };
    const record = (): void => {};
    retainOccasionStateReceipts(admitted, options);
    retainOccasionStateReceipts(assertCurrent, options);
    retainOccasionStateReceipts(record, options);
    return { signal, admitted, assertCurrent, record };
  }

  /**
   * Read the profile, the owner's names and the policy once, and settle who each
   * line is about from the stored readings. A `remember-only` line without
   * `for me` that has no stored reading for its current title, person and names
   * is read once (in parallel with any others) and the readings are stored in
   * one write; a reading that could not be taken (no model, deadline) is not
   * stored and the line takes the ordinary cadence until the next call.
   */
  private async read(op: OccasionsOperation, options: OccasionMutationOptions): Promise<OccasionsReading> {
    await this.deps.state.prepareRead(options);
    const now = this.now();
    const timezone = this.timezone();
    const policy = this.policy();
    const names = this.deps.profile.ownerNames?.() ?? [];
    const structural = readOccasionDeclarations(this.deps.profile);
    const subjects = await this.attribute(structural.occasions, names, now, op);
    const withSubject = (occasion: Occasion): Occasion => {
      const subject = subjects.get(occasion.id);
      return subject === undefined || subject === occasion.subject ? occasion : { ...occasion, subject };
    };
    const declarations: OccasionReadResult = {
      ...structural,
      occasions: structural.occasions.map(withSubject),
      declarations: structural.declarations.map(withSubject),
    };
    return {
      now,
      today: todayInZone(now, timezone),
      timezone,
      policy,
      declarations,
      plans: readPlans(this.deps.profile).plans,
      classic: isClassicOperation(),
    };
  }

  private async attribute(
    occasions: readonly Occasion[],
    names: readonly string[],
    now: number,
    op: OccasionsOperation,
  ): Promise<ReadonlyMap<string, OccasionSubject>> {
    const subjects = new Map<string, OccasionSubject>();
    const wanted: { readonly occasion: Occasion; readonly key: string }[] = [];
    let stored: ReadonlyMap<string, OccasionAttribution> | undefined;
    for (const occasion of occasions) {
      if (!needsSubjectReading(occasion)) continue;
      stored ??= new Map((await this.deps.state.attributions()).map((entry) => [entry.occasionId, entry]));
      const key = attributionKey(occasion, names);
      const hit = stored.get(occasion.id);
      if (hit !== undefined && hit.key === key) subjects.set(occasion.id, hit.subject);
      else wanted.push({ occasion, key });
    }
    if (wanted.length === 0) return subjects;
    const readings = await Promise.all(wanted.map(({ occasion, key }) => {
      const shared = this.attributionReads.get(key)
        ?? readOccasionSubject(occasion, names, op.signal).finally(() => this.attributionReads.delete(key));
      this.attributionReads.set(key, shared);
      return shared;
    }));
    const records: OccasionAttribution[] = [];
    wanted.forEach(({ occasion, key }, index) => {
      const reading = readings[index]!;
      subjects.set(occasion.id, reading.subject);
      if (reading.store) records.push({ occasionId: occasion.id, key, subject: reading.subject, readAt: now });
    });
    try {
      await this.deps.state.recordAttributions(records, op.admitted);
    } catch (error) {
      // The readings stand for this call; the next one reads the lines again.
      op.signal.throwIfAborted();
      logger.warn('occasions: could not store who a date is about', { error: summarizeError(error) });
    }
    return subjects;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Every declared occasion, with what the machine knows about each.
   *
   * This is the answer a surface renders. It DOES carry the date and the day
   * count, and that is not a contradiction of the never-the-date rule: this is
   * the owner asking their own system what it holds, over an authenticated verb,
   * which is exactly the explicit ask that unlocks a closed-tier read. The rule
   * is about what an unprompted message pushes onto a channel.
   */
  async list(options: OccasionMutationOptions = {}): Promise<OccasionListResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      const op = this.operation(options);
      const reading = await this.read(op, options);
      const { today, policy, declarations, plans } = reading;
      const acknowledgements = await this.deps.state.acknowledgements();
      const views: OccasionView[] = declarations.occasions.map((occasion) => {
        const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
        const window = occurrence === null ? null : occurrenceWindow(occasion, occurrence, today, plans, policy);
        const answer = occurrence === null
          ? null
          : acknowledgements.find(
            (entry) => entry.occasionId === occasion.id && entry.occurrence === occurrence,
          )?.answer ?? null;
        return {
          occasion,
          nextOccurrence: occurrence,
          daysUntil: window === null ? null : window.daysUntil,
          leadDays: effectiveLead(occasion, policy),
          inLeadWindow: window?.inside ?? false,
          answer,
          mirrored: occasion.mirrored,
        };
      });
      op.admitted();
      return { today, timezone: reading.timezone, occasions: views, unparsed: declarations.unparsed, conflicts: declarations.conflicts,
        ...(reading.classic ? { provenance: 'classic' as const, subjectAssessment: 'not-evaluated' as const } : {}) };
    });
  }

  /** Every declared plan, and whether one has the owner away right now. */
  listPlans(): PlanListResult {
    const today = this.today();
    const { plans, unparsed } = readPlans(this.deps.profile);
    const awayNow = plans.find((plan) => plan.away && plan.from <= today && today <= plan.to) ?? null;
    return { today, plans, unparsed, awayNow };
  }

  /** What the machine-owned store is holding, and what the last sweep removed. */
  async disclose(options: OccasionMutationOptions = {}): Promise<OccasionStateDisclosure> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    const result = await this.deps.state.disclose(); owned.assertCurrent?.(); return result;
  }

  /** What the owner landed on before, for one occasion. */
  async giftHistory(occasionId: string, options: OccasionMutationOptions = {}): Promise<readonly GiftRecord[]> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    const result = await this.deps.state.giftHistory(occasionId); owned.assertCurrent?.(); return result;
  }

  // -------------------------------------------------------------------------
  // Capture, proposed, confirmed once, then silent (see capture.ts)
  // -------------------------------------------------------------------------

  /** What would be written, and the one line to put to the owner. Writes nothing. */
  proposeOccasion(input: ProposeOccasionInput): OccasionProposal {
    return proposeOccasion(this.deps.profile, input);
  }

  /** Write the confirmed occasion. Refuses without a kind rather than guessing. */
  async confirmOccasion(input: ConfirmOccasionInput, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options);
    return confirmOccasion(this.deps.profile, this.deps.writer, input, owned);
  }

  /** The same two-step capture, for a plan. */
  proposePlan(input: ProposePlanInput): OccasionProposal {
    return proposePlan(input);
  }

  async confirmPlan(input: ConfirmPlanInput, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options);
    return confirmPlan(this.deps.writer, input, owned);
  }

  /** Remove an occasion and everything the machine remembered about it. */
  async removeOccasion(input: {
    readonly occasionId: string;
    readonly confirmed: boolean;
    readonly authority: AuthoritySurface | 'autonomous';
  }, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    return removeOccasion(
      this.deps.profile,
      this.deps.writer,
      (id) => this.deps.state.dropOccasion(id, owned.assertCurrent),
      input, owned,
    );
  }

  /** Change an occasion in place; its id, answers and gift history stay. Proposes without `confirmed`. */
  async updateOccasion(input: UpdateOccasionInput, options: OccasionMutationOptions = {}): Promise<OccasionEditOutcome> {
    const owned = captureOccasionOperation(this.deps, options);
    return updateOccasion(this.deps.profile, this.deps.writer, input, owned);
  }

  /** Change a plan in place. Proposes without `confirmed`. */
  async updatePlan(input: UpdatePlanInput, options: OccasionMutationOptions = {}): Promise<OccasionEditOutcome> {
    const owned = captureOccasionOperation(this.deps, options);
    return updatePlan(this.deps.profile, this.deps.writer, input, owned);
  }

  /** Remove a plan by id, after one confirmation. */
  async removePlan(input: {
    readonly planId: string;
    readonly planFrom?: string | undefined;
    readonly confirmed: boolean;
    readonly authority: AuthoritySurface | 'autonomous';
  }, options: OccasionMutationOptions = {}): Promise<OccasionWriteOutcome> {
    const owned = captureOccasionOperation(this.deps, options);
    return removePlan(this.deps.profile, this.deps.writer, input, owned);
  }

  // -------------------------------------------------------------------------
  // Answers
  // -------------------------------------------------------------------------

  /**
   * Record yes, no or later for one occurrence.
   *
   *  - **no**, silent for the rest of this cycle. The record expires with the
   *    occurrence, so next year asks fresh carrying no memory of the refusal.
   *  - **later**, not a decline. It comes back roughly halfway to the date.
   *  - **yes**, opens the interview, and the answer is what stops the nudging.
   *
   * A one-off carries no expiry: "handled" is permanent for something that
   * happens once.
   */
  async answer(input: {
    readonly occasionId: string;
    readonly answer: OccasionAnswer;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly interview: InterviewProgress | null }> {
    return withConfiguredDecisionModelPolicy(() => this.withAnswerOwnership(input.occasionId, options, owned => this.answerOwned(input, owned)));
  }

  /** A later response for this occasion retires earlier work, including an unfinished gift reading. */
  private async withAnswerOwnership<T>(key: string, options: OccasionMutationOptions, run: (owned: OccasionMutationOptions) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    this.answerOwners.get(key)?.abort();
    this.answerOwners.set(key, controller);
    const signal = AbortSignal.any([controller.signal, ...(this.deps.signal ? [this.deps.signal] : []), ...(options.signal ? [options.signal] : [])]);
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (this.answerOwners.get(key) !== controller) throw new OccasionReadingHeldError();
      assertSynchronousJudgmentGuard(() => options.assertCurrent?.(), () => new OccasionReadingHeldError());
    };
    retainOccasionStateReceipts(assertCurrent, options);
    try {
      assertCurrent();
      return await run({ ...options, signal, assertCurrent });
    } finally { if (this.answerOwners.get(key) === controller) this.answerOwners.delete(key); }
  }

  /**
   * An answer depends only on the occasion existing and on today's date, so its
   * writes carry the caller's restriction and nothing else: a settings save or a
   * profile edit elsewhere does not make "no, thanks" fail.
   */
  private async answerOwned(input: {
    readonly occasionId: string;
    readonly answer: OccasionAnswer;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly interview: InterviewProgress | null }> {
    const assertCurrent = options.assertCurrent ?? (() => {});
    await this.deps.state.prepareRead(options);
    const today = this.today();
    const now = this.now();
    const occasion = readOccasionDeclarations(this.deps.profile).occasions.find(
      (entry) => entry.id === input.occasionId,
    );
    if (occasion === undefined) {
      return { ok: false, reason: 'There is no occasion by that name.', interview: null };
    }
    if (input.occurrence !== undefined && !isOccurrenceDate(input.occurrence)) {
      return { ok: false, reason: OCCURRENCE_REFUSAL, interview: null };
    }
    const occurrence = input.occurrence ?? nextOccurrence(occasion.date, occasion.recurrence, today);
    if (occurrence === null) {
      return { ok: false, reason: 'That occasion has no upcoming date.', interview: null };
    }

    // "Acknowledged" says the owner has this one in hand, which must leave the
    // open item standing. Recording it as an ordinary answer would resolve and
    // delete the item, so it takes the acknowledge path instead.
    if (input.answer === 'acknowledged') {
      const outcome = await this.acknowledgeAs(occasion, occurrence, 'explicit', assertCurrent);
      if (outcome.alreadyAnswered !== null) {
        return { ok: false, reason: alreadyAnsweredReply(occasion.title, outcome.alreadyAnswered), interview: null };
      }
      return { ok: true, reason: null, interview: null };
    }

    const answer: OccasionAcknowledgement = {
      id: `${occasion.id}@${occurrence}`,
      occasionId: occasion.id,
      occurrence,
      answer: input.answer,
      answeredAt: now,
      ...(occasion.recurrence === 'annual' ? { expiresAfter: occurrence } : {}),
      ...(input.answer === 'later' ? { returnOn: laterReturnDate(today, occurrence) } : {}),
    };

    if (input.answer === 'yes' && occasion.kind === 'gift-giving') {
      const work = new OccasionReadingWork({ ...(options.signal ? { signal: options.signal } : {}), assertCurrent });
      const interview = await this.startInterview(occasion, occurrence, now, work);
      await this.deps.state.recordInterviewAnswer(answer, interview, nudgeItemId(occasion.id, occurrence), assertCurrent);
      return { ok: true, reason: null, interview: progressOf(interview) };
    }
    await this.deps.state.recordAnswer(answer, assertCurrent);

    if (input.answer === 'later') {
      // The open item stays OPEN and moves; "later" is an answer to this
      // moment, not to the question.
      //
      // It also RETURNS THE LEAD BOUNDARY, and that is not a hole in the
      // two-raise ceiling. The ceiling exists to stop an item the owner has ignored
      // from repeating at them; "come back nearer the time" is the opposite of
      // ignoring it, it is an instruction, and a system that took the
      // instruction and then stayed silent because it had used up its two
      // turns would be worse than one that never offered "later" at all.
      await this.deps.state.settleOpenItem(nudgeItemId(occasion.id, occurrence), item => item === undefined ? null : {
        ...item,
        servedBoundaries: [],
        dueOn: laterReturnDate(today, occurrence),
      }, assertCurrent);
      return { ok: true, reason: null, interview: null };
    }

    await this.deps.state.resolveOpenItem(nudgeItemId(occasion.id, occurrence), assertCurrent);
    return { ok: true, reason: null, interview: null };
  }

  // -------------------------------------------------------------------------
  // The interview
  // -------------------------------------------------------------------------

  private async startInterview(
    occasion: Occasion,
    occurrence: IsoDate,
    now: number,
    work: OccasionReadingWork,
  ): Promise<Interview> {
    const existing = await this.deps.state.activeInterview(occasion.id, occurrence);
    work.assertCurrent();
    if (existing !== undefined) return existing;
    requireDecisionFeature('planning a new gift interview from inferred profile interests');
    const policy = this.policy();
    const subject = occasion.person.trim().length > 0 ? occasion.person : occasion.title;
    const personLines = await work.wait(async () => this.deps.profile.person(subject, { signal: work.signal, assertCurrent: work.assertCurrent, retain: check => work.retain(check) }));
    const history = await work.wait(() => this.deps.state.giftHistory(occasion.id));
    const interview = await prepareInterview({
      occasion,
      occurrence,
      personLines,
      history: storedGiftEvidence(history),
      maxQuestions: policy.interviewQuestions,
    }, work);
    work.assertCurrent();
    return { ...interview, startedAt: now };
  }

  /** The interview for one occasion, resumed at the question the owner did not answer. */
  async interview(interviewId: string, options: OccasionMutationOptions = {}): Promise<InterviewProgress | null> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    const found = await this.deps.state.interview(interviewId);
    owned.assertCurrent?.();
    return found === undefined ? null : progressOf(found);
  }

  /** Record one answer and hand back the next question, if there is one. */
  async answerInterview(input: {
    readonly interviewId: string;
    readonly stepId: string;
    readonly text: string;
  }, options: OccasionMutationOptions = {}): Promise<InterviewProgress | null> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    // Read, apply and write in one store write: two answers arriving together
    // each build on the interview the other left.
    const updated = await this.deps.state.updateInterview(input.interviewId, (found) => {
      if (!found.steps.some((step) => step.id === input.stepId)) {
        const next = nextStep(found);
        throw new GatewayVerbError(
          `This interview has no step "${input.stepId.slice(0, 80)}", so nothing was recorded. `
          + (next === undefined ? 'Every step is already answered.' : `The next unanswered step is "${next.id}".`),
          'INVALID_ARGUMENT', 400, 'stepId',
        );
      }
      return answerStep(found, input.stepId, input.text, this.now());
    }, owned.assertCurrent);
    if (updated === undefined) return null;
    // Working on the gift IS acknowledging the occasion. Being asked whether the
    // owner has thought about a birthday while they are in the middle of answering
    // questions about what to buy for it would be the feature interrupting its
    // own interview, so engagement here mutes the push by itself, no verb, no
    // extra sentence from them, nothing to remember to do. A `yes` already on
    // the occurrence (the one that opened this interview) is left as it is.
    const occasion = readOccasionDeclarations(this.deps.profile).occasions.find((entry) => entry.id === updated.occasionId);
    if (occasion !== undefined) await this.acknowledgeAs(occasion, updated.occurrence, 'gift-flow', owned.assertCurrent ?? (() => {}));
    return progressOf(updated);
  }

  /**
   * Close the interview with what the owner landed on, and write the gift history.
   *
   * Recording the OUTCOME is the point: "the owner said yes in 2026" cannot stop year
   * three steering where year one did, and a history that only holds answers is
   * a history of questions.
   */
  async recordGiftOutcome(input: {
    readonly interviewId: string;
    readonly landedOn: string;
  }, options: OccasionMutationOptions = {}): Promise<InterviewProgress | null> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    const completed = await this.deps.state.updateInterview(
      input.interviewId,
      (found) => completeInterview(found, input.landedOn.trim(), this.now()),
      owned.assertCurrent,
    );
    if (completed === undefined) return null;
    const record = giftRecordFor(completed);
    if (record !== null) await this.deps.state.recordGift(record, owned.assertCurrent);
    await this.deps.state.resolveOpenItem(interviewItemId(completed.occasionId, completed.occurrence), owned.assertCurrent);
    return progressOf(completed);
  }

  // -------------------------------------------------------------------------
  // The sweep
  // -------------------------------------------------------------------------

  /**
   * One pass: reap, decide, mirror, deliver, remember.
   *
   * Housekeeping runs FIRST and unconditionally, before the enabled check and
   * before quiet hours, because a store that only reaps when the feature is
   * allowed to speak is a store that never reaps on a machine where the owner turned
   * nudging off.
   *
   * It runs the same in every mode. With decision models off or unavailable,
   * who a date is about is the line's own `for me` marker, and the outcome says
   * so (`provenance: 'classic'`).
   */
  async sweep(options: OccasionMutationOptions = {}): Promise<SweepOutcome> {
    return withConfiguredDecisionModelPolicy(async () => {
      const op = this.operation(options);
      const reading = await this.read(op, options);
      const { now, today, policy, declarations, plans } = reading;
      const occasions = declarations.occasions;
      const provenance = reading.classic ? CLASSIC_PROVENANCE : {};

      const housekeeping = await this.deps.state.sweep({
        today,
        now,
        // A profile that declares nothing cannot tell "the owner removed every
        // line" from "the profile is unavailable or not loaded yet", and acting
        // on the wrong guess deletes every answer. Without a declaration the
        // orphan rules wait; time-based expiry still runs, and an explicit
        // removal drops its own records. A line that is there but does not
        // parse still counts as declared.
        declaredOccasionIds: declarations.declaredIds.size === 0 ? undefined : declarations.declaredIds,
        giftHistoryYears: policy.giftHistoryYears,
      }, op.assertCurrent);

      const mirrored = policy.calendarMirror ? await this.runMirror(occasions, today, now, op) : 0;
      const acknowledgements = await this.deps.state.acknowledgements();
      const openItemsBefore = await this.deps.state.openItems();
      const decision = decideSweep({
        now,
        today,
        minutesOfDay: minutesOfDayInZone(now, reading.timezone),
        occasions,
        conflicts: declarations.conflicts,
        plans,
        acknowledgements,
        openItems: openItemsBefore,
        interviews: await this.interviewsInFlight(),
        policy,
      });

      if (decision.hold !== null) {
        return {
          ...provenance,
          ranAt: now,
          today,
          hold: decision.hold,
          nudge: null,
          conflictMessages: [],
          resumedInterviews: [],
          delivered: false,
          deliveryChannel: '',
          deliveryId: null,
          deliveries: [],
          mirrored,
          housekeeping,
        };
      }

      const nudge = decision.due.length === 0
        ? null
        : { ...prepareNudge(decision.due.map((entry) => subjectFor(entry.occasion, entry.daysUntil))), id: `occasions-${now}`, raisedAt: now };
      const destinations = resolveNudgeDestinations(policy.nudgeChannel);
      const canPush = this.deps.deliverer !== undefined && destinations.length > 0;

      const conflictMessages = decision.conflicts.map(
        (conflict) => composeConflictMessage(conflict.title, conflict.dates),
      );
      const resumeMessages = decision.resumeInterviews.flatMap((interview) => {
        const occasion = occasions.find((entry) => entry.id === interview.occasionId);
        return occasion === undefined ? [] : [composeInterviewResumeMessage(occasion.title)];
      });
      const reminderLines = [...conflictMessages, ...resumeMessages];

      // A raise is spent by a push that a destination ACCEPTED, not by an
      // attempt: a dead destination would otherwise leave the owner with one push
      // on the day instead of two, or a conflict quiet for three days that was
      // never sent. So an item whose raise is a push is written after the push,
      // and only as raised if a destination took it. With nowhere to push
      // (pull-only), nothing can ever land and the items are written now.
      const dueItemIds = new Set(decision.due.map((entry) => nudgeItemId(entry.occasion.id, entry.occurrence)));
      const awaitingNudge = canPush && nudge !== null
        ? decision.openItemWrites.filter((item) => item.kind === 'nudge' && dueItemIds.has(item.id))
        : [];
      const awaitingReminders = canPush && reminderLines.length > 0
        ? decision.openItemWrites.filter((item) => item.kind === 'conflict' || item.kind === 'interview')
        : [];
      const awaiting = new Set([...awaitingNudge, ...awaitingReminders]);
      await this.deps.state.putOpenItems(
        decision.openItemWrites.filter((item) => !awaiting.has(item)),
        op.assertCurrent, () => {},
      );

      const deliveries = nudge === null
        ? []
        : await pushNudge(this.deps.deliverer, nudge, destinations, op.assertCurrent, options.withNudgeDelivery);
      const landed = deliveries.filter((entry) => entry.delivered);
      if (awaitingNudge.length > 0) {
        // Recorded with no freshness check: what a destination accepted is a
        // fact about the past, and recording it whatever changed during the send
        // is what stops the same reminder being pushed again next pass.
        if (landed.length > 0) {
          await this.deps.state.putOpenItems(awaitingNudge, op.record, () => {});
        } else {
          // Nothing accepted it. An item already stored keeps its unspent
          // boundary as it is; a new one is opened unspent so the pull lists it
          // and the next sweep tries again.
          const stored = new Set(openItemsBefore.map((item) => item.id));
          await this.deps.state.putOpenItems(
            awaitingNudge.filter((item) => !stored.has(item.id)).map((item) => ({ ...item, raiseCount: 0, servedBoundaries: [] })),
            op.record, () => {},
          );
        }
      }

      // Conflicts and an unfinished gift conversation are raised again on their
      // own cadence, under the same rule: recorded as raised only when a
      // destination accepted them. Unaccepted, nothing is written, so a new one
      // is raised again next pass and a stored one stays due. Each line names
      // the occasion and never a date.
      const reminderDeliveries = awaitingReminders.length === 0
        ? []
        : await pushNudge(this.deps.deliverer, {
          id: `occasions-reminders-${now}`,
          raisedAt: now,
          subjects: [],
          message: reminderLines.join('\n'),
          answerable: false,
        }, destinations, op.assertCurrent, options.withNudgeDelivery);
      if (reminderDeliveries.some((entry) => entry.delivered)) {
        await this.deps.state.putOpenItems(awaitingReminders, op.record, () => {});
      }

      return {
        ...provenance,
        ranAt: now,
        today,
        hold: null,
        nudge,
        conflictMessages,
        resumedInterviews: decision.resumeInterviews.map((entry) => entry.id),
        delivered: landed.length > 0,
        deliveryChannel: destinations.join(', '),
        deliveryId: landed[0]?.deliveryId ?? null,
        deliveries: [...deliveries, ...reminderDeliveries],
        mirrored,
        housekeeping,
      };
    });
  }

  /** Unfinished interviews, for the resume case. */
  private async interviewsInFlight(): Promise<readonly Interview[]> {
    const items = await this.deps.state.openItems();
    const found: Interview[] = [];
    for (const item of items) {
      if (item.kind !== 'interview') continue;
      const interview = await this.deps.state.interview(
        interviewIdFor(item.occasionId, item.occurrence),
      );
      if (interview !== undefined && interview.completedAt === undefined) found.push(interview);
    }
    // An interview that has no open item yet, one just started by a `yes`,
    // is also in flight, and is what creates the item on the next sweep.
    const started = await this.deps.state.acknowledgements();
    for (const ack of started) {
      if (ack.answer !== 'yes') continue;
      const id = interviewIdFor(ack.occasionId, ack.occurrence);
      if (found.some((entry) => entry.id === id)) continue;
      const interview = await this.deps.state.interview(id);
      if (interview !== undefined && interview.completedAt === undefined) found.push(interview);
    }
    return found;
  }

  /**
   * Write occasions out to the calendar, once each.
   *
   * A previously recorded external id is passed back to the implementation so
   * the mirror is idempotent even where the calendar itself has no natural key,
   * and an occurrence already mirrored is not offered again at all. A calendar
   * entry the calendar accepted is recorded whatever changed meanwhile, for the
   * same reason an accepted push is.
   */
  private async runMirror(
    occasions: readonly Occasion[],
    today: IsoDate,
    now: number,
    op: OccasionsOperation,
  ): Promise<number> {
    const mirror = this.deps.calendar;
    if (mirror === undefined) return 0;
    let count = 0;
    for (const occasion of occasions) {
      if (occasion.kind === 'neither') continue;
      const occurrence = nextOccurrence(occasion.date, occasion.recurrence, today);
      if (occurrence === null) continue;
      const existing = await this.deps.state.mirrorFor(occasion.id, occurrence);
      if (existing !== undefined) continue;
      op.assertCurrent();
      let externalId: string | null;
      try {
        externalId = await mirror.mirror({ occasion, occurrence });
      } catch (error) {
        // One calendar failure must not stop the sweep before it decides and
        // delivers; the occurrence is simply offered again next pass.
        logger.warn('occasions: calendar mirror failed for one occasion', { error: summarizeError(error) });
        continue;
      }
      if (externalId === null) continue;
      await this.deps.state.recordMirror({
        occasionId: occasion.id,
        occurrence,
        externalId,
        mirroredAt: now,
      }, op.record);
      count += 1;
    }
    return count;
  }

  /**
   * Everything outstanding, without delivering anything.
   *
   * This is how a surface that is not a push destination receives a nudge: it
   * pulls what is open at the top of a turn rather than being pushed at. A
   * stored date is the prior scheduling that permits raising something
   * unprompted, which is what keeps this consistent with the agent being
   * conversation-first.
   *
   * When the agent IS a configured push destination, an item a push has already
   * landed there is left out. The push and the pull are two ways of getting the
   * same thing to the same conversation, and doing both would have the agent
   * raise one birthday twice. The condition is the LANDED push rather than the
   * configuration: an item no push has ever landed on the agent, because the
   * sender is not registered, or because the send failed, carries no stamp and
   * still comes back here, so the guard cannot turn into a way of dropping a
   * nudge.
   *
   * It does not depend on a sweep having run: an occurrence inside its window
   * with no open item yet is listed from the declarations (pending.ts). With an
   * unchanged profile it makes no model request at all.
   */
  async pending(options: OccasionMutationOptions = {}): Promise<PendingResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      const op = this.operation(options);
      const reading = await this.read(op, options);
      const { now, today, policy, declarations, plans } = reading;
      const composed = preparePending({
        today,
        policy,
        occasions: declarations.occasions,
        conflicts: declarations.conflicts,
        plans,
        openItems: await this.deps.state.openItems(),
        acknowledgements: await this.deps.state.acknowledgements(),
      });
      const interviews = (await this.interviewsInFlight()).map(progressOf);
      op.admitted();
      const { open: _subjects, ...rest } = composed;
      return {
        ...rest,
        ...(reading.classic ? CLASSIC_PROVENANCE : {}),
        nudge: composed.nudge === null ? null : { ...composed.nudge, id: `occasions-pending-${today}`, raisedAt: now },
        interviews,
      };
    });
  }

  /**
   * Record that the owner has one occurrence in hand. See acknowledge.ts.
   *
   * Deliberately NOT a fourth value routed through {@link answer}: a `yes` or a
   * `no` resolves the open item and removes it, and this one must leave it
   * standing. Same store, different promise. An occurrence already answered
   * `yes` or `no` is left exactly as it is, and the reply says so.
   */
  async acknowledge(input: {
    readonly occasionId: string;
    readonly source: OccasionAckSource;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly reply: string; readonly changed: boolean }> {
    return this.withAnswerOwnership(input.occasionId, options, owned => this.acknowledgeOwned(input, owned));
  }

  private async acknowledgeOwned(input: {
    readonly occasionId: string;
    readonly source: OccasionAckSource;
    readonly occurrence?: string | undefined;
  }, options: OccasionMutationOptions = {}): Promise<{ readonly ok: boolean; readonly reason: string | null; readonly reply: string; readonly changed: boolean }> {
    const assertCurrent = options.assertCurrent ?? (() => {});
    const today = this.today();
    const occasion = readOccasionDeclarations(this.deps.profile).occasions.find(
      (entry) => entry.id === input.occasionId,
    );
    if (occasion === undefined) {
      return { ok: false, reason: 'There is no occasion by that name.', reply: '', changed: false };
    }
    if (input.occurrence !== undefined && !isOccurrenceDate(input.occurrence)) {
      return { ok: false, reason: OCCURRENCE_REFUSAL, reply: '', changed: false };
    }
    const upcoming = nextOccurrence(occasion.date, occasion.recurrence, today);
    // A date the model names in conversation must be the upcoming one: any other
    // date would record a mute that never fires while the real reminder keeps going.
    // A surface acting on an open item may still name that item's own date.
    if (input.source === 'conversation' && input.occurrence !== undefined && input.occurrence !== upcoming) {
      return {
        ok: false,
        reason: `'${input.occurrence}' is not an upcoming date of that occasion`
          + `${upcoming ? `; its next occurrence is ${upcoming} (YYYY-MM-DD)` : ''}. `
          + 'Omit the occurrence to acknowledge the upcoming one. Nothing was changed.',
        reply: '',
        changed: false,
      };
    }
    const occurrence = input.occurrence ?? upcoming;
    if (occurrence === null) {
      return { ok: false, reason: 'That occasion has no upcoming date.', reply: '', changed: false };
    }
    const outcome = await this.acknowledgeAs(occasion, occurrence, input.source, assertCurrent);
    return outcome.alreadyAnswered === null
      ? { ok: true, reason: null, reply: acknowledgementReply(occasion.title), changed: true }
      : { ok: true, reason: null, reply: alreadyAnsweredReply(occasion.title, outcome.alreadyAnswered), changed: false };
  }

  /** The one write path for "the owner has this occurrence in hand". */
  private async acknowledgeAs(occasion: Occasion, occurrence: IsoDate, source: OccasionAckSource, assertCurrent: () => void): Promise<AcknowledgeOutcome> {
    await this.deps.state.prepareRead();
    return acknowledgeOccurrence({
      acknowledge: (entry, itemId, build) => this.deps.state.acknowledge(entry, itemId, build, assertCurrent),
    }, { occasion, occurrence, now: this.now(), source });
  }

  /**
   * Resolve a date conflict with the date the owner says is right: the other
   * declarations of that title leave the profile, the machine state for the
   * occasion stays, and the conflict reminder is closed. See capture.ts.
   */
  async resolveConflict(input: {
    readonly occasionId: string;
    readonly keep?: string | undefined;
    readonly authority?: AuthoritySurface | 'autonomous' | undefined;
  }, options: OccasionMutationOptions = {}): Promise<ConflictResolution> {
    const owned = captureOccasionOperation(this.deps, options);
    await this.deps.state.prepareRead(options);
    return resolveOccasionConflict(
      this.deps.profile,
      this.deps.writer,
      () => this.deps.state.resolveOpenItem(conflictItemId(input.occasionId), owned.assertCurrent),
      input,
      owned,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OCCURRENCE_REFUSAL = 'The occurrence must be an ISO date such as 2026-03-14, or be left out to mean the next one.';

function isOccurrenceDate(value: string): boolean {
  return value.trim() === value && isIsoDate(value);
}

function progressOf(interview: Interview): InterviewProgress {
  const step = nextStep(interview);
  return {
    interviewId: interview.id,
    occasionId: interview.occasionId,
    occurrence: interview.occurrence,
    steps: interview.steps,
    nextStep: step ?? null,
    complete: interview.completedAt !== undefined,
    landedOn: interview.landedOn ?? null,
  };
}

