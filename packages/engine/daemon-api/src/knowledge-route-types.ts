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
export type KnowledgePacketDetail = string;

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

export interface KnowledgeServiceLike {
  getStatus(scope?: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<unknown>;
  /** With `after` present (null for the first page): newest first, the `limit` records after that key, and `hasMore`. */
  querySources(input: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<{ readonly total: number; readonly items: readonly unknown[]; readonly hasMore?: boolean | undefined }>;
  queryNodes(input: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<{ readonly total: number; readonly items: readonly unknown[]; readonly hasMore?: boolean | undefined }>;
  queryIssues(input: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<{ readonly total: number; readonly items: readonly unknown[]; readonly hasMore?: boolean | undefined }>;
  reviewIssue(input: Record<string, unknown>): Promise<unknown>;
  getItemScoped(id: string, scope?: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<unknown | null>;
  listConnectors(): readonly unknown[];
  getConnector(id: string): unknown | null;
  doctorConnector(id: string): Promise<unknown | null>;
  listProjectionTargets(limit: number, scope?: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<readonly unknown[]>;
  map(input: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<unknown>;
  /** `scope.extractionId` reads that one extraction (empty when unknown or outside the scope). */
  listExtractions(limit: number, sourceId?: string, scope?: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<readonly unknown[]>;
  listUsageRecords(
    limit: number,
    filter: { targetKind?: 'source' | 'node' | 'issue'; targetId?: string; usageKind?: KnowledgeUsageKind },
  ): readonly unknown[];
  listConsolidationCandidates(
    limit: number,
    filter: { status?: KnowledgeCandidateStatus; subjectKind?: 'source' | 'node' | 'issue'; subjectId?: string },
  ): readonly unknown[];
  getConsolidationCandidate(id: string): unknown | null;
  listConsolidationReports(limit: number): readonly unknown[];
  getConsolidationReport(id: string): unknown | null;
  listJobs(): readonly unknown[];
  getJob(jobId: string): unknown | null;
  listJobRuns(limit: number, jobId?: string): readonly unknown[];
  listRefinementTasks(limit: number, filter: Record<string, unknown>): readonly unknown[];
  getRefinementTask(id: string): unknown | null;
  runRefinement(input: Record<string, unknown>): Promise<unknown>;
  cancelRefinementTask(id: string): Promise<unknown | null>;
  listSchedules(limit: number): readonly unknown[];
  getSchedule(id: string): unknown | null;
  ingestUrl(input: Record<string, unknown>): Promise<unknown>;
  ingestArtifact(input: Record<string, unknown>): Promise<unknown>;
  syncBrowserHistory(input: Record<string, unknown>): Promise<unknown>;
  importBookmarksFromFile(input: Record<string, unknown>): Promise<unknown>;
  importUrlsFromFile(input: Record<string, unknown>): Promise<unknown>;
  ingestConnectorInput(input: Record<string, unknown>): Promise<unknown>;
  searchScoped(input: Record<string, unknown>, options?: KnowledgeScopeReadOptions): Promise<readonly unknown[]>;
  ask(input: Record<string, unknown>, options?: Pick<KnowledgeScopeReadOptions, 'signal'>): Promise<unknown>;
  buildPacket(
    task: string,
    writeScope: readonly string[],
    limit: number,
    options: {
      detail?: KnowledgePacketDetail;
      budgetLimit?: number;
      knowledgeSpaceId?: string;
      includeAllSpaces?: boolean;
      signal?: AbortSignal;
      assertCurrent?: () => void;
    },
  ): Promise<unknown> | unknown;
  decideConsolidationCandidate(
    id: string,
    decision: 'accept' | 'reject' | 'supersede',
    input: Record<string, unknown>,
  ): Promise<unknown>;
  runJob(jobId: string, input: Record<string, unknown>): Promise<unknown>;
  /** Stops a queued or running job run; refuses (409) a run that finished or that another process owns. */
  cancelJobRun?(runId: string): Promise<unknown>;
  lint(): Promise<readonly unknown[]>;
  reindex(): Promise<unknown>;
  saveSchedule(input: {
    readonly id?: string | undefined;
    readonly jobId: string;
    readonly schedule: AutomationScheduleDefinition;
    readonly label?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  }): Promise<unknown>;
  deleteSchedule(id: string): Promise<boolean>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<unknown | null>;
  renderProjection(input: {
    kind: KnowledgeProjectionTargetKind;
    id?: string;
    limit?: number;
    knowledgeSpaceId?: string;
    includeAllSpaces?: boolean;
  }, options?: KnowledgeScopeReadOptions): Promise<unknown>;
  materializeProjection(input: {
    kind: KnowledgeProjectionTargetKind;
    id?: string | undefined;
    limit?: number | undefined;
    filename?: string | undefined;
    knowledgeSpaceId?: string | undefined;
    includeAllSpaces?: boolean | undefined;
  }): Promise<unknown>;
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
