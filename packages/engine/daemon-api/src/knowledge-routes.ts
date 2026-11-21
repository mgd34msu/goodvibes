import type { DaemonKnowledgeRouteHandlers } from './context.js';
import { resolvePrivateHostFetchOptions } from './http-policy.js';
import { GoodVibesError, DaemonErrorCategory, readRefusal } from '@goodvibes/engine/errors';
import { authenticationRequiredResponse, jsonErrorResponse, missingScopeRefusal, readServiceErrorResponse } from './error-response.js';
import { decodeCursor, encodeCursor, listingEnvelope } from './pagination.js';
import { createArtifactFromUploadRequest, isArtifactUploadRequest } from './artifact-upload.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  readBoundedBodyInteger,
  readBoundedPositiveInteger,
  readOptionalBoundedInteger,
  readOptionalStringField,
  readSelectionField,
  readStringArrayField,
  refuseEmptySelection,
  type JsonRecord,
} from './route-helpers.js';
import { createDaemonKnowledgeRefinementRouteHandlers } from './knowledge-refinement-routes.js';
import {
  KNOWLEDGE_BROWSER_KINDS,
  KNOWLEDGE_BROWSER_SOURCE_KINDS,
  KNOWLEDGE_CANDIDATE_STATUSES,
  KNOWLEDGE_PACKET_DETAILS,
  KNOWLEDGE_REVIEW_ACTIONS,
  KNOWLEDGE_SOURCE_TYPES,
  KNOWLEDGE_SUBJECT_KINDS,
  KNOWLEDGE_USAGE_KINDS,
  type AutomationScheduleDefinition,
  type DaemonKnowledgeRouteContext,
  type KnowledgeAskRequest,
  type KnowledgeBrowserKind,
  type KnowledgeBrowserSourceKind,
  type KnowledgeMapQuery,
  type KnowledgePacketDetail,
  type KnowledgeProjectionRequest,
  type KnowledgeSourceType,
  type KnowledgeSpaceScope,
  type KnowledgeSubjectKind,
  type KnowledgeScopeReadOptions,
} from './knowledge-route-types.js';

type KnowledgeSearchBody = {
  readonly query: string;
  readonly limit: number;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
};

type KnowledgeAskBody = KnowledgeAskRequest;

type KnowledgePacketBody = {
  readonly task: string;
  readonly writeScope: string[];
  readonly limit: number;
  readonly detail?: KnowledgePacketDetail | undefined;
  readonly budgetLimit?: number | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly includeAllSpaces?: boolean | undefined;
};

type KnowledgeRunJobBody = {
  readonly mode?: 'inline' | 'background' | undefined;
  readonly sourceIds?: string[] | undefined;
  readonly limit?: number | undefined;
};

const MAX_KNOWLEDGE_INGEST_TAGS = 64;

