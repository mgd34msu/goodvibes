import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { captureOwnedJson, retainOwnedJson, type RetainedOwnedJson } from '../gate/judgment-input.js';
import type { ContractRunner } from '../contract/runner.js';
import { isTerminalContractStatus } from '../contract/types.js';
import type { ContractView } from '../contract/types.js';
import { hashState } from '@goodvibes-jev/judgment';
import { goalObligationSource } from '../contract/goal-obligation-proof.js';
import { originalObligationSource } from '../contract/batteries/original-obligation-coverage.js';

// Process-local provenance: copied tool JSON cannot mint a native work receipt.
// These are work checkpoints, never final-response publication permits.
const nativeWorkReceipts = new WeakMap<object, RetainedOwnedJson>();
const applyReceipt = Reflect.apply, receiptGet = WeakMap.prototype.get, receiptSet = WeakMap.prototype.set, receiptDelete = WeakMap.prototype.delete;
export function isNativeCompletedWorkReceipt(original: unknown, admitted: unknown): boolean {
  if (!original || typeof original !== 'object') return false;
  const retained = applyReceipt(receiptGet, nativeWorkReceipts, [original]) as RetainedOwnedJson | undefined;
  if (!retained) return false;
  try { retained.assertCurrent(); }
  catch { applyReceipt(receiptDelete, nativeWorkReceipts, [original]); return false; }
  try { return isDeepStrictEqual(retained.snapshot, captureOwnedJson(admitted, nodeTypes.isProxy)); }
  catch { return false; }
}

function recordedReview(contract: ContractView, target: 'final-answer-review' | 'goal-obligations' | 'original-obligations', answerDigest: () => string | null) {
  const decision = contract.decisions.findLast(entry => entry.targetId === `${contract.id}.${target}`);
  if (!decision) return null;
  try {
    const receipt: unknown = JSON.parse(decision.reason);
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
    const record = receipt as Record<string, unknown>;
    const ids = (value: unknown) => Array.isArray(value) && value.length > 0 && value.every(id => typeof id === 'string' && id.length > 0);
    const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
    const version = (value: unknown) => object(value) && typeof value.name === 'string' && value.name.length > 0
      && Number.isSafeInteger(value.version) && (value.version as number) > 0;
    const reading = (value: unknown) => object(value) && typeof value.probability === 'number' && Number.isFinite(value.probability)
      && value.probability >= 0 && value.probability <= 1 && typeof value.verdict === 'string' && typeof value.outcome === 'string';
    const policy = object(record.policy) ? record.policy : null;
    // Native execution has an independent log-input verifier. Ordinary host
    // reviews do not; their unused state commitment is absent on new receipts.
    // Actual saved older bound receipts remain valid in either mode.
    const inputBinding = Object.hasOwn(record, 'stateHash') ? digest(record.stateHash) : contract.nativeSource === undefined;
    const wellFormed = typeof record.passed === 'boolean' && digest(record.outputDigest) && inputBinding
      && ids(record.decisionIds) && policy !== null
      && (target === 'final-answer-review'
        ? record.schemaVersion === 2 && (!Object.hasOwn(record, 'evidenceDigest') || digest(record.evidenceDigest)) && ids(record.fulfillmentDecisionIds)
          && version(policy.fulfillment) && version(policy.content) && ['high', 'critical'].includes(String(policy.stakes))
          && object(record.readings) && reading(record.readings.unfinished) && reading(record.readings.unsupported)
        : target === 'original-obligations'
          ? ((record.schemaVersion === 1 && digest(record.evidenceDigest))
              || (record.schemaVersion === 2 && !Object.hasOwn(record, 'evidenceDigest')))
            && version(policy) && digest(record.sourceDigest)
            && object(record.reading) && reading(record.reading) && record.passed === (record.reading.verdict === 'no')
            && ids(decision.decisionIds) && JSON.stringify(record.decisionIds) === JSON.stringify(decision.decisionIds)
            && decision.decisionIds.every(id => contract.checks.at(-1)?.decisionIds.includes(id))
          : record.schemaVersion === 1 && version(policy) && digest(record.literalSourceDigest) && ids(record.sourceJudgmentDecisionIds)
            && reading(record.reading) && reading(record.sourceGoal));
    return { record, recordedDecisionId: decision.id, wellFormed,
      matchesSavedAnswer: wellFormed && record.outputDigest === answerDigest(),
      ...(target === 'goal-obligations' ? { matchesOriginalScope: wellFormed && record.literalSourceDigest === hashState(goalObligationSource(contract)) } : {}),
      ...(target === 'original-obligations' ? { matchesOriginalScope: wellFormed && record.sourceDigest === hashState(originalObligationSource(contract)) } : {}),
      meaning: 'Exact saved native Jev receipt with host-computed bindings. A mismatched or rejected receipt is not acceptance. A matching passed receipt establishes review of that saved result under its recorded policy; it grants no current final-response permit.' };
  } catch { return null; }
}

