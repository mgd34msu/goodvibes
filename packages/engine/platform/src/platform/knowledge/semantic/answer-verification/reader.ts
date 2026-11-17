import { requireSemanticKnowledge } from '../../decision-policy.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { checkAnswers, toJson, type JudgmentPort, type YesNoReading, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { freezeSupport } from '../verification/projection.js';
import { answerCandidateQuality, answerEvidenceSufficiency, answerCandidatePreference } from './batteries.js';
import { KnowledgeAnswerQualityHeldError as Held, type AnswerCandidate, type AnswerQualityBoolean,
  type AnswerVerificationInput, type VerifiedAnswerSelection } from './types.js';
export * from './types.js';

export const ANSWER_VERIFICATION_LIMITS = Object.freeze({ evidence: Infinity, candidates: Infinity, characters: Infinity, candidateCharacters: Infinity, timeoutMs: 2_147_483_647 });
function jsonState(value: object): Record<string, JsonValue> {
  const state = toJson(value);
  if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Held('malformed');
  return freezeSupport(state);
}
/** A settled yes/no, or undefined when the reading did not settle (which never withholds the answer by itself). */
function booleanReading(reading: YesNoReading): AnswerQualityBoolean | undefined {
  if (reading.outcome !== 'act' || reading.verdict === 'uncertain') return undefined;
  return { verdict: reading.verdict, probability: reading.probability, outcome: 'act' };
}
function snapshotInput(input: AnswerVerificationInput): AnswerVerificationInput {
  assertJudgmentInput(input);
  if (typeof input.query !== 'string' || !input.query.trim() || !Array.isArray(input.evidence) || !Array.isArray(input.candidates)) throw new Held('malformed');
  if (input.evidence.length > ANSWER_VERIFICATION_LIMITS.evidence || input.candidates.length > ANSWER_VERIFICATION_LIMITS.candidates) throw new Held('budget');
  const references = new Set<string>(), candidates = new Set<string>();
  for (const evidence of input.evidence) {
    if (!evidence || typeof evidence.reference !== 'string' || !/^evidence-[1-9]\d*$/.test(evidence.reference)
      || references.has(evidence.reference) || typeof evidence.text !== 'string'
      || (evidence.title !== undefined && typeof evidence.title !== 'string')) throw new Held('malformed');
    references.add(evidence.reference);
    for (const values of [evidence.facts, evidence.subjects]) if (values !== undefined) {
      if (!Array.isArray(values)) throw new Held('malformed');
      for (const value of values) if (typeof value !== 'string') throw new Held('malformed');
    }
  }
  for (const candidate of input.candidates) {
    if (!candidate || !['generated', 'rendered'].includes(candidate.id) || candidates.has(candidate.id)
      || typeof candidate.text !== 'string' || !candidate.text.trim()) throw new Held('malformed');
    if (candidate.text.length > ANSWER_VERIFICATION_LIMITS.candidateCharacters) throw new Held('budget');
    if (candidate.facts !== undefined) {
      if (!Array.isArray(candidate.facts)) throw new Held('malformed');
      for (const value of candidate.facts) if (typeof value !== 'string') throw new Held('malformed');
    }
    candidates.add(candidate.id);
    for (const match of [candidate.text, ...(candidate.facts ?? [])].join('\n').matchAll(/\[ref:[^\]]*(?:\]|$)/g)) {
      const reference = /^\[ref:(evidence-[1-9]\d*)\]$/.exec(match[0])?.[1];
      if (!reference || !references.has(reference)) throw new Held('malformed');
    }
  }
  const snapshot = { query: input.query, evidence: input.evidence.map(({ reference, title, text, facts, subjects }) => ({ reference, title, text, facts, subjects })),
    candidates: input.candidates.map(({ id, text, facts }) => ({ id, text, facts })) };
  if (JSON.stringify(snapshot).length > ANSWER_VERIFICATION_LIMITS.characters) throw new Held('budget');
  return freezeSupport(structuredClone(snapshot));
}
function validatedPort(port: JudgmentPort): JudgmentPort {
  return { ...port, model: port.model, async ask(request) {
    requireSemanticKnowledge();
    const result = await port.ask(request);
    if (!result?.answers || (result.decisionId !== undefined && (typeof result.decisionId !== 'string' || !result.decisionId.trim()))) throw new Held('malformed');
    try { checkAnswers(request.questions, result.answers); }
    catch { throw new Held('malformed'); }
    return result;
  } };
}
/** Read-only, all-selected-candidate barrier. The caller owns fresh-state validation before gap writes. */
export async function verifyKnowledgeAnswer(input: AnswerVerificationInput,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs?: number | undefined } = {},
): Promise<VerifiedAnswerSelection> {
  requireSemanticKnowledge();
  if (options.signal?.aborted) throw new Held('aborted');
  const snapshot = snapshotInput(input);
  if (!snapshot.evidence.some((row) => row.text.trim())) return freezeSupport({ confidence: 0, quality: { status: 'no-evidence', decisionIds: [] } });
  const timeoutMs = options.timeoutMs;
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > ANSWER_VERIFICATION_LIMITS.timeoutMs)) throw new Held('budget');
  const controller = new AbortController();
  let reason: 'aborted' | 'budget' | undefined;
  const abort = () => { reason ??= 'aborted'; controller.abort(); };
  options.signal?.addEventListener('abort', abort, { once: true });
  const timer = timeoutMs === undefined || timeoutMs === 0 ? undefined : setTimeout(() => { reason ??= 'budget'; controller.abort(); }, timeoutMs);
  let stopRace = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    const stop = () => reject(new Held(reason ?? 'aborted'));
    controller.signal.addEventListener('abort', stop, { once: true });
    stopRace = () => controller.signal.removeEventListener('abort', stop);
  });
  const check = () => { if (controller.signal.aborted || options.signal?.aborted) throw new Held(reason ?? 'aborted'); };
  const run = async (): Promise<VerifiedAnswerSelection> => {
    check(); const port = validatedPort(judgmentPort('engine.knowledge.answer-quality'));
    const settings = { signal: controller.signal, site: 'engine.knowledge.answer-quality' };
    const evidencePromise = answerEvidenceSufficiency.run(port, jsonState({ query: snapshot.query, evidence: snapshot.evidence }), settings);
    const candidatePromises = snapshot.candidates.map(async (candidate) => ({ candidate,
      run: await answerCandidateQuality.run(port, jsonState({ query: snapshot.query, evidence: snapshot.evidence, candidate }), settings),
    }));
    const [evidenceRun, readings] = await Promise.all([evidencePromise, Promise.all(candidatePromises)]);
    check();
    const enough = booleanReading(evidenceRun.readings.enough);
    const decisions = [evidenceRun.result.decisionId, ...readings.map(({ run }) => run.result.decisionId)].filter((id): id is string => id !== undefined);
    // Only the fidelity reading of the answer itself can withhold it. A candidate
    // whose fidelity does not settle is not shown; an unsettled sufficiency or
    // completeness reading only keeps the answer from being called verified.
    let unsettled = enough ? 0 : 1;
    const read = readings.flatMap(({ candidate, run }) => {
      const complete = booleanReading(run.readings.complete);
      if (!complete) unsettled += 1;
      if (run.readings.fidelity.outcome !== 'act') {
        unsettled += 1;
        run.recordAction(`candidate ${candidate.id}: fidelity unsettled; not shown`);
        return [];
      }
      run.recordAction(`candidate ${candidate.id}: ${run.readings.fidelity.choice}; complete=${complete?.verdict ?? 'unsettled'}; no write yet`);
      return [{ candidate, fidelity: run.readings.fidelity, complete }];
    });
    evidenceRun.recordAction(`evidence sufficiency=${enough?.verdict ?? 'unsettled'}; no repair write yet`);
    const supported = read.filter(({ fidelity }) => fidelity.choice === 'supported');
    const complete = supported.filter((candidate) => candidate.complete?.verdict === 'yes');
    const eligible = complete.length ? complete : supported;
    if (!eligible.length) return freezeSupport({ confidence: 0, quality: { status: 'unsupported',
      ...(enough ? { evidenceSufficient: enough } : {}), decisionIds: decisions, ...(unsettled ? { unsettled } : {}) } });
    let selected = [...eligible].sort((left, right) => right.fidelity.confidence - left.fidelity.confidence)[0]!;
    if (eligible.length > 1) {
      check();
      const preference = await answerCandidatePreference.run(port, jsonState({ query: snapshot.query,
        candidates: Object.fromEntries(eligible.map(({ candidate }) => [candidate.id, candidate.text])),
      }), settings);
      check();
      // An unsettled preference keeps the candidate whose fidelity reading is strongest.
      const preferred = preference.readings.preferred.outcome === 'act'
        ? eligible.find(({ candidate }) => candidate.id === preference.readings.preferred.choice) : undefined;
      if (preferred) selected = preferred;
      else unsettled += 1;
      if (preference.result.decisionId) decisions.push(preference.result.decisionId);
      preference.recordAction(`selected verified candidate ${selected.candidate.id}; no write yet`);
    }
    return freezeSupport({ candidate: selected.candidate, confidence: Math.round(selected.fidelity.confidence * 100), quality: {
      status: selected.complete?.verdict === 'yes' && enough?.verdict === 'yes' ? 'verified' : 'partial',
      fidelity: { verdict: selected.fidelity.choice, probability: selected.fidelity.confidence, outcome: selected.fidelity.outcome },
      ...(enough ? { evidenceSufficient: enough } : {}), ...(selected.complete ? { answerComplete: selected.complete } : {}),
      decisionIds: decisions, ...(unsettled ? { unsettled } : {}),
    } });
  };
  try { return await Promise.race([run(), cancelled]); }
  catch (error) { controller.abort(); throw error instanceof Held ? error : new Held('unavailable'); }
  finally { clearTimeout(timer); stopRace(); options.signal?.removeEventListener('abort', abort); }
}