export function createDaemonKnowledgeRouteHandlers(
  context: DaemonKnowledgeRouteContext,
): DaemonKnowledgeRouteHandlers {
  return {
    getKnowledgeStatus: (url, request) => readScopedKnowledgeResponse(context, request, async options =>
      Response.json(await context.knowledgeService.getStatus(readKnowledgeSpaceQuery(url), options))),
    getKnowledgeSources: (url, request) => readScopedKnowledgeResponse(context, request, options => handleGetKnowledgeSources(context, url, options)),
    getKnowledgeNodes: (url, request) => readScopedKnowledgeResponse(context, request, options => handleGetKnowledgeNodes(context, url, options)),
    getKnowledgeIssues: (url, request) => readScopedKnowledgeResponse(context, request, options =>
      readKnowledgeListing(url, 'issues', page => context.knowledgeService.queryIssues({ ...page, ...readKnowledgeSpaceQuery(url) }, options))),
    getKnowledgeItem: (id, url, request) => readScopedKnowledgeResponse(context, request, async options => {
      const item = await context.knowledgeService.getItemScoped(id, readKnowledgeSpaceQuery(url), options);
      return item
        ? Response.json(item)
        : jsonErrorResponse({ error: 'Unknown knowledge item' }, { status: 404 });
    }),
    getKnowledgeConnectors: () => Response.json({ connectors: context.knowledgeService.listConnectors() }),
    getKnowledgeConnector: (id) => {
      const connector = context.knowledgeService.getConnector(id);
      return connector
        ? Response.json({ connector })
        : jsonErrorResponse({ error: 'Unknown knowledge connector' }, { status: 404 });
    },
    getKnowledgeConnectorDoctor: async (id) => {
      const report = await context.knowledgeService.doctorConnector(id);
      return report
        ? Response.json({ report })
        : jsonErrorResponse({ error: 'Unknown knowledge connector' }, { status: 404 });
    },
    getKnowledgeProjectionTargets: (url, request) => readScopedKnowledgeResponse(context, request, async options => Response.json({
      targets: await context.knowledgeService.listProjectionTargets(readLimit(url, 25), readKnowledgeSpaceQuery(url), options),
    })),
    getKnowledgeMap: (url, request) => {
      const filters = readKnowledgeMapFilters(url);
      if (filters instanceof Response) return filters;
      return readScopedKnowledgeResponse(context, request, async options => Response.json(await context.knowledgeService.map({
        limit: readLimit(url, 500),
        includeSources: readBooleanQuery(url, 'includeSources'),
        includeIssues: readBooleanQuery(url, 'includeIssues'),
        includeGenerated: readBooleanQuery(url, 'includeGenerated'),
        ...filters,
      }, options)));
    },
    getKnowledgeGraphqlSchema: () => Response.json({
      language: 'graphql',
      domain: 'knowledge',
      schema: context.knowledgeGraphqlService.schemaText,
    }),
    getKnowledgeExtractions: (url, request) => readScopedKnowledgeResponse(context, request, async options => {
      const sourceId = url.searchParams.get('sourceId') ?? undefined;
      return Response.json({
        extractions: await context.knowledgeService.listExtractions(
          readLimit(url, 100),
          sourceId,
          readKnowledgeSpaceQuery(url),
          options,
        ),
      });
    }),
    getKnowledgeUsage: async (url) => {
      const targetKind = readKnowledgeFilter(url, 'targetKind', KNOWLEDGE_SUBJECT_KINDS);
      if (targetKind instanceof Response) return targetKind;
      const targetId = url.searchParams.get('targetId') ?? undefined;
      const usageKind = readKnowledgeFilter(url, 'usageKind', KNOWLEDGE_USAGE_KINDS);
      if (usageKind instanceof Response) return usageKind;
      return Response.json({
        usage: context.knowledgeService.listUsageRecords(readLimit(url, 100), {
          ...(targetKind ? { targetKind } : {}),
          ...(targetId ? { targetId } : {}),
          ...(usageKind ? { usageKind } : {}),
        }),
      });
    },
    getKnowledgeCandidates: async (url) => {
      const status = readKnowledgeFilter(url, 'status', KNOWLEDGE_CANDIDATE_STATUSES);
      if (status instanceof Response) return status;
      const subjectKind = readKnowledgeFilter(url, 'subjectKind', KNOWLEDGE_SUBJECT_KINDS);
      if (subjectKind instanceof Response) return subjectKind;
      const subjectId = url.searchParams.get('subjectId') ?? undefined;
      return Response.json({
        candidates: context.knowledgeService.listConsolidationCandidates(readLimit(url, 100), {
          ...(status ? { status } : {}),
          ...(subjectKind ? { subjectKind } : {}),
          ...(subjectId ? { subjectId } : {}),
        }),
      });
    },
    getKnowledgeCandidate: (id) => {
      const candidate = context.knowledgeService.getConsolidationCandidate(id);
      return candidate
        ? Response.json({ candidate })
        : jsonErrorResponse({ error: 'Unknown knowledge consolidation candidate' }, { status: 404 });
    },
    getKnowledgeReports: async (url) => Response.json({ reports: context.knowledgeService.listConsolidationReports(readLimit(url, 100)) }),
    getKnowledgeReport: (id) => {
      const report = context.knowledgeService.getConsolidationReport(id);
      return report
        ? Response.json({ report })
        : jsonErrorResponse({ error: 'Unknown knowledge consolidation report' }, { status: 404 });
    },
    getKnowledgeExtraction: (id, url, request) => readScopedKnowledgeResponse(context, request, async options => {
      const extraction = (await context.knowledgeService.listExtractions(1, undefined, { ...readKnowledgeSpaceQuery(url), extractionId: id }, options))[0];
      return extraction
        ? Response.json({ extraction })
        : jsonErrorResponse({ error: 'Unknown knowledge extraction' }, { status: 404 });
    }),
    getKnowledgeSourceExtraction: (id, url, request) => readScopedKnowledgeResponse(context, request, async options => {
      const extraction = (await context.knowledgeService.listExtractions(1, id, readKnowledgeSpaceQuery(url), options))[0];
      return extraction
        ? Response.json({ extraction })
        : jsonErrorResponse({ error: 'Unknown source extraction' }, { status: 404 });
    }),
    getKnowledgeJobs: () => Response.json({ jobs: context.knowledgeService.listJobs() }),
    getKnowledgeJob: (jobId) => {
      const job = context.knowledgeService.getJob(jobId);
      return job
        ? Response.json({ job })
        : jsonErrorResponse({ error: 'Unknown knowledge job' }, { status: 404 });
    },
    getKnowledgeJobRuns: (url) => {
      const jobId = url.searchParams.get('jobId') ?? undefined;
      return Response.json({ runs: context.knowledgeService.listJobRuns(readLimit(url, 25), jobId) });
    },
    ...createDaemonKnowledgeRefinementRouteHandlers(context),
    getKnowledgeSchedules: (url) => Response.json({ schedules: context.knowledgeService.listSchedules(readLimit(url, 100)) }),
    getKnowledgeSchedule: (id) => {
      const schedule = context.knowledgeService.getSchedule(id);
      return schedule
        ? Response.json({ schedule })
        : jsonErrorResponse({ error: 'Unknown knowledge schedule' }, { status: 404 });
    },
    postKnowledgeIngestUrl: async (request) => handleKnowledgeIngestUrl(context, request),
    postKnowledgeIngestArtifact: async (request) => handleKnowledgeIngestArtifact(context, request),
    postKnowledgeSyncBrowserHistory: async (request) => handleKnowledgeSyncBrowserHistory(context, request),
    postKnowledgeImportBookmarks: async (request) => handleKnowledgeImportBookmarks(context, request),
    postKnowledgeImportUrls: async (request) => handleKnowledgeImportUrls(context, request),
    postKnowledgeIngestConnector: async (request) => handleKnowledgeIngestConnector(context, request),
    postKnowledgeSearch: async (request) => handleKnowledgeSearch(context, request),
    postKnowledgeAsk: async (request) => handleKnowledgeAsk(context, request),
    postKnowledgePacket: async (request) => handleKnowledgePacket(context, request),
    postKnowledgeReviewIssue: async (id, request) => handleKnowledgeReviewIssue(context, id, request),
    postKnowledgeDecideCandidate: async (id, request) => handleKnowledgeDecideCandidate(context, id, request),
    postKnowledgeRunJob: async (jobId, request) => handleKnowledgeRunJob(context, jobId, request),
    postKnowledgeCancelJobRun: async (runId, request) => handleKnowledgeCancelJobRun(context, runId, request),
    postKnowledgeLint: async (request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json({ issues: await context.knowledgeService.lint() });
    },
    postKnowledgeReindex: async (request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      return Response.json(await context.knowledgeService.reindex());
    },
    postKnowledgeSaveSchedule: async (request) => handleKnowledgeSaveSchedule(context, request),
    deleteKnowledgeSchedule: async (id, request) => {
      const admin = context.requireAdmin(request);
      if (admin) return admin;
      const deleted = await context.knowledgeService.deleteSchedule(id);
      return deleted
        ? Response.json({ deleted: true })
        : jsonErrorResponse({ error: 'Unknown knowledge schedule' }, { status: 404 });
    },
    postKnowledgeSetScheduleEnabled: async (id, request) => handleKnowledgeSetScheduleEnabled(context, id, request),
    postKnowledgeRenderProjection: async (request) => handleKnowledgeRenderProjection(context, request),
    postKnowledgeMaterializeProjection: async (request) => handleKnowledgeMaterializeProjection(context, request),
    executeKnowledgeGraphql: async (request) => handleKnowledgeGraphql(context, request, 'query'),
    executeKnowledgeGraphqlMutation: async (request) => handleKnowledgeGraphql(context, request, 'mutation'),
  };
}

/**
 * Run one scoped knowledge read for the request's principal.
 *
 * The request is authenticated once, where it entered the daemon; here the
 * principal is only read back. Whether the read is still wanted is the
 * request's signal, which the auth layer also aborts when the credential is
 * revoked, so a check between steps of the read is one property read and never
 * a second authentication.
 */
async function readScopedKnowledgeResponse(
  context: DaemonKnowledgeRouteContext,
  request: Request,
  read: (options: KnowledgeScopeReadOptions) => Promise<Response>,
): Promise<Response> {
  if (!context.resolveAuthenticatedPrincipal(request)) return authenticationRequiredResponse();
  const signal = context.requestSignal?.(request) ?? request.signal;
  const options: KnowledgeScopeReadOptions = { signal, assertCurrent: () => signal.throwIfAborted() };
  try {
    signal.throwIfAborted();
    const response = await read(options);
    signal.throwIfAborted();
    return response;
  } catch (error) {
    if (request.signal.aborted) return jsonErrorResponse({ error: 'Knowledge read canceled.' }, { status: 499 });
    if (signal.aborted) {
      return jsonErrorResponse({
        error: 'The credential this knowledge read was made with was revoked while it ran; nothing was returned.',
        code: 'CREDENTIAL_REVOKED',
        state: 'the credential was revoked',
        next: ['Sign in or pair again, then repeat the read'],
      }, { status: 401 });
    }
    const refused = knowledgeReadRefusal(error, `${request.method} ${new URL(request.url).pathname}`);
    if (refused) return refused;
    throw error;
  }
}

