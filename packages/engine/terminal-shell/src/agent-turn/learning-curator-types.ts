export type LearningCandidateStatus =
  | 'unassessed'
  | 'needs-review'
  | 'needs-setup'
  | 'needs-consolidation'
  | 'low-confidence'
  | 'proposal-ready'
  | 'ready-to-promote'
  | 'ready';
export type LocalLearningCandidateDomain = 'memory' | 'note' | 'persona' | 'skill' | 'skill_bundle' | 'routine';
export type LearningCandidateDomain = LocalLearningCandidateDomain | 'work_plan' | 'research_run' | 'session' | 'capture' | 'vibe';
export type LearningProposalTarget = 'memory' | 'skill' | 'routine' | 'persona';
export type VibeCandidateKind = 'blocked' | 'truncated';

export interface SessionInfoLike {
  readonly name: string;
  readonly title?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly timestamp?: number | undefined;
  readonly messageCount?: number | undefined;
  readonly filePath?: string | undefined;
}

export interface SessionManagerLike {
  readonly list?: (() => readonly SessionInfoLike[]) | undefined;
  readonly load?: ((name: string) => { readonly meta?: { readonly title?: string }; readonly messages?: readonly unknown[] }) | undefined;
}

export interface AgentHarnessLearningCuratorArgs {
  readonly candidateId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

export interface LearningScores {
  readonly usefulness: number;
  readonly freshness: number;
  readonly sourceQuality: number;
  readonly risk: number;
}

export interface LearningConsolidationDiff {
  readonly field: string;
  readonly survivor: string;
  readonly duplicates: readonly string[];
  readonly merged: string;
}

export interface LearningConsolidationFields {
  readonly detail?: string | undefined;
  readonly description?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly triggers?: readonly string[] | undefined;
}

export interface LearningConsolidationPlan {
  readonly survivorId: string;
  readonly duplicateIds: readonly string[];
  readonly sharedKey: string;
  /** Duplicates that were already staged as stale; they stay in the plan so they can be deleted, and are never staged again. */
  readonly staleDuplicateIds?: readonly string[] | undefined;
  readonly diffs: readonly LearningConsolidationDiff[];
  readonly staleRoutes: readonly string[];
  readonly deleteRoutes: readonly string[];
  readonly rollbackRoutes: readonly string[];
}

export interface LearningCandidate {
  readonly operationProvenance?: 'classic' | undefined;
  readonly semanticAssessment?: 'not-evaluated' | undefined;
  readonly judgmentDecisionIds?: readonly string[] | undefined;
  readonly id: string;
  readonly label: string;
  readonly domain: LearningCandidateDomain;
  readonly recordId: string | null;
  readonly status: LearningCandidateStatus;
  readonly priority: number | null;
  readonly reason: string;
  readonly next: string;
  readonly scores: LearningScores | null;
  readonly reviewState?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly active?: boolean | undefined;
  readonly confidence?: number | undefined;
  readonly proposalTarget?: LearningProposalTarget | undefined;
  readonly proposalFields?: Readonly<Record<string, string>> | undefined;
  readonly missingRequirements?: readonly string[] | undefined;
  readonly inspectRoute: string;
  readonly modelRoute: string;
  readonly reviewRoute?: string | undefined;
  readonly staleRoute?: string | undefined;
  readonly createRoute?: string | undefined;
  readonly deleteRoute?: string | undefined;
  readonly cleanupRoutes?: readonly string[] | undefined;
  readonly rollbackRoutes?: readonly string[] | undefined;
  readonly consolidation?: LearningConsolidationPlan | undefined;
}

export interface LearningConsolidationBatchCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly domain: LearningCandidateDomain;
  readonly survivorId: string;
  readonly duplicateCount: number;
  readonly duplicateIds?: readonly string[] | undefined;
  readonly diffFields: readonly string[];
  readonly detailRoute: string;
  readonly previewRoute: string;
  readonly stalePhaseRoute: string;
  readonly deletePhaseRoute: string;
  readonly staleRoute?: string | undefined;
  readonly deleteRoute?: string | undefined;
  readonly staleRoutes?: readonly string[] | undefined;
  readonly deleteRoutes?: readonly string[] | undefined;
  readonly rollbackRoutes?: readonly string[] | undefined;
}

export interface LearningConsolidationBatchPlan {
  readonly status: 'ready';
  readonly candidates: number;
  readonly duplicateRecords: number;
  readonly domains: readonly Record<string, unknown>[];
  readonly routes: Record<string, string>;
  readonly phases: readonly Record<string, unknown>[];
  readonly topCandidates: readonly LearningConsolidationBatchCandidate[];
  readonly policy: string;
}

export interface LearningPromptPlan {
  readonly status: 'ready' | 'attention' | 'empty';
  readonly promptActiveCount: number;
  readonly suppressedCount: number;
  readonly proposalCount: number | null;
  readonly consolidationCount: number | null;
  readonly promptActiveRecords: readonly Record<string, unknown>[];
  readonly reviewFirst: readonly Record<string, unknown>[];
  readonly proposalQueue: readonly Record<string, unknown>[];
  readonly consolidationQueue: readonly Record<string, unknown>[];
  readonly suppressed: Record<string, number>;
  readonly orderingRules: readonly string[];
  readonly routes: Record<string, string>;
  readonly policy: string;
}

export type LearningCandidateResolution =
  | { readonly status: 'found'; readonly candidate: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

export type LearningCandidateDraft = Omit<LearningCandidate, 'priority' | 'scores'>;
