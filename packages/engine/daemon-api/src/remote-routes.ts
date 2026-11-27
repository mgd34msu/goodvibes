import { getPeerEndpoint, type PeerEndpointContract } from '@goodvibes/engine/contracts';
import type { DaemonRemoteManagementRouteHandlers } from './context.js';
import { jsonErrorResponse, readJsonErrorResponse, serviceFailureStatus } from './error-response.js';
import { requestActor } from './http-policy.js';
import type { Selection } from '@goodvibes/engine/errors';
import { keepReachableNaming } from './pagination.js';
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  isJsonRecord,
  readOptionalStringField,
  readStringArrayField,
  serializableJsonResponse,
  type JsonRecord,
  type RouteBodySchema,
} from './route-helpers.js';

/**
 * The auth object the remote route handlers carry through untouched.
 *
 * Exported because a host composing these handlers has to name the type in its
 * own signatures, and a declaration it cannot import is a declaration it copies:
 * the daemon product mirrored this alias and the 17-method service interface
 * below by hand, verbatim, purely because neither carried the keyword.
 */
export type RemotePeerAuth = unknown;
const MAX_REMOTE_RESULT_BYTES = 1_000_000;
const MAX_REMOTE_PAYLOAD_BYTES = 1_000_000;
const MAX_REMOTE_CAPABILITIES = 128;
const MAX_REMOTE_COMMANDS = 128;
const MAX_REMOTE_SCOPES = 128;

/**
 * The endpoints a paired peer calls, by their id in the published peer
 * contract. Their method, path, required scope and body fields are read from
 * that contract, so the routes the daemon serves and the contract a peer is
 * built against are one description.
 */
export type PeerRouteId = 'pair.request' | 'pair.verify' | 'peer.heartbeat' | 'work.pull' | 'work.complete';
const PEER_ROUTE_IDS: readonly PeerRouteId[] = ['pair.request', 'pair.verify', 'peer.heartbeat', 'work.pull', 'work.complete'];

/** A request matched to a peer endpoint, with the path parameters its contract path names (such as `workId`). */
export interface PeerRouteMatch {
  readonly id: PeerRouteId;
  readonly params: Readonly<Record<string, string>>;
}

interface PeerRoute {
  readonly id: PeerRouteId;
  readonly endpoint: PeerEndpointContract;
  readonly pattern: RegExp;
  readonly paramNames: readonly string[];
}

/** Daemon bounds on body fields the contract types but does not limit. */
type PeerFieldLimits = Readonly<Record<string, { readonly min?: number | undefined; readonly max: number }>>;

let peerRoutes: ReadonlyMap<PeerRouteId, PeerRoute> | undefined;

