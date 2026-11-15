import { JudgmentError } from './errors.ts';
import type { EntryType, Questions } from './types.ts';

import { LIMITS } from './limits-table.ts';

export { LIMITS };

/**
 * A conservative token estimate for a JSON value: its serialized length over
 * three. Real tokenization averages closer to four characters per token for
 * English. The estimate selects long-context transport; the endpoint performs exact tokenization.
 */
export function estimateTokens(value: unknown): number {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return Math.ceil((text?.length ?? 0) / 3);
}

/** Estimates select the provider's context mode; they must not reject valid input. */
export function requiresLongContext(state: EntryType, questions: Questions): boolean {
  const stateTokens = estimateTokens(state);
  const questionTokens = Object.values(questions).map(question => estimateTokens(question));
  return stateTokens + questionTokens.reduce((sum, tokens) => sum + tokens, 0) > LIMITS.maxRequestTokens
    || questionTokens.some(tokens => stateTokens + tokens > LIMITS.maxStateWithQuestionTokens);
}

/** Enforce the documented wire-body limit, leaving exact tokenization to Jev. */
export function validateContextBudget(state: EntryType, questions: Questions): void {
  const bytes = new TextEncoder().encode(JSON.stringify({ state, questions })).byteLength;
  if (bytes > LIMITS.maxRequestBytes) {
    throw new JudgmentError('invalid-request', `System One request exceeds its ${LIMITS.maxRequestBytes}-byte body limit; partition the evidence into separate readings.`, { reason: 'body-too-large' });
  }
}

/** Rejects a request that breaks a documented limit, before anything is sent. */
export function validateQuestions(questions: Questions): void {
  const names = Object.keys(questions);
  if (names.length === 0) {
    throw new JudgmentError('invalid-request', 'a judgment request needs at least one question', { reason: 'no-questions' });
  }
  for (const name of names) {
    if (name.trim().length === 0) {
      throw new JudgmentError('invalid-request', 'question names must be nonempty', { reason: 'empty-question-name' });
    }
    const question = questions[name]!;
    switch (question.type) {
      case 'noul':
        break;
      case 'choice': {
        const count = Object.keys(question.criteria).length;
        if (count < LIMITS.minChoiceOptions || count > LIMITS.maxChoiceOptions) {
          throw new JudgmentError(
            'invalid-request',
            `choice "${name}" has ${count} options; allowed ${LIMITS.minChoiceOptions} to ${LIMITS.maxChoiceOptions}`,
            { reason: count < LIMITS.minChoiceOptions ? 'too-few-options' : 'too-many-options' },
          );
        }
        break;
      }
      case 'score': {
        const count = question.criteria.length;
        if (count < LIMITS.minScoreLevels || count > LIMITS.maxScoreLevels) {
          throw new JudgmentError(
            'invalid-request',
            `score "${name}" has ${count} levels; allowed ${LIMITS.minScoreLevels} to ${LIMITS.maxScoreLevels}`,
            { reason: count < LIMITS.minScoreLevels ? 'too-few-levels' : 'too-many-levels' },
          );
        }
        break;
      }
    }
  }
}
