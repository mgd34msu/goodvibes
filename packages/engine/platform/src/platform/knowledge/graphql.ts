/**
 * graphql.ts, the knowledge GraphQL service.
 *
 * `graphql` is an optionalDependency and is reached only through
 * `graphqlModule()` / `primeGraphqlModule()` in ./graphql-schema.js. The two
 * class-static initialisers here, `buildSchema(KNOWLEDGE_GRAPHQL_SDL)` and
 * `printSchema(...)`, ran at MODULE INIT, which made an install without the
 * package a daemon that could not start rather than a GraphQL surface that
 * reports itself unavailable. They are lazily-computed accessors now, built on
 * first use and then cached, so the schema is still parsed and printed exactly
 * once per process. See ./graphql-schema.js and utils/optional-dependency.ts.
 */

import type { GraphQLSchema } from 'graphql';
import type { KnowledgeService } from './service.js';
import {
  KNOWLEDGE_GRAPHQL_SDL,
  clampInt,
  clampOffset,
  graphqlModule,
  installJsonScalar,
  mapJob,
  mapJobRun,
  mapPacket,
  mapProjectionBundle,
  mapProjectionTarget,
  pickOperation,
  primeGraphqlModule,
  toJobMode,
  toPacketDetail,
  toProjectionKind,
} from './graphql-schema.js';
import type { KnowledgeSpaceScopeInput } from './spaces.js';
import { KnowledgeScopeSelectionHeldError, type KnowledgeScopeSelectionOptions } from './scope-selection.js';

export interface KnowledgeGraphqlAccessProfile {
  readonly operation: 'query' | 'mutation';
  readonly requiredScopes: readonly string[];
  readonly adminRequired: boolean;
}

export function inspectKnowledgeGraphqlAccess(
  source: string,
  operationName?: string,
): KnowledgeGraphqlAccessProfile {
  const document = graphqlModule().parse(source);
  const operation = pickOperation(document, operationName);
  return operation === 'mutation'
    ? { operation, requiredScopes: ['write:knowledge'], adminRequired: true }
    : { operation, requiredScopes: ['read:knowledge'], adminRequired: false };
}

interface KnowledgeGraphqlContext {
  readonly service: KnowledgeService;
  readonly admin: boolean;
  readonly scopes: readonly string[];
}

function assertWriteAccess(context: KnowledgeGraphqlContext): void {
  const { GraphQLError } = graphqlModule();
  if (!context.admin) {
    throw new GraphQLError('Knowledge GraphQL mutation requires admin access.');
  }
  if (!context.scopes.includes('write:knowledge')) {
    throw new GraphQLError('Knowledge GraphQL mutation requires write:knowledge.');
  }
}

export interface KnowledgeGraphqlExecuteInput {
  readonly query: string;
  readonly operationName?: string | undefined;
  readonly variables?: Record<string, unknown> | undefined;
  readonly admin: boolean;
  readonly scopes: readonly string[];
  readonly scopeOptions?: Pick<KnowledgeScopeSelectionOptions, 'signal' | 'assertCurrent' | 'shouldStop'> | undefined;
}

export class KnowledgeGraphqlService {
  private static cachedSchema: GraphQLSchema | undefined;
  private static cachedSchemaSdl: string | undefined;

  /**
   * The parsed schema, built on first use. This was a class-static
   * initialiser, which ran `buildSchema` at module init and so required
   * `graphql`, an optionalDependency, for the module to load at all.
   */
  private static get schema(): GraphQLSchema {
    if (!KnowledgeGraphqlService.cachedSchema) {
      const schema = graphqlModule().buildSchema(KNOWLEDGE_GRAPHQL_SDL);
      installJsonScalar(schema);
      KnowledgeGraphqlService.cachedSchema = schema;
    }
    return KnowledgeGraphqlService.cachedSchema;
  }

  /** The printed schema text, computed on first use for the same reason. */
  static get schemaSdl(): string {
    KnowledgeGraphqlService.cachedSchemaSdl ??= graphqlModule().printSchema(KnowledgeGraphqlService.schema);
    return KnowledgeGraphqlService.cachedSchemaSdl;
  }

  constructor(private readonly service: KnowledgeService) {
    // Resolve `graphql` now, through the dynamic import a bundler follows, so
    // a compiled binary has the bundled module in hand before any route reads
    // `schemaText`, which the daemon-api route contract requires to be a
    // synchronous string. Never rejects; an absent package is remembered and
    // reported by the accessors that need it.
    void primeGraphqlModule();
  }

  get schemaText(): string {
    return KnowledgeGraphqlService.schemaSdl;
  }

