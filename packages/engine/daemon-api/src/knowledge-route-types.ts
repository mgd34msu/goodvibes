import type { ArtifactStoreUploadLike } from './artifact-upload.js';
import type { JsonRecord } from './route-helpers.js';

/** A schedule the knowledge scheduler can store: one of the three kinds the automation scheduler runs. */
export type AutomationScheduleDefinition =
  | { readonly kind: 'at'; readonly at: number }
  | { readonly kind: 'every'; readonly intervalMs: number; readonly anchorAt?: number | undefined }
  | {
    readonly kind: 'cron';
    readonly expression: string;
    readonly timezone?: string | undefined;
    readonly staggerMs?: number | undefined;
    readonly staggerPhase?: number | undefined;
  };
export type KnowledgeProjectionTargetKind = 'overview' | 'bundle' | 'source' | 'node' | 'issue' | 'dashboard' | 'rollup';
/** The values the knowledge store accepts; route filters and ingest fields are checked against these lists. */
export const KNOWLEDGE_USAGE_KINDS = ['search-hit', 'packet-item', 'item-open', 'neighbor-open', 'projection-read', 'multimodal-writeback'] as const;
export const KNOWLEDGE_CANDIDATE_STATUSES = ['open', 'accepted', 'rejected', 'superseded'] as const;
export const KNOWLEDGE_SOURCE_TYPES = ['url', 'bookmark', 'bookmark-list', 'history', 'document', 'repo', 'dataset', 'image', 'manual', 'other'] as const;
export type KnowledgeUsageKind = typeof KNOWLEDGE_USAGE_KINDS[number];
export type KnowledgeCandidateStatus = typeof KNOWLEDGE_CANDIDATE_STATUSES[number];
export type KnowledgeSourceType = typeof KNOWLEDGE_SOURCE_TYPES[number];
export const KNOWLEDGE_PACKET_DETAILS = ['compact', 'standard', 'detailed'] as const;
export type KnowledgePacketDetail = typeof KNOWLEDGE_PACKET_DETAILS[number];
export const KNOWLEDGE_SUBJECT_KINDS = ['source', 'node', 'issue'] as const;
export type KnowledgeSubjectKind = typeof KNOWLEDGE_SUBJECT_KINDS[number];
export const KNOWLEDGE_REVIEW_ACTIONS = ['accept', 'reject', 'resolve', 'reopen', 'edit', 'forget'] as const;
export type KnowledgeReviewAction = typeof KNOWLEDGE_REVIEW_ACTIONS[number];
/** The browsers whose history and bookmarks a sync can read. */
export const KNOWLEDGE_BROWSER_KINDS = [
  'chrome', 'chromium', 'brave', 'edge', 'vivaldi', 'arc', 'opera',
  'firefox', 'zen', 'librewolf', 'waterfox', 'floorp', 'safari', 'orion', 'epiphany',
] as const;
export type KnowledgeBrowserKind = typeof KNOWLEDGE_BROWSER_KINDS[number];
export type KnowledgeBrowserSourceKind = 'history' | 'bookmark';
export type KnowledgeAnswerMode = 'concise' | 'standard' | 'detailed';
export type KnowledgeJobRunMode = 'inline' | 'background';