interface HeldReadingAdvice {
  readonly status: number;
  readonly retryable: boolean;
  state(recordId: string | undefined): string;
  next(recordId: string | undefined): readonly string[];
}

const RETRY_WITHOUT_DECISION_MODEL = 'Set judgment.policy to Hybrid (falls back when no decision model answers) or No Decision Model (no decision-model readings), then retry';

/** What each reason a knowledge reading was held means for the caller, and what gets past it. */
const HELD_READING_ADVICE: Readonly<Record<string, HeldReadingAdvice>> = {
  unavailable: {
    status: 503, retryable: true,
    state: () => 'no decision model answered the reading this read needs',
    next: () => ['Start or configure a decision model and retry', RETRY_WITHOUT_DECISION_MODEL],
  },
  uncertain: {
    status: 503, retryable: true,
    state: () => 'the decision model could not settle a reading this read needs',
    next: () => ['Retry the read', RETRY_WITHOUT_DECISION_MODEL],
  },
  stale: {
    status: 409, retryable: true,
    state: (id) => id ? `knowledge record ${id} changed while it was being read` : 'the knowledge store changed while it was being read',
    next: () => ['Retry the read once the write in progress finishes'],
  },
  malformed: {
    status: 500, retryable: false,
    state: (id) => id ? `knowledge record ${id} is malformed` : 'a stored knowledge record is malformed',
    next: (id) => id
      ? [`Fix or forget knowledge record ${id}, then retry`]
      : ['Run POST /api/knowledge/lint to find the malformed record, fix or forget it, then retry'],
  },
  budget: {
    status: 503, retryable: false,
    state: () => 'the read reached its limit of decision-model readings',
    next: () => ['Narrow the read (a smaller limit or one knowledgeSpaceId) and retry', RETRY_WITHOUT_DECISION_MODEL],
  },
};

/**
 * The one refusal a knowledge read answers when the knowledge layer held it:
 * what was being read, why (naming the record when one record caused it), and
 * what to do. An error that already carries a refusal (`state` and `next`) is
 * passed through unchanged.
 */
function knowledgeReadRefusal(error: unknown, what: string): Response | undefined {
  if (!(error instanceof Error)) return undefined;
  const carried = readRefusal(error);
  if (carried) return jsonErrorResponse(error, { status: carried.status ?? 503 });
  if (!/(?:Held|Hold|Stale)Error$/.test(error.name)) return undefined;
  const { reason, recordId } = error as { reason?: unknown; recordId?: unknown };
  const key = typeof reason === 'string' && Object.hasOwn(HELD_READING_ADVICE, reason) ? reason : error.name.endsWith('StaleError') ? 'stale' : 'unavailable';
  const advice = HELD_READING_ADVICE[key]!;
  const id = typeof recordId === 'string' && recordId ? recordId : undefined;
  return jsonErrorResponse({
    error: `${what} was not answered: ${advice.state(id)}.`,
    code: `KNOWLEDGE_READ_${key.toUpperCase()}`,
    state: advice.state(id),
    next: advice.next(id),
    recoverable: advice.retryable,
  }, { status: advice.status });
}

function readLimit(url: URL, fallback: number): number {
  return readBoundedPositiveInteger(url.searchParams.get('limit'), fallback, 1_000);
}

function readBooleanQuery(url: URL, key: string): boolean | undefined {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === '') return undefined;
  return raw === '1' || raw.toLowerCase() === 'true' || raw.toLowerCase() === 'yes';
}

function readKnowledgeSpaceQuery(url: URL): KnowledgeSpaceScope {
  return {
    ...(url.searchParams.get('knowledgeSpaceId') ? { knowledgeSpaceId: url.searchParams.get('knowledgeSpaceId')! } : {}),
    ...(readBooleanQuery(url, 'includeAllSpaces') === true ? { includeAllSpaces: true } : {}),
  };
}

/** The map's query filters; a record kind outside source, node and issue is a 400, not a filter that matches nothing. */
function readKnowledgeMapFilters(url: URL): Omit<KnowledgeMapQuery, 'limit' | 'includeSources' | 'includeIssues' | 'includeGenerated'> | Response {
  const minConfidence = readOptionalBoundedInteger(url.searchParams.get('minConfidence'), 0, 100);
  const requestedKinds = readStringList(url, 'recordKinds', 'recordKind');
  const unknownKind = requestedKinds.find((kind) => !isOneOf(KNOWLEDGE_SUBJECT_KINDS, kind));
  if (unknownKind !== undefined) {
    return jsonErrorResponse({
      error: `recordKinds must be among ${KNOWLEDGE_SUBJECT_KINDS.join(', ')}; got "${unknownKind}". No map was built.`,
      code: 'INVALID_ARGUMENT',
    }, { status: 400 });
  }
  return {
    ...readKnowledgeSpaceQuery(url),
    ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
    ...(minConfidence !== undefined && Number.isFinite(minConfidence) ? { minConfidence } : {}),
    recordKinds: requestedKinds.filter((kind): kind is KnowledgeSubjectKind => isOneOf(KNOWLEDGE_SUBJECT_KINDS, kind)),
    ids: readStringList(url, 'ids', 'id'),
    linkedToIds: readStringList(url, 'linkedToIds', 'linkedToId'),
    nodeKinds: readStringList(url, 'nodeKinds', 'nodeKind'),
    sourceTypes: readStringList(url, 'sourceTypes', 'sourceType'),
    sourceStatuses: readStringList(url, 'sourceStatuses', 'sourceStatus'),
    nodeStatuses: readStringList(url, 'nodeStatuses', 'nodeStatus'),
    issueCodes: readStringList(url, 'issueCodes', 'issueCode'),
    issueStatuses: readStringList(url, 'issueStatuses', 'issueStatus'),
    issueSeverities: readStringList(url, 'issueSeverities', 'issueSeverity'),
    edgeRelations: readStringList(url, 'edgeRelations', 'edgeRelation'),
    tags: readStringList(url, 'tags', 'tag'),
  };
}

