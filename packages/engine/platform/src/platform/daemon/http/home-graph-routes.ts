import type { HomeGraphService } from '../../knowledge/index.js';
import {
  createArtifactFromUploadRequest,
  isArtifactUploadRequest,
  type ArtifactStoreUploadLike,
} from '@goodvibes-jev/engine/daemon-api';
import type {
  HomeGraphAskInput,
  HomeGraphExport,
  HomeGraphIngestArtifactInput,
  HomeGraphIngestNoteInput,
  HomeGraphIngestUrlInput,
  HomeGraphLinkInput,
  HomeGraphMapInput,
  HomeGraphProjectionInput,
  HomeGraphReviewInput,
  HomeGraphSnapshotInput,
} from '../../knowledge/index.js';
import { readBoundedPositiveInteger, readOptionalBoundedInteger, requireParsedBody, routeFailureResponse } from './route-helpers.js';

type JsonRecord = Record<string, unknown>;

interface HomeGraphRouteContext {
  readonly artifactStore: ArtifactStoreUploadLike;
  readonly homeGraphService: HomeGraphService;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly parseOptionalJsonBody: (req: Request) => Promise<JsonRecord | null | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  /** The authenticated caller's principal id, when the request carries a recognised token. */
  readonly callerId?: ((req: Request) => string | undefined) | undefined;
}

/**
 * The paths the home graph routes serve.
 * Read by the capability-route reconcile, which cannot see a sub-router that is
 * dispatched ahead of the shared route table. `{param}` is one path segment.
 */
export const HOME_GRAPH_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'GET', path: '/api/homeassistant/home-graph/status' },
  { method: 'GET', path: '/api/homeassistant/home-graph/issues' },
  { method: 'GET', path: '/api/homeassistant/home-graph/sources' },
  { method: 'GET', path: '/api/homeassistant/home-graph/pages' },
  { method: 'GET', path: '/api/homeassistant/home-graph/refinement/tasks' },
  { method: 'POST', path: '/api/homeassistant/home-graph/refinement/tasks/{taskId}/cancel' },
  { method: 'GET', path: '/api/homeassistant/home-graph/refinement/tasks/{taskId}' },
  { method: 'POST', path: '/api/homeassistant/home-graph/refinement/run' },
  { method: 'GET', path: '/api/homeassistant/home-graph/browse' },
  { method: 'GET', path: '/api/homeassistant/home-graph/map' },
  { method: 'POST', path: '/api/homeassistant/home-graph/map' },
  { method: 'POST', path: '/api/homeassistant/home-graph/export' },
  { method: 'POST', path: '/api/homeassistant/home-graph/reset' },
  { method: 'POST', path: '/api/homeassistant/home-graph/ask' },
  { method: 'POST', path: '/api/homeassistant/home-graph/reindex' },
  { method: 'POST', path: '/api/homeassistant/home-graph/sync' },
  { method: 'POST', path: '/api/homeassistant/home-graph/ingest/url' },
  { method: 'POST', path: '/api/homeassistant/home-graph/ingest/note' },
  { method: 'POST', path: '/api/homeassistant/home-graph/ingest/artifact' },
  { method: 'POST', path: '/api/homeassistant/home-graph/link' },
  { method: 'POST', path: '/api/homeassistant/home-graph/unlink' },
  { method: 'POST', path: '/api/homeassistant/home-graph/device-passport' },
  { method: 'POST', path: '/api/homeassistant/home-graph/room-page' },
  { method: 'POST', path: '/api/homeassistant/home-graph/packet' },
  { method: 'POST', path: '/api/homeassistant/home-graph/facts/review' },
  { method: 'POST', path: '/api/homeassistant/home-graph/import' },
];

