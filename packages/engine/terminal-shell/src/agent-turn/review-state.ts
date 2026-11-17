import { defineLifecycle } from '@goodvibes-jev/engine/platform/platform/utils';

/** The review state shared by notes, personas, routines, skills and skill bundles. */
export type AgentReviewState = 'fresh' | 'reviewed' | 'stale';

/**
 * Every review-state move is legal: an edit makes any record fresh again,
 * a review marks any record reviewed, and any record may be marked stale.
 * Declared once so the four registries that persist this state share it.
 */
export const agentReviewStateLifecycle = defineLifecycle<AgentReviewState>('review state', {
  fresh: ['fresh', 'reviewed', 'stale'],
  reviewed: ['fresh', 'reviewed', 'stale'],
  stale: ['fresh', 'reviewed', 'stale'],
});

/** Reads a persisted review state; anything unrecognised is fresh. */
export function parseAgentReviewState(value: unknown): AgentReviewState {
  return agentReviewStateLifecycle.isState(value) ? value : 'fresh';
}

export interface AgentReviewStatePatch {
  readonly reviewState: AgentReviewState;
  readonly staleReason: string | undefined;
  readonly reviewedAt: string | undefined;
}

/** The fields an edit resets: the record is fresh again and any review is discarded. */
export function freshReviewPatch(): AgentReviewStatePatch {
  return { reviewState: 'fresh', staleReason: undefined, reviewedAt: undefined };
}

/** The fields a review sets. */
export function reviewedReviewPatch(): AgentReviewStatePatch {
  return { reviewState: 'reviewed', staleReason: undefined, reviewedAt: new Date().toISOString() };
}

/** The fields marking stale sets; `reviewedAt` is left as the record has it. */
export function staleReviewPatch(reason: string): Pick<AgentReviewStatePatch, 'reviewState' | 'staleReason'> {
  return { reviewState: 'stale', staleReason: reason.trim() || 'Marked stale by user.' };
}