function compilePeerRoute(id: PeerRouteId): PeerRoute {
  const endpoint = getPeerEndpoint(id);
  if (!endpoint) throw new Error(`The published peer contract has no "${id}" endpoint, so the daemon cannot serve it.`);
  if (endpoint.auth === 'bearer-peer-token' && !endpoint.requiredScope) {
    throw new Error(`The published peer contract's "${id}" endpoint takes a peer token but names no required scope.`);
  }
  const paramNames: string[] = [];
  const source = endpoint.path.split('/').map((segment) => {
    const param = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(segment);
    if (param) {
      paramNames.push(param[1]!);
      return '([^/]+)';
    }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { id, endpoint, pattern: new RegExp(`^${source}$`), paramNames };
}

function peerRouteTable(): ReadonlyMap<PeerRouteId, PeerRoute> {
  peerRoutes ??= new Map(PEER_ROUTE_IDS.map((id) => [id, compilePeerRoute(id)]));
  return peerRoutes;
}

function peerRoute(id: PeerRouteId): PeerRoute {
  return peerRouteTable().get(id)!;
}

/** The peer endpoint a request is for, by the contract's method and path; null when it is not one. */
export function matchPeerRoute(method: string, pathname: string): PeerRouteMatch | null {
  if (!pathname.startsWith('/api/remote/')) return null;
  for (const route of peerRouteTable().values()) {
    if (route.endpoint.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = match[index + 1]!;
    });
    return { id: route.id, params };
  }
  return null;
}

/** The scope a peer token must hold to call this endpoint, as the contract states it. */
function peerRouteScope(id: PeerRouteId): string | undefined {
  return peerRoute(id).endpoint.requiredScope;
}

/**
 * A body reader built from the endpoint's input schema in the peer contract:
 * each declared property is read by its declared type, an `enum` value outside
 * the list and a missing `required` field are refused naming the field, and
 * path parameters are left to the path. `limits` bounds numbers and lists.
 */
function peerBodySchema<T>(id: PeerRouteId, limits: PeerFieldLimits = {}): RouteBodySchema<T> {
  // The contract is read on the first request, not when this module loads.
  return createRouteBodySchema<T>(`peer ${id}`, (body) => {
    const read = readPeerBody(peerRoute(id), body, limits);
    // The reader produced exactly the fields the contract's input schema declares.
    return read instanceof Response ? read : read as unknown as T;
  });
}

function readPeerBody(route: PeerRoute, body: JsonRecord, limits: PeerFieldLimits): JsonRecord | Response {
  const schema = route.endpoint.inputSchema ?? {};
  const properties = isJsonRecord(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((field): field is string => typeof field === 'string') : []);
  const target = `${route.endpoint.method} ${route.endpoint.path}`;
  const output: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(properties)) {
    if (route.paramNames.includes(field)) continue;
    const property = isJsonRecord(declared) ? declared : {};
    const allowed = Array.isArray(property.enum) ? property.enum : undefined;
    const value = readPeerField(body, field, property, limits[field]);
    if (allowed && value !== undefined && !allowed.includes(value)) {
      return jsonErrorResponse({
        error: `${field} must be one of ${allowed.map(String).join(', ')} for ${target}`,
        code: 'INVALID_ARGUMENT',
        state: `${field} was ${JSON.stringify(value)}`,
        next: [`Send ${field} as one of ${allowed.map(String).join(', ')}.`],
      }, { status: 400 });
    }
    if (value === undefined) {
      if (required.has(field)) {
        return jsonErrorResponse({
          error: `Missing ${field} for ${target}`,
          code: 'INVALID_ARGUMENT',
          state: `the request body has no ${field}`,
          next: [`Send ${field}; the peer contract lists it as required for ${target}.`],
        }, { status: 400 });
      }
      continue;
    }
    output[field] = value;
  }
  return output;
}

function readPeerField(
  body: JsonRecord,
  field: string,
  property: Readonly<Record<string, unknown>>,
  limit: PeerFieldLimits[string] | undefined,
): unknown {
  switch (property.type) {
    case 'string':
      return readOptionalStringField(body, field);
    case 'number':
    case 'integer': {
      const value = body[field];
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
      return limit ? boundedPositiveNumber(value, limit.min ?? 0, limit.max) : value;
    }
    case 'boolean':
      return typeof body[field] === 'boolean' ? body[field] : undefined;
    case 'array':
      // Not sent stays undefined; an explicit `[]` stays `[]` (a heartbeat with `commands: []`
      // clears the stored list; one without `commands` keeps it).
      return readStringArrayField(body, field, limit?.max);
    case 'object':
      return readRemoteMetadata(body[field]);
    default:
      // A field the contract leaves open (a work result) is passed on as sent.
      return body[field];
  }
}

