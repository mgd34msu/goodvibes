import { decisionOrClassic, isClassicOperation } from '../runtime/decision-policy.js';
/**
 * Owner escalations: the question
 * put to the owner, built in code, and the owner's free-text reply, read with
 * `contract.owner-reply` (the reply pattern) against that question.
 *
 * An escalation moves its target (a unit or a group) and the contract to
 * `awaiting-owner` and releases any hold. What a reply does is code:
 *
 * | Reading at act | unsettled | stalled, fix-rounds-exhausted | plan-unresolved | writing-unclear | attempts-undecided |
 * |---|---|---|---|---|---|
 * | approve | refused unless every judged criterion already reads met | refused: approval cannot pass unmet criteria | the plan as shown is accepted | files may change; planning starts | the proposed attempt is taken |
 * | amend | the planner rewrites the target's criteria as instructed; the target is checked again | same | the planner re-plans with the instruction | whether files may change is read from the reply; planning starts | the attempt the reply asks for is read (`contract.owner-pick`) and taken |
 * | reject | the contract is cancelled, "stopped by the owner", failure kind owner-rejected | same | same | same | same |
 *
 * Any other reading, or one below act, asks the same question again with one
 * fixed line. Nothing the owner says can pass a criterion that reads unmet.
 *
 * With no decision model in use a reply is read by code: "approve", "stop" or
 * "change: ..." (and their plain synonyms); anything else asks again and says
 * which words are read. The work is never stopped for want of a model: the
 * deliverable of such a contract is put to the owner as a code-answered
 * "accept" or "cancel" question instead of being judged.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Outcome } from '@goodvibes-jev/judgment';
import type { OwnerReplyAction, OwnerReplyReading } from '../../events/contract.js';
import { ownerPick } from './batteries/owner-pick.js';
import { ownerReply } from './batteries/owner-reply.js';
import { readForbidsWriting, REQUEST_SHAPE_SITE, saysNoAtAct, saysYesAtAct } from './batteries/request-shape.js';
import { acceptAttempt, assertAttemptTakeable } from './best-of-n.js';
import { engineItem } from './group-runner.js';
import { emptyJudgmentUsage, meteredPort, type DecidedCheck } from './check.js';
import { amendTarget } from './amendment.js';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { latestSeverity, QUALITY_EVIDENCE_SENTENCES } from './nudge.js';
import { lastFencedBlock } from './plan-schema.js';
import { acceptEscalatedPlan, planContract, withOwnerWritingDecision } from './planner.js';
import { failureFromError, isAbortError, type ContractRun } from './run-context.js';
import type { StepContext } from './steps.js';
import {
  type AttemptSelectionRecord,
  type Contract,
  type ContractStatus,
  type ContractUnit,
  type Criterion,
  type Escalation,
  type EscalationReason,
  type EscalationScope,
  type QualityItem,
  type UnitCheck,
} from './types.js';
import { addJudgmentUsage } from './usage.js';
import { releaseSharedTreeForOwner, retakeSharedTreeAfterOwner } from './workstreams.js';

/** The decision site owner replies are logged under. */
export const OWNER_REPLY_SITE = 'contract.owner-reply';
/** The decision site the attempt an owner asks for is logged under. */
export const OWNER_PICK_SITE = 'contract.owner-pick';

// ── The question (built in code, reviewable here) ─────────────────────────────

/** One fixed sentence per reason. */
export const REASON_SENTENCES: Readonly<Record<EscalationReason, string>> = {
  'plan-unresolved': 'The planner could not resolve these problems, and repairing again is not making progress.',
  'writing-unclear': 'Your request does not make clear whether the work may change files.',
  stalled: 'The work stopped making progress and the remaining problems need you.',
  unsettled: 'The checks could not confirm some criteria from the evidence, and the agent could not show more.',
  'fix-rounds-exhausted': 'The fix rounds allowed for this work are used up.',
  'attempts-undecided': 'The attempts could not be chosen between with confidence.',
  'owner-decision-needed': 'This needs a decision only you can make.',
};

/** What approval does, per reason, as the question's last line states it. */
const APPROVAL_CLAUSES: Readonly<Record<EscalationReason, string>> = {
  'plan-unresolved': 'accepting the plan as it stands',
  'writing-unclear': 'changing files',
  unsettled: '(approval cannot establish missing evidence: say what to change instead)',
  stalled: '(approval cannot pass unmet criteria: say what to change instead)',
  'fix-rounds-exhausted': '(approval cannot pass unmet criteria: say what to change instead)',
  'owner-decision-needed': '(approval cannot pass unmet criteria: say what to change instead)',
  'attempts-undecided': 'taking the proposed attempt',
};

/** Said when a reply did not read as approve, change or stop at act. */
export const ASK_AGAIN_LINE = 'I could not tell whether that approves, changes or stops the work.';
/** Added under a question with no decision model in use: replies are read literally. */
export const NO_MODEL_REPLY_LINE = 'No decision model is in use, so replies are read literally: reply "approve", "stop", or "change: " followed by what to change.';
/** Said when a reply about file changes cannot be read without a decision model. */
export const NO_MODEL_WRITING_LINE = 'No decision model is in use, so whether that allows changing files cannot be read: reply "approve" to allow file changes, or "stop".';
/** Said when approval was given for work whose criteria are not met. */
export const APPROVAL_REFUSED_LINE = 'Approval cannot pass work whose criteria are not met: say what to change about what is required, or stop the contract.';
/** Said when an attempt was approved or asked for but none could be taken from the reply. */
export const NAME_AN_ATTEMPT_LINE = (candidateIds: readonly string[]): string => `Say which attempt to take: ${candidateIds.join(', ')}.`;
/** Said when an approved plan cannot run at all. */
export const PLAN_UNRUNNABLE_LINE = (problems: string): string => `The plan cannot run as it stands (${problems}); change what is required, or stop the contract.`;
/** Said when the owner's change could not be made into criteria. */
export const AMENDMENT_FAILED_LINE = (problems: string): string => `That change could not be applied (${problems}); say it another way, or stop the contract.`;
/** Added when a reply was read but acting on it failed (a provider outage, no route): nothing it asked for was applied. */
export const REPLY_NOT_APPLIED_LINE = (reason: string): string => `That could not be applied right now (${reason}); reply again to retry, or stop the contract.`;

/** Lines the runner adds under a question it asks again; they are dropped before another is added. */
const ADDED_LINE_PREFIXES = [ASK_AGAIN_LINE, APPROVAL_REFUSED_LINE, 'Say which attempt to take', 'The plan cannot run as it stands', 'That change could not be applied', 'That could not be applied right now', NO_MODEL_REPLY_LINE, NO_MODEL_WRITING_LINE];

const APPROVE_WORDS = new Set(['approve', 'approved', 'yes', 'y', 'ok', 'okay', 'accept', 'accepted', 'go ahead', 'lgtm']);
const STOP_WORDS = new Set(['stop', 'cancel', 'reject', 'rejected', 'no', 'n', 'abort']);
const CHANGE_PREFIX = /^(?:change|amend)\s*:\s*(\S[\s\S]*)$/i;

