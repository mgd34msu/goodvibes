import type { JsonValue } from '@goodvibes-jev/judgment';
/**
 * What one serving reading may send to the decision model: the passages of the
 * node's sources that bear on it, never whole documents. The number of nodes in
 * a pass is local work and is not limited.
 */
export const NODE_ACTIVATION_LIMITS = Object.freeze({
  /** Extracted passages sent with one reading, across all of the node's sources. */
  evidenceBytes: 24 * 1024,
  /** The whole reading state (candidate, subjects, passages); over this the node holds with reason `budget`. */
  requestBytes: 64 * 1024,
  /** Longest passage; a longer paragraph is cut at sentence ends. */
  passageChars: 1_200,
  concurrency: 4, timeoutMs: 2_147_483_647, defaultTimeoutMs: 0,
});
export interface KnowledgeNodeActivationOptions {
  readonly signal?: AbortSignal | undefined;
  /** Retained caller authority, rechecked synchronously at every final commit. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly timeoutMs?: number | undefined;
  /** A composed serving pass cannot consume a pending draft as a successful claim. */
  readonly requireAccepted?: boolean | undefined;
}
export type NodeActivationReason = 'no' | 'uncertain' | 'unavailable' | 'unconfigured' | 'missing-evidence' | 'foreign-space' | 'budget' | 'aborted' | 'stale' | 'malformed' | 'rejected' | 'invalid-request' | 'internal' | 'unrecorded' | 'decision-model-disabled' | 'observation-revalidation' | 'owner-confidence-floor' | 'replacement-requires-review';
export class KnowledgeNodeActivationHeldError extends Error {
  override readonly name = 'KnowledgeNodeActivationHeldError';
  constructor(readonly reason: NodeActivationReason, readonly detail?: string) {
    super(reason === 'decision-model-disabled'
      ? 'Automatic knowledge activation requires a decision model in Classic operation; retain a draft or use explicit owner review.'
      : `Knowledge node activation held: ${reason}.${detail ? ` ${detail}` : ''}`);
  }
}
export interface NodeActivationReading {
  readonly operationProvenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated';
  readonly outcome: 'accepted' | 'pending-review';
  readonly reason?: NodeActivationReason | undefined;
  /** For `budget`: the reading's size and the limit, so a reviewer knows why it was not sent. */
  readonly detail?: string | undefined;
  /** Passages and characters of the sources that were not sent with the reading. */
  readonly omitted?: { readonly passages: number; readonly characters: number } | undefined;
  readonly probability?: number | undefined;
  readonly decisionId?: string | undefined;
  readonly model?: string | undefined;
  readonly requestedModel?: string | undefined;
}
/** A projected reading: the state to send, or the reason it holds without a request. */
export interface NodeActivationRequest {
  readonly state: Record<string, JsonValue>;
  readonly reason?: 'missing-evidence' | 'foreign-space' | 'budget' | undefined;
  readonly detail?: string | undefined;
  readonly omitted?: { readonly passages: number; readonly characters: number } | undefined;
}