export interface AuthenticatedPrincipalLike {
  readonly principalId: string;
  readonly principalKind: string;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

export interface KnowledgeGraphqlAccessLike {
  /** The operation the parsed document runs (operationName picks it among several). */
  readonly operation: 'query' | 'mutation';
  readonly requiredScopes: readonly string[];
  readonly adminRequired?: boolean | undefined;
}

export interface KnowledgeGraphqlResultLike {
  readonly data?: unknown | undefined;
  readonly errors?: readonly unknown[] | undefined;
}

export interface KnowledgeGraphqlServiceLike {
  readonly schemaText: string;
  execute(input: {
    readonly query: string;
    readonly operationName?: string | undefined;
    readonly variables?: Record<string, unknown> | undefined;
    readonly admin: boolean;
    readonly scopes: readonly string[];
    readonly scopeOptions?: KnowledgeScopeReadOptions;
  }): Promise<KnowledgeGraphqlResultLike>;
}

export interface KnowledgeScopeReadOptions {
  readonly signal: AbortSignal;
  readonly assertCurrent: () => void;
}

/** Which knowledge space a read covers; absent means the default space. */
export interface KnowledgeSpaceScope {
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
}

/** One page of a newest-first listing: `after` is null for the first page. */
export interface KnowledgeListingQuery extends KnowledgeSpaceScope {
  readonly limit?: number | undefined;
  readonly after?: { readonly updatedAt: number; readonly id: string } | null | undefined;
}

export interface KnowledgeListingResult {
  readonly total: number;
  readonly items: readonly unknown[];
  readonly hasMore?: boolean | undefined;
}

export interface KnowledgeMapQuery extends KnowledgeSpaceScope {
  readonly limit?: number | undefined;
  /** `nextCursor` of an earlier map of the same request: the next slice. */
  readonly cursor?: string | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeIssues?: boolean | undefined;
  readonly includeGenerated?: boolean | undefined;
  readonly query?: string | undefined;
  readonly minConfidence?: number | undefined;
  readonly recordKinds?: readonly KnowledgeSubjectKind[] | undefined;
  readonly ids?: readonly string[] | undefined;
  readonly linkedToIds?: readonly string[] | undefined;
  readonly nodeKinds?: readonly string[] | undefined;
  readonly sourceTypes?: readonly string[] | undefined;
  readonly sourceStatuses?: readonly string[] | undefined;
  readonly nodeStatuses?: readonly string[] | undefined;
  readonly issueCodes?: readonly string[] | undefined;
  readonly issueStatuses?: readonly string[] | undefined;
  readonly issueSeverities?: readonly string[] | undefined;
  readonly edgeRelations?: readonly string[] | undefined;
  readonly tags?: readonly string[] | undefined;
}

export interface KnowledgeIssueReviewRequest {
  readonly issueId: string;
  readonly action: KnowledgeReviewAction;
  /** The authenticated principal, never a name from the request body. */
  readonly reviewer?: string | undefined;
  readonly value?: Record<string, unknown> | undefined;
}

export interface KnowledgeRefinementTaskFilter {
  readonly spaceId?: string | undefined;
  readonly state?: string | undefined;
  readonly subjectKind?: string | undefined;
  readonly subjectId?: string | undefined;
  readonly gapId?: string | undefined;
}

export interface KnowledgeRefinementRunRequest {
  readonly knowledgeSpaceId?: string | undefined;
  readonly gapIds?: readonly string[] | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
  readonly maxRunMs?: number | undefined;
  readonly force?: boolean | undefined;
}

/** Fields every ingest accepts; `allowPrivateHosts` is present only when the daemon's policy allowed it. */
export interface KnowledgeIngestCommon {
  readonly sessionId?: string | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeUrlIngestRequest extends KnowledgeIngestCommon {
  readonly url: string;
  readonly title?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly folderPath?: string | undefined;
  readonly sourceType?: KnowledgeSourceType | undefined;
  readonly connectorId?: string | undefined;
}

export interface KnowledgeArtifactIngestRequest extends KnowledgeIngestCommon {
  readonly artifactId?: string | undefined;
  readonly path?: string | undefined;
  readonly uri?: string | undefined;
  readonly title?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly folderPath?: string | undefined;
  readonly sourceType?: KnowledgeSourceType | undefined;
  readonly connectorId?: string | undefined;
}

export interface KnowledgeFileImportRequest extends KnowledgeIngestCommon {
  readonly path: string;
}

export interface KnowledgeConnectorIngestRequest extends KnowledgeIngestCommon {
  readonly connectorId: string;
  readonly input?: unknown;
  readonly content?: string | undefined;
  readonly path?: string | undefined;
}

export interface KnowledgeBrowserSyncRequest {
  readonly browsers?: readonly KnowledgeBrowserKind[] | undefined;
  readonly sourceKinds?: readonly KnowledgeBrowserSourceKind[] | undefined;
  readonly homeOverride?: string | undefined;
  readonly limit?: number | undefined;
  readonly sinceMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly connectorId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeSearchRequest extends KnowledgeSpaceScope {
  readonly query: string;
  readonly limit?: number | undefined;
}

export interface KnowledgeAskRequest {
  readonly query: string;
  readonly knowledgeSpaceId?: string | undefined;
  readonly limit?: number | undefined;
  readonly mode?: KnowledgeAnswerMode | undefined;
  readonly includeSources?: boolean | undefined;
  readonly includeConfidence?: boolean | undefined;
  readonly includeLinkedObjects?: boolean | undefined;
  readonly candidateSourceIds?: readonly string[] | undefined;
  readonly candidateNodeIds?: readonly string[] | undefined;
  readonly strictCandidates?: boolean | undefined;
}

export interface KnowledgePacketOptions {
  readonly detail?: KnowledgePacketDetail;
  readonly budgetLimit?: number;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

export interface KnowledgeCandidateDecisionRequest {
  /** The authenticated principal, never a name from the request body. */
  readonly decidedBy?: string | undefined;
  readonly memoryClass?: string | undefined;
  readonly scope?: string | undefined;
  readonly detail?: string | undefined;
}

export interface KnowledgeJobRunRequest {
  readonly mode?: KnowledgeJobRunMode | undefined;
  readonly sourceIds?: readonly string[] | undefined;
  readonly limit?: number | undefined;
}

export interface KnowledgeScheduleRequest {
  readonly id?: string | undefined;
  readonly jobId: string;
  readonly schedule: AutomationScheduleDefinition;
  readonly label?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface KnowledgeProjectionRequest extends KnowledgeSpaceScope {
  readonly kind: KnowledgeProjectionTargetKind;
  readonly id?: string | undefined;
  readonly limit?: number | undefined;
}

export interface KnowledgeProjectionMaterializeRequest extends KnowledgeProjectionRequest {
  readonly filename?: string | undefined;
}

/**
 * The knowledge service as the routes call it. Every input is the shape the
 * route has already checked, and the members are function-typed properties so
 * the platform's service is checked against them strictly: a field the service
 * renames or retypes fails to compile where the router passes it in.
 */
export interface KnowledgeServiceLike {
  readonly getStatus: (scope?: KnowledgeSpaceScope, options?: KnowledgeScopeReadOptions) => Promise<unknown>;
  /** With `after` present (null for the first page): newest first, the `limit` records after that key, and `hasMore`. */
  readonly querySources: (input: KnowledgeListingQuery, options?: KnowledgeScopeReadOptions) => Promise<KnowledgeListingResult>;
  readonly queryNodes: (input: KnowledgeListingQuery, options?: KnowledgeScopeReadOptions) => Promise<KnowledgeListingResult>;
  readonly queryIssues: (input: KnowledgeListingQuery, options?: KnowledgeScopeReadOptions) => Promise<KnowledgeListingResult>;
  readonly reviewIssue: (input: KnowledgeIssueReviewRequest) => Promise<unknown>;
  readonly getItemScoped: (id: string, scope?: KnowledgeSpaceScope, options?: KnowledgeScopeReadOptions) => Promise<unknown | null>;
  readonly listConnectors: () => readonly unknown[];
  readonly getConnector: (id: string) => unknown | null;
  readonly doctorConnector: (id: string) => Promise<unknown | null>;
  readonly listProjectionTargets: (limit: number, scope?: KnowledgeSpaceScope, options?: KnowledgeScopeReadOptions) => Promise<readonly unknown[]>;
  readonly map: (input: KnowledgeMapQuery, options?: KnowledgeScopeReadOptions) => Promise<unknown>;
  /** `scope.extractionId` reads that one extraction (empty when unknown or outside the scope). */
  readonly listExtractions: (
    limit: number,
    sourceId?: string,
    scope?: KnowledgeSpaceScope & { readonly extractionId?: string | undefined },
    options?: KnowledgeScopeReadOptions,
  ) => Promise<readonly unknown[]>;
  readonly listUsageRecords: (
    limit: number,
    filter: {
      readonly targetKind?: KnowledgeSubjectKind | undefined;
      readonly targetId?: string | undefined;
      readonly usageKind?: KnowledgeUsageKind | undefined;
    },
  ) => readonly unknown[];
  readonly listConsolidationCandidates: (
    limit: number,
    filter: {
      readonly status?: KnowledgeCandidateStatus | undefined;
      readonly subjectKind?: KnowledgeSubjectKind | undefined;
      readonly subjectId?: string | undefined;
    },
  ) => readonly unknown[];
  readonly getConsolidationCandidate: (id: string) => unknown | null;
  readonly listConsolidationReports: (limit: number) => readonly unknown[];
  readonly getConsolidationReport: (id: string) => unknown | null;
  readonly listJobs: () => readonly unknown[];
  readonly getJob: (jobId: string) => unknown | null;
  readonly listJobRuns: (limit: number, jobId?: string) => readonly unknown[];
  readonly listRefinementTasks: (limit: number, filter: KnowledgeRefinementTaskFilter) => readonly unknown[];
  readonly getRefinementTask: (id: string) => unknown | null;
  readonly runRefinement: (input: KnowledgeRefinementRunRequest) => Promise<unknown>;
  readonly cancelRefinementTask: (id: string) => Promise<unknown | null>;
  readonly listSchedules: (limit: number) => readonly unknown[];
  readonly getSchedule: (id: string) => unknown | null;
  readonly ingestUrl: (input: KnowledgeUrlIngestRequest) => Promise<unknown>;
  readonly ingestArtifact: (input: KnowledgeArtifactIngestRequest) => Promise<unknown>;
  readonly syncBrowserHistory: (input: KnowledgeBrowserSyncRequest) => Promise<unknown>;
  readonly importBookmarksFromFile: (input: KnowledgeFileImportRequest) => Promise<unknown>;
  readonly importUrlsFromFile: (input: KnowledgeFileImportRequest) => Promise<unknown>;
  readonly ingestConnectorInput: (input: KnowledgeConnectorIngestRequest) => Promise<unknown>;
  readonly searchScoped: (input: KnowledgeSearchRequest, options?: KnowledgeScopeReadOptions) => Promise<readonly unknown[]>;
  readonly ask: (input: KnowledgeAskRequest, options?: { readonly signal?: AbortSignal | undefined }) => Promise<unknown>;
  readonly buildPacket: (task: string, writeScope: readonly string[], limit: number, options: KnowledgePacketOptions) => Promise<unknown> | unknown;
  readonly decideConsolidationCandidate: (
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: KnowledgeCandidateDecisionRequest,
  ) => Promise<unknown>;
  readonly runJob: (jobId: string, input: KnowledgeJobRunRequest) => Promise<unknown>;
  /** Stops a queued or running job run; refuses (409) a run that finished or that another process owns. */
  readonly cancelJobRun?: ((runId: string) => Promise<unknown>) | undefined;
  readonly lint: () => Promise<readonly unknown[]>;
  readonly reindex: () => Promise<unknown>;
  readonly saveSchedule: (input: KnowledgeScheduleRequest) => Promise<unknown>;
  readonly deleteSchedule: (id: string) => Promise<boolean>;
  readonly setScheduleEnabled: (id: string, enabled: boolean) => Promise<unknown | null>;
  readonly renderProjection: (input: KnowledgeProjectionRequest, options?: KnowledgeScopeReadOptions) => Promise<unknown>;
  readonly materializeProjection: (input: KnowledgeProjectionMaterializeRequest) => Promise<unknown>;
}

export interface DaemonKnowledgeRouteContext {
  readonly artifactStore: ArtifactStoreUploadLike;
  readonly configManager: { get(key: string): unknown };
  readonly inspectGraphqlAccess: (
    query: string,
    operationName?: string,
  ) => KnowledgeGraphqlAccessLike;
  readonly normalizeAtSchedule: (at: number) => AutomationScheduleDefinition;
  readonly normalizeCronSchedule: (
    expression: string,
    timezone?: string,
    staggerMs?: unknown,
  ) => AutomationScheduleDefinition;
  readonly normalizeEverySchedule: (
    interval: number | string,
    anchorAt?: number,
  ) => AutomationScheduleDefinition;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly parseJsonText: (raw: string) => JsonRecord | Response;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly resolveAuthenticatedPrincipal: (req: Request) => AuthenticatedPrincipalLike | null;
  /**
   * The request's signal from the auth layer: aborted when the request ends or
   * when the credential it was authenticated with is revoked. Absent, a read
   * follows only the request's own signal.
   */
  readonly requestSignal?: ((req: Request) => AbortSignal | undefined) | undefined;
  readonly knowledgeService: KnowledgeServiceLike;
  readonly knowledgeGraphqlService: KnowledgeGraphqlServiceLike;
}
