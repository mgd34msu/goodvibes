import type { AgentWorkspaceReviewPacketTimeline, AgentWorkspaceReviewPacketWizard } from '../input/agent-workspace-types.ts';

export type DocumentOpsLaneId =
  | 'documents'
  | 'uploads'
  | 'exports'
  | 'reviewer_readiness'
  | 'review_packet_timeline'
  | 'review_packet_wizard'
  | 'source_library'
  | 'media_artifacts'
  | 'artifact_browser'
  | 'model_compare';

export type DocumentOpsStatus = 'ready' | 'attention' | 'partial' | 'needs-setup' | 'gap';
export type ReviewerReadinessStatus = 'ready' | 'attention' | 'needs-setup';
export type ReviewerReadinessCheckStatus = 'pass' | 'attention' | 'needs-setup';

export interface AgentHarnessDocumentOpsArgs {
  readonly laneId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

export interface DocumentOpsLane {
  readonly id: DocumentOpsLaneId;
  readonly label: string;
  readonly status: DocumentOpsStatus;
  readonly outcome: string;
  readonly current: string;
  readonly next: string;
  readonly userRoute: string;
  readonly modelRoute: string;
  readonly signals: readonly string[];
  readonly actionIds: readonly string[];
  readonly reviewerReadiness?: ReviewerReadinessChecklist;
  readonly reviewPacketWizard?: AgentWorkspaceReviewPacketWizard;
  /** The whole timeline (the lane's signals list only the latest five); read by `/documents timeline`. */
  readonly reviewPacketTimeline?: AgentWorkspaceReviewPacketTimeline;
}

export interface ReviewerReadinessChecklist {
  readonly status: ReviewerReadinessStatus;
  readonly next: string;
  readonly summary: {
    readonly documents: number;
    readonly openComments: number;
    readonly proposedSuggestions: number;
    readonly documentsMissingSourceArtifacts: number;
    readonly savedComparisons: number;
    readonly unrevealedComparisons: number;
    readonly hiddenJudgments: number;
    /** Revealed judgments, whether or not a route decision was recorded for them. */
    readonly revealedJudgments: number;
    /** Revealed judgments that still lack an apply or leave-unchanged route decision. */
    readonly judgmentsAwaitingRouteDecision: number;
    readonly handoffsMissingRelatedArtifacts: number;
  };
  /** Stores that could not be read in full; the counts above do not include what was not read. */
  readonly readProblems?: readonly string[];
  readonly checks: readonly ReviewerReadinessCheck[];
  readonly policy: string;
}

export interface ReviewerReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: ReviewerReadinessCheckStatus;
  readonly count: number;
  readonly detail: string;
  readonly inspectRoute: string;
  readonly repairRoute?: string;
  /** The line a person types to fix it, with a blank in angle brackets where they choose; absent when nothing is to fix. */
  readonly ownerLine?: string | undefined;
}

export type DocumentOpsLaneResolution =
  | { readonly status: 'found'; readonly lane: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };
