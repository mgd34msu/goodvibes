import { Buffer } from 'node:buffer';
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

/**
 * One request's state and questions serialized once. The size checks, the
 * context-mode choice and the wire body are all taken from these texts, so a
 * large state is not serialized again for each of them.
 */
export interface SerializedInput {
  readonly stateText: string;
  readonly questionsText: string;
  /** Characters the context estimate counts for the state: a string state's own length, else its JSON length. */
  readonly stateChars: number;
  /** Each question's own serialized length, for the per-question context estimate. */
  readonly questionLengths: readonly number[];
  /** UTF-8 bytes of `{"state":…,"questions":…}`. */
  readonly bytes: number;
}

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

export function serializeInput(state: EntryType, questions: Questions): SerializedInput {
  const stateText = JSON.stringify(state) ?? 'null', questionsText = JSON.stringify(questions);
  return {
    stateText, questionsText,
    stateChars: typeof state === 'string' ? state.length : stateText.length,
    questionLengths: Object.values(questions).map(question => JSON.stringify(question).length),
    // `{"state":` + state + `,"questions":` + questions + `}`
    bytes: 9 + utf8Bytes(stateText) + 13 + utf8Bytes(questionsText) + 1,
  };
}

/** The wire body for one target: exactly `JSON.stringify({ state, questions, model })`, built from the texts. */
export const wireBody = (input: SerializedInput, model: string): string =>
  `{"state":${input.stateText},"questions":${input.questionsText},"model":${JSON.stringify(model)}}`;

/** Bytes of `wireBody(input, model)` without building it. */
export const wireBodyBytes = (input: SerializedInput, model: string): number =>
  input.bytes - 1 + 9 + utf8Bytes(JSON.stringify(model)) + 1;

/** Estimates select the provider's context mode; they must not reject valid input. */
export function requiresLongContextFor(input: SerializedInput): boolean {
  const stateTokens = Math.ceil(input.stateChars / 3);
  const questionTokens = input.questionLengths.map(chars => Math.ceil(chars / 3));
  return stateTokens + questionTokens.reduce((sum, tokens) => sum + tokens, 0) > LIMITS.maxRequestTokens
    || questionTokens.some(tokens => stateTokens + tokens > LIMITS.maxStateWithQuestionTokens);
}

/** Enforce the documented wire-body limit, leaving exact tokenization to Jev. */
export function checkInputBytes(input: SerializedInput): void {
  if (input.bytes > LIMITS.maxRequestBytes) {
    throw new JudgmentError('invalid-request', `System One request exceeds its ${LIMITS.maxRequestBytes}-byte body limit; partition the evidence into separate readings.`, { reason: 'body-too-large' });
  }
}

export function validateContextBudget(state: EntryType, questions: Questions): void {
  checkInputBytes(serializeInput(state, questions));
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