/** A reply as code reads it with no decision model: the plain word, or "change:" with what to change. */
export function readOwnerReplyLiterally(text: string): { readonly choice: OwnerReplyReading; readonly instruction?: string } {
  const trimmed = text.trim();
  const change = CHANGE_PREFIX.exec(trimmed);
  if (change !== null) return { choice: 'amend', instruction: change[1]!.trim() };
  const word = trimmed.replace(/[.!]+$/, '').trim().toLowerCase();
  if (APPROVE_WORDS.has(word)) return { choice: 'approve' };
  if (STOP_WORDS.has(word)) return { choice: 'reject' };
  return { choice: 'unclear' };
}

/**
 * The failure pause: what a native session contract asks when its turn keeps
 * failing. Native contracts have no owner approval of the work, and this is not
 * one: the only answers are to run the turn again or to stop the contract, no
 * criterion changes, and no reading of the reply is involved.
 */
export const FAILURE_PAUSE_ANSWERS = ['retry', 'cancel'] as const;
export type FailurePauseAnswer = (typeof FAILURE_PAUSE_ANSWERS)[number];

export interface FailurePauseInput {
  /** What failed, in the owner's terms (the turn's error). */
  readonly what: string;
  /** How many times the turn was tried before the pause. */
  readonly attempts: number;
}

/** The answer a reply names: exactly retry or cancel, ignoring case, spacing and a closing full stop. */
export function readFailurePauseAnswer(text: string): FailurePauseAnswer | undefined {
  const word = text.trim().replace(/[.!]+$/, '').toLowerCase();
  return FAILURE_PAUSE_ANSWERS.find((answer) => answer === word);
}

/** The failure-pause question, built in code. */
export function buildFailurePauseQuestion(contract: Contract, unit: Pick<ContractUnit, 'title'>, input: FailurePauseInput): string {
  const what = titleOf(input.what).slice(0, 400);
  return [
    `Contract ${contract.id} is paused: its work on unit "${titleOf(unit.title)}" failed after ${input.attempts} attempt${input.attempts === 1 ? '' : 's'}.`,
    `What failed: ${what}`,
    'The work done so far is kept in the project tree. Nothing was approved and no criterion changed.',
    'Reply "retry" to run the turn again with a fresh set of attempts, or "cancel" to stop the contract. No other answer is accepted.',
  ].join('\n');
}

/** The question a failed unit asks (`pauseFailedUnit`), built in code. */
export function buildUnitFailureQuestion(contract: Contract, unit: Pick<ContractUnit, 'id' | 'title'>, reason: string): string {
  return [
    `Contract ${contract.id} is paused: unit ${unit.id} ("${titleOf(unit.title)}") failed.`,
    `What failed: ${titleOf(reason).slice(0, 400)}`,
    'The work the other units finished is kept, and the units that wait on this one are held, not skipped. Nothing was approved and no criterion changed.',
    'Reply "retry" to run the unit again with a fresh agent (its dependents then run as usual), or "cancel" to stop the contract. No other answer is accepted.',
  ].join('\n');
}

/** Whether an escalation is the retry-or-cancel question of a failed unit of an agent-run contract. */
function isUnitFailurePause(run: ContractRun, escalation: Pick<Escalation, 'failurePause' | 'scope'>): boolean {
  return escalation.failurePause === true && escalation.scope === 'unit' && run.contract.nativeSource === undefined && run.contract.sessionMode !== true;
}

export type { OwnerReplyAction };

/**
 * Why a reply was turned away before anything changed: the caller asked for
 * something the contract cannot take now, not the platform failing. The
 * messages are unchanged for callers that match on them.
 */
export type OwnerReplyRefusal =
  /** No such escalation, or it was already answered. */
  | 'not-open'
  /** Another reply to the same question is being read. */
  | 'already-reading'
  /** The contract ended while the reply was being read. */
  | 'ended'
  /** The answer is not one this question accepts. */
  | 'not-an-answer'
  /** Contracts of this kind do not read replies of this form. */
  | 'unsupported';

export class OwnerReplyRefusedError extends Error {
  constructor(message: string, readonly refusal: OwnerReplyRefusal) {
    super(message);
    this.name = 'OwnerReplyRefusedError';
  }
}

export interface OwnerReplyOutcome {
  readonly escalationId: string;
  readonly reading: OwnerReplyReading;
  readonly outcome: Outcome;
  readonly action: OwnerReplyAction;
  /** The escalation now open when the question was put again. */
  readonly nextEscalationId?: string | undefined;
}

export interface EscalationInput {
  readonly scope: EscalationScope;
  readonly targetId: string;
  readonly reason: EscalationReason;
  readonly unmetCriterionIds: readonly string[];
  readonly unshownCriterionIds?: readonly string[] | undefined;
  readonly decisionIds: readonly string[];
  /** A fixed extra line under the reason sentence (the conflicting files, why a planned fix is not possible). */
  readonly note?: string | undefined;
  /** The whole question, when it was built elsewhere (asking again). */
  readonly question?: string | undefined;
  /**
   * The question accepts only "retry" or "cancel", answered by code: a pause
   * that approves nothing (a publication that could not reach the owner's
   * tree). Allowed for every contract, native ones included.
   */
  readonly retryOrCancel?: true | undefined;
}

/** What publishing a checked result ran into, for the publication pause. */
export interface PublicationPauseInput {
  /** The obstacle, as the last publication attempt recorded it. */
  readonly note: string;
  /** The branch holding the result in worktree mode. */
  readonly branch?: string | undefined;
}

/** The publication-pause question, built in code: the obstacle, where the result is, and the two answers. */
export function buildPublicationPauseQuestion(contract: Contract, input: PublicationPauseInput): string {
  return [
    `Contract ${contract.id} passed its checks, but its result could not be published to the project: ${titleOf(input.note).slice(0, 400)}`,
    input.branch === undefined
      ? 'The checked changes are kept in the working tree.'
      : `The checked result is kept on branch ${input.branch}; you can also apply it yourself with: git merge ${input.branch}`,
    'Clear what blocks it (finish or abort your own merge or rebase, or commit or stash edits to the same files), then reply "retry" to publish it again; or reply "cancel" to stop the contract. Resuming the contracts also retries it.',
  ].join('\n');
}

/** Whether an open escalation is a publication pause: a retry-or-cancel question about the deliverable. */
export function isPublicationPause(escalation: Pick<Escalation, 'failurePause' | 'scope' | 'resolvedAt' | 'reason'>): boolean {
  return escalation.failurePause === true && escalation.scope === 'deliverable' && escalation.reason !== 'unsettled' && escalation.resolvedAt === undefined;
}

/** What the owner is shown when no decision model can check a finished result. */
export interface OwnerAcceptanceInput {
  /** The required checks that ran and passed against the result. */
  readonly gates: readonly string[];
  /** The branch holding the result in worktree mode. */
  readonly branch?: string | undefined;
  /** The head of the result's answer. */
  readonly answer: string;
}

/** The answers the owner-acceptance question takes; code reads them. */
export const ACCEPTANCE_ANSWERS = ['accept', 'cancel'] as const;
export type AcceptanceAnswer = (typeof ACCEPTANCE_ANSWERS)[number];

/** The answer a reply to the owner-acceptance question names, or undefined. */
export function readAcceptanceAnswer(text: string): AcceptanceAnswer | undefined {
  const word = text.trim().replace(/[.!]+$/, '').trim().toLowerCase();
  if (word === 'accept' || word === 'approve' || word === 'yes') return 'accept';
  if (word === 'cancel' || word === 'stop' || word === 'no') return 'cancel';
  return undefined;
}

