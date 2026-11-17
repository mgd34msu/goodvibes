import { toJson, type JsonValue } from '@goodvibes-jev/judgment';
import { assertJudgmentInput } from '../../../gate/judgment-input.js';
import { judge } from '../../../runtime/judge.js';
import { answerGapAdmission, answerGapEquivalence } from './battery.js';
import { KnowledgeAnswerGapHeldError as Held, type AnswerGapCandidate, type AnswerGapMeaning } from './types.js';
export * from './types.js';

function json(value: object): Record<string, JsonValue> {
  assertJudgmentInput(value);
  const result = toJson(value);
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Held('malformed');
  return result as Record<string, JsonValue>;
}

export interface AnswerGapReading {
  readonly yes: boolean;
  /** `fallback` when the reading did not settle (no decision model, deadline, unsure). */
  readonly decidedBy: 'model' | 'cache' | 'fallback';
  readonly decisionId?: string | undefined;
}

function outcome(result: { readonly value: boolean; readonly source: 'model' | 'cache' | 'fallback'; readonly decisionId?: string | undefined }): AnswerGapReading {
  return { yes: result.value, decidedBy: result.source, ...(result.decisionId ? { decisionId: result.decisionId } : {}) };
}

/**
 * Whether a question with no named subject is specific enough to record as a
 * missing answer. When the reading does not settle nothing is recorded: an
 * unrecorded gap costs nothing, a vague one is research nobody asked for.
 */
export async function readAnswerGapAdmission(question: AnswerGapMeaning, signal?: AbortSignal): Promise<AnswerGapReading> {
  return outcome(await judge({
    site: answerGapAdmission.name, battery: answerGapAdmission, state: json({ question }),
    ...(signal ? { signal } : {}),
    settle: (readings) => readings.gapSubject.outcome === 'act' && (readings.gapSubject.verdict === 'yes' || readings.gapSubject.verdict === 'no')
      ? readings.gapSubject.verdict === 'yes' : undefined,
    fallback: () => false,
    describe: (admitted) => admitted ? 'record the missing answer' : 'not specific enough to record',
  }));
}

/**
 * Whether an earlier missing answer is the same question. Code already matched
 * exact text and subjects and chose this one candidate; when the reading does
 * not settle the question is recorded as its own gap.
 */
export async function readAnswerGapEquivalence(question: AnswerGapMeaning, candidate: AnswerGapCandidate, signal?: AbortSignal): Promise<AnswerGapReading> {
  return outcome(await judge({
    site: answerGapEquivalence.name, battery: answerGapEquivalence, state: json({ question, candidate }),
    ...(signal ? { signal } : {}),
    settle: (readings) => readings.sameQuestion.outcome === 'act' && (readings.sameQuestion.verdict === 'yes' || readings.sameQuestion.verdict === 'no')
      ? readings.sameQuestion.verdict === 'yes' : undefined,
    fallback: () => false,
    describe: (same) => same ? 'same missing answer' : 'a different missing answer',
  }));
}