  async execute(input: KnowledgeGraphqlExecuteInput) {
    const context: KnowledgeGraphqlContext = {
      service: this.service,
      admin: input.admin,
      scopes: [...input.scopes],
    };
    const providedScopeOptions = input.scopeOptions;
    const scopeOptions = providedScopeOptions ?? {};
    const signal = scopeOptions.signal;
    const shouldStop = scopeOptions.shouldStop;
    const callerCurrent = scopeOptions.assertCurrent;
    const assertCurrent = () => {
      if (input.scopeOptions !== providedScopeOptions || scopeOptions.signal !== signal
        || scopeOptions.shouldStop !== shouldStop || scopeOptions.assertCurrent !== callerCurrent) {
        throw new KnowledgeScopeSelectionHeldError('stale');
      }
      if (signal?.aborted || shouldStop?.()) throw new KnowledgeScopeSelectionHeldError('aborted');
      callerCurrent?.();
    };
    assertCurrent();
    const primed = await primeGraphqlModule();
    assertCurrent();
    if (!primed.available) throw new Error(primed.reason);
    const { graphql } = graphqlModule();
    const rootValue = this.createRootValue({ signal, shouldStop, assertCurrent });
    const result = await graphql({
      schema: KnowledgeGraphqlService.schema,
      source: input.query,
      rootValue,
      contextValue: context,
      variableValues: input.variables,
      operationName: input.operationName,
    });
    assertCurrent();
    return result;
  }