function readStringList(url: URL, ...names: readonly string[]): readonly string[] {
  return names
    .flatMap((name) => url.searchParams.getAll(name))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

const knowledgeBodySchemas = createRouteBodySchemaRegistry({
  search: createRouteBodySchema<KnowledgeSearchBody>('POST /api/knowledge/search', (body) => {
    const query = readOptionalStringField(body, 'query');
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    const knowledgeSpaceId = readOptionalStringField(body, 'knowledgeSpaceId');
    return {
      query,
      limit: readBoundedBodyInteger(body.limit, 10, 100),
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
      ...(body.includeAllSpaces === true ? { includeAllSpaces: true } : {}),
    };
  }),
  ask: createRouteBodySchema<KnowledgeAskBody>('POST /api/knowledge/ask', (body) => {
    const query = readOptionalStringField(body, 'query');
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    const mode = readKnowledgeAnswerMode(body.mode);
    const knowledgeSpaceId = readOptionalStringField(body, 'knowledgeSpaceId');
    const candidateSourceIds = readStringArrayField(body, 'candidateSourceIds');
    const candidateNodeIds = readStringArrayField(body, 'candidateNodeIds');
    // An explicit empty candidate list selects nothing; it is never "every source".
    if (candidateSourceIds?.length === 0) return refuseEmptySelection('candidateSourceIds', 'search every source');
    if (candidateNodeIds?.length === 0) return refuseEmptySelection('candidateNodeIds', 'search every node');
    return {
      query,
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
      ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 8, 50) } : {}),
      ...(mode ? { mode } : {}),
      ...(typeof body.includeSources === 'boolean' ? { includeSources: body.includeSources } : {}),
      ...(typeof body.includeConfidence === 'boolean' ? { includeConfidence: body.includeConfidence } : {}),
      ...(typeof body.includeLinkedObjects === 'boolean' ? { includeLinkedObjects: body.includeLinkedObjects } : {}),
      ...(candidateSourceIds ? { candidateSourceIds } : {}),
      ...(candidateNodeIds ? { candidateNodeIds } : {}),
      ...(typeof body.strictCandidates === 'boolean' ? { strictCandidates: body.strictCandidates } : {}),
    };
  }),
  packet: createRouteBodySchema<KnowledgePacketBody>('POST /api/knowledge/packet', (body) => {
    const task = readOptionalStringField(body, 'task');
    if (!task) return jsonErrorResponse({ error: 'Missing task' }, { status: 400 });
    const detail = readKnowledgePacketDetail(body.detail);
    if (detail instanceof Response) return detail;
    const budgetLimit = Object.hasOwn(body, 'budgetLimit')
      ? readBoundedBodyInteger(body.budgetLimit, 6, 100)
      : undefined;
    const knowledgeSpaceId = readOptionalStringField(body, 'knowledgeSpaceId');
    return {
      task,
      writeScope: readStringArrayField(body, 'writeScope') ?? [],
      limit: readBoundedBodyInteger(body.limit, 6, 50),
      ...(detail ? { detail } : {}),
      ...(typeof budgetLimit === 'number' ? { budgetLimit } : {}),
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
      ...(body.includeAllSpaces === true ? { includeAllSpaces: true } : {}),
    };
  }),
  runJob: createRouteBodySchema<KnowledgeRunJobBody>('POST /api/knowledge/jobs/:jobId/run', (body) => {
    const mode = readKnowledgeJobRunMode(body.mode);
    const sourceIds = readStringArrayField(body, 'sourceIds');
    // An explicit empty selection selects nothing; it is never "every source".
    if (sourceIds?.length === 0) return refuseEmptySelection('sourceIds', 'run the job over every source');
    return {
      ...(mode ? { mode } : {}),
      ...(sourceIds ? { sourceIds } : {}),
      ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 50, 500) } : {}),
    };
  }),
});

function isOneOf<T extends string>(accepted: readonly T[], value: string): value is T {
  return (accepted as readonly string[]).includes(value);
}

/**
 * A query filter checked against its accepted values. An empty value is absent;
 * any other value outside the set is a 400 naming the accepted values, because a
 * dropped filter returns every record and a passed-through typo returns none,
 * and either reads as a true answer to the question asked.
 */
function readKnowledgeFilter<T extends string>(url: URL, name: string, accepted: readonly T[]): T | undefined | Response {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return undefined;
  if (isOneOf(accepted, value)) return value;
  return jsonErrorResponse({
    error: `${name} must be one of ${accepted.join(', ')}; got "${value}". No filter was applied.`,
    code: 'INVALID_ARGUMENT',
  }, { status: 400 });
}

/**
 * An ingest's `sourceType`, checked against the store's list. Absent stays absent (the
 * service infers it); an unknown value is a 400 naming the accepted values instead of a
 * source stored under a type no filter or view knows.
 */
function readKnowledgeSourceType(value: unknown): { sourceType?: KnowledgeSourceType } | Response {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string' && isOneOf(KNOWLEDGE_SOURCE_TYPES, value)) {
    return { sourceType: value };
  }
  return jsonErrorResponse({
    error: `sourceType must be one of ${KNOWLEDGE_SOURCE_TYPES.join(', ')}; got ${JSON.stringify(value)}. Nothing was ingested.`,
    code: 'INVALID_ARGUMENT',
  }, { status: 400 });
}

function readKnowledgeAnswerMode(value: unknown): 'concise' | 'standard' | 'detailed' | undefined {
  return value === 'concise' || value === 'standard' || value === 'detailed' ? value : undefined;
}

/** A packet's `detail`: absent stays absent (the service default); a value outside the list is a 400. */
function readKnowledgePacketDetail(value: unknown): KnowledgePacketDetail | undefined | Response {
  if (value === undefined || value === null || value === '') return undefined;
  const detail = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (isOneOf(KNOWLEDGE_PACKET_DETAILS, detail)) return detail;
  return jsonErrorResponse({
    error: `detail must be one of ${KNOWLEDGE_PACKET_DETAILS.join(', ')}; got ${JSON.stringify(value)}.`,
    code: 'INVALID_ARGUMENT',
  }, { status: 400 });
}

function readKnowledgeJobRunMode(value: unknown): 'inline' | 'background' | undefined {
  return value === 'inline' || value === 'background' ? value : undefined;
}

function readKnowledgeProjectionRequest(
  body: JsonRecord,
): KnowledgeProjectionRequest | Response {
  const rawKind = typeof body.kind === 'string' ? body.kind.trim().toLowerCase() : '';
  if (
    rawKind !== 'overview'
    && rawKind !== 'bundle'
    && rawKind !== 'source'
    && rawKind !== 'node'
    && rawKind !== 'issue'
    && rawKind !== 'dashboard'
    && rawKind !== 'rollup'
  ) {
    return jsonErrorResponse({
      error: 'Projection kind must be one of overview, bundle, source, node, issue, dashboard, or rollup.',
      code: 'INVALID_PROJECTION_KIND',
    }, { status: 400 });
  }
  const id = typeof body.id === 'string' ? body.id.trim() : '';
  if ((rawKind === 'source' || rawKind === 'node' || rawKind === 'issue' || rawKind === 'rollup') && !id) {
    return jsonErrorResponse({ error: `Projection kind ${rawKind} requires id.` }, { status: 400 });
  }
  const knowledgeSpaceId = readOptionalStringField(body, 'knowledgeSpaceId');
  return {
    kind: rawKind,
    ...(id ? { id } : {}),
    ...(Object.hasOwn(body, 'limit') ? { limit: readBoundedBodyInteger(body.limit, 20, 500) } : {}),
    ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
    ...(body.includeAllSpaces === true ? { includeAllSpaces: true } : {}),
  };
}

