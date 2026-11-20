import { judgmentPort, JudgmentPortMissingError, DecisionModelsDisabledError } from '@goodvibes/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes/judgment';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { activateClassicFallback, decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { freezeSupport } from '../semantic/verification/projection.js';
import { nodeServingWithoutReview } from './battery.js';
import { KnowledgeNodeActivationHeldError as Held, NODE_ACTIVATION_LIMITS as LIMITS,
  type KnowledgeNodeActivationOptions, type NodeActivationReading, type NodeActivationReason, type NodeActivationRequest } from './types.js';

/** Native pending state, with no model, probability, battery or decision receipt. */
export function classicNodeActivation(): NodeActivationReading {
  return { outcome: 'pending-review', reason: 'decision-model-disabled', operationProvenance: 'classic', semanticAssessment: 'not-evaluated' };
}
function failureReason(error: unknown): NodeActivationReason {
  if (error instanceof Held) return error.reason;
  if (error instanceof JudgmentPortMissingError) return 'unconfigured';
  if (error instanceof JudgmentError) return error.kind === 'invalid-response' ? 'malformed' : error.kind;
  return 'internal';
}
function checkedPort(port: JudgmentPort, current: () => void): JudgmentPort {
  const model = port.model, ask = port.ask, recorder = port.recorder;
  const check = () => {
    current();
    if (port.model !== model || port.ask !== ask || port.recorder !== recorder
      || !isClassicOperation() && judgmentPort(nodeServingWithoutReview.name) !== port) throw new Held('stale');
  };
  return { ...port, model, async ask(request) {
    check();
    // A sibling reading's model failure switched this operation to running without
    // a model (Hybrid): no request is sent, and decisionOrClassic below answers
    // with the pending-review reading, so the knowledge waits for the owner's review.
    if (isClassicOperation()) throw new DecisionModelsDisabledError('automatic knowledge serving without owner review');
    const result = await port.ask(request);
    check();
    const answer = result?.answers?.serve;
    if (!answer || answer.type !== 'noul' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1
      || typeof result.model !== 'string' || !result.model.trim() || typeof result.requestedModel !== 'string' || !result.requestedModel.trim()
      || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    return result;
  } };
}
/**
 * One pass over projected readings. Each input was built and privacy-scanned by
 * `projectNodeActivation` within its size limits; an input that carries a
 * reason holds without a request.
 */
export async function readNodeActivations(inputs: readonly NodeActivationRequest[], options: KnowledgeNodeActivationOptions = {}): Promise<readonly NodeActivationReading[]> {
  return withConfiguredDecisionModelPolicy(() => readOwnedNodeActivations(inputs, options));
}
function heldReading(input: NodeActivationRequest, reason: NodeActivationReason): NodeActivationReading {
  return { outcome: 'pending-review', reason, ...(input.detail ? { detail: input.detail } : {}), ...(input.omitted ? { omitted: input.omitted } : {}) };
}
async function readOwnedNodeActivations(snapshots: readonly NodeActivationRequest[], options: KnowledgeNodeActivationOptions): Promise<readonly NodeActivationReading[]> {
  const signal = options.signal, assertCurrent = options.assertCurrent;
  let retired = false;
  const callerCurrent = () => {
    if (signal?.aborted) throw new Held('aborted');
    if (retired) throw new Held('stale');
    try {
      isClassicOperation(); // Revalidate the operation's pinned host policy as well as its caller.
      if (options.signal !== signal || options.assertCurrent !== assertCurrent) throw new Held('stale');
      assertSynchronousJudgmentGuard(assertCurrent, () => new Held('stale'));
    } catch { retired = true; throw new Held('stale'); }
    if (signal?.aborted) throw new Held('aborted');
  };
  callerCurrent();
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > LIMITS.timeoutMs)) throw new Held('budget');
  if (isClassicOperation()) {
    callerCurrent();
    return freezeSupport(snapshots.map(input => ({ ...classicNodeActivation(), ...(input.reason ? { reason: input.reason } : {}), ...(input.detail ? { detail: input.detail } : {}) })));
  }
  if (!snapshots.length) return [];
  const controller = new AbortController();
  let failure: Held | undefined, rejectStop: (error: Held) => void = () => {};
  const stopped = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
  const stop = (error: Held) => { failure ??= error; controller.abort(); rejectStop(failure); };
  const abort = () => stop(new Held('aborted'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs === undefined || timeoutMs === 0 ? undefined : setTimeout(() => stop(new Held('budget')), timeoutMs);
  const check = () => { if (failure) throw failure; if (controller.signal.aborted) throw new Held('aborted'); callerCurrent(); };
  async function run(): Promise<readonly NodeActivationReading[]> {
    check();
    let port: JudgmentPort | undefined, unavailable: NodeActivationReason | undefined;
    if (!isClassicOperation() && snapshots.some((input) => !input.reason)) {
      let raw: JudgmentPort | undefined;
      try { raw = judgmentPort(nodeServingWithoutReview.name); }
      catch (error) {
        check();
        if (!(error instanceof DecisionModelsDisabledError && isClassicOperation()) && !activateClassicFallback(error)) unavailable = failureReason(error);
      }
      if (raw) {
        try { port = checkedPort(raw, check); }
        catch (error) { check(); unavailable = error instanceof Held ? error.reason : 'malformed'; }
      }
    }
    const readings: NodeActivationReading[] = []; let next = 0;
    await Promise.all(Array.from({ length: Math.min(LIMITS.concurrency, snapshots.length) }, async () => {
      while (next < snapshots.length) {
        check(); const index = next++, input = snapshots[index]!;
        if (input.reason || unavailable) { readings[index] = heldReading(input, input.reason ?? unavailable!); continue; }
        try {
          readings[index] = await decisionOrClassic<NodeActivationReading>(async () => {
            check();
            const read = await nodeServingWithoutReview.run(port!, input.state, { signal: controller.signal, site: nodeServingWithoutReview.name, beforeAttempt: check });
            check(); const reading = read.readings.serve;
            const accepted = reading.outcome === 'act' && reading.verdict === 'yes';
            const result: NodeActivationReading = { outcome: accepted ? 'accepted' : 'pending-review',
              ...(!accepted ? { reason: reading.outcome === 'act' && reading.verdict === 'no' ? 'no' as const : 'uncertain' as const } : {}),
              ...(input.omitted ? { omitted: input.omitted } : {}),
              probability: reading.probability, decisionId: read.result.decisionId, model: read.result.model, requestedModel: read.result.requestedModel };
            read.recordAction(accepted ? 'prepared automatic serving judgment; exact write guard still required; no operator authority or taint removal'
              : 'held for review; no serving authority');
            check(); return result;
          }, () => { check(); return classicNodeActivation(); }, () => { check(); return true; });
        } catch (error) {
          check();
          const reason = failureReason(error);
          if (reason === 'aborted' || reason === 'stale' || reason === 'budget') throw new Held(reason);
          readings[index] = heldReading(input, reason);
        }
      }
    }));
    check(); return freezeSupport(readings);
  }
  try { return await Promise.race([run(), stopped]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); }
}
