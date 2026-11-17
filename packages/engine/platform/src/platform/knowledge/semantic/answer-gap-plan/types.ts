import type { JsonValue } from '@goodvibes-jev/judgment';
export interface AnswerGapMeaning {
  readonly query: string;
  readonly subject?: string | undefined;
  readonly subjects: readonly { readonly reference: string; readonly content: Readonly<Record<string, JsonValue>> }[];
  readonly sources: readonly { readonly reference: string; readonly content: Readonly<Record<string, JsonValue>> }[];
}
export interface AnswerGapCandidate extends AnswerGapMeaning {
  readonly reference: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly reason?: string | undefined;
  readonly issues?: readonly (AnswerGapMeaning & { readonly reference: string; readonly message: string; readonly reason?: string | undefined })[] | undefined;
}
export interface AnswerGapInput {
  readonly question: AnswerGapMeaning;
  readonly candidates: readonly AnswerGapCandidate[];
  readonly needsSubject: boolean;
}
export type AnswerGapHoldReason = 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeAnswerGapHeldError extends Error {
  override readonly name = 'KnowledgeAnswerGapHeldError';
  constructor(readonly reason: AnswerGapHoldReason) { super(`Knowledge answer gap held (${reason}); no gap write was authorized.`); }
}
/**
 * Recording a missing answer: an earlier gap with the same normalised question
 * and the same subjects is the same gap (no request); otherwise at most
 * `equivalenceRequests` earlier gap sharing a subject is read for equivalence.
 */
export const ANSWER_GAP_LIMITS = Object.freeze({ equivalenceRequests: 1 });