function readKnowledgeSchedule(
  context: DaemonKnowledgeRouteContext,
  value: unknown,
): AutomationScheduleDefinition | Response {
  if (typeof value !== 'object' || value === null) {
    return jsonErrorResponse({ error: 'Missing schedule object' }, { status: 400 });
  }
  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === 'string' ? schedule.kind.trim().toLowerCase() : '';
  try {
    switch (kind) {
      case 'every':
        if (typeof schedule.intervalMs === 'number') {
          return context.normalizeEverySchedule(
            schedule.intervalMs,
            typeof schedule.anchorAt === 'number' ? schedule.anchorAt : undefined,
          );
        }
        if (typeof schedule.interval === 'string') {
          return context.normalizeEverySchedule(
            schedule.interval,
            typeof schedule.anchorAt === 'number' ? schedule.anchorAt : undefined,
          );
        }
        throw new GoodVibesError('Invalid schedule: every schedule requires intervalMs or an interval object. Set schedule.intervalMs (number, in milliseconds) or schedule.interval.', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
      case 'cron':
        if (typeof schedule.expression !== 'string' || !schedule.expression.trim()) {
          throw new GoodVibesError('Invalid schedule: cron schedule requires a cron expression string in schedule.expression (e.g. "0 9 * * 1-5").', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
        }
        return context.normalizeCronSchedule(
          schedule.expression,
          typeof schedule.timezone === 'string' ? schedule.timezone : undefined,
          schedule.staggerMs,
        );
      case 'at':
        if (typeof schedule.at !== 'number') throw new GoodVibesError('Invalid schedule: at schedule requires schedule.at as a Unix timestamp in milliseconds.', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
        return context.normalizeAtSchedule(schedule.at);
      default:
        throw new GoodVibesError('Invalid schedule kind. Expected schedule.kind to be one of: "at", "every", or "cron".', { category: DaemonErrorCategory.BAD_REQUEST, source: 'contract', recoverable: false });
    }
  } catch (error) {
    // Answered at once: every refusal above names its own category, and a
    // normaliser that throws is refusing the caller's schedule.
    return jsonErrorResponse(error, { status: 400 });
  }
}

function readGraphqlVariables(
  value: unknown,
  parseJsonText: DaemonKnowledgeRouteContext['parseJsonText'],
): JsonRecord | Response | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') {
    const parsed = parseJsonText(value);
    if (parsed instanceof Response) return parsed;
    return parsed;
  }
  if (typeof value === 'object') {
    return value as JsonRecord;
  }
  return jsonErrorResponse({ error: 'GraphQL variables must be an object or JSON string.' }, { status: 400 });
}

async function parseKnowledgeGraphqlRequest(
  context: DaemonKnowledgeRouteContext,
  req: Request,
): Promise<{ query: string; operationName?: string; variables?: Record<string, unknown> } | Response> {
  if (req.method === 'GET') {
    const url = new URL(req.url);
    const query = url.searchParams.get('query')?.trim() ?? '';
    if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
    const variables = readGraphqlVariables(url.searchParams.get('variables'), context.parseJsonText);
    if (variables instanceof Response) return variables;
    const operationName = url.searchParams.get('operationName')?.trim();
    return {
      query,
      ...(operationName ? { operationName } : {}),
      ...(variables ? { variables } : {}),
    };
  }

  const contentType = req.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.startsWith('application/graphql')) {
    const query = (await req.text()).trim();
    return query
      ? { query }
      : jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
  }

  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  if (!body) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return jsonErrorResponse({ error: 'Missing query' }, { status: 400 });
  const variables = readGraphqlVariables(body.variables, context.parseJsonText);
  if (variables instanceof Response) return variables;
  const operationName = typeof body.operationName === 'string' ? body.operationName.trim() : '';
  return {
    query,
    ...(operationName ? { operationName } : {}),
    ...(variables ? { variables } : {}),
  };
}

/**
 * Whether every error is the document's own fault (syntax or validation: located in the
 * document, never at a resolver path). An error raised while resolving, such as a store
 * that is unavailable, is a server fault a client may retry.
 */
function graphqlErrorsAreRequestFaults(errors: readonly unknown[]): boolean {
  return errors.every((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { path, locations, extensions } = entry as { path?: unknown; locations?: unknown; extensions?: { code?: unknown } | null };
    const code = extensions?.code;
    if (code === 'GRAPHQL_PARSE_FAILED' || code === 'GRAPHQL_VALIDATION_FAILED' || code === 'BAD_USER_INPUT') return true;
    return path === undefined && Array.isArray(locations);
  });
}

/**
 * One knowledge GraphQL operation. `kind` is the route's: a query on
 * knowledge.graphql.query (a read), a mutation on knowledge.graphql.mutate (a
 * change that also sends outward), so the method a call addresses says what
 * it does, for admission and for the relay's step-up alike. An operation of
 * the other kind is refused naming the method that runs it.
 */
async function handleKnowledgeGraphql(context: DaemonKnowledgeRouteContext, req: Request, kind: 'query' | 'mutation'): Promise<Response> {
  const parsed = await parseKnowledgeGraphqlRequest(context, req);
  if (parsed instanceof Response) return parsed;
  const principal = context.resolveAuthenticatedPrincipal(req);
  if (!principal) {
    return authenticationRequiredResponse();
  }

  let access;
  try {
    access = context.inspectGraphqlAccess(parsed.query, parsed.operationName);
  } catch (error) {
    return jsonErrorResponse(error, { status: 400 });
  }
  // The operation that runs is the parsed one (operationName picks it), not how the document starts.
  if (access.operation === 'mutation' && kind === 'query') {
    return jsonErrorResponse({
      error: 'This is a GraphQL mutation; knowledge.graphql.query runs queries only. Send it to knowledge.graphql.mutate (POST /api/knowledge/graphql/mutate).',
      code: 'GRAPHQL_MUTATION_NOT_ALLOWED',
    }, { status: 400 });
  }
  if (access.operation !== 'mutation' && kind === 'mutation') {
    return jsonErrorResponse({
      error: 'This is a GraphQL query; knowledge.graphql.mutate runs mutations only. Send it to knowledge.graphql.query (POST /api/knowledge/graphql).',
      code: 'GRAPHQL_QUERY_NOT_ALLOWED',
    }, { status: 400 });
  }

  const scopeDenied = missingScopeRefusal('knowledge GraphQL operation', access.requiredScopes, principal.scopes);
  if (scopeDenied) return jsonErrorResponse(scopeDenied, { status: 403 });
  if (access.adminRequired && !principal.admin) {
    return jsonErrorResponse({ error: 'Knowledge GraphQL mutation requires admin access.' }, { status: 403 });
  }

  return readScopedKnowledgeResponse(context, req, async options => {
    const result = await context.knowledgeGraphqlService.execute({
      query: parsed.query,
      ...(parsed.operationName ? { operationName: parsed.operationName } : {}),
      ...(parsed.variables ? { variables: parsed.variables } : {}),
      admin: principal.admin,
      scopes: principal.scopes,
      scopeOptions: options,
    });
    const status = result.errors?.length && !result.data ? (graphqlErrorsAreRequestFaults(result.errors) ? 400 : 500) : 200;
    return Response.json(result, { status });
  });
}