/** The service surface the remote management routes call into. See {@link RemotePeerAuth}. */
export interface DistributedRuntimeRouteService {
  listPairRequests(): unknown;
  approvePairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null>;
  rejectPairRequest(requestId: string, input: Record<string, unknown>): Promise<unknown | null>;
  listPeers(kind?: 'node' | 'device', limit?: number): unknown;
  getPeer(peerId: string): unknown | null;
  rotatePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  revokePeerToken(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  disconnectPeer(peerId: string, input: Record<string, unknown>): Promise<unknown | null>;
  listWork(): unknown;
  invokePeer(input: Record<string, unknown>): Promise<unknown>;
  cancelWork(workId: string, input: Record<string, unknown>): Promise<unknown | null>;
  getNodeHostContract(): unknown;
  requestPairing(input: Record<string, unknown>): Promise<unknown>;
  verifyPairRequest(requestId: string, challenge: string, input: Record<string, unknown>): Promise<unknown | null>;
  heartbeatPeer(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown>;
  claimWork(auth: RemotePeerAuth, input: Record<string, unknown>): Promise<unknown>;
  completeWork(auth: RemotePeerAuth, workId: string, input: Record<string, unknown>): Promise<unknown | null>;
}

interface SessionUserLike {
  readonly username: string;
}

type RemoteMetadata = Record<string, unknown>;

type RemotePairRequestBody = {
  readonly peerKind: 'device' | 'node';
  readonly requestedId?: string | undefined;
  readonly label: string;
  readonly platform?: string | undefined;
  readonly deviceFamily?: string | undefined;
  readonly version?: string | undefined;
  readonly clientMode?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly metadata: RemoteMetadata;
  readonly ttlMs?: number | undefined;
};

type RemotePairVerifyBody = {
  readonly requestId: string;
  readonly challenge: string;
  readonly metadata: RemoteMetadata;
};

type RemotePeerHeartbeatBody = {
  readonly capabilities?: readonly string[] | undefined;
  readonly commands?: readonly string[] | undefined;
  readonly version?: string | undefined;
  readonly clientMode?: string | undefined;
  readonly metadata: RemoteMetadata;
};

type RemoteWorkPullBody = {
  readonly maxItems?: number | undefined;
  readonly leaseMs?: number | undefined;
};

type RemoteWorkCompleteBody = {
  readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  readonly result: unknown;
  readonly error?: string | undefined;
  readonly metadata: RemoteMetadata;
};

type RemoteOperatorNoteBody = {
  readonly note?: string | undefined;
  readonly reason?: string | undefined;
  readonly label?: string | undefined;
  readonly tokenId?: string | undefined;
  readonly requeueClaimedWork?: boolean | undefined;
  /** Not sent: the published scope set. Never empty: `[]` is refused. */
  readonly scopes?: Selection<string> | undefined;
};

type RemoteInvokeBody = {
  readonly command: string;
  readonly payload: unknown;
  readonly priority: 'high' | 'default' | 'normal';
  readonly waitMs?: number | undefined;
  readonly timeoutMs?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly automationRunId?: string | undefined;
  readonly automationJobId?: string | undefined;
  readonly approvalId?: string | undefined;
  readonly metadata: RemoteMetadata;
};

/**
 * Registered execution backends: hosts the daemon runs a command on itself (a
 * docker container, an ssh host, a cloud VM, a local process). An id a paired
 * peer holds is never a backend, so `remote.peers.invoke` runs on a backend
 * only when no paired peer has the id.
 */
export interface RemoteBackendRouteService {
  has(peerId: string): Promise<boolean>;
  list(): Promise<unknown>;
  register(input: Record<string, unknown>): Promise<unknown>;
  remove(peerId: string): Promise<boolean>;
  invoke(input: {
    readonly peerId: string;
    readonly command: string;
    readonly payload?: unknown;
    readonly timeoutMs?: number | undefined;
  }): Promise<unknown>;
}

interface DaemonRemoteRouteContext {
  /** The principal the gate authenticated; pair approvals, token rotation and invokes are attributed to it. */
  readonly resolveAuthenticatedPrincipal?: ((req: Request) => { readonly principalId: string } | null) | undefined;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  readonly requireAdmin: (req: Request) => Response | null;
  readonly requireRemotePeer: (req: Request, scope?: string) => Promise<RemotePeerAuth | Response>;
  readonly requireAuthenticatedSession: (req: Request) => SessionUserLike | null;
  readonly distributedRuntime: DistributedRuntimeRouteService;
  /** Absent on a host that runs no commands on registered backends. */
  readonly remoteBackends?: RemoteBackendRouteService | undefined;
}

const remoteBodySchemas = createRouteBodySchemaRegistry({
  pairRequest: peerBodySchema<RemotePairRequestBody>('pair.request', {
    capabilities: { max: MAX_REMOTE_CAPABILITIES },
    commands: { max: MAX_REMOTE_COMMANDS },
    ttlMs: { min: 1_000, max: 86_400_000 },
  }),
  pairVerify: peerBodySchema<RemotePairVerifyBody>('pair.verify'),
  peerHeartbeat: peerBodySchema<RemotePeerHeartbeatBody>('peer.heartbeat', {
    capabilities: { max: MAX_REMOTE_CAPABILITIES },
    commands: { max: MAX_REMOTE_COMMANDS },
  }),
  workPull: peerBodySchema<RemoteWorkPullBody>('work.pull', {
    maxItems: { min: 1, max: 100 },
    leaseMs: { min: 1_000, max: 3_600_000 },
  }),
  workComplete: peerBodySchema<RemoteWorkCompleteBody>('work.complete'),
  operatorNote: createRouteBodySchema<RemoteOperatorNoteBody>('POST /api/remote/operator-action', (body) => {
    const note = readOptionalStringField(body, 'note');
    const reason = readOptionalStringField(body, 'reason');
    const label = readOptionalStringField(body, 'label');
    const tokenId = readOptionalStringField(body, 'tokenId');
    const scopes = readStringArrayField(body, 'scopes', MAX_REMOTE_SCOPES);
    const [firstScope, ...otherScopes] = scopes ?? [];
    // A token with no scope has no use, and an empty list is never "every scope".
    if (scopes !== undefined && firstScope === undefined) {
      return jsonErrorResponse({
        error: 'scopes is an empty list: a peer token needs at least one scope; omit scopes for the published set.',
        code: 'INVALID_ARGUMENT',
      }, { status: 400 });
    }
    return {
      ...(note ? { note } : {}),
      ...(reason ? { reason } : {}),
      ...(label ? { label } : {}),
      ...(tokenId ? { tokenId } : {}),
      ...(typeof body.requeueClaimedWork === 'boolean' ? { requeueClaimedWork: body.requeueClaimedWork } : {}),
      scopes: firstScope === undefined ? { kind: 'default' } : { kind: 'only', values: [firstScope, ...otherScopes] },
    };
  }),
  invoke: createRouteBodySchema<RemoteInvokeBody>('POST /api/remote/peers/:peerId/invoke', (body) => {
    const command = readOptionalStringField(body, 'command');
    if (!command) return jsonErrorResponse({ error: 'Missing remote invoke command' }, { status: 400 });
    const waitMs = boundedPositiveNumber(body.waitMs, 0, 300_000);
    const timeoutMs = boundedPositiveNumber(body.timeoutMs, 1_000, 300_000);
    const sessionId = readOptionalStringField(body, 'sessionId');
    const routeId = readOptionalStringField(body, 'routeId');
    const automationRunId = readOptionalStringField(body, 'automationRunId');
    const automationJobId = readOptionalStringField(body, 'automationJobId');
    const approvalId = readOptionalStringField(body, 'approvalId');
    return {
      command,
      payload: body.payload,
      priority: body.priority === 'high' || body.priority === 'default' ? body.priority : 'normal',
      ...(waitMs !== undefined ? { waitMs } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(routeId ? { routeId } : {}),
      ...(automationRunId ? { automationRunId } : {}),
      ...(automationJobId ? { automationJobId } : {}),
      ...(approvalId ? { approvalId } : {}),
      metadata: readRemoteMetadata(body.metadata),
    };
  }),
});

export function createDaemonRemoteRouteHandlers(
  context: DaemonRemoteRouteContext,
): DaemonRemoteManagementRouteHandlers {
  return {
    getRemotePairRequests: () => Response.json({ requests: context.distributedRuntime.listPairRequests() }),
    approveRemotePairRequest: async (requestId, request) => handleApproveRemotePairRequest(context, requestId, request),
    rejectRemotePairRequest: async (requestId, request) => handleRejectRemotePairRequest(context, requestId, request),
    getRemotePeers: (request) => handleListRemotePeers(context, request),
    getRemotePeer: (peerId) => {
      const peer = context.distributedRuntime.getPeer(peerId);
      return peer ? Response.json({ peer }) : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
    },
    rotateRemotePeerToken: async (peerId, request) => handleRotateRemotePeerToken(context, peerId, request),
    revokeRemotePeerToken: async (peerId, request) => handleRevokeRemotePeerToken(context, peerId, request),
    disconnectRemotePeer: async (peerId, request) => handleDisconnectRemotePeer(context, peerId, request),
    // A work item is of the session, schedule, run and question it names: a caller that is not the owner himself is
    // listed only those it may reach every one of (pagination.ts keepReachableNaming, control-plane/caller-reach.ts).
    getRemoteWork: () => {
      const work = context.distributedRuntime.listWork();
      const field = (item: unknown, key: string): string | undefined => {
        const value = item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[key] : undefined;
        return typeof value === 'string' ? value : undefined;
      };
      return Response.json({ work: Array.isArray(work) ? keepReachableNaming(work as readonly unknown[], [
        ['session', (item) => field(item, 'sessionId')], ['schedule', (item) => field(item, 'automationJobId')],
        ['schedule-run', (item) => field(item, 'automationRunId')], ['approval', (item) => field(item, 'approvalId')],
      ]) : work });
    },
    invokeRemotePeer: async (peerId, request) => handleInvokeRemotePeer(context, peerId, request),
    cancelRemoteWork: async (workId, request) => handleCancelRemoteWork(context, workId, request),
    getRemoteNodeHostContract: () => serializableJsonResponse({ contract: context.distributedRuntime.getNodeHostContract() }),
    getRemoteBackends: async (request) => handleListRemoteBackends(context, request),
    registerRemoteBackend: async (request) => handleRegisterRemoteBackend(context, request),
    removeRemoteBackend: async (peerId, request) => handleRemoveRemoteBackend(context, peerId, request),
  };
}

/**
 * The peer list, narrowed by the query's `kind` (node or device) and cut to
 * its `limit` (a positive whole number) when one is given; with no limit
 * every peer is returned.
 */
function handleListRemotePeers(context: DaemonRemoteRouteContext, request: Request): Response {
  const query = new URL(request.url).searchParams;
  const kindText = query.get('kind');
  const kind = kindText === 'node' || kindText === 'device' ? kindText : undefined;
  if (kindText !== null && kind === undefined) {
    return jsonErrorResponse({ error: 'kind must be node or device' }, { status: 400 });
  }
  const limitText = query.get('limit');
  const limit = limitText === null ? Number.MAX_SAFE_INTEGER : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1) {
    return jsonErrorResponse({ error: 'limit must be a positive whole number' }, { status: 400 });
  }
  return Response.json({ peers: context.distributedRuntime.listPeers(kind, limit) });
}

function backendsUnavailable(): Response {
  return jsonErrorResponse({
    error: 'This host runs no commands on registered backends.',
    code: 'REMOTE_BACKENDS_UNAVAILABLE',
    next: ['Use a daemon host; it keeps the registered docker, ssh, cloud terminal and local process backends.'],
  }, { status: 501 });
}

async function handleListRemoteBackends(context: DaemonRemoteRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  if (!context.remoteBackends) return backendsUnavailable();
  try {
    return Response.json(await context.remoteBackends.list());
  } catch (error) {
    return refusalResponse(error) ?? readJsonErrorResponse(error, { status: serviceFailureStatus(error) });
  }
}

async function handleRegisterRemoteBackend(context: DaemonRemoteRouteContext, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  if (!context.remoteBackends) return backendsUnavailable();
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const peerId = readOptionalStringField(body, 'peerId');
  // A paired peer owns its id: invoking it queues work for that peer, so a backend cannot take it.
  if (peerId && context.distributedRuntime.getPeer(peerId)) {
    return jsonErrorResponse({
      error: `A paired peer already has the id '${peerId}'; register the backend under another id.`,
      code: 'REMOTE_BACKEND_ID_TAKEN',
    }, { status: 409 });
  }
  try {
    const backend = await context.remoteBackends.register(body);
    return Response.json({ backend }, { status: 201 });
  } catch (error) {
    return refusalResponse(error) ?? readJsonErrorResponse(error, { status: serviceFailureStatus(error) });
  }
}

async function handleRemoveRemoteBackend(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  if (!context.remoteBackends) return backendsUnavailable();
  try {
    return await context.remoteBackends.remove(peerId)
      ? Response.json({ peerId, removed: true })
      : jsonErrorResponse({ error: `No registered backend has the id '${peerId}'.`, code: 'REMOTE_PEER_NOT_FOUND' }, { status: 404 });
  } catch (error) {
    return refusalResponse(error) ?? readJsonErrorResponse(error, { status: serviceFailureStatus(error) });
  }
}

export async function handleRemotePairRequest(
  /** `remoteAddress`: the address the request came from, as the daemon resolved it; kept with the request so the owner sees it. */
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'> & { readonly remoteAddress?: string | undefined },
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.pairRequest.parse(body);
  if (input instanceof Response) return input;
  const created = await context.distributedRuntime.requestPairing({
    ...input,
    metadata: readMetadataWithClientHintForwardedFor(req, input.metadata),
    requestedBy: 'remote',
    ...(context.remoteAddress ? { remoteAddress: context.remoteAddress } : {}),
  });
  return Response.json(created, { status: 201 });
}

export async function handleRemotePairVerify(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.pairVerify.parse(body);
  if (input instanceof Response) return input;
  let verified: unknown;
  try {
    verified = await context.distributedRuntime.verifyPairRequest(input.requestId, input.challenge, {
      metadata: readMetadataWithClientHintForwardedFor(req, input.metadata),
    });
  } catch (error) {
    const refused = refusalResponse(error);
    if (refused) return refused;
    throw error;
  }
  return verified
    ? Response.json(verified)
    : jsonErrorResponse({ error: 'Pair request not approved, expired, or invalid' }, { status: 404 });
}

export async function handleRemotePeerHeartbeat(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, peerRouteScope('peer.heartbeat'));
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.peerHeartbeat.parse(body);
  if (input instanceof Response) return input;
  const peer = await context.distributedRuntime.heartbeatPeer(auth, {
    ...input,
    metadata: readMetadataWithClientHintForwardedFor(req, input.metadata),
  });
  return Response.json({ peer });
}

export async function handleRemotePeerWorkPull(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, peerRouteScope('work.pull'));
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.workPull.parse(body);
  if (input instanceof Response) return input;
  const work = await context.distributedRuntime.claimWork(auth, {
    maxItems: input.maxItems,
    leaseMs: input.leaseMs,
  });
  return Response.json({ work });
}

