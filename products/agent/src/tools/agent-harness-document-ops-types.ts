import type { AgentReviewPacketTimeline, AgentReviewPacketWizard } from '../input/runtime-snapshot-types.ts';

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
export type { ReviewerReadinessStatus } from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-report';
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
  /** The controls the lane's work is done with: place, tab, key (what the key says). */
  readonly controls: readonly string[];
  readonly reviewerReadiness?: ReviewerReadinessChecklist;
  readonly reviewPacketWizard?: AgentReviewPacketWizard;
  /** The whole timeline (the lane's signals list only the latest five); the daemon's documents.timeline tells the same. */
  readonly reviewPacketTimeline?: AgentReviewPacketTimeline;
}

// The readiness checklist is computed by the daemon too, from the stores themselves (terminal-shell agent-turn/review-packet-report.ts).
export type { ReviewerReadinessCheck, ReviewerReadinessChecklist } from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-report';
import type { ReviewerReadinessChecklist } from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-report';

export type DocumentOpsLaneResolution =
  | { readonly status: 'found'; readonly lane: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };
