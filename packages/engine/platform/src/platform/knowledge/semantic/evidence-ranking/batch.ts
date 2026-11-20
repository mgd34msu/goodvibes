import { judgmentPort, JudgmentPortMissingError } from '@goodvibes/engine/errors';
import { withAnswerVerificationBudget } from '../answer-verification/budget.js';
import { KnowledgeAnswerQualityHeldError } from '../answer-verification/types.js';
import { freezeSupport } from '../verification/projection.js';
import { prepareAnswerEvidenceRelevance, snapshotAnswerEvidenceRelevanceInput } from './reader.js';
import { EVIDENCE_RELEVANCE_LIMITS as LIMITS, KnowledgeEvidenceRelevanceHeldError as Held,
  type AnswerEvidenceCandidate, type AnswerEvidenceRelevanceInput, type AnswerEvidenceRelevancePlan,
  type AnswerEvidenceRelevanceReading } from './types.js';

/** Whole candidates only, validated and copied once. Each reader input keeps
 * the existing 100-row and 160k-character bounds; the corpus is never cut.
 */
function prepareBatches(input: AnswerEvidenceRelevanceInput) {
  const snapshot = snapshotAnswerEvidenceRelevanceInput(input);
  const head = { query: snapshot.query, ...(snapshot.subjects ? { subjects: snapshot.subjects } : {}) };
  const baseCharacters = JSON.stringify({ ...head, candidates: [] }).length;
  const batches: AnswerEvidenceRelevanceInput[] = [];
  const ordinals = new Map<string, number>();
  let candidates: AnswerEvidenceCandidate[] = [], characters = baseCharacters;
  const flush = () => { if (candidates.length) batches.push(freezeSupport({ ...head, candidates })); candidates = []; characters = baseCharacters; };
  snapshot.candidates.forEach((candidate, index) => {
    ordinals.set(candidate.reference, index);
    const length = JSON.stringify(candidate).length;
    if (candidates.length === 100 || characters + length + (candidates.length ? 1 : 0) > 160_000) flush();
    characters += length + (candidates.length ? 1 : 0);
    candidates.push(candidate);
  });
  flush();
  return { batches, ordinals, query: snapshot.query };
}

/** Reuses the same reading and transport. Its actual requests contain one
 * candidate, query and subjects, never batch peers: batching cannot alter the
 * question, and same-model probabilities retain one stable global ordering.
 */
export async function prepareAnswerEvidenceRelevanceBatches(input: AnswerEvidenceRelevanceInput, options: {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly observeVerdict?: ((verdict: 'yes' | 'no') => void) | undefined;
} = {}): Promise<AnswerEvidenceRelevancePlan> {
  try {
    return await withAnswerVerificationBudget(async (signal, deadlineAt) => {
      const prepared = prepareBatches(input);
      const active = () => {
        if (signal.aborted) throw new Held('aborted');
        if (Date.now() >= deadlineAt) throw new Held('budget');
        options.assertCurrent?.();
      };
      active();
      if (!prepared.query.trim() || !prepared.batches.length) return freezeSupport({ accepted: [], rejected: [] });
      const configured = judgmentPort('engine.knowledge.answer-evidence-relevance'), configuredModel = configured.model;
      const check = () => {
        active();
        if (judgmentPort('engine.knowledge.answer-evidence-relevance') !== configured || configured.model !== configuredModel) throw new Held('stale');
      };
      const accepted: AnswerEvidenceRelevanceReading[] = [], rejected: AnswerEvidenceRelevanceReading[] = [], unsettled: string[] = [];
      let model: string | undefined, requestedModel: string | undefined;
      for (const batch of prepared.batches) {
        check();
        const plan = await prepareAnswerEvidenceRelevance(batch, { signal, timeoutMs: Number.isFinite(deadlineAt) ? Math.max(1, deadlineAt - Date.now()) : 0, assertCurrent: check, observeVerdict: options.observeVerdict, validated: true });
        check();
        if ((model !== undefined && model !== plan.model) || (requestedModel !== undefined && requestedModel !== plan.requestedModel)) throw new Held('stale');
        model = plan.model; requestedModel = plan.requestedModel;
        accepted.push(...plan.accepted); rejected.push(...plan.rejected); unsettled.push(...(plan.unsettled ?? []));
      }
      check();
      accepted.sort((a, b) => b.probability - a.probability || prepared.ordinals.get(a.reference)! - prepared.ordinals.get(b.reference)!);
      rejected.sort((a, b) => prepared.ordinals.get(a.reference)! - prepared.ordinals.get(b.reference)!);
      return freezeSupport({ model, requestedModel, accepted, rejected, ...(unsettled.length > 0 ? { unsettled } : {}) });
    }, options.timeoutMs ?? LIMITS.defaultTimeoutMs, options.signal);
  } catch (error) {
    if (error instanceof KnowledgeAnswerQualityHeldError && (error.reason === 'budget' || error.reason === 'aborted')) throw new Held(error.reason, { cause: error });
    if (error instanceof JudgmentPortMissingError) throw new Held('unconfigured', { cause: error });
    throw error;
  }
}
