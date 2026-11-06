import { activateClassicFallback, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { categoryForCode, categoryForStatus, failureState, GoodVibesSdkError, isKnownErrorCode, judgmentPort, JudgmentPortMissingError, DecisionModelsDisabledError } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { isKnowledgeSourceQualityFailure } from '../source-quality.js';
import { repairFailureCause } from './self-improvement-failure-battery.js';
import { KnowledgeRepairBudgetError } from './self-improvement-budget.js';
import { isOwnedSupportBudgetExpiry } from './support-budget.js';

const SITE = 'knowledge.self-improvement.failure-cause';
const CAUSES = ['request_timeout', 'run_budget', 'other', 'unknown'] as const;
type Cause = 'request_timeout' | 'run_budget' | 'other' | 'unknown';
export interface RepairFailureConclusion {
  readonly operationProvenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated';
  readonly cause: Cause;
  readonly basis: string;
  readonly outcome?: string;
  readonly decisionId?: string;
  readonly retries?: number;
  readonly isCurrent: () => boolean;
  readonly isOwnerCurrent: () => boolean;
}
function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  // Do not execute getters supplied by a thrown object.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
function structuralCause(error: unknown): { cause: Cause; basis: string } | undefined {
  if (error instanceof KnowledgeRepairBudgetError) return { cause: 'run_budget', basis: 'owned-timer' };
  if (isOwnedSupportBudgetExpiry(error)) return { cause: 'run_budget', basis: 'owned-support-timer' };
  // A failed/unsettled judgment is not evidence of the repair's budget cause.
  if (isKnowledgeSourceQualityFailure(error)) return { cause: 'other', basis: 'typed-judgment-hold' };
  if (error instanceof GoodVibesSdkError && error.category !== 'unknown') {
    return { cause: error.category === 'timeout' ? 'request_timeout' : 'other', basis: 'typed-category' };
  }
  const status = [field(error, 'status'), field(error, 'statusCode')]
    .find((value): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599);
  if (status !== undefined) return { cause: categoryForStatus(status) === 'timeout' ? 'request_timeout' : 'other', basis: 'http-status' };
  for (const candidate of [error, field(error, 'cause')]) {
    const code = field(candidate, 'code');
    if (typeof code !== 'string') continue;
    if (code === 'TIMEOUT' || code === 'AGENT_TIMEOUT') return { cause: 'request_timeout', basis: 'sdk-timeout-code' };
    const category = categoryForCode(code);
    if (category !== undefined) return { cause: category === 'timeout' ? 'request_timeout' : 'other', basis: 'error-code' };
    if (code !== 'UNKNOWN' && isKnownErrorCode(code)) return { cause: 'other', basis: 'sdk-error-code' };
  }
  if (error instanceof DOMException) return { cause: error.name === 'TimeoutError' ? 'request_timeout' : 'other', basis: 'dom-exception' };
  return undefined;
}

/** Capture the composition before repair yields. Never borrow a later owner's port or memo. */
export function captureRepairFailureReader(options: { readonly signal?: AbortSignal | undefined; readonly deadlineAt: number; readonly shouldStop: () => boolean; readonly ownerStopped?: () => boolean }) {
  const signal = options.signal, shouldStop = options.shouldStop, stopped = options.ownerStopped, deadlineAt = options.deadlineAt;
  let classic = isClassicOperation();
  const classicNow = () => { classic = isClassicOperation() || classic; return classic; };
  const ownerStopped = () => signal?.aborted === true || (stopped ?? shouldStop)();
  const nativeOwnerCurrent = () => options.signal === signal && options.shouldStop === shouldStop
    && options.ownerStopped === stopped && options.deadlineAt === deadlineAt && !ownerStopped();
  let port: JudgmentPort | undefined;
  let model: string | undefined;
  let missing: JudgmentPortMissingError | undefined;
  if (!classic) {
    try { port = judgmentPort(SITE); } catch (error) { if (error instanceof JudgmentPortMissingError) missing = error; }
    try { model = port?.model; } catch { /* A local metadata fault is never provider availability exhaustion. */ }
  }
  const ownerCurrent = () => {
    try {
      if (!nativeOwnerCurrent()) return false;
      if (classicNow()) return true;
    } catch { return false; }
    try {
      const current = judgmentPort(SITE);
      return current === port && current.model === model;
    } catch (error) { return error instanceof JudgmentPortMissingError && port === undefined; }
  };
  return async (error: unknown): Promise<RepairFailureConclusion> => withConfiguredDecisionModelPolicy(async () => {
    classicNow();
    const provenance = () => classic ? { operationProvenance: 'classic' as const, semanticAssessment: 'not-evaluated' as const } : {};
    let structural: ReturnType<typeof structuralCause>;
    try { structural = structuralCause(error); }
    catch { return { ...provenance(), cause: 'unknown', basis: 'unreadable-structure', isCurrent: () => ownerCurrent() && !shouldStop(), isOwnerCurrent: ownerCurrent }; }
    if (structural) return { ...structural, ...provenance(), isCurrent: () => ownerCurrent() && !shouldStop(), isOwnerCurrent: ownerCurrent };
    let retries = 0;
    const current = () => !shouldStop() && ownerCurrent();
    const unresolved = (basis: string): RepairFailureConclusion => ({ ...provenance(), cause: 'unknown', basis, retries, isCurrent: current, isOwnerCurrent: ownerCurrent });
    if (ownerStopped()) return unresolved('cancelled');
    if (!nativeOwnerCurrent()) return unresolved('stale');
    if (classicNow()) return unresolved('classic-not-evaluated');
    if (!port) {
      if (missing && current() && activateClassicFallback(missing)) { classic = true; return unresolved('classic-not-evaluated'); }
      return unresolved('unconfigured');
    }
    if (!current()) return unresolved('stale');
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return unresolved('reading-budget-unavailable');
    const controller = new AbortController();
    let rejectStopped: (error: Error) => void = () => {};
    const interrupted = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    let stopReason: string | undefined;
    const stop = (reason: string) => { stopReason = reason; controller.abort(); rejectStopped(new Error(reason)); };
    const abort = () => stop('cancelled');
    signal?.addEventListener('abort', abort, { once: true });
    const timer = Number.isFinite(remaining) ? setTimeout(() => stop('reading-budget-unavailable'), remaining) : undefined;
    timer?.unref?.();
    const beforeAttempt = () => {
      if (!current() || controller.signal.aborted || Date.now() >= deadlineAt) throw new Error('Failure reading is no longer current');
      if (classicNow()) throw new DecisionModelsDisabledError('semantic repair failure cause');
    };
    try {
      const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Failure carries no textual cause.';
      const evidence = { message };
      assertJudgmentInput(evidence); // Complete wording before shared bounded projection.
      beforeAttempt();
      const owned = port;
      const checked: JudgmentPort = { ...owned, model: owned.model, async ask(request) {
        beforeAttempt();
        const result = await owned.ask(request);
        if (!current() || controller.signal.aborted || Date.now() >= deadlineAt) throw new Error('Failure reading is no longer current');
        const answer = result.answers.cause;
        if (!answer || answer.type !== 'choice' || !CAUSES.includes(answer.choice as Cause)
          || !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1
          || !answer.probabilities || !CAUSES.every((cause) => Number.isFinite(answer.probabilities[cause])
            && answer.probabilities[cause]! >= 0 && answer.probabilities[cause]! <= 1)
          || typeof result.model !== 'string' || !result.model.trim()
          || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
          || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Error('Malformed failure reading');
        return result;
      } };
      const run = await Promise.race([interrupted, repairFailureCause.run(checked, failureState(evidence), {
        site: SITE, signal: controller.signal, beforeAttempt, onRetry: () => { retries++; },
      })]);
      if (!current()) { run.recordAction('discarded: failure reading owner or gap changed'); return unresolved('stale'); }
      if (controller.signal.aborted || Date.now() >= deadlineAt) return unresolved('reading-budget-unavailable');
      const reading = run.readings.cause;
      const cause = reading.outcome === 'act' ? reading.choice : 'unknown';
      run.recordAction(cause === 'request_timeout' || cause === 'run_budget' ? `cause established: ${cause}; existing owner decides deferral` : 'no budget deferral established');
      return { cause, basis: 'reading', outcome: reading.outcome, ...(run.result.decisionId ? { decisionId: run.result.decisionId } : {}), retries, isCurrent: current, isOwnerCurrent: ownerCurrent };
    } catch (error) {
      if (stopReason) return unresolved(stopReason);
      if (!current()) return unresolved('stale');
      if (classicNow() || activateClassicFallback(error)) { classic = true; return unresolved('classic-not-evaluated'); }
      return unresolved('unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
    }
  });
}