export async function handleRemotePeerWorkComplete(
  context: Pick<DaemonRemoteRouteContext, 'parseJsonBody' | 'requireRemotePeer' | 'distributedRuntime'>,
  workId: string,
  req: Request,
): Promise<Response> {
  const auth = await context.requireRemotePeer(req, peerRouteScope('work.complete'));
  if (auth instanceof Response) return auth;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.workComplete.parse(body);
  if (input instanceof Response) return input;
  const result = validateRemoteJsonPayload(input.result, MAX_REMOTE_RESULT_BYTES, 'result');
  if (result instanceof Response) return result;
  const work = await context.distributedRuntime.completeWork(auth, workId, {
    status: input.status,
    result,
    error: input.error,
    metadata: input.metadata,
  });
  if (!work) return jsonErrorResponse({ error: 'Unknown or unclaimed remote work item' }, { status: 404 });
  // The service hands back the stored record when it refuses a report, so a
  // record in a different settled state than the one reported is a refusal.
  const requested = input.status ?? (input.error ? 'failed' : 'completed');
  const stored = readWorkStatus(work);
  if (stored !== undefined && stored !== requested) {
    return withWork(jsonErrorResponse({
      error: `Remote work ${workId} is ${stored} and cannot become ${requested}; the report was not recorded. Do not report it again.`,
      code: 'REMOTE_WORK_SETTLED',
    }, { status: 409 }), work);
  }
  return Response.json({ work });
}

