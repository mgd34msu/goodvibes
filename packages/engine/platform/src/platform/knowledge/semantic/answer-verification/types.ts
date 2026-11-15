import type { Outcome } from '@goodvibes-jev/judgment';
export type AnswerCandidateId = 'generated' | 'rendered';
export interface AnswerEvidenceProjection {
  /** Local structural label, never the store ID. */
  readonly reference: string;
  readonly title?: string | undefined;
  readonly text: string;
  readonly facts?: readonly string[] | undefined;
  readonly subjects?: readonly string[] | undefined;
}
export interface AnswerCandidate { readonly id: AnswerCandidateId; readonly text: string; readonly facts?: readonly string[] | undefined; }
export interface AnswerVerificationInput {
  readonly query: string;
  readonly evidence: readonly AnswerEvidenceProjection[];
  readonly candidates: readonly AnswerCandidate[];
}
export interface AnswerQualityBoolean {
  readonly verdict: 'yes' | 'no'; readonly probability: number; readonly outcome: 'act';
}
export interface KnowledgeAnswerQuality {
  readonly status: 'verified' | 'partial' | 'unsupported' | 'no-evidence';
  readonly fidelity?: { readonly verdict: 'supported' | 'contradicted' | 'unsupported'; readonly probability: number; readonly outcome: Outcome } | undefined;
  readonly evidenceSufficient?: AnswerQualityBoolean | undefined;
  readonly answerComplete?: AnswerQualityBoolean | undefined;
  readonly decisionIds: readonly string[];
  /** Local citation provenance. Store identities are never sent to the judgment port. */
  readonly evidenceReferences?: readonly { readonly reference: string; readonly sourceId: string; readonly extractionId: string }[] | undefined;
}
export interface VerifiedAnswerSelection {
  readonly candidate?: AnswerCandidate | undefined;
  readonly quality: KnowledgeAnswerQuality;
  /** Display only: supported fidelity probability ×100, not completeness or retrieval score. */
  readonly confidence: number;
}
export type AnswerQualityHoldReason = 'uncertain' | 'unavailable' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeAnswerQualityHeldError extends Error {
  override readonly name = 'KnowledgeAnswerQualityHeldError';
  /** `cause` keeps the failure the hold stands for, so it can be diagnosed from the error and the log. */
  constructor(readonly reason: AnswerQualityHoldReason, options?: { readonly cause?: unknown }) {
    super(`Knowledge answer verification held (${reason})${causeText(options?.cause)}; no further answer or repair action is authorized.`,
      options?.cause === undefined ? undefined : { cause: options.cause });
  }
}

function causeText(cause: unknown): string {
  if (cause === undefined) return '';
  const message = cause instanceof Error ? cause.message : String(cause);
  return message ? `: ${message.slice(0, 300)}` : '';
}
