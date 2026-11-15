import { activateClassicFallback, decisionOrClassic } from '../../runtime/decision-policy.js';
import { captureJudgmentPort, DecisionModelsDisabledError, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput, captureOwnedJson, JudgmentInputError } from '../../gate/judgment-input.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/native-error-summary.js';
import { homeGraphPagePriority } from './batteries/page-priority.js';
import type { KnowledgeStore } from '../store.js';
import { knowledgePageCandidateRepresentation } from '../source-structural-references.js';

export class HomeGraphPagePriorityHeldError extends Error {
  constructor(readonly reason: 'unavailable' | 'uncertain' | 'stale' | 'aborted' | 'budget') {
    super(`Home Graph page priority held: ${reason}.`);
  }
}

/**
 * Orders candidates by the priority reading, best first. The order is a
 * preference, never a precondition: a candidate whose reading does not settle
 * keeps its catalog place after the settled ones, and with no model (missing,
 * unreachable or off) the catalog order stands. Only a cancelled call throws.
 */
export async function rankHomeGraphPageCandidates<T>(input: PagePriorityInput<T>): Promise<readonly T[]> {
  return (await readHomeGraphPagePriorities(input)).map((row) => row.candidate);
}

interface PagePriorityInput<T> {
  readonly candidates: readonly T[];
  readonly content: (candidate: T) => object;
  readonly purpose: string;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly store?: KnowledgeStore | undefined;
}

/** {@link rankHomeGraphPageCandidates} with each settled probability, for a caller that stores it. */
export async function readHomeGraphPagePriorities<T>(input: PagePriorityInput<T>): Promise<readonly { readonly candidate: T; readonly probability?: number }[]> {
  const signal = input.signal, callerCurrent = input.assertCurrent, store = input.store;
  assertJudgmentInput({ purpose: input.purpose, candidates: input.candidates.map((candidate) => knowledgePageCandidateRepresentation(store, candidate)) });
  const content = input.candidates.map(candidate => captureOwnedJson(input.content(candidate)));
  assertJudgmentInput(content);
  const check = () => {
    if (signal?.aborted) throw new HomeGraphPagePriorityHeldError('aborted');
    callerCurrent?.();
  };
  check();
  const catalog = () => input.candidates.map((candidate) => ({ candidate }));
  if (!content.length) return [];
  const candidates = content.map((value, index) => {
    if (!value || typeof value !== 'object') throw new JudgmentInputError('unsupported-input');
    return { id: `page-${index + 1}`, content: toJson(value) };
  });
  return decisionOrClassic(async () => {
    let authority: ReturnType<typeof captureJudgmentPort>;
    try { authority = captureJudgmentPort(homeGraphPagePriority.name, { ...(signal ? { signal } : {}), assertCurrent: check }); }
    catch (error) {
      if (error instanceof DecisionModelsDisabledError || activateClassicFallback(error)) throw error;
      check();
      if (error instanceof JudgmentPortMissingError) return catalog();
      throw error;
    }
    let result: Awaited<ReturnType<typeof homeGraphPagePriority.rerank>>;
    try {
      result = await homeGraphPagePriority.rerank(authority.port, input.purpose as JsonValue, candidates, {
        site: homeGraphPagePriority.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
      });
    } catch (error) {
      if (error instanceof DecisionModelsDisabledError || activateClassicFallback(error)) throw error;
      check();
      logger.warn('Home Graph page priority could not be read; keeping catalog order', { error: summarizeError(error) });
      return catalog();
    }
    check();
    const byId = new Map(input.candidates.map((candidate, index) => [`page-${index + 1}`, { candidate, index }]));
    const settled = new Map(result.ranked.filter((row) => row.reading.outcome === 'act' && row.reading.verdict !== 'uncertain')
      .map((row) => [row.id, row.probability]));
    return [...byId.entries()].map(([id, row]) => ({ ...row, probability: settled.get(id) }))
      .sort((left, right) => (right.probability ?? -1) - (left.probability ?? -1) || left.index - right.index)
      .map((row) => row.probability === undefined ? { candidate: row.candidate } : { candidate: row.candidate, probability: row.probability });
  }, () => {
    check();
    return catalog();
  });
}