function readWorkStatus(work: unknown): string | undefined {
  if (typeof work !== 'object' || work === null) return undefined;
  const status = (work as { readonly status?: unknown }).status;
  return typeof status === 'string' ? status : undefined;
}

async function withWork(response: Response, work: unknown): Promise<Response> {
  const body = await response.json() as Record<string, unknown>;
  return Response.json({ ...body, work }, { status: response.status });
}

/**
 * A move the runtime refused because of a record's state carries its own HTTP
 * status, a code and a message that names the state and the next step. Answer
 * with exactly that instead of a generic not-found.
 */
function refusalResponse(error: unknown): Response | null {
  if (!(error instanceof Error)) return null;
  const { status, code } = error as Error & { readonly status?: unknown; readonly code?: unknown };
  if (typeof status !== 'number' || status < 400 || status > 499 || typeof code !== 'string') return null;
  return jsonErrorResponse({ error: error.message, code }, { status });
}

function isUnknownPeerError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const { status, code } = error as Error & { readonly status?: unknown; readonly code?: unknown };
  return status === 404 || (typeof code === 'string' && /NOT_FOUND|UNKNOWN_PEER/i.test(code)) || /unknown (distributed )?peer|peer .*not found/i.test(error.message);
}

// Non-numeric input is omitted from downstream calls so services can apply
// their own defaults.
function boundedPositiveNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function validateRemoteJsonPayload(value: unknown, maxBytes: number, field: string): unknown | Response {
  const size = estimateJsonByteLengthWithinLimit(value ?? null, maxBytes);
  if (size.kind === 'invalid') {
    return jsonErrorResponse({
      error: `Remote ${field} must be JSON-serializable`,
      code: 'INVALID_REMOTE_JSON_PAYLOAD',
    }, { status: 400 });
  }
  if (size.byteLength <= maxBytes) return value;
  return jsonErrorResponse({
    error: `Remote ${field} exceeds ${maxBytes} bytes after JSON encoding. Reduce payload size before retrying.`,
    code: 'REMOTE_PAYLOAD_TOO_LARGE',
  }, { status: 413 });
}

