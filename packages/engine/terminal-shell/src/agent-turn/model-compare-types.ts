import type { ToolExecuteOptions } from '@goodvibes/engine/platform/platform/tools';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { ChatResponse, LLMProvider } from '@goodvibes/engine/platform/platform/providers';

export interface AgentModelCompareToolArgs {
  readonly mode?: unknown;
  readonly prompt?: unknown;
  readonly modelRefs?: unknown;
  readonly candidateCount?: unknown;
  readonly rubric?: unknown;
  readonly systemPrompt?: unknown;
  readonly maxTokens?: unknown;
  readonly reveal?: unknown;
  readonly saveArtifact?: unknown;
  readonly preview?: unknown;
  readonly benchmarkKind?: unknown;
  readonly comparisonId?: unknown;
  readonly artifactId?: unknown;
  readonly leftArtifactId?: unknown;
  readonly rightArtifactId?: unknown;
  readonly sectionId?: unknown;
  readonly winner?: unknown;
  readonly winnerBlindId?: unknown;
  readonly reasons?: unknown;
  readonly notes?: unknown;
  readonly decision?: unknown;
  readonly limit?: unknown;
  readonly includeReasons?: unknown;
  readonly taskType?: unknown;
  readonly documentId?: unknown;
  readonly relatedArtifactIds?: unknown;
  readonly previewBytes?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

export interface AgentModelCompareRouteUpdateResult {
  readonly previousModel?: string | undefined;
  readonly selectedModel: string;
}

export interface AgentModelCompareCatalogModel {
  readonly id?: string | undefined;
  readonly modelId?: string | undefined;
  readonly provider?: string | undefined;
  readonly providerId?: string | undefined;
  readonly registryKey?: string | undefined;
  readonly displayName?: string | undefined;
  readonly selectable?: boolean | undefined;
  readonly current?: boolean | undefined;
  readonly contextWindow?: number | undefined;
}

export interface AgentModelCompareModelCatalog {
  readonly listModels: (query?: { readonly selectableOnly?: boolean | undefined }) => readonly AgentModelCompareCatalogModel[] | Promise<readonly AgentModelCompareCatalogModel[]>;
  readonly getCurrentModel?: (() => AgentModelCompareCatalogModel | Promise<AgentModelCompareCatalogModel>) | undefined;
  readonly recordModelUsage?: ((registryKey: string, ownership?: Pick<ToolExecuteOptions, 'signal' | 'assertCurrent'>) => Promise<unknown>) | undefined;
}

export interface AgentModelCompareProviderRegistry {
  readonly getForModel: (modelId: string, provider?: string) => LLMProvider;
}

export type AgentModelCompareArtifactStore = Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'list' | 'get' | 'readContent'>>;

export interface AgentModelCompareToolDeps {
  readonly toolRegistry?: ToolRegistry | undefined;
  readonly modelCatalog: AgentModelCompareModelCatalog;
  readonly providerRegistry: AgentModelCompareProviderRegistry;
  readonly artifactStore?: AgentModelCompareArtifactStore | undefined;
  /** Random source for the blind-label order; tests fix it. Defaults to Math.random. */
  readonly random?: (() => number) | undefined;
  readonly applyModelRoute?: ((registryKey: string, options?: ToolExecuteOptions, ownership?: Pick<ToolExecuteOptions, 'signal' | 'assertCurrent'>) => AgentModelCompareRouteUpdateResult | Promise<AgentModelCompareRouteUpdateResult>) | undefined;
  /**
   * How each candidate's metered call is run when the comparison itself is the owner's confirmed act (the daemon's
   * comparison runner): each candidate admitted as theirs too, under the same gate. Absent: a candidate is a nested call
   * of the comparison, admitted on its own (a model's comparison in a turn).
   */
  readonly dispatchCandidate?: ((name: string, args: Record<string, unknown>) => Promise<{ readonly success: boolean; readonly output?: string | undefined; readonly error?: string | undefined }>) | undefined;
}

export interface ResolvedCompareModel {
  readonly registryKey: string;
  readonly modelId: string;
  readonly providerId: string;
  readonly displayName: string;
  readonly current: boolean;
}

export type CompareCandidateStatus = 'completed' | 'failed';

export interface CompareCandidateResult {
  readonly blindId: string;
  readonly model: ResolvedCompareModel;
  readonly status: CompareCandidateStatus;
  readonly content: string;
  readonly stopReason?: string | undefined;
  readonly usage?: ChatResponse['usage'] | undefined;
  readonly latencyMs: number;
  readonly toolCallCount?: number | undefined;
  readonly error?: string | undefined;
}

export interface StoredComparison {
  readonly comparisonId: string;
  readonly createdAt: string;
  readonly promptPreview: string;
  readonly rubric: string;
  readonly sourceArtifact?: SavedComparisonArtifact | undefined;
  readonly benchmarkKind?: string | undefined;
  readonly taskType?: string | undefined;
  readonly documentId?: string | undefined;
  readonly candidates: readonly CompareCandidateResult[];
  readonly artifact?: SavedComparisonArtifact | undefined;
  readonly artifactStatus?: ComparisonArtifactStatus | undefined;
}

export interface LoadedComparisonJudgment {
  readonly artifact: SavedComparisonArtifact;
  readonly judgmentId: string;
  readonly comparisonId: string;
  readonly winnerBlindId: string;
  readonly reasons: string;
  readonly notes: string;
  readonly revealIncludedInJudgment: boolean;
  readonly sourceArtifactId?: string | undefined;
  readonly benchmarkKind?: string | undefined;
  readonly taskType?: string | undefined;
  readonly documentId?: string | undefined;
  readonly winnerModel?: {
    readonly registryKey: string;
    readonly providerId: string;
    readonly modelId: string;
    readonly displayName: string;
  } | undefined;
}

export interface LoadedComparisonHandoff {
  readonly artifact: SavedComparisonArtifact;
  readonly handoffId: string;
  readonly sourceArtifactId: string;
  readonly sourceKind: 'comparison' | 'judgment';
  readonly comparisonId: string;
  readonly relatedArtifactIds: readonly string[];
  readonly revealIncludedInHandoff: boolean;
}

export interface SavedComparisonArtifact {
  readonly artifactId: string;
  readonly filename?: string | undefined;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly documentId?: string | undefined;
}

export interface ComparisonArtifactStatus {
  readonly state: 'saved' | 'disabled' | 'unavailable' | 'failed';
  readonly message: string;
}

export const MODE_RUN = 'run';
export const MODE_REVEAL = 'reveal';
export const MODE_REVIEW = 'review';
export const MODE_SIDE_BY_SIDE = 'sideBySide';
export const MODE_JUDGE = 'judge';
export const MODE_APPLY = 'apply';
export const MODE_ROUTE_DECISION = 'routeDecision';
export const MODE_EXPORT = 'export';
export const MODE_HANDOFF = 'handoff';
export const MODE_HANDOFF_ARCHIVE = 'handoffArchive';
export const MODE_HANDOFF_DIFF = 'handoffDiff';
export const MODE_ANALYTICS = 'analytics';
export const MODE_SYNTHESIS = 'synthesis';
export const MIN_CANDIDATES = 2;
export const DEFAULT_CANDIDATE_COUNT = 2;
export const DEFAULT_MAX_TOKENS = 0;
export const DEFAULT_CANDIDATE_OUTPUT_CHARS = 12_000;
export const MAX_HANDOFF_ARTIFACT_BYTES = 40_000;
/** Total source bytes a handoff archive may package. */
export const MAX_HANDOFF_ARCHIVE_BYTES = 64 * 1024 * 1024;
export const MAX_HANDOFF_DIFF_INPUT_LINES = 360;
export const MAX_HANDOFF_DIFF_ROWS = 120;
export const MAX_HANDOFF_DIFF_SECTION_PREVIEW_CHARS = 180;
export const DEFAULT_SIDE_BY_SIDE_PREVIEW_BYTES = 2_000;
export const MAX_SIDE_BY_SIDE_PREVIEW_BYTES = 10_000;
export const COMPARISON_STORE_LIMIT = 25;
export const BLIND_LABELS = ['A', 'B', 'C', 'D'] as const;

export { MODEL_REASON_THEME_LABELS } from '@goodvibes/engine/platform/platform/routing';
