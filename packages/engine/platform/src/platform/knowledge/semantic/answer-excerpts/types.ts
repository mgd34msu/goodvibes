/** One field of a source as it is stored: where it came from and its exact text. */
export interface AnswerExcerptDocument {
  readonly field: string;
  readonly kind: 'source-summary' | 'source-description' | 'extraction';
  readonly text: string;
}
/** A paragraph-sized span of one field, with half-open UTF-16 offsets for String.slice. */
export interface AnswerExcerptSpan {
  readonly field: string;
  readonly kind: AnswerExcerptDocument['kind'];
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export type AnswerExcerptHoldReason = 'unconfigured' | 'unavailable' | 'unsettled' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeAnswerExcerptHeldError extends Error {
  override readonly name = 'KnowledgeAnswerExcerptHeldError';
  constructor(readonly reason: AnswerExcerptHoldReason) {
    super(`Knowledge answer excerpts held (${reason}); no partial selection was authorized.`);
  }
}
/**
 * What one source's excerpt reading may send: at most `passages` spans of at
 * most `passageChars` characters, chosen by the words they share with the
 * question, within `requestBytes` of passage text. `fallbackPassages` are kept
 * when the reading does not settle.
 */
export const ANSWER_EXCERPT_LIMITS = Object.freeze({ passages: 8, passageChars: 1_600, requestBytes: 12 * 1024, fallbackPassages: 2 });
