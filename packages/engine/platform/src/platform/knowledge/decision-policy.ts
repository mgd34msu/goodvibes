import { DecisionModelsDisabledError } from '@goodvibes-jev/engine/errors';
import { activateClassicFallback, isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { selectKnowledgePassages, splitKnowledgePassages } from './passages.js';

/** The words every knowledge result built without a decision model carries, so the user can tell. */
export const KNOWLEDGE_WITHOUT_DECISION_MODEL = 'no decision model is in use, so nothing here was read or checked by one';

/** Bytes of a matched record's text quoted in a keyword answer. */
const KEYWORD_EXCERPT_BYTES = 600;

/** The passages of a matched record's stored text that mention the question's words: the plain form of an excerpt. */
export function knowledgeKeywordExcerpt(text: string, terms: readonly string[]): string {
  if (!text.trim()) return '';
  return selectKnowledgePassages(splitKnowledgePassages([[text]], KEYWORD_EXCERPT_BYTES), terms, KEYWORD_EXCERPT_BYTES)
    .passages.map((passage) => passage.text.trim()).filter(Boolean).join(' ... ');
}

/**
 * The guard of a decision-model reading: no reading starts in an operation that
 * runs without a decision model. Every knowledge feature that reaches a reader
 * takes its own path without a model first ({@link withOrWithoutDecisionModel}),
 * so this only stops a reading that began before a Hybrid fallback in the same
 * operation; that feature's no-model path then gives the result. It never
 * turns a semantic assessment into a fact.
 */
export function requireSemanticKnowledge(): void {
  if (isClassicOperation()) throw new DecisionModelsDisabledError('a semantic knowledge reading');
}

/**
 * Runs a knowledge feature with a decision model when one is in use, and its
 * path without one otherwise: none is set, No Decision Model is chosen, or the
 * set model failed during this operation under Hybrid (the failure has already
 * been told once by the decision-model notice). Under Decision Model Only a
 * failing model's error stands, and a cancellation is never turned into a
 * result. While a model answers this costs one in-memory policy check.
 */
export function withOrWithoutDecisionModel<T>(withModel: () => Promise<T>, withoutModel: () => T | Promise<T>,
  signal?: AbortSignal | undefined): Promise<T> {
  return withConfiguredDecisionModelPolicy(async () => {
    if (isClassicOperation()) return withoutModel();
    try {
      return await withModel();
    } catch (error) {
      // A reader may wrap the model's failure in its own hold; the port already
      // switched this operation to running without a model when it failed.
      if (signal?.aborted || !(isClassicOperation() || activateClassicFallback(error))) throw error;
      return withoutModel();
    }
  });
}