  /**
   * One resolver per field the schema declares: graphql-js reads `rootValue[field]`,
   * so a field with no entry here answers with a null-field error that names nothing
   * about the cause. The schema test walks both lists and keeps them equal.
   */
  private createRootValue(scopeOptions: KnowledgeScopeSelectionOptions) {
    const listUsage = ({ limit, targetKind, targetId, usageKind }: { limit?: number; targetKind?: 'source' | 'node' | 'issue'; targetId?: string; usageKind?: string }) => (
      this.service.listUsageRecords(clampInt(limit, 100), {
        ...(targetKind ? { targetKind } : {}),
        ...(targetId ? { targetId } : {}),
        ...(usageKind ? { usageKind: usageKind as 'search-hit' | 'packet-item' | 'item-open' | 'neighbor-open' | 'projection-read' | 'multimodal-writeback' } : {}),
      })
    );
    return {
      status: async (args: { knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => this.service.getStatus(graphqlScope(args), scopeOptions),
      sources: async (args: { limit?: number; offset?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => (
        await this.service.querySources({
          limit: clampInt(args.limit, 100),
          offset: clampOffset(args.offset),
          ...graphqlScope(args),
        }, scopeOptions)
      ).items,
      nodes: async (args: { limit?: number; offset?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => (
        await this.service.queryNodes({
          limit: clampInt(args.limit, 100),
          offset: clampOffset(args.offset),
          ...graphqlScope(args),
        }, scopeOptions)
      ).items,
      issues: async (args: { limit?: number; offset?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => (
        await this.service.queryIssues({
          limit: clampInt(args.limit, 100),
          offset: clampOffset(args.offset),
          ...graphqlScope(args),
        }, scopeOptions)
      ).items,
      itemView: async ({ kind, id }: { kind: string; id: string }) => {
        if (kind !== 'source' && kind !== 'node' && kind !== 'issue') {
          throw new (graphqlModule().GraphQLError)(`Unsupported knowledge item kind: ${kind}`);
        }
        const item = await this.service.getItemScoped(id, {}, scopeOptions);
        return item?.[kind] ? item : null;
      },
      extractions: async (args: { limit?: number; sourceId?: string; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => (
        await this.service.listExtractions(clampInt(args.limit, 100), args.sourceId, graphqlScope(args), scopeOptions)
      ).slice(0, clampInt(args.limit, 100)),
      sourceExtraction: async ({ sourceId }: { sourceId: string }) => (await this.service.listExtractions(1, sourceId, {}, scopeOptions))[0] ?? null,
      neighbors: async ({ kind, id, relation, limit }: { kind: 'source' | 'node'; id: string; relation?: string | undefined; limit?: number }) => {
        if (kind !== 'source' && kind !== 'node') {
          throw new (graphqlModule().GraphQLError)(`Unsupported knowledge neighbor kind: ${kind}`);
        }
        return (await this.service.getNeighbors(kind, id, { relation, limit: clampInt(limit, 20) }, scopeOptions)).edges;
      },
      search: async (args: { query: string; limit?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => (
        this.service.searchScoped({
          query: args.query,
          limit: clampInt(args.limit, 10),
          ...graphqlScope(args),
        }, scopeOptions)
      ),
      packet: async (args: {
        task: string;
        writeScope?: string[];
        limit?: number;
        detail?: string;
        budgetLimit?: number;
        knowledgeSpaceId?: string;
        includeAllSpaces?: boolean;
      }) => mapPacket(await this.service.buildPacket(
        args.task,
        args.writeScope ?? [],
        clampInt(args.limit, 6),
        {
          ...scopeOptions,
          detail: toPacketDetail(args.detail),
          ...(typeof args.budgetLimit === 'number' ? { budgetLimit: args.budgetLimit } : {}),
          ...graphqlScope(args),
        },
      )),
      connectors: () => this.service.listConnectors(),
      connectorDoctor: ({ id }: { id: string }) => this.service.doctorConnector(id),
      projectionTargets: async (args: { limit?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => (
        await this.service.listProjectionTargets(clampInt(args.limit, 25), graphqlScope(args), scopeOptions)
      ).map((target) => mapProjectionTarget(target)),
      projection: async (args: { kind: string; id?: string; limit?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean }) => mapProjectionBundle(await this.service.renderProjection({
        kind: toProjectionKind(args.kind),
        id: args.id,
        limit: clampInt(args.limit, 12),
        ...graphqlScope(args),
      }, scopeOptions)),
      jobs: () => this.service.listJobs().map((job) => mapJob(job)),
      job: ({ id }: { id: string }) => {
        const job = this.service.getJob(id);
        return job ? mapJob(job) : null;
      },
      jobRuns: ({ limit, jobId }: { limit?: number; jobId?: string }) => this.service.listJobRuns(clampInt(limit, 25), jobId).map((run) => mapJobRun(run)),
      usage: listUsage,
      usageRecords: listUsage,
      consolidationCandidates: ({ limit, status, subjectKind, subjectId }: { limit?: number; status?: string; subjectKind?: 'source' | 'node' | 'issue'; subjectId?: string }) => (
        this.service.listConsolidationCandidates(clampInt(limit, 100), {
          ...(status ? { status: status as 'open' | 'accepted' | 'rejected' | 'superseded' } : {}),
          ...(subjectKind ? { subjectKind } : {}),
          ...(subjectId ? { subjectId } : {}),
        })
      ),
      consolidationReports: ({ limit }: { limit?: number }) => this.service.listConsolidationReports(clampInt(limit, 100)),
      schedules: ({ limit }: { limit?: number }) => this.service.listSchedules(clampInt(limit, 100)),
      ingestUrl: async (
        args: {
          url: string;
          title?: string | undefined;
          tags?: string[] | undefined;
          folderPath?: string | undefined;
          sessionId?: string | undefined;
          sourceType?: string | undefined;
          connectorId?: string | undefined;
          allowPrivateHosts?: boolean | undefined;
          metadata?: Record<string, unknown> | undefined;
        },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const result = await this.service.ingestUrl({
          url: args.url,
          title: args.title,
          tags: args.tags,
          folderPath: args.folderPath,
          sessionId: args.sessionId,
          sourceType: args.sourceType as Parameters<KnowledgeService['ingestUrl']>[0]['sourceType'],
          connectorId: args.connectorId,
          allowPrivateHosts: args.allowPrivateHosts,
          metadata: args.metadata,
        });
        return result.source;
      },
      ingestArtifact: async (
        args: {
          artifactId?: string | undefined;
          path?: string | undefined;
          uri?: string | undefined;
          title?: string | undefined;
          tags?: string[] | undefined;
          folderPath?: string | undefined;
          sessionId?: string | undefined;
          sourceType?: string | undefined;
          connectorId?: string | undefined;
          allowPrivateHosts?: boolean | undefined;
          metadata?: Record<string, unknown> | undefined;
        },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const result = await this.service.ingestArtifact({
          artifactId: args.artifactId,
          path: args.path,
          uri: args.uri,
          title: args.title,
          tags: args.tags,
          folderPath: args.folderPath,
          sessionId: args.sessionId,
          sourceType: args.sourceType as Parameters<KnowledgeService['ingestArtifact']>[0]['sourceType'],
          connectorId: args.connectorId,
          allowPrivateHosts: args.allowPrivateHosts,
          metadata: args.metadata,
        });
        return result.source;
      },
      importBookmarksFromFile: async (args: { path: string; sessionId?: string; allowPrivateHosts?: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.importBookmarksFromFile(args);
      },
      importUrlsFromFile: async (args: { path: string; sessionId?: string; allowPrivateHosts?: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.importUrlsFromFile(args);
      },
      ingestBookmarkSeeds: async (args: { seeds: string[]; connectorId?: string; sessionId?: string }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.ingestBookmarkSeeds(
          args.seeds.map((url) => ({ url })),
          args.sessionId,
          'bookmark',
          args.connectorId ?? 'bookmark',
        );
      },
      ingestWithConnector: async (args: { connectorId: string; input: string; sessionId?: string; allowPrivateHosts?: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.ingestWithConnector(args.connectorId, args.input, args.sessionId, args.allowPrivateHosts);
      },
      ingestConnectorInput: async (args: { input: string; connectorId?: string; sessionId?: string; allowPrivateHosts?: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        if (!args.connectorId) throw new (graphqlModule().GraphQLError)('ingestConnectorInput needs a connectorId; list the available ones with the connectors query.');
        return this.service.ingestConnectorInput({
          connectorId: args.connectorId,
          content: args.input,
          ...(args.sessionId !== undefined ? { sessionId: args.sessionId } : {}),
          ...(args.allowPrivateHosts !== undefined ? { allowPrivateHosts: args.allowPrivateHosts } : {}),
        });
      },
      lint: async (_args: Record<string, never>, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.lint();
      },
      reindex: async (_args: Record<string, never>, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.reindex();
      },
      runJob: async (args: { id: string; mode?: string; sourceIds?: string[]; limit?: number }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return mapJobRun(await this.service.runJob(args.id, {
          ...(args.mode ? { mode: toJobMode(args.mode) } : {}),
          ...(args.sourceIds ? { sourceIds: args.sourceIds } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        }));
      },
      decideConsolidationCandidate: async (args: { id: string; status: string; decidedBy?: string; memoryClass?: string; scope?: string; detail?: string }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        const decision = CANDIDATE_DECISIONS[args.status];
        if (!decision) {
          throw new (graphqlModule().GraphQLError)(`Unsupported candidate status "${args.status}". Use accepted, rejected or superseded.`);
        }
        return this.service.decideConsolidationCandidate(args.id, decision, {
          decidedBy: args.decidedBy,
          memoryClass: args.memoryClass,
          scope: args.scope,
          detail: args.detail,
        });
      },
      saveSchedule: async (args: { id?: string; jobId: string; label?: string; enabled?: boolean; schedule: Record<string, unknown> }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.saveSchedule({
          id: args.id,
          jobId: args.jobId,
          label: args.label,
          enabled: args.enabled,
          schedule: args.schedule as unknown as Parameters<KnowledgeService['saveSchedule']>[0]['schedule'],
        });
      },
      deleteSchedule: async (args: { id: string }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.deleteSchedule(args.id);
      },
      setScheduleEnabled: async (args: { id: string; enabled: boolean }, context: KnowledgeGraphqlContext) => {
        assertWriteAccess(context);
        return this.service.setScheduleEnabled(args.id, args.enabled);
      },
      renderProjection: async (
        args: { kind: string; id?: string; limit?: number; knowledgeSpaceId?: string; includeAllSpaces?: boolean },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        return mapProjectionBundle(await this.service.renderProjection({
          kind: toProjectionKind(args.kind),
          id: args.id,
          limit: clampInt(args.limit, 12),
          ...graphqlScope(args),
        }, scopeOptions));
      },
      materializeProjection: async (
        args: { kind: string; id?: string; limit?: number; filename?: string; knowledgeSpaceId?: string; includeAllSpaces?: boolean },
        context: KnowledgeGraphqlContext,
      ) => {
        assertWriteAccess(context);
        const materialized = await this.service.materializeProjection({
          kind: toProjectionKind(args.kind),
          id: args.id,
          limit: clampInt(args.limit, 12),
          filename: args.filename,
          ...graphqlScope(args),
        }, scopeOptions);
        return {
          ...materialized,
          bundle: mapProjectionBundle(materialized.bundle),
        };
      },
    };
  }
}

const CANDIDATE_DECISIONS: Readonly<Record<string, 'accept' | 'reject' | 'supersede'>> = Object.assign(Object.create(null) as Record<string, 'accept' | 'reject' | 'supersede'>, {
  accepted: 'accept', accept: 'accept', rejected: 'reject', reject: 'reject', superseded: 'supersede', supersede: 'supersede',
});

function graphqlScope(input: KnowledgeSpaceScopeInput = {}): KnowledgeSpaceScopeInput {
  return {
    ...(typeof input.knowledgeSpaceId === 'string' && input.knowledgeSpaceId.trim()
      ? { knowledgeSpaceId: input.knowledgeSpaceId }
      : {}),
    ...(input.includeAllSpaces === true ? { includeAllSpaces: true } : {}),
  };
}

export function getKnowledgeGraphqlSchemaText(): string {
  return KnowledgeGraphqlService.schemaSdl;
}
