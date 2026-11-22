/**
 * How a finished contract describes itself (docs/design/contract-runner.md
 * section 6.5): its answer, which reaches the person, and its status line,
 * which reaches operator surfaces only.
 *
 * The owner record runs no model, so without this its output would be the
 * status line, and a person asking about their flights would be answered with
 * "Contract ctr-1a2b3c4d passed (3 of 3 criteria met...)". The answer belongs
 * to the unit that produced the deliverable: the integration unit of a
 * multi-unit plan, otherwise the plan's one unit. A structured completion
 * report contributes its result, or the accompanying prose answer. Only a
 * report without either falls back to its summary.
 */
import { parseCompletionReportParts } from '../agents/completion-report.js';
import type { Contract, ContractUnit } from './types.js';

/** Said when a contract passed but its deliverable unit left no text to show. */
export const CONTRACT_PASSED_WITHOUT_OUTPUT = 'The work is finished. Every acceptance criterion was checked and met.';

/** The unit whose answer is the deliverable's: the integration unit, or the one unit of a single-unit plan. */
export function answerUnit(contract: Pick<Contract, 'units' | 'groups'>): ContractUnit | undefined {
  const planUnits = contract.units.filter((unit) => contract.groups.find((group) => group.id === unit.groupId)?.kind !== 'fix');
  return planUnits.find((unit) => unit.role === 'integration') ?? (planUnits.length === 1 ? planUnits[0] : undefined);
}

/** The accepted unit that supplied the current explicit final answer. */
export function finalAnswerUnit(contract: Pick<Contract, 'units' | 'groups'>): ContractUnit | undefined {
  const answerRepairs = new Set(contract.groups.filter(group => group.kind === 'fix' && group.repairs?.scope === 'deliverable').map(group => group.id));
  for (const unit of [...contract.units].reverse()) {
    if (unit.status !== 'passed' || !answerRepairs.has(unit.groupId)) continue;
    // Only an explicit complete final answer replaces the rejected draft.
    // Research results and engineering fix notes remain supporting evidence.
    const report = parseCompletionReportParts(unit.answer ?? '')?.report;
    const result = typeof report?.finalAnswer === 'string' ? report.finalAnswer.trim() : '';
    if (result) return unit;
  }
  const original = answerUnit(contract);
  const report = original?.status === 'passed' ? parseCompletionReportParts(original.answer ?? '')?.report : undefined;
  return typeof report?.finalAnswer === 'string' && report.finalAnswer.trim() ? original : undefined;
}

/** The contract's answer: its result, accompanying prose, summary, or unstructured answer. */
export function renderContractAnswer(contract: Pick<Contract, 'units' | 'groups'>): string {
  const finalUnit = finalAnswerUnit(contract);
  const finalReport = finalUnit ? parseCompletionReportParts(finalUnit.answer ?? '')?.report : undefined;
  if (typeof finalReport?.finalAnswer === 'string') return finalReport.finalAnswer.trim();
  const raw = (answerUnit(contract)?.answer ?? '').trim();
  if (raw.length === 0) return '';
  const parts = parseCompletionReportParts(raw);
  const report = parts?.report;
  // Reviews and research carry their findings in result. Returning only the
  // summary loses the file references and evidence the caller requested.
  const result = report && 'result' in report && typeof report.result === 'string' ? report.result.trim() : '';
  if (result.length > 0) return result;
  if (parts?.body.length) return parts.body;
  const summary = report?.summary?.trim();
  return summary !== undefined && summary.length > 0 ? summary : raw;
}

/**
 * What the deliverable judge reads as the output: the deliverable unit's final
 * output as recorded when it passed, then the answers of the units that fixed
 * the deliverable. These reports accompany the actual answer as evidence;
 * they cannot substitute for a missing answer in the deliverable check.
 * Empty when nothing was recorded: the judge then reads the diff and gates
 * alone, and code never states in its evidence that the work succeeded.
 */
export function deliverableOutput(contract: Pick<Contract, 'units' | 'groups'>): string {
  const deliverableFixes = new Set(contract.groups.filter((group) => group.kind === 'fix' && group.repairs?.scope === 'deliverable').map((group) => group.id));
  const parts = [
    (answerUnit(contract)?.answer ?? '').trim(),
    ...contract.units.filter((unit) => deliverableFixes.has(unit.groupId)).map((unit) => {
      const answer = (unit.answer ?? '').trim();
      return answer.length === 0 ? '' : `Fix ${unit.id} "${unit.title}":\n${answer}`;
    }),
  ];
  return parts.filter((part) => part.length > 0).join('\n\n');
}