/** Runtime observations from this session, including terminal work which the
 * active-contract list intentionally omits. These are scoped receipts, never a
 * permit to publish another answer or evidence about unrelated work. */
export function completedContractEvidence(runner: Pick<ContractRunner, 'list'>, sessionId: string, projectRoot?: string) {
  return runner.list({ sessionId, includeTerminal: true, includeInputSnapshot: false })
    .filter(contract => contract.sessionId === sessionId && isTerminalContractStatus(contract.status))
    .map(contract => {
      // Actual saved receipts independently bind this one original answer.
      // Hash only when a well-formed receipt needs comparison, once for this
      // observation. The complete answer itself is already returned below.
      const answer = contract.answer;
      let retainedAnswerDigest: string | undefined;
      const answerDigest = () => typeof answer === 'string' ? retainedAnswerDigest ??= hashState(answer) : null;
      const originalObligationCoverage = recordedReview(contract, 'original-obligations', answerDigest);
      const hasOriginalObligationCoverage = contract.decisions.some(decision => decision.targetId === `${contract.id}.original-obligations`);
      const work = {
      kind: 'host-completed-contract', id: contract.id, sessionId: contract.sessionId,
      projectRoot: contract.projectRoot, ask: contract.ask, goal: contract.goal,
      status: contract.status, completedAt: contract.completedAt ?? null,
      originalGoal: contract.originalSource?.goal ?? contract.nativeSource?.goal ?? contract.goal,
      originalCriteria: contract.originalSource?.criteria ?? contract.nativeSource?.criteria ?? null,
      criteria: contract.criteria.map(criterion => ({ id: criterion.id, text: criterion.text,
        quote: criterion.quote ?? null, disposition: criterion.disposition,
        dispositionReason: criterion.dispositionReason ?? null, status: criterion.status,
        reading: criterion.readings.at(-1) ?? null })),
      finalCheck: contract.checks.at(-1) ?? null,
      contentReview: recordedReview(contract, 'final-answer-review', answerDigest),
      goalCoverage: recordedReview(contract, 'goal-obligations', answerDigest),
      ...(originalObligationCoverage ? { originalObligationCoverage } : {}),
      units: contract.units.map(unit => ({ id: unit.id, goal: unit.goal, status: unit.status,
        check: unit.checks.at(-1) ?? null })),
      answer: answer ?? null, publication: contract.commit ?? null,
      error: contract.error ?? null, failureKind: contract.failureKind ?? null,
      meaning: 'Actual terminal runtime record for this identified contract and original scope. Its checks describe the saved work, not current final-response approval. A passed status alone does not establish unsupported new claims, current artifact contents, successful publication or unrelated work. Failed/cancelled checks and publication failures remain evidence. Compare the current response and original request with the exact recorded scope, checks, answer, publication and any later invalidating observations.',
      };
      if (projectRoot && projectRoot === work.projectRoot && work.status === 'passed' && work.finalCheck?.result === 'pass'
        && work.contentReview?.wellFormed && work.contentReview.matchesSavedAnswer && work.contentReview.record.passed === true
        && ((work.originalObligationCoverage?.wellFormed && work.originalObligationCoverage.matchesSavedAnswer && work.originalObligationCoverage.matchesOriginalScope
          && work.originalObligationCoverage.record.passed === true)
          || (!hasOriginalObligationCoverage && work.goalCoverage?.wellFormed && work.goalCoverage.matchesSavedAnswer && work.goalCoverage.matchesOriginalScope
            && work.goalCoverage.record.passed === true))
        && ['applied', 'committed'].includes(String(work.publication?.status)))
        applyReceipt(receiptSet, nativeWorkReceipts, [work, retainOwnedJson(work, nodeTypes.isProxy)]);
      return work;
    });
}