/**
 * The owner-acceptance question, built in code: a finished result that no
 * decision model could check is published only when the owner accepts it.
 */
export function buildOwnerAcceptanceQuestion(contract: Contract, input: OwnerAcceptanceInput): string {
  const answer = input.answer.replace(/\s+/g, ' ').trim();
  return [
    `Contract ${contract.id} finished "${titleOf(contract.goal || contract.ask)}", but no decision model is in use, so the result was not independently checked against what you asked for.`,
    input.gates.length === 0 ? 'No required checks are configured for this project.' : `Required checks that passed: ${input.gates.join(', ')}.`,
    ...(answer.length === 0 ? [] : [`Its answer begins: ${answer.length <= 400 ? answer : `${answer.slice(0, 397)}...`}`]),
    input.branch === undefined
      ? 'Its changes are in the working tree.'
      : `Its changes are on branch ${input.branch}; you can inspect them with: git diff HEAD...${input.branch}`,
    'Reply "accept" to publish the result to the project, or "cancel" to stop the contract. Nothing is published until you accept.',
  ].join('\n');
}

/** Whether an escalation is the owner-acceptance question of a result no decision model checked. */
export function isOwnerAcceptance(escalation: Pick<Escalation, 'failurePause' | 'scope' | 'reason'>): boolean {
  return escalation.failurePause === true && escalation.scope === 'deliverable' && escalation.reason === 'unsettled';
}

/**
 * Closes a publication pause as retried: the contract goes back to judging,
 * the status it paused from. The caller then publishes (on a reply, the
 * deliverable step, which reuses the recorded acceptance; on resume, the
 * commit step). Returns false when the contract is not waiting on it.
 */
export function retryPublicationPause(run: ContractRun, escalation: Escalation, how: string): boolean {
  if (!isPublicationPause(escalation)) return false;
  const { contract } = run;
  if (contract.status === 'awaiting-owner') run.moveContract(contract.statusBeforeOwner ?? 'judging');
  contract.statusBeforeOwner = undefined;
  contract.statusLine = undefined;
  escalation.reply = { text: how, reading: 'amend', outcome: 'act', decisionId: undefined };
  escalation.resolvedAt = run.env.now();
  run.decide('owner-replied', contract.id, `${escalation.id}: retry, the checked result is published again (${how})`);
  run.emit({ type: 'CONTRACT_OWNER_REPLIED', contractId: run.id, escalationId: escalation.id, reading: 'amend', outcome: 'act', action: 'amended' });
  return true;
}

function titleOf(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= 120 ? oneLine : `${oneLine.slice(0, 117)}...`;
}

/** The criteria a target is judged on. */
export function targetCriteria(contract: Contract, scope: EscalationScope, targetId: string): Criterion[] {
  if (scope === 'unit') return contract.units.flatMap((unit) => [unit, ...(unit.attemptUnits ?? [])]).find((unit) => unit.id === targetId)?.criteria ?? [];
  if (scope === 'group') return contract.groups.find((group) => group.id === targetId)?.criteria ?? [];
  if (scope === 'deliverable') return contract.criteria;
  return [];
}

function subjectOf(contract: Contract, scope: EscalationScope, targetId: string): string {
  if (scope === 'unit') return `unit "${titleOf(contract.units.find((unit) => unit.id === targetId)?.title ?? targetId)}"`;
  if (scope === 'group') return `group "${titleOf(contract.groups.find((group) => group.id === targetId)?.title ?? targetId)}"`;
  if (scope === 'deliverable') return `the deliverable "${titleOf(contract.goal)}"`;
  if (scope === 'plan') return `plan "${titleOf(contract.goal)}"`;
  return `the request "${titleOf(contract.ask)}"`;
}

function criterionLine(criterion: Criterion, withSeverity: boolean): string {
  const severity = withSeverity ? latestSeverity(criterion) : undefined;
  return `- [${criterion.id}] ${criterion.text}${severity === undefined ? '' : ` (${severity})`}`;
}

/** The escalation question (section 6.3's form). */
export function buildEscalationQuestion(contract: Contract, input: EscalationInput): string {
  const criteria = targetCriteria(contract, input.scope, input.targetId);
  const pick = (ids: readonly string[]): Criterion[] => criteria.filter((criterion) => ids.includes(criterion.id));
  const unmet = pick(input.unmetCriterionIds);
  const unshown = pick(input.unshownCriterionIds ?? []);
  return [
    `Contract ${contract.id} needs your decision on ${subjectOf(contract, input.scope, input.targetId)}.`,
    REASON_SENTENCES[input.reason],
    ...(input.note === undefined ? [] : [input.note]),
    ...(unmet.length > 0 ? ['Still not met:', ...unmet.map((criterion) => criterionLine(criterion, true))] : []),
    ...(unshown.length > 0 ? ['Not shown:', ...unshown.map((criterion) => criterionLine(criterion, false))] : []),
    `Reply to approve ${APPROVAL_CLAUSES[input.reason]}, to change what is required (say how), or to stop the contract.`,
  ].join('\n');
}

/**
 * What else an `unsettled` check left unshown besides criteria: the unit's
 * goal as a whole, and quality items that did not read clean. The check had no
 * problem (it would have nudged), so every quality item not read "no" at act
 * is one the agent was asked to show and did not. Approval accepts these too,
 * so the question names them. Undefined when there are none.
 */
export function unsettledReadingsNote(unit: Pick<ContractUnit, 'goal'>, check: Pick<UnitCheck, 'goal' | 'quality'>): string | undefined {
  const quality = (Object.keys(check.quality) as QualityItem[]).filter((item) => {
    const reading = check.quality[item];
    return reading !== undefined && !(reading.verdict === 'no' && reading.outcome === 'act');
  });
  const lines = [
    ...(check.goal.verdict === 'unshown' ? [`Not shown for the unit as a whole: that it does what it is for (${titleOf(unit.goal)}).`] : []),
    ...(quality.length > 0 ? ['Not shown about the quality of the work:', ...quality.map((item) => `- ${QUALITY_EVIDENCE_SENTENCES[item]}`)] : []),
  ];
  return lines.length === 0 ? undefined : lines.join('\n');
}

/** The attempts-undecided question: the proposal, if any, and every candidate with the head of its answer. */
export function buildAttemptsQuestion(contract: Contract, unitId: string, selection: AttemptSelectionRecord): string {
  const unit = contract.units.find((candidate) => candidate.id === unitId);
  const answerOf = (id: string): string => titleOf(unit?.attemptUnits?.find((attempt) => attempt.id === id)?.answer ?? '(no answer recorded)');
  return [
    `Contract ${contract.id} needs your decision on unit "${titleOf(unit?.title ?? unitId)}".`,
    REASON_SENTENCES['attempts-undecided'],
    `Selection: ${selection.reasons}`,
    'Candidates:',
    ...selection.candidateIds.map((id) => `- ${id}${id === selection.proposedId ? ' (proposed)' : ''}: ${answerOf(id)}`),
    selection.proposedId === undefined
      ? 'Reply naming the attempt to take, or to stop the contract.'
      : `Reply to approve taking ${selection.proposedId}, to name another attempt, or to stop the contract.`,
  ].join('\n');
}

/** How much of an attempt's answer the owner-pick reading sees. */
const ATTEMPT_ANSWER_HEAD = 2_000;