const unitList = (ids: readonly string[]): string => `unit${ids.length === 1 ? '' : 's'} ${ids.join(', ')}`;

/**
 * How the units' work was checked, when the decision model could not judge
 * some of it: which units were judged and passed, which were delivered but
 * not judged and why, which were not delivered, and where the work is. Empty
 * when every unit's last check was judged (or no decision model is in use),
 * so an ordinary result says nothing more.
 */
export function unitCheckingLines(contract: Pick<Contract, 'units' | 'isolation' | 'branch' | 'worktreePath'>): string[] {
  const notJudged = new Map<string, string[]>();
  const judged: string[] = [], undelivered: string[] = [];
  for (const unit of contract.units) {
    const last = unit.checks.findLast((check) => check.trigger !== 'turn-end');
    if (last?.notJudged !== undefined) notJudged.set(last.notJudged, [...(notJudged.get(last.notJudged) ?? []), unit.id]);
    else if ((unit.status === 'passed' || unit.status === 'held-merge') && (last?.decisionIds.length ?? 0) > 0) judged.push(unit.id);
    else if (unit.status === 'failed' || unit.status === 'cancelled') undelivered.push(`${unit.id} (${unit.status}${unit.failureReason === undefined ? '' : `: ${unit.failureReason}`})`);
  }
  if (notJudged.size === 0) return [];
  return [
    ...(judged.length > 0 ? [`Judged and passed: ${unitList(judged)}.`] : []),
    ...[...notJudged].map(([reason, ids]) => `Delivered but not judged: ${unitList(ids)}; the decision model could not judge ${ids.length === 1 ? 'it' : 'them'} (${reason}). The work is kept as delivered.`),
    ...(undelivered.length > 0 ? [`Not delivered: ${undelivered.join(', ')}.`] : []),
    contract.isolation === 'worktree' && contract.branch !== undefined
      ? `The work is on branch ${contract.branch}${contract.worktreePath === undefined ? '' : ` (worktree ${contract.worktreePath})`}.`
      : 'The work is in the working tree.',
  ];
}

/**
 * The commit outcome as one honest line: a real commit (with any ignored
 * paths it skipped), or which of the "nothing was committed" cases happened.
 */
export function describeCommitOutcome(headHash: string | null, skippedIgnored: readonly string[], nothingChanged: boolean): string {
  const ignoredNote = skippedIgnored.length > 0 ? `${skippedIgnored.length} ignored path${skippedIgnored.length === 1 ? '' : 's'} skipped` : null;
  if (headHash) {
    const shortHash = headHash.slice(0, 8);
    return ignoredNote ? `committed ${shortHash} (${ignoredNote})` : `committed ${shortHash}`;
  }
  if (ignoredNote) return `commit skipped: ${ignoredNote}`;
  if (nothingChanged) return 'commit skipped: the contract changed no files';
  return 'commit skipped: nothing to stage';
}

/**
 * The status line for operator surfaces: `Contract {id} passed ({met} of
 * {judged} criteria met, {n} corrections{, n excluded}); {commit note}`.
 */
export function describeContractOutcome(contract: Pick<Contract, 'id' | 'criteria' | 'units' | 'commit'> & Partial<Pick<Contract, 'checks'>>): string {
  const judged = contract.criteria.filter((criterion) => criterion.disposition === 'judged');
  const met = judged.filter((criterion) => criterion.status === 'met').length;
  const last = contract.checks?.at(-1);
  // A result no decision model read was accepted by the owner: its criteria were not checked.
  if (last !== undefined && last.decisionIds.length === 0 && last.goal.outcome === 'confirm') {
    const commit = contract.commit === undefined ? '' : `; ${contract.commit.note}`;
    return `Contract ${contract.id} accepted by the owner (${judged.length} criteri${judged.length === 1 ? 'on' : 'a'} not independently checked: no decision model was in use)${commit}`;
  }
  const nudges = contract.units.flatMap((unit) => [unit, ...(unit.attemptUnits ?? [])]).reduce((total, unit) => total + unit.nudges.length, 0);
  const excluded = contract.criteria.filter((criterion) => criterion.disposition === 'excluded').length;
  const parts = [
    `${met} of ${judged.length} criteri${judged.length === 1 ? 'on' : 'a'} met`,
    `${nudges} correction${nudges === 1 ? '' : 's'}`,
    ...(excluded > 0 ? [`${excluded} excluded: requires an agent arrangement`] : []),
  ];
  const commit = contract.commit === undefined ? '' : `; ${contract.commit.note}`;
  return `Contract ${contract.id} passed (${parts.join(', ')})${commit}`;
}