export class HomeGraphRoutes {
  constructor(private readonly context: HomeGraphRouteContext) {}

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    const pathname = normalizeHomeGraphPath(url.pathname);
    if (!pathname.startsWith('/api/homeassistant/home-graph')) return null;
    try {
      if (pathname === '/api/homeassistant/home-graph/status' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.status(readSpaceFromUrl(url)));
      }
      if (pathname === '/api/homeassistant/home-graph/issues' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.listIssues({
          ...readSpaceFromUrl(url),
          status: url.searchParams.get('status') ?? undefined,
          severity: url.searchParams.get('severity') ?? undefined,
          code: url.searchParams.get('code') ?? undefined,
          limit: readLimit(url, 100),
        }));
      }
      if (pathname === '/api/homeassistant/home-graph/sources' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.listSources({
          ...readSpaceFromUrl(url),
          limit: readLimit(url, 100),
        }));
      }
      if (pathname === '/api/homeassistant/home-graph/pages' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.listPages({
          ...readSpaceFromUrl(url),
          limit: readLimit(url, 100),
          includeMarkdown: readBoolean(url, 'includeMarkdown', true),
        }));
      }
      if (pathname === '/api/homeassistant/home-graph/refinement/tasks' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.listRefinementTasks({
          ...readSpaceFromUrl(url),
          limit: readLimit(url, 100),
          state: url.searchParams.get('state') ?? undefined,
          subjectId: url.searchParams.get('subjectId') ?? undefined,
          gapId: url.searchParams.get('gapId') ?? undefined,
        }));
      }
      const refinementTaskCancelMatch = pathname.match(/^\/api\/homeassistant\/home-graph\/refinement\/tasks\/([^/]+)\/cancel$/);
      if (refinementTaskCancelMatch && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.cancelRefinementTask({
          ...readSpaceFromUrl(url),
          taskId: decodeURIComponent(refinementTaskCancelMatch[1]!),
        })));
      }
      const refinementTaskMatch = pathname.match(/^\/api\/homeassistant\/home-graph\/refinement\/tasks\/([^/]+)$/);
      if (refinementTaskMatch && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.getRefinementTask({
          ...readSpaceFromUrl(url),
          taskId: decodeURIComponent(refinementTaskMatch[1]!),
        }));
      }
      if (pathname === '/api/homeassistant/home-graph/refinement/run' && req.method === 'POST') {
        return await this.admin(req, async () => {
          const body = await this.readOptionalBody(req);
          return Response.json(await this.context.homeGraphService.runRefinement({
            ...readSpaceFromUrl(url),
            ...(body ?? {}),
          }));
        });
      }
      if (pathname === '/api/homeassistant/home-graph/browse' && req.method === 'GET') {
        return Response.json(await this.context.homeGraphService.browse({
          ...readSpaceFromUrl(url),
          limit: readLimit(url, 250),
        }));
      }
      if (pathname === '/api/homeassistant/home-graph/map' && (req.method === 'GET' || req.method === 'POST')) {
        const body = req.method === 'POST' ? await this.readOptionalBody(req) : {};
        const result = await this.context.homeGraphService.map({
          ...readSpaceFromUrl(url),
          ...readMapFiltersFromUrl(url),
          ...body,
          limit: readBodyPositiveInteger(body.limit, 1_000) ?? readLimit(url, 500),
          includeSources: readBooleanValue(body.includeSources) ?? readBoolean(url, 'includeSources', true),
          includeIssues: readBooleanValue(body.includeIssues) ?? readBoolean(url, 'includeIssues', false),
          includeGenerated: readBooleanValue(body.includeGenerated) ?? readBoolean(url, 'includeGenerated', true),
        } satisfies HomeGraphMapInput);
        if (url.searchParams.get('format') === 'svg') {
          return new Response(result.svg, {
            headers: {
              'content-type': 'image/svg+xml; charset=utf-8',
            },
          });
        }
        return Response.json(result);
      }
      if (pathname === '/api/homeassistant/home-graph/export' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.exportSpace(await this.readOptionalBody(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/reset' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.resetSpace(await this.readOptionalBody(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/ask' && req.method === 'POST') {
        // Answering also repairs stale extractions, regenerates device pages and queues
        // enrichment. Those writes are admin-only when called directly, so a caller
        // without the admin role gets the answer with the service told not to write.
        const body = await this.readBody<HomeGraphAskInput>(req);
        const readOnly = this.context.requireAdmin(req) !== null;
        const input: HomeGraphAskInput = readOnly ? { ...body, readOnly: true } : body;
        return Response.json(await this.context.homeGraphService.ask(input));
      }
      if (pathname === '/api/homeassistant/home-graph/reindex' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.reindex(await this.readOptionalBody(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/sync' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.syncSnapshot(await this.readBody<HomeGraphSnapshotInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/ingest/url' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.ingestUrl(await this.readBody<HomeGraphIngestUrlInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/ingest/note' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.ingestNote(await this.readBody<HomeGraphIngestNoteInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/ingest/artifact' && req.method === 'POST') {
        return await this.admin(req, async () => {
          if (isArtifactUploadRequest(req)) {
            const uploaded = await createArtifactFromUploadRequest(this.context.artifactStore, req);
            if (uploaded instanceof Response) return uploaded;
            return Response.json(await this.context.homeGraphService.ingestArtifact({
              ...uploaded.fields,
              artifactId: uploaded.artifactId,
            } as unknown as HomeGraphIngestArtifactInput));
          }
          return Response.json(await this.context.homeGraphService.ingestArtifact(await this.readBody<HomeGraphIngestArtifactInput>(req)));
        });
      }
      if (pathname === '/api/homeassistant/home-graph/link' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.linkKnowledge(await this.readBody<HomeGraphLinkInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/unlink' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.unlinkKnowledge(await this.readBody<HomeGraphLinkInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/device-passport' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.refreshDevicePassport(await this.readBody<HomeGraphProjectionInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/room-page' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.generateRoomPage(await this.readBody<HomeGraphProjectionInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/packet' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.generatePacket(await this.readBody<HomeGraphProjectionInput>(req))));
      }
      if (pathname === '/api/homeassistant/home-graph/facts/review' && req.method === 'POST') {
        return await this.admin(req, async () => {
          const body = await this.readBody<HomeGraphReviewInput>(req);
          // The recorded reviewer is the authenticated caller; a name in the body is kept only as what the caller claimed.
          const { reviewer: claimed, ...rest } = body;
          const callerId = this.context.callerId?.(req);
          const input: HomeGraphReviewInput = {
            ...rest,
            ...(callerId ? { reviewer: callerId } : {}),
            ...(typeof claimed === 'string' && claimed.trim() ? { claimedReviewer: claimed.trim() } : {}),
          };
          return Response.json(await this.context.homeGraphService.reviewFact(input));
        });
      }
      if (pathname === '/api/homeassistant/home-graph/import' && req.method === 'POST') {
        return await this.admin(req, async () => Response.json(await this.context.homeGraphService.importSpace(await this.readBody<HomeGraphSpaceImportInput>(req))));
      }
      return Response.json({ error: 'Unknown Home Graph route' }, { status: 404 });
    } catch (error) {
      return routeFailureResponse(error);
    }
  }

  private async admin(req: Request, fn: () => Promise<Response>): Promise<Response> {
    const adminError = this.context.requireAdmin(req);
    if (adminError) return adminError;
    return fn();
  }

  private async readBody<T>(req: Request): Promise<T> {
    const body = await this.context.parseJsonBody(req);
    return requireParsedBody(body) as T;
  }

  private async readOptionalBody(req: Request): Promise<JsonRecord> {
    const body = await this.context.parseOptionalJsonBody(req);
    return requireParsedBody(body) ?? {};
  }
}

function normalizeHomeGraphPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/g, '') : pathname;
}