/**
 * Compute the exact JSON-encoded byte length of a string without allocating the encoded form.
 * Walks each code unit and counts the bytes JSON.stringify would emit:
 *   - 2 bytes for the surrounding quotes
 *   - 2 bytes for short-escape characters (", \, \b, \t, \n, \f, \r)
 *   - 6 bytes for other control chars (\uXXXX)
 *   - 1–4 bytes per non-control code point (UTF-8 encoding length)
 */
function jsonStringByteLength(s: string): number {
  let len = 2; // surrounding quotes
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c === 0x08 || c === 0x09 || c === 0x0a || c === 0x0c || c === 0x0d) {
      len += 2; // \" \\ \b \t \n \f \r
    } else if (c < 0x20) {
      len += 6; // \uXXXX
    } else if (c < 0x80) {
      len += 1;
    } else if (c < 0x800) {
      len += 2;
    } else if ((c & 0xfc00) === 0xd800 && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      len += 4; // surrogate pair → 4-byte UTF-8
      i++;
    } else {
      len += 3;
    }
  }
  return len;
}

export function estimateJsonByteLengthWithinLimit(
  value: unknown,
  maxBytes: number,
): { readonly kind: 'ok'; readonly byteLength: number } | { readonly kind: 'invalid' } {
  // Walk the value with a counting replacer so we never allocate the full
  // encoded string. The replacer throws a sentinel as soon as the running total
  // passes maxBytes. Strings and keys use their exact encoded length, numbers and
  // literals their printed length, and each container its brackets; one comma is
  // charged per child, so a container can be over-counted by at most one byte.
  let byteCount = 0;
  let isRoot = true;
  const OVER_LIMIT = Symbol('over-limit');
  try {
    JSON.stringify(value, function (this: unknown, key: string, val: unknown) {
      if (val === undefined || typeof val === 'function' || typeof val === 'symbol') return val;
      if (!isRoot) {
        byteCount += 1; // the comma before this child
        if (!Array.isArray(this)) byteCount += jsonStringByteLength(key) + 1; // "key":
      }
      isRoot = false;
      if (typeof val === 'string') byteCount += jsonStringByteLength(val);
      else if (typeof val === 'number') byteCount += Number.isFinite(val) ? String(val).length : 4;
      else if (typeof val === 'boolean') byteCount += val ? 4 : 5;
      else if (val === null) byteCount += 4;
      else byteCount += 2; // { } or [ ]
      if (byteCount > maxBytes) {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw OVER_LIMIT;
      }
      return val;
    });
    if (value === undefined) return { kind: 'ok', byteLength: 4 }; // undefined → JSON undefined
    return { kind: 'ok', byteLength: Math.min(byteCount, maxBytes + 1) };
  } catch (err) {
    if (err === OVER_LIMIT) return { kind: 'ok', byteLength: maxBytes + 1 };
    return { kind: 'invalid' };
  }
}