function answerHead(answer: string | undefined): string {
  if (answer === undefined) return '(no answer recorded)';
  return answer.length <= ATTEMPT_ANSWER_HEAD ? answer : `${answer.slice(0, ATTEMPT_ANSWER_HEAD)}...`;
}

/** The question without the lines the runner added when it asked before. */
function baseQuestion(question: string): string {
  const lines = question.split('\n');
  while (lines.length > 0 && ADDED_LINE_PREFIXES.some((prefix) => lines.at(-1)!.startsWith(prefix))) lines.pop();
  return lines.join('\n');
}

// ── Raising and replying ──────────────────────────────────────────────────────

export interface Rejudge {
  /** Checks a group again after its criteria were amended. */
  rejudgeGroup(run: ContractRun, groupId: string): Promise<void>;
  /** Checks the deliverable again after the contract's criteria were amended. */
  rejudgeDeliverable(run: ContractRun): Promise<void>;
}

export interface Escalations {
  /** Opens an escalation: target and contract to awaiting-owner, the question, the event. */
  raise(run: ContractRun, input: EscalationInput): Escalation;
  /** Unsettled readings reached `contract.evidenceNudgeLimit` (4.6): ask the owner to confirm. */
  unitAwaitsOwner(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void>;
  /** The best-of-N selection did not act (6.2): ask the owner which attempt to take. */
  attemptsUndecided(run: ContractRun, unitId: string, selection: AttemptSelectionRecord): Promise<void>;
  reply(run: ContractRun, escalationId: string, text: string): Promise<OwnerReplyOutcome>;
  /**
   * A native session contract's turn keeps failing: it pauses (awaiting-owner,
   * its work kept) and asks the owner to retry or cancel. Opens no approval:
   * `raise` still refuses every source-bound contract. Asking again while a
   * failure pause is open returns the open one.
   */
  pauseForOwnerRetry(run: ContractRun, input: FailurePauseInput): Escalation;
  /**
   * A unit of an agent-run contract failed: instead of ending the contract, the
   * unit waits on the owner (awaiting-owner; the finished work kept, its
   * dependents held, not skipped) with one question, retry or cancel. Retry
   * gives the unit a fresh agent (an item the engine already failed is reset, so
   * its dependents wait on it again); cancel stops the contract. Null when the
   * contract cannot wait on it: native or session-mode work, a best-of-N unit or
   * attempt (the attempt selection decides those), a contract or unit in a state
   * that cannot move to the owner. Asking again for a unit already asked returns
   * the open question.
   */
  pauseFailedUnit(run: ContractRun, unit: ContractUnit, reason: string): Escalation | null;
  /**
   * An operator picked a unit's attempt through `fleet.attempts.pick`: the
   * unit's open `attempts-undecided` escalation closes, and the attempt is
   * taken as the owner's pick would be. The caller has checked that the
   * attempt is one of the unit's passing candidates.
   */
  operatorPick(run: ContractRun, unitId: string, attemptId: string): Promise<void>;
}

export function createEscalations(context: StepContext, rejudge: Rejudge): Escalations {
  function open(run: ContractRun): Escalation[] {
    return run.contract.escalations.filter((escalation) => escalation.resolvedAt === undefined);
  }

  function raise(run: ContractRun, input: EscalationInput): Escalation {
    const { contract } = run;
    // A session's own request is fixed and answered by native decisions, not owner approval. A contract started
    // by unattended work keeps its source as the fixed root and asks its owner like any other.
    if (contract.nativeSource !== undefined && input.retryOrCancel !== true) throw new Error('Native session contracts do not ask for owner approval');
    const built = input.question ?? buildEscalationQuestion(contract, input);
    // A code-answered question names its own answers; any other says how a reply is read without a model.
    const question = input.retryOrCancel !== true && input.reason !== 'attempts-undecided' && isClassicOperation() && !built.endsWith(NO_MODEL_REPLY_LINE)
      ? `${built}\n${NO_MODEL_REPLY_LINE}` : built;
    const escalation: Escalation = {
      id: `${contract.id}.e${contract.escalations.length + 1}`,
      at: run.env.now(),
      scope: input.scope,
      targetId: input.targetId,
      reason: input.reason,
      question,
      unmetCriterionIds: [...input.unmetCriterionIds],
      ...(input.decisionIds.length === 0 ? {} : { decisionIds: [...input.decisionIds] }),
      ...(input.retryOrCancel === true ? { failurePause: true as const } : {}),
    };
    // The contract moves first: a refused contract move must not leave a unit
    // or group waiting on an owner who was never asked.
    if (contract.status !== 'awaiting-owner') {
      const before = contract.status;
      run.moveContract('awaiting-owner');
      contract.statusBeforeOwner = before;
    }
    if (input.scope === 'unit') {
      const unit = run.unit(input.targetId);
      if (unit !== undefined) {
        run.releaseHold(unit);
        run.moveUnit(unit, 'awaiting-owner');
        // Other contracts are not held behind a question nobody may be looking at; the reply takes the tree again.
        releaseSharedTreeForOwner(run, unit.groupId);
      }
    } else if (input.scope === 'group') {
      const group = run.group(input.targetId);
      if (group !== undefined) {
        run.moveGroup(group, 'awaiting-owner');
        releaseSharedTreeForOwner(run, group.id);
      }
    }
    contract.escalations.push(escalation);
    run.decide('escalated', input.targetId, `${input.reason}: asked the owner`, input.decisionIds);
    run.emit({
      type: 'CONTRACT_ESCALATED',
      contractId: contract.id,
      escalationId: escalation.id,
      scope: escalation.scope,
      targetId: escalation.targetId,
      reason: escalation.reason,
      question,
      unmetCriterionIds: escalation.unmetCriterionIds,
    });
    context.ownerProgress(run);
    return escalation;
  }

  function pauseForOwnerRetry(run: ContractRun, input: FailurePauseInput): Escalation {
    const { contract } = run;
    if (contract.nativeSource === undefined || contract.sessionMode !== true) {
      throw new Error(`contract ${run.id} does not run in a native session, so it has no turn to retry; only a native session contract can pause for a retry`);
    }
    if (run.terminal) throw new Error(`contract ${run.id} has ended (${contract.status}); there is nothing to pause`);
    const asked = open(run).find((escalation) => escalation.failurePause === true);
    if (asked !== undefined) return asked;
    const unit = contract.units.find((candidate) => candidate.status === 'running' || candidate.status === 'nudged');
    if (unit === undefined) throw new Error(`contract ${run.id} is ${contract.status} and has no unit waiting on its session turn, so there is no failed turn to pause`);
    const before = contract.status;
    // The contract moves first: a refused contract move must not leave a unit waiting on an owner who was never asked.
    if (before !== 'awaiting-owner') {
      run.moveContract('awaiting-owner');
      contract.statusBeforeOwner = before;
    }
    try {
      run.releaseHold(unit);
      run.moveUnit(unit, 'awaiting-owner');
    } catch (error) {
      if (before !== 'awaiting-owner') { run.moveContract(before); contract.statusBeforeOwner = undefined; }
      throw error;
    }
    const question = buildFailurePauseQuestion(contract, unit, input);
    const escalation: Escalation = {
      id: `${contract.id}.e${contract.escalations.length + 1}`,
      at: run.env.now(),
      scope: 'unit',
      targetId: unit.id,
      reason: 'owner-decision-needed',
      question,
      unmetCriterionIds: [],
      failurePause: true,
    };
    contract.escalations.push(escalation);
    run.decide('escalated', unit.id, `turn failed after ${input.attempts} attempt${input.attempts === 1 ? '' : 's'}: paused and asked the owner to retry or cancel`);
    run.emit({
      type: 'CONTRACT_ESCALATED',
      contractId: contract.id,
      escalationId: escalation.id,
      scope: escalation.scope,
      targetId: escalation.targetId,
      reason: escalation.reason,
      question,
      unmetCriterionIds: escalation.unmetCriterionIds,
    });
    context.ownerProgress(run);
    // A restart must find the question still open.
    context.checkpoint?.(run);
    return escalation;
  }

  /** Contract statuses a failed unit can pause from, and unit statuses that can move to the owner. */
  const PAUSABLE_CONTRACT: ReadonlySet<ContractStatus> = new Set(['running', 'judging', 'fixing', 'awaiting-owner']);
  const PAUSABLE_UNIT: ReadonlySet<ContractUnit['status']> = new Set(['running', 'checking', 'held', 'nudged', 'fixing']);

  function pauseFailedUnit(run: ContractRun, unit: ContractUnit, reason: string): Escalation | null {
    const { contract } = run;
    if (run.terminal || contract.nativeSource !== undefined || contract.sessionMode === true) return null;
    if (unit.attemptOf !== undefined || unit.attemptUnits !== undefined) return null;
    const asked = open(run).find((escalation) => escalation.failurePause === true && escalation.scope === 'unit' && escalation.targetId === unit.id);
    if (asked !== undefined) return asked;
    if (!PAUSABLE_CONTRACT.has(contract.status) || !PAUSABLE_UNIT.has(unit.status)) return null;
    // A retry needs the unit's work item: one missing from the engine (a lost snapshot) cannot run again.
    const item = engineItem(run, unit.id);
    if (item === undefined || item.state === 'passed') return null;
    unit.failureReason = reason;
    const escalation = raise(run, {
      scope: 'unit', targetId: unit.id, reason: 'owner-decision-needed', unmetCriterionIds: [], decisionIds: [],
      question: buildUnitFailureQuestion(contract, unit, reason), retryOrCancel: true,
    });
    // A restart must find the question still open; the debounced write follows if this one fails.
    try { context.checkpoint?.(run); } catch { /* the contract is held and its write is scheduled */ }
    return escalation;
  }

  /** Back to the status the contract left for the owner, once nothing else waits on them. */
  function resume(run: ContractRun, to?: ContractStatus): void {
    if (open(run).length > 0 || run.contract.status !== 'awaiting-owner') return;
    run.moveContract(to ?? run.contract.statusBeforeOwner ?? 'running');
    run.contract.statusBeforeOwner = undefined;
    context.ownerProgress(run);
  }

  async function unitAwaitsOwner(run: ContractRun, unitId: string, check: DecidedCheck): Promise<void> {
    const unit = run.unit(unitId);
    if (unit === undefined || run.terminal) return;
    const unshown = [...check.verdicts].filter(([, verdict]) => verdict === 'unshown').map(([id]) => id);
    check.recordAction('escalated to the owner: unsettled');
    const note = unsettledReadingsNote(unit, check.check);
    raise(run, {
      scope: 'unit',
      targetId: unit.id,
      reason: 'unsettled',
      unmetCriterionIds: [],
      unshownCriterionIds: unshown,
      decisionIds: check.check.decisionIds,
      ...(note === undefined ? {} : { note }),
    });
  }

  async function attemptsUndecided(run: ContractRun, unitId: string, selection: AttemptSelectionRecord): Promise<void> {
    if (run.terminal || run.unit(unitId) === undefined) return;
    raise(run, {
      scope: 'unit',
      targetId: unitId,
      reason: 'attempts-undecided',
      unmetCriterionIds: [],
      decisionIds: selection.decisionId === undefined ? [] : [selection.decisionId],
      question: buildAttemptsQuestion(run.contract, unitId, selection),
    });
  }

  /** Puts the escalation's question again with `line` under it, as a new open escalation. */
  function askAgain(run: ContractRun, escalation: Escalation, line: string): Escalation {
    return raise(run, {
      scope: escalation.scope,
      targetId: escalation.targetId,
      reason: escalation.reason,
      unmetCriterionIds: escalation.unmetCriterionIds,
      decisionIds: [],
      question: `${baseQuestion(escalation.question)}\n${line}`,
    });
  }

  // ── What each reading does ────────────────────────────────────────────────────

  type Handled = { readonly action: OwnerReplyAction; readonly next?: Escalation | undefined };

  async function approveUnsettled(run: ContractRun, escalation: Escalation, decisionId: string | undefined): Promise<Handled> {
    const unit = run.unit(escalation.targetId);
    if (unit === undefined) return { action: 'refused' };
    const judged = unit.criteria.filter((criterion) => criterion.disposition === 'judged');
    // A reply grants authority to continue; it is not evidence that a criterion holds.
    // Existing met readings remain valid. Unsettled criteria require new evidence
    // or an explicit amendment of what is required before this unit can pass.
    if (judged.some((criterion) => criterion.status !== 'met')) {
      return { action: 'refused', next: askAgain(run, escalation, APPROVAL_REFUSED_LINE) };
    }
    resume(run);
    context.checks().passUnit(run, unit, unit.answer ?? unit.lastOutput ?? '', 'passed: all judged criteria have supporting readings');
    return { action: 'approved' };
  }

  async function approvePlan(run: ContractRun, escalation: Escalation): Promise<Handled> {
    const accepted = await acceptEscalatedPlan(run.contract, escalation, context.plannerDeps(run), { signal: run.abort.signal });
    if (accepted.kind === 'unrunnable') {
      return { action: 'refused', next: askAgain(run, escalation, PLAN_UNRUNNABLE_LINE(accepted.problems.map((problem) => problem.message).join(' '))) };
    }
    await context.continuePlanning(run, accepted.kind === 'failed' || accepted.kind === 'cancelled' ? accepted : { kind: 'accepted', plan: accepted.plan, decisionIds: accepted.decisionIds });
    return { action: 'approved' };
  }

  async function plan(run: ContractRun, input: { readonly ownerInstruction?: string | undefined; readonly previousPlan?: string | undefined } = {}): Promise<void> {
    const outcome = await planContract(run.contract, context.plannerDeps(run), { proposedUnits: run.proposedUnits, signal: run.abort.signal, ...input });
    await context.continuePlanning(run, outcome);
  }

  /** Settles writing as the owner said, recording the readings it rests on on the `shaped` decision, and plans. */
  async function writingDecided(run: ContractRun, forbidsWriting: boolean, how: string, decisionIds: readonly string[] = [], ownerInstruction?: string): Promise<void> {
    const shape = run.contract.shape;
    if (shape === undefined) throw new Error(`contract ${run.id} has no request shape`);
    run.contract.shape = withOwnerWritingDecision(shape, forbidsWriting);
    run.decide('shaped', run.id, `the owner settled writing: files ${forbidsWriting ? 'may not' : 'may'} change (${how})`, decisionIds);
    await plan(run, ownerInstruction === undefined ? {} : { ownerInstruction });
  }

  /** The owner's reply changes what is required about writing: read with `forbids_writing` alone. */
  async function amendWriting(run: ContractRun, escalation: Escalation, text: string): Promise<Handled> {
    const usage = emptyJudgmentUsage();
    let read: Awaited<ReturnType<typeof readForbidsWriting>> | undefined;
    try {
      read = await decisionOrClassic<Awaited<ReturnType<typeof readForbidsWriting>> | undefined>(() => readForbidsWriting(meteredPort(judgmentPort(REQUEST_SHAPE_SITE), usage), text, { signal: run.abort.signal }), () => undefined);
    } finally {
      addJudgmentUsage(run.contract.judgmentUsage, usage);
    }
    // No decision model can read what the change says about files: the owner is asked in plain words.
    if (read === undefined) return { action: 'asked-again', next: askAgain(run, escalation, NO_MODEL_WRITING_LINE) };
    const { reading } = read;
    if (!saysYesAtAct(reading) && !saysNoAtAct(reading)) {
      read.recordAction('writing not settled by the reply: asked again');
      return { action: 'asked-again', next: askAgain(run, escalation, ASK_AGAIN_LINE) };
    }
    read.recordAction(`the owner settled writing: files ${saysYesAtAct(reading) ? 'may not' : 'may'} change`);
    await writingDecided(run, saysYesAtAct(reading), 'read from the reply', read.decisionId === undefined ? [] : [read.decisionId], text);
    return { action: 'amended' };
  }

  async function amendWork(run: ContractRun, escalation: Escalation, text: string): Promise<Handled> {
    const amended = await amendTarget(run, escalation, text, context);
    if (amended.kind === 'problems') return { action: 'refused', next: askAgain(run, escalation, AMENDMENT_FAILED_LINE(amended.problems.join(' '))) };
    if (escalation.scope === 'unit') {
      const unit = run.unit(escalation.targetId);
      if (unit === undefined) return { action: 'refused' };
      resume(run);
      await context.checks().runCheck(run, unit, 'owner-amend');
    } else if (escalation.scope === 'group') {
      resume(run);
      await rejudge.rejudgeGroup(run, escalation.targetId);
    } else {
      resume(run, 'judging');
      await rejudge.rejudgeDeliverable(run);
    }
    return { action: 'amended' };
  }

  async function takeAttempt(run: ContractRun, escalation: Escalation, attemptId: string | undefined, how: string, decisionId: string | undefined, action: 'approved' | 'amended'): Promise<Handled> {
    const selection = run.unit(escalation.targetId)?.attemptSelection;
    if (selection === undefined) return { action: 'refused' };
    if (attemptId === undefined) return { action: 'refused', next: askAgain(run, escalation, NAME_AN_ATTEMPT_LINE(selection.candidateIds)) };
    assertAttemptTakeable(run, escalation.targetId, attemptId);
    resume(run);
    await acceptAttempt(run, escalation.targetId, attemptId, how, decisionId === undefined ? [] : [decisionId]);
    return { action };
  }

  /** The attempt a reply asks for (by id, by position, or by what it did), read with `contract.owner-pick`; none below act. */
  async function askedAttempt(run: ContractRun, escalation: Escalation, text: string): Promise<{ readonly id: string | undefined; readonly decisionId: string | undefined }> {
    const unit = run.unit(escalation.targetId);
    const selection = unit?.attemptSelection;
    if (unit === undefined || selection === undefined) return { id: undefined, decisionId: undefined };
    // Each candidate is its position and the head of its answer, as the
    // question showed it, so the reading's size does not grow with the answers.
    const candidates = selection.candidateIds.map((id, index) => ({
      id,
      content: { position: index + 1, answer: answerHead(unit.attemptUnits?.find((attempt) => attempt.id === id)?.answer) },
    }));
    assertJudgmentInput({ reply: text, question: escalation.question, candidates });
    const usage = emptyJudgmentUsage();
    try {
      return await decisionOrClassic(async () => {
        const read = await ownerPick.select(meteredPort(judgmentPort(OWNER_PICK_SITE), usage), { reply: text, question: escalation.question }, candidates, { site: OWNER_PICK_SITE, signal: run.abort.signal });
        const taken = read.outcome === 'act' ? read.chosen : undefined;
        read.recordAction(taken === undefined ? 'no attempt taken: asked again' : `took ${taken}`);
        return { id: taken, decisionId: read.decisionId };
      }, () => ({ id: attemptNamedLiterally(text, selection.candidateIds), decisionId: undefined }));
    } finally {
      addJudgmentUsage(run.contract.judgmentUsage, usage);
    }
  }

  async function approve(run: ContractRun, escalation: Escalation, decisionId: string | undefined): Promise<Handled> {
    switch (escalation.reason) {
      case 'unsettled':
        return approveUnsettled(run, escalation, decisionId);
      case 'plan-unresolved':
        return approvePlan(run, escalation);
      case 'writing-unclear':
        await writingDecided(run, false, 'approved by the owner');
        return { action: 'approved' };
      case 'attempts-undecided': {
        const proposed = run.unit(escalation.targetId)?.attemptSelection?.proposedId;
        return takeAttempt(run, escalation, proposed, 'the owner approved the proposed attempt', decisionId, 'approved');
      }
      case 'stalled':
      case 'fix-rounds-exhausted':
      case 'owner-decision-needed':
        return { action: 'refused', next: askAgain(run, escalation, APPROVAL_REFUSED_LINE) };
    }
  }

  async function amend(run: ContractRun, escalation: Escalation, text: string, decisionId: string | undefined): Promise<Handled> {
    switch (escalation.reason) {
      case 'plan-unresolved':
        await plan(run, { ownerInstruction: text, previousPlan: lastFencedBlock(escalation.question) });
        return { action: 'amended' };
      case 'writing-unclear':
        return amendWriting(run, escalation, text);
      case 'attempts-undecided': {
        const asked = await askedAttempt(run, escalation, text);
        return takeAttempt(run, escalation, asked.id, 'the owner asked for this attempt', asked.decisionId ?? decisionId, 'amended');
      }
      case 'unsettled':
      case 'stalled':
      case 'fix-rounds-exhausted':
      case 'owner-decision-needed':
        return amendWork(run, escalation, text);
    }
  }

  async function reply(run: ContractRun, escalationId: string, text: string): Promise<OwnerReplyOutcome> {
    const escalation = run.contract.escalations.find((candidate) => candidate.id === escalationId);
    // A failure pause is answered by code, not read; with no decision model any other reply is read literally.
    if (escalation?.failurePause !== true && run.contract.nativeSource !== undefined) throw new OwnerReplyRefusedError('Native contracts do not read owner approval replies', 'unsupported');
    if (escalation === undefined || escalation.resolvedAt !== undefined) throw new OwnerReplyRefusedError(`contract ${run.id} has no open escalation ${escalationId}`, 'not-open');
    // Claimed before the first await: a second reply to the same question
    // (two quick messages, two surfaces) must not be read and acted on too.
    if (run.replying.has(escalationId)) throw new OwnerReplyRefusedError(`a reply to ${escalationId} is already being read; wait for its result`, 'already-reading');
    run.replying.add(escalationId);
    try {
      // A failure pause's answer is checked before anything is taken: a refused reply never takes the tree.
      if (escalation.failurePause === true) failurePauseAnswer(run, escalation, text);
      // The waiting group gave the shared tree up; it takes it again before the reply acts.
      const waitingGroup = escalation.scope === 'unit' ? run.unit(escalation.targetId)?.groupId
        : escalation.scope === 'group' ? escalation.targetId : undefined;
      if (waitingGroup !== undefined) await retakeSharedTreeAfterOwner(run, waitingGroup);
      try {
        return escalation.failurePause === true ? replyToFailurePause(run, escalation, text) : await replyClaimed(run, escalation, text);
      } catch (error) {
        // Nothing was applied and the question is still open: the waiting group gives the tree up again.
        if (waitingGroup !== undefined && escalation.resolvedAt === undefined) releaseSharedTreeForOwner(run, waitingGroup);
        throw error;
      }
    } finally {
      run.replying.delete(escalationId);
    }
  }

  /**
   * The answer a failure pause accepts, or the refusal that leaves it open. Reads only: it is checked before the
   * reply takes anything (the shared tree) and again where the answer is applied.
   */
  function failurePauseAnswer(run: ContractRun, escalation: Escalation, text: string):
    { readonly kind: 'acceptance'; readonly answer: 'accept' | 'cancel' } | { readonly kind: 'failure'; readonly answer: FailurePauseAnswer; readonly publication: boolean; readonly unitFailure: boolean } {
    if (isOwnerAcceptance(escalation)) {
      const answer = readAcceptanceAnswer(text);
      if (answer === undefined) {
        throw new OwnerReplyRefusedError(`"${titleOf(text)}" is not an answer to ${escalation.id}: it only accepts "accept" (publish the result that was not independently checked) or "cancel" (stop the contract); the question is still open`, 'not-an-answer');
      }
      return { kind: 'acceptance', answer };
    }
    const publication = isPublicationPause(escalation);
    const unitFailure = isUnitFailurePause(run, escalation);
    if (!publication && !unitFailure && (run.contract.nativeSource === undefined || run.contract.sessionMode !== true)) throw new OwnerReplyRefusedError(`${escalation.id} is not a failure pause of a native session contract`, 'unsupported');
    const answer = readFailurePauseAnswer(text);
    if (answer === undefined) {
      throw new OwnerReplyRefusedError(`"${titleOf(text)}" is not an answer to ${escalation.id}: it only accepts ${FAILURE_PAUSE_ANSWERS.map((word) => `"${word}"`).join(' or ')} ("retry" runs the failed work again, "cancel" stops the contract), and nothing here approves the work; the question is still open`, 'not-an-answer');
    }
    if (unitFailure && answer === 'retry') {
      const unit = run.unit(escalation.targetId);
      if (unit === undefined || unit.status !== 'awaiting-owner') throw new OwnerReplyRefusedError(`unit ${escalation.targetId} no longer waits on ${escalation.id}`, 'not-open');
    }
    return { kind: 'failure', answer, publication, unitFailure };
  }

  /** Retry runs the turn (or the publication) again; cancel stops the contract. Any other answer leaves the question open. */
  function replyToFailurePause(run: ContractRun, escalation: Escalation, text: string): OwnerReplyOutcome {
    const checked = failurePauseAnswer(run, escalation, text);
    if (checked.kind === 'acceptance') return replyToOwnerAcceptance(run, escalation, text, checked.answer);
    const { answer, publication, unitFailure } = checked;
    const { contract } = run;
    if (publication && answer === 'retry') {
      retryPublicationPause(run, escalation, text);
      context.ownerProgress(run);
      context.checkpoint?.(run);
      // Publishing again reuses the recorded acceptance; it judges again only when the accepted result changed.
      void rejudge.rejudgeDeliverable(run);
      return { escalationId: escalation.id, reading: 'amend', outcome: 'act', action: 'amended' };
    }
    const reading: OwnerReplyReading = answer === 'cancel' ? 'reject' : 'amend';
    const action: OwnerReplyAction = answer === 'cancel' ? 'stopped' : 'amended';
    if (unitFailure && answer === 'retry') {
      const unit = run.unit(escalation.targetId)!;
      escalation.reply = { text, reading, outcome: 'act', decisionId: undefined };
      escalation.resolvedAt = run.env.now();
      unit.failureReason = undefined;
      unit.transportRetries = 0;
      run.decide('owner-replied', unit.id, `${escalation.id}: retry, unit ${unit.id} runs again with a fresh agent`);
      run.emit({ type: 'CONTRACT_OWNER_REPLIED', contractId: run.id, escalationId: escalation.id, reading, outcome: 'act', action });
      resume(run);
      context.groups().requeueUnit(run, unit, 'run again at the owner\'s request after it failed', 'fresh-unit');
      context.ownerProgress(run);
      try { context.checkpoint?.(run); } catch { /* the contract is held and its write is scheduled */ }
      return { escalationId: escalation.id, reading, outcome: 'act', action };
    }
    if (answer === 'retry') {
      // The contract moves first; a refused move leaves the question open.
      const unit = run.unit(escalation.targetId);
      if (contract.status === 'awaiting-owner') run.moveContract(contract.statusBeforeOwner ?? 'running');
      contract.statusBeforeOwner = undefined;
      // A nudge that was waiting for the next turn is still queued: the unit goes back to waiting on it, not to a plain run.
      if (unit !== undefined && unit.status === 'awaiting-owner') run.moveUnit(unit, (run.runtime(unit).session?.queued.length ?? 0) > 0 ? 'nudged' : 'running');
    }
    escalation.reply = { text, reading, outcome: 'act', decisionId: undefined };
    escalation.resolvedAt = run.env.now();
    run.decide('owner-replied', escalation.targetId, `${escalation.id}: ${answer}, ${answer === 'retry' ? 'the turn runs again' : 'the contract is stopped'}`);
    run.emit({ type: 'CONTRACT_OWNER_REPLIED', contractId: run.id, escalationId: escalation.id, reading, outcome: 'act', action });
    if (answer === 'cancel') {
      contract.failureKind = 'owner-rejected';
      const unitReason = unitFailure ? run.unit(escalation.targetId)?.failureReason : undefined;
      run.control.cancel(publication ? 'stopped by the owner after its checked result could not be published'
        : unitFailure ? `stopped by the owner after unit ${escalation.targetId} failed${unitReason === undefined ? '' : `: ${unitReason}`}`
          : 'stopped by the owner after its turn kept failing');
    } else {
      context.ownerProgress(run);
      context.checkpoint?.(run);
    }
    return { escalationId: escalation.id, reading, outcome: 'act', action };
  }

  /**
   * The owner's answer to a result no decision model checked: "accept" records
   * the acceptance and publishes it (the deliverable step finds the accepted,
   * unchanged result); "cancel" stops the contract. Any other answer leaves the
   * question open.
   */
  function replyToOwnerAcceptance(run: ContractRun, escalation: Escalation, text: string, answer: 'accept' | 'cancel'): OwnerReplyOutcome {
    const { contract } = run;
    const reading: OwnerReplyReading = answer === 'accept' ? 'approve' : 'reject';
    const action: OwnerReplyAction = answer === 'accept' ? 'approved' : 'stopped';
    if (answer === 'accept' && contract.status === 'awaiting-owner') run.moveContract(contract.statusBeforeOwner ?? 'judging');
    if (answer === 'accept') contract.statusBeforeOwner = undefined;
    escalation.reply = { text, reading, outcome: 'act', decisionId: undefined };
    escalation.resolvedAt = run.env.now();
    run.decide('owner-replied', contract.id, answer === 'accept'
      ? `${escalation.id}: accept, the owner accepted the result that no decision model checked; it is published`
      : `${escalation.id}: cancel, the contract is stopped`);
    run.emit({ type: 'CONTRACT_OWNER_REPLIED', contractId: run.id, escalationId: escalation.id, reading, outcome: 'act', action });
    if (answer === 'cancel') {
      contract.failureKind = 'owner-rejected';
      run.control.cancel('stopped by the owner instead of accepting its result');
      return { escalationId: escalation.id, reading, outcome: 'act', action };
    }
    context.ownerProgress(run);
    context.checkpoint?.(run);
    // The deliverable step publishes the accepted result, or checks it again when it changed meanwhile.
    void rejudge.rejudgeDeliverable(run);
    return { escalationId: escalation.id, reading, outcome: 'act', action };
  }

  async function replyClaimed(run: ContractRun, escalation: Escalation, text: string): Promise<OwnerReplyOutcome> {
    const usage = emptyJudgmentUsage();
    let read: ReplyRead;
    try {
      read = await decisionOrClassic(async (): Promise<ReplyRead> => {
        const answered = await ownerReply.read(
          meteredPort(judgmentPort(OWNER_REPLY_SITE), usage),
          { reason: escalation.reason, question: escalation.question },
          text,
          { site: OWNER_REPLY_SITE, signal: run.abort.signal },
        );
        return { choice: answered.reading.choice as OwnerReplyReading, outcome: answered.reading.outcome, decisionId: answered.decisionId,
          recordAction: (action) => answered.recordAction(action) };
      }, (): ReplyRead => {
        const literal = readOwnerReplyLiterally(text);
        // An attempts question is answered by naming an attempt, which the pick reads literally too.
        const choice = literal.choice === 'unclear' && escalation.reason === 'attempts-undecided' ? 'amend' : literal.choice;
        return { choice, outcome: 'act', decisionId: undefined, literal: true,
          ...(literal.instruction === undefined ? {} : { instruction: literal.instruction }), recordAction: () => {} };
      });
    } catch (error) {
      // Nothing was decided and the question is still open: the owner can reply again.
      if (!run.terminal && !isAbortError(error, run.abort.signal)) {
        throw new Error(`the reply to ${escalation.id} could not be read (${failureFromError(error).reason}); the question is still open, so reply again`, { cause: error });
      }
      throw error;
    } finally {
      addJudgmentUsage(run.contract.judgmentUsage, usage);
    }
    // The read awaited: another surface (an operator pick) may have answered
    // this question while it ran, and may not be stamped over. Ending the
    // contract aborts the read itself, so the terminal check is a guard against
    // a reader that returned regardless of the abort.
    if (run.terminal) {
      throw new OwnerReplyRefusedError(`contract ${run.id} ended while the reply to ${escalation.id} was being read; nothing was applied`, 'ended');
    }
    if (escalation.resolvedAt !== undefined) {
      throw new OwnerReplyRefusedError(`${escalation.id} was answered while the reply was being read; nothing was applied`, 'not-open');
    }
    const { choice: reading, outcome } = read;
    escalation.reply = { text, reading, outcome, decisionId: read.decisionId };
    escalation.resolvedAt = run.env.now();
    const decisionIds = read.decisionId === undefined ? [] : [read.decisionId];

    const replied = (action: OwnerReplyAction): void => {
      read.recordAction(action);
      run.decide('owner-replied', escalation.targetId, `${escalation.id}: ${reading} (${outcome}), ${action}`, decisionIds);
      run.emit({ type: 'CONTRACT_OWNER_REPLIED', contractId: run.id, escalationId: escalation.id, reading, outcome, action });
    };

    let handled: Handled;
    if (outcome !== 'act' || reading === 'unclear') {
      handled = { action: 'asked-again', next: askAgain(run, escalation, read.literal === true ? NO_MODEL_REPLY_LINE : ASK_AGAIN_LINE) };
      replied(handled.action);
    } else if (reading === 'reject') {
      handled = { action: 'stopped' };
      replied(handled.action);
      run.contract.failureKind = 'owner-rejected';
      run.control.cancel('stopped by the owner');
    } else {
      try {
        handled = reading === 'approve' ? await approve(run, escalation, read.decisionId) : await amend(run, escalation, read.instruction ?? text, read.decisionId);
      } catch (error) {
        if (run.terminal || isAbortError(error, run.abort.signal)) throw error;
        // A step that cannot run (no route for the amendment planner, a Jev
        // outage) leaves the owner's question standing: it is asked again with
        // what failed, and the contract keeps its work.
        const failure = failureFromError(error);
        try {
          handled = { action: 'asked-again', next: askAgain(run, escalation, REPLY_NOT_APPLIED_LINE(failure.reason)) };
        } catch {
          run.control.fail(failure.kind, `the owner's reply to ${escalation.id} could not be acted on: ${failure.reason}`);
          throw error;
        }
      }
      replied(handled.action);
    }
    return {
      escalationId: escalation.id,
      reading,
      outcome,
      action: handled.action,
      ...(handled.next === undefined ? {} : { nextEscalationId: handled.next.id }),
    };
  }

  async function operatorPick(run: ContractRun, unitId: string, attemptId: string): Promise<void> {
    if (run.contract.nativeSource !== undefined) throw new Error('Native attempts require a fresh Jev decision');
    // The pick answers the question at once. A reply to it still being read
    // finds the question answered when its reading returns and applies nothing.
    // A refused pick leaves the owner's question open.
    assertAttemptTakeable(run, unitId, attemptId);
    for (const escalation of open(run)) {
      if (escalation.reason === 'attempts-undecided' && escalation.targetId === unitId) escalation.resolvedAt = run.env.now();
    }
    resume(run);
    await acceptAttempt(run, unitId, attemptId, 'picked by the operator (fleet.attempts.pick)');
  }

  return { raise, unitAwaitsOwner, attemptsUndecided, pauseForOwnerRetry, pauseFailedUnit, reply, operatorPick };
}

/** A reply as the runner acts on it: the decision model's reading, or code's literal reading with no model in use. */
interface ReplyRead {
  readonly choice: OwnerReplyReading;
  readonly outcome: Outcome;
  readonly decisionId: string | undefined;
  /** Read by code because no decision model is in use. */
  readonly literal?: true;
  /** What to change, from a literal "change: ..." reply. */
  readonly instruction?: string;
  recordAction(action: string): void;
}

/** The attempt a reply names without a decision model: exactly one candidate id in it, or its position (1, 2, ...). */
function attemptNamedLiterally(text: string, candidateIds: readonly string[]): string | undefined {
  const named = candidateIds.filter((id) => text.includes(id));
  if (named.length === 1) return named[0];
  if (named.length > 1) return undefined;
  const positions = [...text.matchAll(/\b(\d+)\b/g)].map((match) => Number(match[1]));
  return positions.length === 1 && positions[0]! >= 1 && positions[0]! <= candidateIds.length ? candidateIds[positions[0]! - 1] : undefined;
}

/** Criteria of a target that read unmet, and those that read unshown, by id. */
export function standingCriteria(criteria: readonly Criterion[]): { readonly unmet: string[]; readonly unshown: string[] } {
  const judged = criteria.filter((criterion) => criterion.disposition === 'judged');
  return {
    unmet: judged.filter((criterion) => criterion.status === 'unmet').map((criterion) => criterion.id),
    unshown: judged.filter((criterion) => criterion.status === 'unshown' || criterion.status === 'unread').map((criterion) => criterion.id),
  };
}