type HomeGraphSpaceImportInput = {
  readonly installationId?: string | undefined;
  readonly knowledgeSpaceId?: string | undefined;
  readonly data: HomeGraphExport;
};

function readSpaceFromUrl(url: URL): JsonRecord {
  return {
    ...(url.searchParams.get('installationId') ? { installationId: url.searchParams.get('installationId')! } : {}),
    ...(url.searchParams.get('knowledgeSpaceId') ? { knowledgeSpaceId: url.searchParams.get('knowledgeSpaceId')! } : {}),
  };
}

function readLimit(url: URL, fallback: number): number {
  return readBoundedPositiveInteger(url.searchParams.get('limit'), fallback, 1_000);
}

function readBodyPositiveInteger(value: unknown, max: number): number | undefined {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return undefined;
  return Math.min(max, Math.max(1, Math.trunc(parsed)));
}

function readBoolean(url: URL, key: string, fallback: boolean): boolean {
  const value = url.searchParams.get(key);
  if (value === null) return fallback;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function readBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function readMapFiltersFromUrl(url: URL): Partial<HomeGraphMapInput> {
  const minConfidence = readOptionalBoundedInteger(url.searchParams.get('minConfidence'), 0, 100);
  return {
    ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
    ...(url.searchParams.get('cursor') ? { cursor: url.searchParams.get('cursor')! } : {}),
    ...(minConfidence !== undefined ? { minConfidence } : {}),
    recordKinds: readRecordKinds(url, 'recordKinds', 'recordKind'),
    ids: readList(url, 'ids', 'id'),
    linkedToIds: readList(url, 'linkedToIds', 'linkedToId'),
    nodeKinds: readList(url, 'nodeKinds', 'nodeKind'),
    sourceTypes: readList(url, 'sourceTypes', 'sourceType'),
    sourceStatuses: readList(url, 'sourceStatuses', 'sourceStatus'),
    nodeStatuses: readList(url, 'nodeStatuses', 'nodeStatus'),
    issueCodes: readList(url, 'issueCodes', 'issueCode'),
    issueStatuses: readList(url, 'issueStatuses', 'issueStatus'),
    issueSeverities: readList(url, 'issueSeverities', 'issueSeverity'),
    edgeRelations: readList(url, 'edgeRelations', 'edgeRelation'),
    tags: readList(url, 'tags', 'tag'),
    ha: {
      objectKinds: readList(url, 'haObjectKinds', 'haObjectKind', 'objectKind'),
      entityIds: readList(url, 'entityIds', 'entityId'),
      deviceIds: readList(url, 'deviceIds', 'deviceId'),
      areaIds: readList(url, 'areaIds', 'areaId'),
      integrationIds: readList(url, 'integrationIds', 'integrationId'),
      integrationDomains: readList(url, 'integrationDomains', 'integrationDomain'),
      domains: readList(url, 'domains', 'domain'),
      deviceClasses: readList(url, 'deviceClasses', 'deviceClass'),
      labels: readList(url, 'labels', 'label'),
    },
  };
}

function readList(url: URL, ...names: readonly string[]): readonly string[] {
  return names
    .flatMap((name) => url.searchParams.getAll(name))
    .flatMap((value) => value.split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function readRecordKinds(url: URL, ...names: readonly string[]): HomeGraphMapInput['recordKinds'] {
  return readList(url, ...names).filter((value): value is 'source' | 'node' | 'issue' => (
    value === 'source' || value === 'node' || value === 'issue'
  ));
}