function buildKnowledgePrivateHostFetchOptions(
  context: DaemonKnowledgeRouteContext,
  requested: unknown,
): { allowPrivateHosts: true } | Record<string, never> | Response {
  return resolvePrivateHostFetchOptions(requested, {
    configManager: context.configManager,
  });
}

function isAbsoluteUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

async function handleKnowledgeIngestUrl(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const url = typeof body.url === 'string' ? body.url.trim() : '';
  if (!url) return jsonErrorResponse({ error: 'Missing url' }, { status: 400 });
  if (!isAbsoluteUrl(url)) return jsonErrorResponse({ error: `url is not a valid absolute URL: ${url}`, code: 'INVALID_ARGUMENT' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  const tags = readStringArrayField(body, 'tags', MAX_KNOWLEDGE_INGEST_TAGS);
  const sourceType = readKnowledgeSourceType(body.sourceType);
  if (sourceType instanceof Response) return sourceType;
  try {
    return Response.json(await context.knowledgeService.ingestUrl({
      url,
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...sourceType,
      ...(typeof body.connectorId === 'string' ? { connectorId: body.connectorId } : {}),
      ...(privateHostFetchOptions ?? {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

async function handleKnowledgeIngestArtifact(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;

  if (isArtifactUploadRequest(request)) {
    // Fields are checked before the upload is stored: a refused one stores nothing.
    const uploaded = await createArtifactFromUploadRequest(context.artifactStore, request, (fields) => {
      const checked = readKnowledgeSourceType(fields.sourceType);
      return checked instanceof Response ? checked : undefined;
    });
    if (uploaded instanceof Response) return uploaded;
    let ingested = false;
    try {
      // The artifact is already stored; only descriptive fields carry over. A `uri`, `path` or
      // `allowPrivateHosts` field would let the uploader name the source's provenance or skip
      // the private-host gate that the JSON branch applies.
      const fields = uploaded.fields;
      const uploadSourceType = readKnowledgeSourceType(fields.sourceType);
      if (uploadSourceType instanceof Response) return uploadSourceType;
      const uploadTags = Array.isArray(fields.tags) ? fields.tags.filter((entry): entry is string => typeof entry === 'string').slice(0, MAX_KNOWLEDGE_INGEST_TAGS) : undefined;
      const result = await context.knowledgeService.ingestArtifact({
        artifactId: uploaded.artifactId,
        ...(typeof fields.title === 'string' ? { title: fields.title } : {}),
        ...(typeof fields.folderPath === 'string' ? { folderPath: fields.folderPath } : {}),
        ...(uploadTags && uploadTags.length > 0 ? { tags: uploadTags } : {}),
        ...(typeof fields.sessionId === 'string' ? { sessionId: fields.sessionId } : {}),
        ...uploadSourceType,
        ...(typeof fields.connectorId === 'string' ? { connectorId: fields.connectorId } : {}),
        ...(typeof fields.metadata === 'object' && fields.metadata !== null ? { metadata: fields.metadata as Record<string, unknown> } : {}),
      });
      ingested = true;
      return Response.json(result, { status: 201 });
    } catch (error) {
      return readServiceErrorResponse(error);
    } finally {
      // Stored only for this ingest: one that did not happen leaves no artifact behind.
      if (!ingested) {
        try { context.artifactStore.delete?.(uploaded.artifactId); } catch { /* the store's own sweep retires it */ }
      }
    }
  }

  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  const tags = readStringArrayField(body, 'tags', MAX_KNOWLEDGE_INGEST_TAGS);
  const sourceType = readKnowledgeSourceType(body.sourceType);
  if (sourceType instanceof Response) return sourceType;
  try {
    return Response.json(await context.knowledgeService.ingestArtifact({
      ...(typeof body.artifactId === 'string' ? { artifactId: body.artifactId } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.uri === 'string' ? { uri: body.uri } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.folderPath === 'string' ? { folderPath: body.folderPath } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...sourceType,
      ...(typeof body.connectorId === 'string' ? { connectorId: body.connectorId } : {}),
      ...(privateHostFetchOptions ?? {}),
      ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

/** The caller's provenance object for a batch ingest, when it sent a plain one. */
function readRequestMetadata(body: Record<string, unknown>): { metadata?: Record<string, unknown> } {
  const { metadata } = body;
  return typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) ? { metadata: metadata as Record<string, unknown> } : {};
}

async function handleKnowledgeSyncBrowserHistory(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseOptionalJsonBody(request);
  if (body instanceof Response) return body;
  const input = body ?? {};
  // Each list is a selection: not sent is the documented default (every installed browser; history and
  // bookmarks), an unknown entry is a 400 naming it, and `[]` is a 400: it selects nothing, never "all".
  const sourceKinds = readSelectionField<KnowledgeBrowserSourceKind>(input, 'sourceKinds', KNOWLEDGE_BROWSER_SOURCE_KINDS, { emptyMeans: 'refuse' });
  if (sourceKinds instanceof Response) return sourceKinds;
  const browsers = readSelectionField<KnowledgeBrowserKind>(
    { browsers: Array.isArray(input.browsers) ? input.browsers.map((entry) => typeof entry === 'string' ? entry.toLowerCase() : entry) : input.browsers },
    'browsers', KNOWLEDGE_BROWSER_KINDS, { emptyMeans: 'refuse' });
  if (browsers instanceof Response) return browsers;
  try {
    return Response.json(await context.knowledgeService.syncBrowserHistory({
      ...(Object.hasOwn(input, 'limit') ? { limit: readBoundedBodyInteger(input.limit, 50, 500) } : {}),
      ...(typeof input.sinceMs === 'number' ? { sinceMs: input.sinceMs } : {}),
      ...(typeof input.homeOverride === 'string' ? { homeOverride: input.homeOverride } : {}),
      ...(typeof input.sessionId === 'string' ? { sessionId: input.sessionId } : {}),
      ...(typeof input.connectorId === 'string' ? { connectorId: input.connectorId } : {}),
      ...readRequestMetadata(input),
      ...(browsers.kind === 'default' ? {} : { browsers }),
      ...(sourceKinds.kind === 'default' ? {} : { sourceKinds }),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

async function handleKnowledgeImportBookmarks(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return jsonErrorResponse({ error: 'Missing path' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.importBookmarksFromFile({
      path,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...readRequestMetadata(body),
      ...(privateHostFetchOptions ?? {}),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

async function handleKnowledgeImportUrls(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const path = typeof body.path === 'string' ? body.path.trim() : '';
  if (!path) return jsonErrorResponse({ error: 'Missing path' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.importUrlsFromFile({
      path,
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...readRequestMetadata(body),
      ...(privateHostFetchOptions ?? {}),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

async function handleKnowledgeIngestConnector(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const connectorId = typeof body.connectorId === 'string' ? body.connectorId.trim() : '';
  if (!connectorId) return jsonErrorResponse({ error: 'Missing connectorId' }, { status: 400 });
  const privateHostFetchOptions = buildKnowledgePrivateHostFetchOptions(context, body.allowPrivateHosts);
  if (privateHostFetchOptions instanceof Response) return privateHostFetchOptions;
  try {
    return Response.json(await context.knowledgeService.ingestConnectorInput({
      connectorId,
      ...(Object.hasOwn(body, 'input') ? { input: body.input } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.path === 'string' ? { path: body.path } : {}),
      ...(typeof body.sessionId === 'string' ? { sessionId: body.sessionId } : {}),
      ...readRequestMetadata(body),
      ...(privateHostFetchOptions ?? {}),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

async function handleKnowledgeSearch(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.search.parse(body);
  if (input instanceof Response) return input;
  return readScopedKnowledgeResponse(context, request, async options => Response.json({ results: await context.knowledgeService.searchScoped(input, options) }));
}

async function handleKnowledgeAsk(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.ask.parse(body);
  if (input instanceof Response) return input;
  return readScopedKnowledgeResponse(context, request, async options => Response.json(await context.knowledgeService.ask(input, { signal: options.signal })));
}

async function handleKnowledgePacket(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.packet.parse(body);
  if (input instanceof Response) return input;
  return readScopedKnowledgeResponse(context, request, async options => Response.json(await context.knowledgeService.buildPacket(input.task, input.writeScope, input.limit, {
    ...(input.detail ? { detail: input.detail } : {}),
    ...(typeof input.budgetLimit === 'number' ? { budgetLimit: input.budgetLimit } : {}),
    ...(input.knowledgeSpaceId ? { knowledgeSpaceId: input.knowledgeSpaceId } : {}),
    ...(input.includeAllSpaces === true ? { includeAllSpaces: true } : {}),
    signal: options.signal,
    assertCurrent: options.assertCurrent,
  })));
}

/**
 * A knowledge lookup failure is a 404 only when the service named the missing
 * record with its own code, or the error carries a real HTTP 404. A bare
 * NOT_FOUND code alone is not enough: every category-only not-found error gets
 * that code by inference, and those are not "this record does not exist".
 */
function isKnowledgeNotFound(error: unknown, domainCode: string): boolean {
  if (!(error instanceof Error)) return false;
  const { code, status } = error as { code?: unknown; status?: unknown };
  return code === domainCode || (code === 'NOT_FOUND' && status === 404);
}

async function handleKnowledgeReviewIssue(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseOptionalJsonBody(request);
  if (body instanceof Response) return body;
  const action = typeof body?.action === 'string' ? body.action.trim().toLowerCase() : '';
  if (!isOneOf(KNOWLEDGE_REVIEW_ACTIONS, action)) {
    return jsonErrorResponse({ error: 'Action must be accept, reject, resolve, reopen, edit, or forget.' }, { status: 400 });
  }
  // The reviewer recorded on the issue is who the daemon authenticated, never a name the
  // request body claims: the review history is the audit trail for this decision.
  const principal = context.resolveAuthenticatedPrincipal(request);
  try {
    return Response.json(await context.knowledgeService.reviewIssue({
      issueId: id,
      action,
      ...(principal ? { reviewer: principal.principalId } : {}),
      ...(body?.value && typeof body.value === 'object' && !Array.isArray(body.value) ? { value: body.value as Record<string, unknown> } : {}),
    }));
  } catch (error) {
    return isKnowledgeNotFound(error, 'KNOWLEDGE_ISSUE_NOT_FOUND')
      ? jsonErrorResponse(error, { status: 404 })
      : readServiceErrorResponse(error, { fallbackStatus: 400 });
  }
}

async function handleKnowledgeDecideCandidate(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const decision = typeof body.decision === 'string' ? body.decision.trim().toLowerCase() : '';
  if (decision !== 'accept' && decision !== 'reject' && decision !== 'supersede') {
    return jsonErrorResponse({ error: 'Decision must be accept, reject, or supersede.' }, { status: 400 });
  }
  const principal = context.resolveAuthenticatedPrincipal(request);
  try {
    return Response.json({
      candidate: await context.knowledgeService.decideConsolidationCandidate(id, decision, {
        ...(principal ? { decidedBy: principal.principalId } : {}),
        ...(typeof body.memoryClass === 'string' ? { memoryClass: body.memoryClass } : {}),
        ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
        ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
      }),
    });
  } catch (error) {
    return isKnowledgeNotFound(error, 'KNOWLEDGE_CANDIDATE_NOT_FOUND')
      ? jsonErrorResponse(error, { status: 404 })
      : readServiceErrorResponse(error, { fallbackStatus: 400 });
  }
}

async function handleKnowledgeRunJob(context: DaemonKnowledgeRouteContext, jobId: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const input = knowledgeBodySchemas.runJob.parse(body);
  if (input instanceof Response) return input;
  try {
    return Response.json({
      run: await context.knowledgeService.runJob(jobId, input),
    });
  } catch (error) {
    return isKnowledgeNotFound(error, 'KNOWLEDGE_JOB_NOT_FOUND')
      ? jsonErrorResponse(error, { status: 404 })
      : readServiceErrorResponse(error, { fallbackStatus: 400 });
  }
}

/** Stops a queued or running job run; a finished run or one another process owns is refused with 409 and what to do. */
async function handleKnowledgeCancelJobRun(context: DaemonKnowledgeRouteContext, runId: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const cancel = context.knowledgeService.cancelJobRun;
  if (!cancel) {
    return jsonErrorResponse({ error: 'This daemon cannot cancel knowledge job runs. Wait for the run to finish.', code: 'KNOWLEDGE_JOB_RUN_CANCEL_UNAVAILABLE' }, { status: 501 });
  }
  try {
    return Response.json({ run: await cancel.call(context.knowledgeService, runId) });
  } catch (error) {
    return isKnowledgeNotFound(error, 'KNOWLEDGE_JOB_RUN_NOT_FOUND')
      ? jsonErrorResponse(error, { status: 404 })
      : readServiceErrorResponse(error, { fallbackStatus: 400 });
  }
}

async function handleKnowledgeSaveSchedule(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const jobId = typeof body.jobId === 'string' ? body.jobId.trim() : '';
  if (!jobId) return jsonErrorResponse({ error: 'Missing jobId' }, { status: 400 });
  const schedule = readKnowledgeSchedule(context, body.schedule);
  if (schedule instanceof Response) return schedule;
  try {
    return Response.json({
      schedule: await context.knowledgeService.saveSchedule({
        ...(typeof body.id === 'string' ? { id: body.id } : {}),
        jobId,
        schedule,
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
      }),
    }, { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

async function handleKnowledgeSetScheduleEnabled(context: DaemonKnowledgeRouteContext, id: string, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  if (typeof body.enabled !== 'boolean') {
    return jsonErrorResponse({ error: 'Missing enabled boolean' }, { status: 400 });
  }
  const schedule = await context.knowledgeService.setScheduleEnabled(id, body.enabled);
  return schedule
    ? Response.json({ schedule })
    : jsonErrorResponse({ error: 'Unknown knowledge schedule' }, { status: 404 });
}

async function handleKnowledgeRenderProjection(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = readKnowledgeProjectionRequest(body);
  if (parsed instanceof Response) return parsed;
  return readScopedKnowledgeResponse(context, request, async options => {
    try {
      return Response.json(await context.knowledgeService.renderProjection(parsed, options));
    } catch (error) {
      if (options.signal.aborted) throw error;
      return readServiceErrorResponse(error);
    }
  });
}

async function handleKnowledgeMaterializeProjection(context: DaemonKnowledgeRouteContext, request: Request): Promise<Response> {
  const admin = context.requireAdmin(request);
  if (admin) return admin;
  const body = await context.parseJsonBody(request);
  if (body instanceof Response) return body;
  const parsed = readKnowledgeProjectionRequest(body);
  if (parsed instanceof Response) return parsed;
  try {
    return Response.json(await context.knowledgeService.materializeProjection({
      ...parsed,
      ...(typeof body.filename === 'string' ? { filename: body.filename } : {}),
    }), { status: 201 });
  } catch (error) {
    return readServiceErrorResponse(error);
  }
}

/** Extract the `id` from an opaque knowledge item (sources/nodes are `unknown` at the platform boundary). */
function extractKnowledgeItemId(item: unknown): string | undefined {
  if (typeof item === 'object' && item !== null && 'id' in item) {
    const id = (item as Record<string, unknown>).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
}

/**
 * Extract the `updatedAt` timestamp from an opaque knowledge item for cursor-based
 * pagination recovery.
 *
 * Knowledge source and node records carry a `readonly updatedAt: number` field
 * (see `KnowledgeSourceRecord` / `KnowledgeNodeRecord` in
 * `platform/knowledge/types.ts`).  The production store sorts both collections
 * by `byUpdatedAtDesc` (newest-first by updatedAt), so the cursor's position
 * key MUST encode `updatedAt`, not `createdAt`, to land at the correct
 * insertion point after a mid-walk deletion.
 *
 * Semantic note: `updatedAt` mutates when an item is modified.  A mid-walk
 * update moves the item to the front of the list (it gains a new updatedAt
 * value) and its old position disappears, identical in effect to a deletion.
 * The insertion-point scan (findIndex(ts < cursor.value)) handles this
 * correctly: the old position is gone, so the scan skips past it naturally.
 *
 * Returns `undefined` when the field is absent or not a number (tolerant of
 * missing values at the platform boundary).
 */
function extractKnowledgeItemUpdatedAt(item: unknown): number | undefined {
  if (typeof item === 'object' && item !== null && 'updatedAt' in item) {
    const ts = (item as Record<string, unknown>).updatedAt;
    return typeof ts === 'number' ? ts : undefined;
  }
  return undefined;
}

/** One page request of a newest-first knowledge listing: `after` is null for the first page. */
interface KnowledgeListingPage {
  readonly limit: number;
  readonly after: { readonly updatedAt: number; readonly id: string } | null;
}

/**
 * One knowledge listing (sources, nodes, issues): always the
 * `{ items, hasMore, nextCursor?, <legacyKey> }` envelope, with or without
 * `limit` or `cursor`.
 *
 * The service pages by key: records sort newest first by `updatedAt` (id on
 * ties) and the cursor names the last record's `updatedAt` and id, so a record
 * deleted or updated mid-walk is passed over, never a restart, and the walk
 * reaches every record at any store size. A cursor that cannot be read is
 * refused (400).
 */
async function readKnowledgeListing(
  url: URL,
  legacyKey: string,
  query: (page: KnowledgeListingPage) => Promise<{ readonly total: number; readonly items: readonly unknown[]; readonly hasMore?: boolean | undefined }>,
): Promise<Response> {
  const limit = readLimit(url, 100);
  const rawCursor = url.searchParams.get('cursor');
  let after: KnowledgeListingPage['after'] = null;
  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded || decoded.createdAt === undefined) {
      return jsonErrorResponse({ error: `Invalid cursor: ${rawCursor}. Restart the listing without a cursor.`, code: 'INVALID_CURSOR' }, { status: 400 });
    }
    after = { updatedAt: decoded.createdAt, id: decoded.id };
  }
  const { items, total, hasMore } = await query({ limit, after });
  const page = items.slice(0, limit);
  const more = hasMore ?? (after === null && total > page.length);
  const last = page[page.length - 1];
  const nextCursor = more && last !== undefined
    ? encodeCursor(extractKnowledgeItemId(last) ?? '', extractKnowledgeItemUpdatedAt(last))
    : undefined;
  return Response.json(listingEnvelope(legacyKey, { items: page, hasMore: more, nextCursor }));
}

/** GET /api/knowledge/sources, see {@link readKnowledgeListing}. */
function handleGetKnowledgeSources(
  context: DaemonKnowledgeRouteContext,
  url: URL,
  options: KnowledgeScopeReadOptions,
): Promise<Response> {
  return readKnowledgeListing(url, 'sources', page => context.knowledgeService.querySources({ ...page, ...readKnowledgeSpaceQuery(url) }, options));
}

/** GET /api/knowledge/nodes, see {@link readKnowledgeListing}. */
function handleGetKnowledgeNodes(
  context: DaemonKnowledgeRouteContext,
  url: URL,
  options: KnowledgeScopeReadOptions,
): Promise<Response> {
  return readKnowledgeListing(url, 'nodes', page => context.knowledgeService.queryNodes({ ...page, ...readKnowledgeSpaceQuery(url) }, options));
}