type ClientHintForwardedFor = string & { readonly __goodvibesClientHintForwardedFor: unique symbol };

function readRemoteMetadata(value: unknown): RemoteMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as RemoteMetadata
    : {};
}

function readMetadataWithClientHintForwardedFor(req: Request, value: unknown): Record<string, unknown> {
  const metadata = { ...readRemoteMetadata(value) };
  const clientHintForwardedFor = readClientHintForwardedFor(req);
  return clientHintForwardedFor ? { ...metadata, x_forwarded_for_untrusted: clientHintForwardedFor } : metadata;
}

function readClientHintForwardedFor(req: Request): ClientHintForwardedFor | undefined {
  // x-forwarded-for is caller-controlled unless the daemon is explicitly behind
  // a trusted proxy. Preserve a small display/audit hint under an explicit
  // client-hint key, but never use it for authorization decisions.
  const value = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  return value ? value as ClientHintForwardedFor : undefined;
}

function operatorActor(context: DaemonRemoteRouteContext, req: Request): string {
  return requestActor(context, req);
}

async function handleApproveRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  let approved: unknown;
  try {
    approved = await context.distributedRuntime.approvePairRequest(requestId, {
      actor: operatorActor(context, req),
      note: input.note,
      label: input.label,
      metadata: readRemoteMetadata(body.metadata),
      confirmReplace: body.confirmReplace === true,
    });
  } catch (error) {
    const refused = refusalResponse(error);
    if (refused) return refused;
    throw error;
  }
  return approved
    ? Response.json(approved)
    : jsonErrorResponse({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRejectRemotePairRequest(context: DaemonRemoteRouteContext, requestId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const rejected = await context.distributedRuntime.rejectPairRequest(requestId, {
    actor: operatorActor(context, req),
    note: input.note,
  });
  return rejected
    ? Response.json(rejected)
    : jsonErrorResponse({ error: 'Unknown remote pair request' }, { status: 404 });
}

async function handleRotateRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const rotated = await context.distributedRuntime.rotatePeerToken(peerId, {
    actor: operatorActor(context, req),
    label: input.label,
    scopes: input.scopes,
  });
  return rotated
    ? Response.json(rotated)
    : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleRevokeRemotePeerToken(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const peer = await context.distributedRuntime.revokePeerToken(peerId, {
    actor: operatorActor(context, req),
    tokenId: input.tokenId,
    note: input.note,
  });
  return peer
    ? Response.json({ peer })
    : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleDisconnectRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const peer = await context.distributedRuntime.disconnectPeer(peerId, {
    actor: operatorActor(context, req),
    note: input.note,
    requeueClaimedWork: input.requeueClaimedWork,
  });
  return peer
    ? Response.json({ peer })
    : jsonErrorResponse({ error: 'Unknown distributed peer' }, { status: 404 });
}

async function handleInvokeRemotePeer(context: DaemonRemoteRouteContext, peerId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.invoke.parse(body);
  if (input instanceof Response) return input;
  const payload = validateRemoteJsonPayload(input.payload, MAX_REMOTE_PAYLOAD_BYTES, 'payload');
  if (payload instanceof Response) return payload;
  try {
    // A registered backend runs the command here and now, and answers with its
    // exit code and output. A paired peer keeps its id, so it is checked first.
    if (context.remoteBackends && !context.distributedRuntime.getPeer(peerId) && await context.remoteBackends.has(peerId)) {
      const backend = await context.remoteBackends.invoke({ peerId, command: input.command, payload, timeoutMs: input.timeoutMs });
      return Response.json({ completed: true, backend });
    }
    const invoked = await context.distributedRuntime.invokePeer({
      peerId,
      command: input.command,
      payload,
      priority: input.priority,
      actor: operatorActor(context, req),
      waitMs: input.waitMs,
      timeoutMs: input.timeoutMs,
      sessionId: input.sessionId,
      routeId: input.routeId,
      automationRunId: input.automationRunId,
      automationJobId: input.automationJobId,
      approvalId: input.approvalId,
      metadata: input.metadata,
      // A caller that went away ends its wait for the result, as a wait that ran out.
      signal: req.signal,
    });
    return Response.json(invoked, { status: 202 });
  } catch (error) {
    // Only a state refusal or an unknown-peer error is answered as such; any other failure is the daemon's own.
    return refusalResponse(error) ?? readJsonErrorResponse(error, { status: isUnknownPeerError(error) ? 404 : serviceFailureStatus(error) });
  }
}

async function handleCancelRemoteWork(context: DaemonRemoteRouteContext, workId: string, req: Request): Promise<Response> {
  const admin = context.requireAdmin(req);
  if (admin) return admin;
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = remoteBodySchemas.operatorNote.parse(body);
  if (input instanceof Response) return input;
  const work = await context.distributedRuntime.cancelWork(workId, {
    actor: operatorActor(context, req),
    reason: input.reason,
  });
  return work
    ? Response.json({ work })
    : jsonErrorResponse({ error: 'Unknown remote work item' }, { status: 404 });
}
