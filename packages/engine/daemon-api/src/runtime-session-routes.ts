import type { DaemonRuntimeSessionRouteHandlers, DaemonRuntimeTaskRouteHandlers } from './context.js';
import { handleRegisterSharedSession } from './runtime-session-register.js';
import {
  handleDeleteSharedSession,
  handleGetSharedSession,
  handleSharedSessionDetach,
  handleSharedSessionLifecycle,
} from './runtime-session-lifecycle-routes.js';
import { withAdmin } from './auth-helpers.js';
import { randomUUID } from 'node:crypto';
import { jsonErrorResponse } from './error-response.js';
import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
import { REASONING_EFFORT_SEVERITY } from '@goodvibes-jev/engine/contracts';
import {
  AUTOMATION_SURFACE_KINDS,
  EXECUTION_FILESYSTEM_POLICIES,
  EXECUTION_NETWORK_POLICIES,
  EXECUTION_RISK_CLASSES,
  SESSION_INPUT_STATES,
  SESSION_SURFACE_KINDS,
  type AutomationSurfaceKind,
  type DaemonRuntimeRouteContext,
  type ExecutionIntent,
  type SessionInputState,
  type SessionKind,
  type SharedSessionRoutingIntent,
} from './runtime-route-types.js';

function isOneOf<T extends string>(accepted: readonly T[], value: string): value is T {
  return (accepted as readonly string[]).includes(value);
}

/** A 400 that names the field and its accepted values. */
function invalidChoice(field: string, value: unknown, accepted: readonly string[]): Response {
  return jsonErrorResponse({
    error: `${field} must be one of ${accepted.join(', ')}; got ${JSON.stringify(value)}.`,
    code: 'INVALID_ARGUMENT',
    field,
  }, { status: 400 });
}

/** The surface a message comes from: absent is the web surface; a name no transport has is a 400. */
function readMessageSurfaceKind(value: unknown): AutomationSurfaceKind | Response {
  if (value === undefined) return 'web';
  return typeof value === 'string' && isOneOf(AUTOMATION_SURFACE_KINDS, value) ? value : invalidChoice('surfaceKind', value, AUTOMATION_SURFACE_KINDS);
}
import {
  createRouteBodySchema,
  createRouteBodySchemaRegistry,
  isJsonRecord,
  readBoundedPositiveInteger,
  readOptionalStringField,
  readStringArrayField,
  type JsonRecord,
} from './route-helpers.js';

const RETRY_REFUSED_MESSAGE = 'Task cannot be retried: only failed or cancelled tasks can be retried';

type SharedSessionSubmission = Awaited<ReturnType<DaemonRuntimeRouteContext['sessionBroker']['submitMessage']>>;
type SharedSessionSteerSubmission = Awaited<ReturnType<DaemonRuntimeRouteContext['sessionBroker']['steerMessage']>>;
type SharedSessionFollowUpSubmission = Awaited<ReturnType<DaemonRuntimeRouteContext['sessionBroker']['followUpMessage']>>;
type SessionSubmission = SharedSessionSubmission | SharedSessionSteerSubmission | SharedSessionFollowUpSubmission;
type RuntimeTaskBody = {
  readonly task: string;
  readonly model?: string | undefined;
  readonly tools?: string[] | undefined;
  readonly routing?: SharedSessionRoutingIntent | undefined;
};
type SharedSessionMessageInput = {
  readonly sessionId: string;
  readonly surfaceKind: AutomationSurfaceKind;
  readonly surfaceId: string;
  readonly externalId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly title?: string | undefined;
  readonly routeId?: string | undefined;
  readonly body: string;
  /** The caller's `messageId`: the replay key, so a repeat after a lost response is answered with the first receipt. */
  readonly providerMessageId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly routing?: SharedSessionRoutingIntent | undefined;
};
export type SharedSessionKind = SessionKind;
export type SharedSessionRecordResponse = {
  readonly id: string;
  /** A known kind, or any other string a newer producer registered (a read never blanks a record over its kind). */
  readonly kind?: SharedSessionKind | (string & {}) | undefined;
  readonly project?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: 'active' | 'closed' | undefined;
  readonly createdAt?: number | undefined;
  readonly updatedAt?: number | undefined;
  readonly lastMessageAt?: number | undefined;
  readonly closedAt?: number | undefined;
  readonly lastActivityAt?: number | undefined;
  readonly messageCount?: number | undefined;
  readonly retainedMessageCount?: number | undefined; // retained bodies when < messageCount
  readonly channelPermissionMode?: string | undefined;
  readonly channelPermissionModeRevision?: number | undefined;
  /** Inputs queued or delivered and not yet ended, as the session broker counts them. */
  readonly pendingInputCount?: number | undefined;
  readonly routeIds: readonly string[];
  readonly surfaceKinds: readonly string[];
  readonly participants: readonly SharedSessionParticipantResponse[];
  readonly activeAgentId?: string | undefined;
  readonly lastAgentId?: string | undefined;
  readonly lastError?: string | undefined;
  readonly metadata: Record<string, unknown>;
};
type SharedSessionParticipantResponse = {
  readonly surfaceKind: string;
  readonly surfaceId: string;
  readonly externalId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly routeId?: string | undefined;
  readonly lastSeenAt: number;
};

const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;
const MAX_SESSION_TOOL_NAMES = 64;
const SHARED_SESSION_STATUSES = new Set<SharedSessionRecordResponse['status']>(['active', 'closed']);

function readBoundedLimit(url: URL, key = 'limit'): number {
  return readBoundedPositiveInteger(url.searchParams.get(key), DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
}

/** Runs a submit/steer/follow-up broker call, converting its closed-session
 * guard throw ({ code: EngineErrorCodes.SESSION_CLOSED, status: 409 }, thrown
 * before any mutation) into the same structured 409 other routes return. */
async function callOrSessionClosed<T>(fn: () => Promise<T>): Promise<T | Response> {
  try {
    return await fn();
  } catch (err: unknown) {
    const closed = err as { code?: string; status?: number; message?: string };
    if (closed.code === 'SESSION_NOT_FOUND') {
      return jsonErrorResponse({ error: closed.message ?? 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: closed.status ?? 404 });
    }
    if (closed.code !== EngineErrorCodes.SESSION_CLOSED) throw err;
    return jsonErrorResponse({ error: 'Session is closed', code: EngineErrorCodes.SESSION_CLOSED }, { status: closed.status ?? 409 });
  }
}

/**
 * The wire form of a session record. Every value comes from the record the
 * broker holds; a field the record lacks is left out rather than filled with a
 * plausible guess, so a damaged record never reads as a fresh active session.
 * `options` are used only when the record itself has no value for that field.
 */
export function toSharedSessionRecordResponse(
  sessionId: string,
  session: unknown,
  options: {
    readonly status?: SharedSessionRecordResponse['status'] | undefined;
    readonly messageCount?: number | undefined;
  } = {},
): SharedSessionRecordResponse {
  const record = isJsonRecord(session) ? session : {};
  const id = readNonEmptyString(record.id) ?? sessionId;
  const createdAt = readFiniteNumber(record.createdAt);
  const updatedAt = readFiniteNumber(record.updatedAt);
  const lastMessageAt = readFiniteNumber(record.lastMessageAt);
  const closedAt = readFiniteNumber(record.closedAt);
  const lastActivityAt = readFiniteNumber(record.lastActivityAt);
  const kind = readNonEmptyString(record.kind);
  const project = readNonEmptyString(record.project);
  const title = readNonEmptyString(record.title);
  const status = readSessionStatus(record.status) ?? options.status;
  const activeAgentId = readNonEmptyString(record.activeAgentId);
  const lastAgentId = readNonEmptyString(record.lastAgentId);
  const lastError = readNonEmptyString(record.lastError);
  const messageCount = readFiniteNumber(record.messageCount) ?? options.messageCount;
  const pendingInputCount = readFiniteNumber(record.pendingInputCount);
  const retained = readFiniteNumber(record.retainedMessageCount);
  const permissionMode = readNonEmptyString(record.channelPermissionMode);
  const permissionRevision = readFiniteNumber(record.channelPermissionModeRevision);
  return {
    id,
    ...(kind ? { kind } : {}),
    ...(project ? { project } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
    ...(lastMessageAt !== undefined ? { lastMessageAt } : {}),
    ...(closedAt !== undefined ? { closedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(retained !== undefined && messageCount !== undefined && retained < messageCount ? { retainedMessageCount: retained } : {}),
    ...(permissionMode ? { channelPermissionMode: permissionMode } : {}),
    ...(permissionRevision !== undefined && Number.isInteger(permissionRevision) && permissionRevision >= 0 ? { channelPermissionModeRevision: permissionRevision } : {}),
    ...(pendingInputCount !== undefined ? { pendingInputCount } : {}),
    routeIds: readStringArray(record.routeIds),
    surfaceKinds: readStringArray(record.surfaceKinds),
    participants: readParticipants(record.participants),
    ...(activeAgentId ? { activeAgentId } : {}),
    ...(lastAgentId ? { lastAgentId } : {}),
    ...(lastError ? { lastError } : {}),
    metadata: isJsonRecord(record.metadata) ? record.metadata : {},
  };
}

function readSessionStatus(value: unknown): SharedSessionRecordResponse['status'] | undefined {
  return typeof value === 'string' && SHARED_SESSION_STATUSES.has(value as SharedSessionRecordResponse['status'])
    ? value as SharedSessionRecordResponse['status']
    : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
}

function readParticipants(value: unknown): SharedSessionParticipantResponse[] {
  if (!Array.isArray(value)) return [];
  const output: SharedSessionParticipantResponse[] = [];
  for (const entry of value) {
    if (!isJsonRecord(entry)) continue;
    const surfaceKind = readNonEmptyString(entry.surfaceKind);
    const surfaceId = readNonEmptyString(entry.surfaceId);
    const lastSeenAt = readFiniteNumber(entry.lastSeenAt);
    if (!surfaceKind || !surfaceId || lastSeenAt === undefined) continue;
    const externalId = readNonEmptyString(entry.externalId);
    const userId = readNonEmptyString(entry.userId);
    const displayName = readNonEmptyString(entry.displayName);
    const routeId = readNonEmptyString(entry.routeId);
    output.push({
      surfaceKind,
      surfaceId,
      ...(externalId ? { externalId } : {}),
      ...(userId ? { userId } : {}),
      ...(displayName ? { displayName } : {}),
      ...(routeId ? { routeId } : {}),
      lastSeenAt,
    });
  }
  return output;
}

export function createDaemonRuntimeSessionRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeSessionRouteHandlers & DaemonRuntimeTaskRouteHandlers {
  return {
    createSharedSession: async (request) => withAdmin(context, request, () => handleCreateSharedSession(context, request)),
    registerSharedSession: async (request) => withAdmin(context, request, () => handleRegisterSharedSession(context, request)),
    postTask: async (request) => withAdmin(context, request, () => handlePostTask(context, request)),
    getSharedSession: async (sessionId) => handleGetSharedSession(context, sessionId),
    closeSharedSession: (sessionId, request) => withAdmin(context, request, () => handleSharedSessionLifecycle(context, sessionId, 'close')),
    reopenSharedSession: (sessionId, request) => withAdmin(context, request, () => handleSharedSessionLifecycle(context, sessionId, 'reopen')),
    detachSharedSession: (sessionId, request) => withAdmin(context, request, () => handleSharedSessionDetach(context, sessionId, request)),
    deleteSharedSession: (sessionId, request) => withAdmin(context, request, () => handleDeleteSharedSession(context, sessionId)),
    getSharedSessionMessages: async (sessionId, url) => handleGetSharedSessionMessages(context, sessionId, url),
    getSharedSessionInputs: async (sessionId, url) => handleGetSharedSessionInputs(context, sessionId, url),
    postSharedSessionMessage: (sessionId, request) => withAdmin(context, request, () => handlePostSharedSessionMessage(context, sessionId, request)),
    postSharedSessionSteer: (sessionId, request) => withAdmin(context, request, () => handlePostSharedSessionSteer(context, sessionId, request)),
    postSharedSessionFollowUp: (sessionId, request) => withAdmin(context, request, () => handlePostSharedSessionFollowUp(context, sessionId, request)),
    cancelSharedSessionInput: (sessionId, inputId, request) => withAdmin(context, request, () => handleCancelSharedSessionInput(context, sessionId, inputId)),
    deliverSharedSessionInput: (sessionId, inputId, request) => withAdmin(context, request, () => handleDeliverSharedSessionInput(context, sessionId, inputId, request)),
    getRuntimeTask: (taskId) => handleGetRuntimeTask(context, taskId),
    runtimeTaskAction: (taskId, action, request) => withAdmin(context, request, () => handleRuntimeTaskAction(context, taskId, action, request)),
    getTaskStatus: (agentId) => handleGetTaskStatus(context, agentId),
    getSharedSessionEvents: (sessionId, request) => withAdmin(context, request, () => handleGetSharedSessionEvents(context, sessionId, request)),
  };
}


const runtimeSessionBodySchemas = createRouteBodySchemaRegistry({
  task: createRouteBodySchema<RuntimeTaskBody>('POST /task', (body) => {
    const task = readOptionalStringField(body, 'task');
    if (!task) {
      return jsonErrorResponse({ error: 'Missing required field: task (non-empty string)' }, { status: 400 });
    }
    const routing = readSharedSessionRoutingIntent(body.routing);
    if (routing instanceof Response) return routing;
    const model = readOptionalStringField(body, 'model');
    const tools = readStringArrayField(body, 'tools', MAX_SESSION_TOOL_NAMES);
    return {
      task,
      ...(model ? { model } : {}),
      ...(tools ? { tools } : {}),
      ...(routing ? { routing } : {}),
    };
  }),
});

async function handleCreateSharedSession(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  await context.sessionBroker.start();
  await context.routeBindings.start();
  const routeBinding = typeof body.routeId === 'string'
    ? context.routeBindings.getBinding(body.routeId)
    : undefined;
  const participantSurface = typeof body.surfaceKind === 'string' && typeof body.surfaceId === 'string' ? body.surfaceKind : undefined;
  if (participantSurface !== undefined && !isOneOf(SESSION_SURFACE_KINDS, participantSurface)) {
    return invalidChoice('surfaceKind', participantSurface, SESSION_SURFACE_KINDS);
  }
  const session = await context.sessionBroker.createSession({
    id: typeof body.id === 'string' ? body.id : undefined,
    title: typeof body.title === 'string' ? body.title : undefined,
    metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
    routeBinding,
    participant: participantSurface !== undefined && typeof body.surfaceId === 'string'
      ? {
          surfaceKind: participantSurface,
          surfaceId: body.surfaceId,
          externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
          userId: typeof body.userId === 'string' ? body.userId : undefined,
          displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
          routeId: routeBinding?.id,
          lastSeenAt: Date.now(),
        }
      : undefined,
  });
  return context.recordApiResponse(req, '/api/sessions', Response.json({
    session: toSharedSessionRecordResponse(session.id, session),
  }, { status: 201 }));
}

async function handlePostTask(context: DaemonRuntimeRouteContext, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const input = runtimeSessionBodySchemas.task.parse(body);
  if (input instanceof Response) return input;
  const wantsSharedSession = typeof body.sessionId === 'string' || typeof body.routeId === 'string' || typeof body.surfaceKind === 'string';
  if (wantsSharedSession) {
    const surfaceKind = readMessageSurfaceKind(body.surfaceKind);
    if (surfaceKind instanceof Response) return surfaceKind;
    const submission = await callOrSessionClosed(() => context.sessionBroker.submitMessage({
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
      routeId: typeof body.routeId === 'string' ? body.routeId : undefined,
      surfaceKind,
      surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
      externalId: typeof body.externalId === 'string' ? body.externalId : undefined,
      threadId: typeof body.threadId === 'string' ? body.threadId : undefined,
      userId: typeof body.userId === 'string' ? body.userId : undefined,
      displayName: typeof body.displayName === 'string' ? body.displayName : undefined,
      title: typeof body.title === 'string' ? body.title : undefined,
      body: input.task,
      metadata: typeof body.metadata === 'object' && body.metadata !== null ? body.metadata as Record<string, unknown> : {},
      ...(input.routing ? { routing: input.routing } : {}),
    }));
    if (submission instanceof Response) return submission;

    if (submission.mode === 'continued-live') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: true,
        mode: submission.mode,
        sessionId: submission.session.id,
        agentId: submission.activeAgentId ?? null,
        inputId: submission.input.id,
      }, { status: 202 }));
    }
    if (submission.mode === 'queued-follow-up') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: true,
        mode: submission.mode,
        sessionId: submission.session.id,
        agentId: submission.activeAgentId ?? null,
        inputId: submission.input.id,
      }, { status: 202 }));
    }
    if (submission.mode === 'rejected') {
      return context.recordApiResponse(req, '/task', Response.json({
        acknowledged: false,
        mode: submission.mode,
        sessionId: submission.session.id,
        inputId: submission.input.id,
      }, { status: 409 }));
    }

    const sessionSpawn = context.trySpawnAgent({
      mode: 'spawn',
      task: submission.task!,
      ...(input.model !== undefined || submission.input.routing?.modelId ? { model: input.model ?? submission.input.routing?.modelId } : {}),
      ...(input.tools !== undefined || submission.input.routing?.tools ? { tools: input.tools ?? [...(submission.input.routing?.tools ?? []).slice(0, MAX_SESSION_TOOL_NAMES)] } : {}),
      ...(submission.input.routing?.providerId ? { provider: submission.input.routing.providerId } : {}),
      ...(submission.input.routing?.executionIntent ? { executionIntent: submission.input.routing.executionIntent } : {}),
    }, 'DaemonServer.handlePostTask.sharedSession', submission.session.id);
    if (sessionSpawn instanceof Response) {
      await releaseUnstartedInput(context, submission.session.id, submission.input.id, sessionSpawn);
      return sessionSpawn;
    }
    const unbound = await bindSpawnedAgent(context, submission.session.id, sessionSpawn.id, submission.input.id);
    if (unbound) return unbound;
    context.queueSurfaceReplyFromBinding(submission.routeBinding, {
      agentId: sessionSpawn.id,
      task: input.task,
      sessionId: submission.session.id,
    });
    return context.recordApiResponse(req, '/task', Response.json({
      acknowledged: true,
      mode: submission.mode,
      sessionId: submission.session.id,
      agentId: sessionSpawn.id,
      status: sessionSpawn.status,
    }, { status: 202 }));
  }

  const spawnResult = context.trySpawnAgent({
    mode: 'spawn',
    task: input.task,
    ...(input.model !== undefined && { model: input.model }),
    ...(input.tools !== undefined && { tools: input.tools }),
    ...(input.routing?.executionIntent ? { executionIntent: input.routing.executionIntent } : {}),
  }, 'DaemonServer', typeof body.sessionId === 'string' ? body.sessionId : undefined);
  if (spawnResult instanceof Response) return spawnResult;
  return context.recordApiResponse(req, '/task', Response.json({
    acknowledged: true,
    agentId: spawnResult.id,
    status: spawnResult.status,
    task: spawnResult.task,
    model: spawnResult.model ?? null,
    tools: spawnResult.tools,
  }, { status: 202 }));
}

async function handleGetSharedSessionMessages(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  url: URL,
): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return jsonErrorResponse({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  const limit = readBoundedLimit(url);
  const offset = Number(url.searchParams.get('offset') ?? 0);
  if (!Number.isSafeInteger(offset) || offset < 0) return jsonErrorResponse({ error: 'offset must be a nonnegative integer' }, { status: 400 });
  const messages = context.sessionBroker.getMessages(sessionId, limit, offset);
  const record: Record<string, unknown> = isJsonRecord(session) ? session : {};
  const total = typeof record.retainedMessageCount === 'number' ? record.retainedMessageCount : typeof record.messageCount === 'number' ? record.messageCount : messages.length;
  const hasMore = offset + messages.length < total;
  return Response.json({
    session: toSharedSessionRecordResponse(sessionId, session, { messageCount: total }),
    messages, total, offset, hasMore, ...(hasMore ? { nextOffset: offset + messages.length } : {}),
  });
}

async function handleGetSharedSessionInputs(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  url: URL,
): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return jsonErrorResponse({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  const limit = readBoundedLimit(url);
  // Collection cursor for live surfaces: filter by state (e.g. 'queued') and/or a
  // `since` createdAt cursor (exclusive) so a surface drains only inputs it has
  // not collected yet. Absent params preserve the legacy "last N inputs" behavior.
  const stateParam = readSessionInputState(url.searchParams.get('state'));
  const sinceParam = readPositiveInt(url.searchParams.get('since'));
  const inputs = (stateParam !== undefined || sinceParam !== undefined)
    ? context.sessionBroker.getInputsSince(sessionId, {
        ...(stateParam !== undefined ? { state: stateParam } : {}),
        ...(sinceParam !== undefined ? { since: sinceParam } : {}),
        limit,
      })
    : context.sessionBroker.getInputs(sessionId, limit);
  return Response.json({
    session: toSharedSessionRecordResponse(sessionId, session),
    inputs,
  });
}

function readSessionInputState(value: string | null): SessionInputState | undefined {
  return value !== null && isOneOf(SESSION_INPUT_STATES, value) ? value : undefined;
}

function readPositiveInt(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** The broker's refusal of a claim on an input another surface holds or that has ended. */
function isInputNotClaimable(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'INPUT_NOT_CLAIMABLE';
}

const SURFACE_ANSWER_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function readSurfaceAnswerStatus(value: unknown): 'completed' | 'failed' | 'cancelled' | undefined {
  return typeof value === 'string' && SURFACE_ANSWER_STATUSES.has(value)
    ? value as 'completed' | 'failed' | 'cancelled'
    : undefined;
}

/** Handle POST /api/sessions/:sessionId/inputs/:inputId/deliver, a live surface reports
 * collection (`{consumed:true}` = completed, else delivered); optional body, null/bare = consumed:false.
 *
 * `agentId` is the surface naming the agent that is answering this input: it
 * binds the reply so a message that arrived over a channel and was dispatched
 * to a surface gets its answer routed back, on the same path the daemon's own
 * spawn takes. `answer` (with `consumed:true`) is that agent's finished output,
 * reported when the surface's turn ends, the daemon writes it into the shared
 * session and pushes it down the reply pipeline. */
async function handleDeliverSharedSessionInput(
  context: DaemonRuntimeRouteContext, sessionId: string, inputId: string, req: Request,
): Promise<Response> {
  const body = await context.parseOptionalJsonBody(req);
  if (body instanceof Response) return body;
  const consumed = body?.consumed === true;
  const agentId = typeof body?.agentId === 'string' && body.agentId.trim() ? body.agentId.trim() : undefined;
  const answer = typeof body?.answer === 'string' ? body.answer : undefined;
  const claim = body?.claim === true && !consumed;
  // A surface that could not start the message reports it failed, with why,
  // so the row ends instead of waiting for an answer that will not come.
  if (consumed && !agentId && readSurfaceAnswerStatus(body?.status) === 'failed' && context.sessionBroker.failInput) {
    const reason = answer?.trim() || 'The surface that collected this message could not start it. Send it again to retry.';
    const failed = await context.sessionBroker.failInput(sessionId, inputId, reason);
    if (!failed) {
      return Response.json({
        error: 'Cannot mark input failed: it is unknown, or no longer queued or delivered; nothing was changed.',
        code: 'INPUT_NOT_DELIVERABLE',
        input: readSessionInput(context, sessionId, inputId),
      }, { status: 409 });
    }
    return context.recordApiResponse(req, `/api/sessions/${sessionId}/inputs/${inputId}/deliver`, Response.json({ input: failed }, { status: 200 }));
  }
  let input: unknown | null;
  try {
    // A claim is granted to one surface; the broker checks it where the row moves.
    input = await context.sessionBroker.markInputDelivered(sessionId, inputId, {
      consumed,
      ...(agentId ? { agentId } : {}),
      ...(claim ? { claim } : {}),
    });
  } catch (error) {
    if (!isInputNotClaimable(error)) throw error;
    return Response.json({
      error: error instanceof Error ? error.message : 'Cannot claim input: another surface already holds it or it has ended. Leave it to that surface; nothing was changed.',
      code: 'INPUT_NOT_CLAIMABLE',
      input: readSessionInput(context, sessionId, inputId),
    }, { status: 409 });
  }
  if (!input) {
    return jsonErrorResponse({ error: 'Unknown shared session input' }, { status: 404 });
  }
  // The broker returns a row it did not move unchanged; a report on an input
  // that already ended is refused here, and its answer is not forwarded.
  const target = consumed ? 'completed' : 'delivered';
  const state = isJsonRecord(input) && typeof input.state === 'string' ? input.state : 'unknown';
  if (state !== target) {
    return Response.json({
      error: `Cannot mark input ${target}: it is ${state}. Only a queued or delivered input can be ${target === 'completed' ? 'completed' : 'delivered'} by a surface; nothing was changed.`,
      code: 'INPUT_NOT_DELIVERABLE',
      input,
    }, { status: 409 });
  }
  if (agentId && answer !== undefined) {
    const status = readSurfaceAnswerStatus(body?.status);
    await context.completeSurfaceReplyFromSurface({
      agentId,
      sessionId,
      body: answer,
      ...(status ? { status } : {}),
    });
  }
  return context.recordApiResponse(req, `/api/sessions/${sessionId}/inputs/${inputId}/deliver`, Response.json({ input }, { status: 200 }));
}

/** Handle POST /api/sessions/:sessionId/messages. Accepts `{body}`; 400 when absent/empty. */
async function handlePostSharedSessionMessage(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;

  // Ordinary session messages default to conversation routing; callers must opt into kind='task' for agent work run under a contract.
  const kind = body.kind === undefined ? 'message' : body.kind;
  if (kind !== 'task' && kind !== 'message' && kind !== 'followup') {
    return jsonErrorResponse(
      { error: `Invalid kind '${String(kind)}'. Accepted values: 'task' | 'message' | 'followup'`, code: 'INVALID_KIND' },
      { status: 400 },
    );
  }

  const message = readSharedSessionMessageBody(body);
  if (!message) {
    return jsonErrorResponse({ error: 'Missing shared session message body' }, { status: 400 });
  }

  const input = buildSharedSessionMessageInput(sessionId, body, message);
  if (input instanceof Response) return input;

  // kind='followup', always queues/spawns a follow-up turn via followUpMessage()
  if (kind === 'followup') {
    const followUpSubmission = await callOrSessionClosed(() => context.sessionBroker.followUpMessage(input));
    if (followUpSubmission instanceof Response) return followUpSubmission;
    return await respondToSessionSubmission(context, req, followUpSubmission, message, `/api/sessions/${sessionId}/messages`, 'DaemonServer.handlePostSharedSessionMessage.followup', {
      context: `shared-session:${followUpSubmission.session.id}`,
    });
  }

  // kind='message', companion main-chat send. Delegates to dedicated handler to avoid
  // inline duplication of session-resolution with submitMessage().
  if (kind === 'message') {
    return handleCompanionMessageKind(context, sessionId, req, input, input.providerMessageId);
  }

  const submission = await callOrSessionClosed(() => context.sessionBroker.submitMessage(input));
  if (submission instanceof Response) return submission;

  return await respondToSessionSubmission(context, req, submission, message, `/api/sessions/${sessionId}/messages`, 'DaemonServer.handlePostSharedSessionMessage', {
    context: `shared-session:${submission.session.id}`,
  });
}

/** Handles kind='message' companion main-chat messages, short-circuits before
 * sessionBroker.submitMessage() so conversation messages route to the existing session instead of spawning continuation work. */
async function handleCompanionMessageKind(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  req: Request,
  input: SharedSessionMessageInput,
  clientMessageId?: string,
): Promise<Response> {
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return jsonErrorResponse({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  if (session.status === 'closed') {
    return jsonErrorResponse({ error: 'Session is closed', code: EngineErrorCodes.SESSION_CLOSED }, { status: 409 });
  }
  const messageId = clientMessageId ?? `companion-${randomUUID()}`;
  const answer = (): Response => context.recordApiResponse(req, `/api/sessions/${sessionId}/messages`, Response.json({
    messageId,
    routedTo: 'conversation',
    sessionId,
  }, { status: 202 }));
  // A client that names its message can retry after a timeout without adding a
  // second turn: a message already stored (or still being stored) under that id
  // is answered as accepted and not appended again.
  const inFlightKey = clientMessageId ? `${sessionId}\u0000${clientMessageId}` : null;
  if (inFlightKey) {
    if (companionMessagesInFlight.has(inFlightKey) || hasStoredCompanionMessage(context, sessionId, clientMessageId!)) return answer();
    companionMessagesInFlight.add(inFlightKey);
  }
  try {
    return await appendAndPublishCompanionMessage(context, sessionId, input, messageId, answer);
  } finally {
    if (inFlightKey) companionMessagesInFlight.delete(inFlightKey);
  }
}

/** Client-chosen message ids being stored right now, so two concurrent retries cannot both append. */
const companionMessagesInFlight = new Set<string>();
const MAX_CLIENT_MESSAGE_ID_LENGTH = 128;
const CLIENT_MESSAGE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const DEDUPE_LOOKBACK_MESSAGES = 200;

function readClientMessageId(value: unknown): string | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CLIENT_MESSAGE_ID_LENGTH || !CLIENT_MESSAGE_ID_PATTERN.test(value)) {
    return jsonErrorResponse(
      { error: `messageId must be 1 to ${MAX_CLIENT_MESSAGE_ID_LENGTH} characters of letters, digits, '.', '_', ':' or '-', so the message was not stored. Send it again with such an id, or without one.`, code: 'INVALID_MESSAGE_ID' },
      { status: 400 },
    );
  }
  return value;
}

function hasStoredCompanionMessage(context: DaemonRuntimeRouteContext, sessionId: string, messageId: string): boolean {
  return context.sessionBroker.getMessages(sessionId, DEDUPE_LOOKBACK_MESSAGES).some((entry) => {
    if (!isJsonRecord(entry)) return false;
    const metadata = entry.metadata;
    return isJsonRecord(metadata) && metadata.messageId === messageId;
  });
}

async function appendAndPublishCompanionMessage(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  input: SharedSessionMessageInput,
  messageId: string,
  answer: () => Response,
): Promise<Response> {
  const timestamp = Date.now();
  const metadata = buildCompanionMessageMetadata(input);
  // Persist the companion message to the session log so GET /api/sessions/:id/messages
  // returns it and the TUI can render it.
  await context.sessionBroker.appendCompanionMessage(sessionId, {
    messageId,
    body: input.body,
    source: 'companion-followup',
    timestamp,
    ...(metadata ? { metadata } : {}),
  });
  // Notify in-process subscribers via the conversation follow-up event (the
  // runtime subscriber turns it into a normal conversation turn that streams out).
  context.publishConversationFollowup(sessionId, {
    messageId,
    body: input.body,
    source: 'companion-followup',
    timestamp,
    ...(metadata ? { metadata } : {}),
  });
  // { routedTo: 'conversation' } signals the companion app the message was persisted.
  return answer();
}

function buildCompanionMessageMetadata(input: SharedSessionMessageInput): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
  };
  if (input.routing) metadata.routing = input.routing;
  if (input.surfaceKind) metadata.surfaceKind = input.surfaceKind;
  if (input.surfaceId) metadata.surfaceId = input.surfaceId;
  if (input.routeId) metadata.routeId = input.routeId;
  if (input.externalId) metadata.externalId = input.externalId;
  if (input.threadId) metadata.threadId = input.threadId;
  if (input.userId) metadata.userId = input.userId;
  if (input.displayName) metadata.displayName = input.displayName;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

/** Handle GET /api/sessions/:id/events, a session-scoped SSE stream for turn events
 * (STREAM_DELTA, TURN_COMPLETED, etc.) and agent events. */
async function handleGetSharedSessionEvents(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  req: Request,
): Promise<Response> {
  await context.sessionBroker.start();
  const session = context.sessionBroker.getSession(sessionId);
  if (!session) {
    return jsonErrorResponse({ error: 'Unknown shared session', code: 'SESSION_NOT_FOUND' }, { status: 404 });
  }
  // Stream lifetime is tied to the request connection; cleanup happens when
  // the response body closes.
  return context.openSessionEventStream(req, sessionId);
}

async function handlePostSharedSessionSteer(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const message = readSharedSessionMessageBody(body);
  if (!message) {
    return jsonErrorResponse({ error: 'Missing shared session steer body' }, { status: 400 });
  }
  const input = buildSharedSessionMessageInput(sessionId, body, message);
  if (input instanceof Response) return input;
  const submission = await callOrSessionClosed(() => context.sessionBroker.steerMessage({
    ...input,
    ...(body.allowSpawnFallback === true ? { allowSpawnFallback: true } : {}),
  }));
  if (submission instanceof Response) return submission;
  return await respondToSessionSubmission(context, req, submission, message, `/api/sessions/${sessionId}/steer`, 'DaemonServer.handlePostSharedSessionSteer', {
    context: `shared-session:${submission.session.id}`,
  });
}

async function handlePostSharedSessionFollowUp(context: DaemonRuntimeRouteContext, sessionId: string, req: Request): Promise<Response> {
  const body = await context.parseJsonBody(req);
  if (body instanceof Response) return body;
  const message = readSharedSessionMessageBody(body);
  if (!message) {
    return jsonErrorResponse({ error: 'Missing shared session follow-up body' }, { status: 400 });
  }
  const input = buildSharedSessionMessageInput(sessionId, body, message);
  if (input instanceof Response) return input;
  const submission = await callOrSessionClosed(() => context.sessionBroker.followUpMessage(input));
  if (submission instanceof Response) return submission;
  return await respondToSessionSubmission(context, req, submission, message, `/api/sessions/${sessionId}/follow-up`, 'DaemonServer.handlePostSharedSessionFollowUp', {
    context: `shared-session:${submission.session.id}`,
  });
}

async function handleCancelSharedSessionInput(context: DaemonRuntimeRouteContext, sessionId: string, inputId: string): Promise<Response> {
  await context.sessionBroker.start();
  const input = await context.sessionBroker.cancelInput(sessionId, inputId);
  if (!input) {
    return jsonErrorResponse({ error: 'Unknown shared session input' }, { status: 404 });
  }
  // cancelInput returns the entry unchanged when state is not 'queued'. Return
  // 409 so callers know the cancel was a no-op, e.g. already spawned.
  const inputRecord = input as { state?: string };
  if (inputRecord.state !== 'queued' && inputRecord.state !== 'cancelled') {
    // Use Response.json directly so the `input` field is preserved in the
    // response body. jsonErrorResponse strips unknown fields via its structured
    // error serializer, which would remove `input`.
    const running = inputRecord.state === 'delivered' || inputRecord.state === 'spawned';
    return Response.json(
      {
        error: `Cannot cancel input in state '${inputRecord.state}': only a queued input can be cancelled. ${running
          ? 'It is already being answered; stop the agent or turn answering it instead.'
          : 'It has already ended; nothing was changed.'}`,
        code: 'CANCEL_NOT_ALLOWED',
        input,
      },
      { status: 409 },
    );
  }
  return Response.json({ input });
}

function handleGetRuntimeTask(context: DaemonRuntimeRouteContext, taskId: string): Response {
  const task = context.runtimeStore?.getState().tasks.tasks.get(taskId);
  if (!task) {
    return jsonErrorResponse({ error: 'Unknown runtime task' }, { status: 404 });
  }
  return Response.json({ task });
}

/**
 * Extract the canonical `body` field from an incoming POST envelope. Returns ''
 * when absent or non-string; the caller must check for '' and return 400.
 */
export function readSharedSessionMessageBody(body: JsonRecord): string {
  return typeof body.body === 'string' ? body.body.trim() : '';
}

function buildSharedSessionMessageInput(
  sessionId: string,
  body: JsonRecord,
  message: string,
): SharedSessionMessageInput | Response {
  const routing = readSharedSessionRoutingIntent(body.routing);
  if (routing instanceof Response) return routing;
  const surfaceKind = readMessageSurfaceKind(body.surfaceKind);
  if (surfaceKind instanceof Response) return surfaceKind;
  // A caller-chosen id makes a resend after a lost response safe: the session
  // broker answers a repeat with the receipt of the input it already holds.
  const clientMessageId = readClientMessageId(body.messageId);
  if (clientMessageId instanceof Response) return clientMessageId;
  return {
    sessionId,
    surfaceKind,
    surfaceId: typeof body.surfaceId === 'string' ? body.surfaceId : 'surface:web',
    ...(typeof body.externalId === 'string' ? { externalId: body.externalId } : {}),
    ...(typeof body.threadId === 'string' ? { threadId: body.threadId } : {}),
    ...(typeof body.userId === 'string' ? { userId: body.userId } : {}),
    ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
    ...(typeof body.title === 'string' ? { title: body.title } : {}),
    ...(typeof body.routeId === 'string' ? { routeId: body.routeId } : {}),
    body: message,
    ...(clientMessageId ? { providerMessageId: clientMessageId } : {}),
    ...(typeof body.metadata === 'object' && body.metadata !== null ? { metadata: body.metadata as Record<string, unknown> } : {}),
    ...(routing ? { routing } : {}),
  };
}

function readToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').slice(0, MAX_SESSION_TOOL_NAMES);
  return tools.length > 0 ? tools : undefined;
}

/**
 * How a run asks to be executed. A value outside a field's list is a 400: an
 * execution limit the caller asked for is never dropped silently.
 */
function readExecutionIntent(value: unknown): ExecutionIntent | undefined | Response {
  if (value === undefined || value === null) return undefined;
  if (!isJsonRecord(value)) return jsonErrorResponse({ error: 'routing.executionIntent must be an object.', code: 'INVALID_ARGUMENT', field: 'routing.executionIntent' }, { status: 400 });
  const { riskClass, requiresApproval, networkPolicy, filesystemPolicy } = value;
  if (riskClass !== undefined && !(typeof riskClass === 'string' && isOneOf(EXECUTION_RISK_CLASSES, riskClass))) {
    return invalidChoice('routing.executionIntent.riskClass', riskClass, EXECUTION_RISK_CLASSES);
  }
  if (networkPolicy !== undefined && !(typeof networkPolicy === 'string' && isOneOf(EXECUTION_NETWORK_POLICIES, networkPolicy))) {
    return invalidChoice('routing.executionIntent.networkPolicy', networkPolicy, EXECUTION_NETWORK_POLICIES);
  }
  if (filesystemPolicy !== undefined && !(typeof filesystemPolicy === 'string' && isOneOf(EXECUTION_FILESYSTEM_POLICIES, filesystemPolicy))) {
    return invalidChoice('routing.executionIntent.filesystemPolicy', filesystemPolicy, EXECUTION_FILESYSTEM_POLICIES);
  }
  if (requiresApproval !== undefined && typeof requiresApproval !== 'boolean') {
    return jsonErrorResponse({ error: 'routing.executionIntent.requiresApproval must be true or false.', code: 'INVALID_ARGUMENT', field: 'routing.executionIntent.requiresApproval' }, { status: 400 });
  }
  return {
    ...(typeof riskClass === 'string' && isOneOf(EXECUTION_RISK_CLASSES, riskClass) ? { riskClass } : {}),
    ...(typeof requiresApproval === 'boolean' ? { requiresApproval } : {}),
    ...(typeof networkPolicy === 'string' && isOneOf(EXECUTION_NETWORK_POLICIES, networkPolicy) ? { networkPolicy } : {}),
    ...(typeof filesystemPolicy === 'string' && isOneOf(EXECUTION_FILESYSTEM_POLICIES, filesystemPolicy) ? { filesystemPolicy } : {}),
  };
}

function readSharedSessionRoutingIntent(value: unknown): SharedSessionRoutingIntent | undefined | Response {
  if (!isJsonRecord(value)) return undefined;
  const record = value;
  const executionIntent = readExecutionIntent(record.executionIntent);
  if (executionIntent instanceof Response) return executionIntent;
  const tools = readToolNames(record.tools);
  const fallbackModels = readStringArrayField(record, 'fallbackModels', MAX_SESSION_TOOL_NAMES);
  const helperModel = readHelperModel(record.helperModel);
  const providerSelection = readProviderSelection(record.providerSelection);
  const providerFailurePolicy = readProviderFailurePolicy(record.providerFailurePolicy);
  const reasoningEffort = readReasoningEffort(record.reasoningEffort);
  return {
    ...(typeof record.modelId === 'string' ? { modelId: record.modelId } : {}),
    ...(typeof record.providerId === 'string' ? { providerId: record.providerId } : {}),
    ...(providerSelection ? { providerSelection } : {}),
    ...(providerFailurePolicy ? { providerFailurePolicy } : {}),
    ...(fallbackModels?.length ? { fallbackModels } : {}),
    ...(helperModel ? { helperModel } : {}),
    ...(tools ? { tools } : {}),
    ...(executionIntent ? { executionIntent } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

function readProviderSelection(value: unknown): SharedSessionRoutingIntent['providerSelection'] | undefined {
  return value === 'inherit-current' || value === 'concrete' || value === 'synthetic' ? value : undefined;
}

function readProviderFailurePolicy(value: unknown): SharedSessionRoutingIntent['providerFailurePolicy'] | undefined {
  return value === 'ordered-fallbacks' || value === 'fail' ? value : undefined;
}

// Which levels a given model accepts is per model; this only rejects a typo,
// against the same list the settings schema and operator routes use.
const REASONING_EFFORT_LEVELS = new Set(REASONING_EFFORT_SEVERITY);

function readReasoningEffort(value: unknown): SharedSessionRoutingIntent['reasoningEffort'] | undefined {
  return typeof value === 'string' && REASONING_EFFORT_LEVELS.has(value) ? value : undefined;
}

function readHelperModel(value: unknown): SharedSessionRoutingIntent['helperModel'] | undefined {
  if (!isJsonRecord(value)) return undefined;
  return typeof value.providerId === 'string' && typeof value.modelId === 'string'
    ? { providerId: value.providerId, modelId: value.modelId }
    : undefined;
}

async function respondToSessionSubmission(
  context: DaemonRuntimeRouteContext,
  req: Request,
  submission: SessionSubmission,
  taskText: string,
  path: string,
  logLabel: string,
  spawnOptions: {
    readonly context?: string | undefined;
    readonly model?: string | undefined;
    readonly provider?: string | undefined;
    readonly tools?: readonly string[] | undefined;
    readonly executionIntent?: ExecutionIntent | undefined;
  } = {},
): Promise<Response> {
  if (
    submission.mode === 'continued-live' ||
    submission.mode === 'queued-follow-up' ||
    submission.mode === 'queued-for-surface'
  ) {
    // queued-for-surface: the input is queued for a live registered surface to
    // collect (sessions.inputs.list) and deliver (sessions.inputs.deliver). No
    // daemon executor is spawned, the surface owns turn execution.
    return context.recordApiResponse(req, path, Response.json({
      session: toSharedSessionRecordResponse(submission.session.id, submission.session),
      message: submission.userMessage ?? null,
      input: submission.input,
      mode: submission.mode,
      agentId: submission.activeAgentId ?? null,
    }, { status: 202 }));
  }
  if (submission.mode === 'rejected') {
    return context.recordApiResponse(req, path, Response.json({
      session: toSharedSessionRecordResponse(submission.session.id, submission.session),
      message: submission.userMessage ?? null,
      input: submission.input,
      mode: submission.mode,
    }, { status: 409 }));
  }

  const spawnResult = context.trySpawnAgent({
    mode: 'spawn',
    task: submission.task!,
    ...(spawnOptions.context ? { context: spawnOptions.context } : {}),
    ...(spawnOptions.model ?? submission.input.routing?.modelId ? { model: spawnOptions.model ?? submission.input.routing?.modelId } : {}),
    ...(spawnOptions.provider ?? submission.input.routing?.providerId ? { provider: spawnOptions.provider ?? submission.input.routing?.providerId } : {}),
    ...(spawnOptions.tools ?? submission.input.routing?.tools ? { tools: [...(spawnOptions.tools ?? submission.input.routing?.tools ?? [])] } : {}),
    ...(spawnOptions.executionIntent ?? submission.input.routing?.executionIntent
      ? { executionIntent: spawnOptions.executionIntent ?? submission.input.routing?.executionIntent }
      : {}),
  }, logLabel, submission.session.id);
  if (spawnResult instanceof Response) {
    await releaseUnstartedInput(context, submission.session.id, submission.input.id, spawnResult);
    return spawnResult;
  }
  const unbound = await bindSpawnedAgent(context, submission.session.id, spawnResult.id, submission.input.id);
  if (unbound) return unbound;
  context.queueSurfaceReplyFromBinding(submission.routeBinding, {
    agentId: spawnResult.id,
    task: taskText,
    sessionId: submission.session.id,
  });
  return context.recordApiResponse(req, path, Response.json({
    session: (() => {
      const session = context.sessionBroker.getSession(submission.session.id);
      return session ? toSharedSessionRecordResponse(submission.session.id, session) : null;
    })(),
    message: submission.userMessage ?? null,
    // The row as the broker holds it after the claim, never an assumed
    // 'spawned': a caller polling this input must see what actually happened to it.
    input: readSessionInput(context, submission.session.id, submission.input.id) ?? submission.input,
    mode: submission.mode,
    agentId: spawnResult.id,
  }, { status: 202 }));
}

function readSessionInput(context: DaemonRuntimeRouteContext, sessionId: string, inputId: string): unknown | null {
  const inputs = context.sessionBroker.getInputs(sessionId, Number.MAX_SAFE_INTEGER);
  return inputs.find((entry) => isJsonRecord(entry) && entry.id === inputId) ?? null;
}

/**
 * Bind a freshly spawned agent to its session input. When the broker cannot
 * record the binding the agent would run with nothing tracking it while the
 * input stays queued, so the agent is cancelled and the input is ended with the
 * reason. Returns the refusal to send, or null once bound.
 */
async function bindSpawnedAgent(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  agentId: string,
  inputId: string,
): Promise<Response | null> {
  try {
    await context.sessionBroker.bindAgent(sessionId, agentId, inputId);
    return null;
  } catch (error) {
    try { context.agentManager.cancel(agentId); } catch { /* the agent may already have ended */ }
    const reason = error instanceof Error && error.message.trim() ? error.message : 'the session could not record it';
    const message = `The agent was started but could not be attached to the session (${reason}), so it was cancelled. Send the input again to retry.`;
    const broker = context.sessionBroker;
    try {
      if (broker.failInput) await broker.failInput(sessionId, inputId, message);
      else await broker.cancelInput(sessionId, inputId);
    } catch { /* the input may already be settled; the refusal below still tells the caller */ }
    return jsonErrorResponse({ error: message, code: 'SESSION_AGENT_BIND_FAILED' }, { status: 500 });
  }
}

/**
 * An input whose agent could not be started is ended with the reason, so it
 * does not stay queued forever (which reads as a busy daemon and a dispatch
 * that never resolves). The refusal itself is still what the caller receives.
 */
async function releaseUnstartedInput(
  context: DaemonRuntimeRouteContext,
  sessionId: string,
  inputId: string,
  refusal: Response,
): Promise<void> {
  let reason = `No agent could be started for this input (HTTP ${refusal.status}). Send it again to retry.`;
  try {
    const body: unknown = await refusal.clone().json();
    if (isJsonRecord(body) && typeof body.error === 'string' && body.error.trim()) {
      reason = `No agent could be started for this input: ${body.error}. Send it again to retry.`;
    }
  } catch { /* a non-JSON refusal keeps the status-only reason */ }
  const broker = context.sessionBroker;
  if (broker.failInput) await broker.failInput(sessionId, inputId, reason);
  else await broker.cancelInput(sessionId, inputId);
}

function handleRuntimeTaskAction(context: DaemonRuntimeRouteContext, taskId: string, action: 'cancel' | 'retry', _req: Request): Response {
  if (!context.runtimeStore || !context.runtimeDispatch) {
    return jsonErrorResponse({ error: 'Runtime store unavailable' }, { status: 503 });
  }
  const task = context.runtimeStore.getState().tasks.tasks.get(taskId);
  if (!task) {
    return jsonErrorResponse({ error: 'Unknown runtime task' }, { status: 404 });
  }
  if (action === 'cancel') {
    if (task.kind === 'agent' && task.owner) {
      context.agentManager.cancel(task.owner);
    }
    context.runtimeDispatch.transitionRuntimeTask(taskId, 'cancelled', {
      endedAt: Date.now(),
      error: 'Cancelled via control plane',
    }, 'daemon.server.tasks.cancel');
    return Response.json({ task: context.runtimeStore.getState().tasks.tasks.get(taskId) });
  }
  if (action === 'retry') {
    if (task.kind !== 'agent') {
      return jsonErrorResponse({ error: 'Retry is only implemented for agent tasks' }, { status: 400 });
    }
    // Decide eligibility BEFORE spawning: a spawn is paid work, and the store
    // refuses queued for anything but a retryable status (see canRetry in
    // runtime/tasks/lifecycle.ts, reached through the dispatch seam).
    if (context.runtimeDispatch.canRetryRuntimeTask?.(taskId) === false) {
      return jsonErrorResponse({ error: RETRY_REFUSED_MESSAGE }, { status: 400 });
    }
    const spawnResult = context.trySpawnAgent({
      mode: 'spawn',
      task: task.description ?? task.title ?? '',
    }, 'DaemonServer.handleRuntimeTaskAction');
    if (spawnResult instanceof Response) return spawnResult;
    context.runtimeDispatch.transitionRuntimeTask(taskId, 'queued', {
      // Ownership moves to the agent this retry spawned: cancel reads this field,
      // and leaving the dead agent's id here made a later cancel a silent no-op.
      owner: spawnResult.id,
      startedAt: undefined,
      endedAt: undefined,
      error: undefined,
      result: undefined,
    }, 'daemon.server.tasks.retry');
    // The store refuses a move it does not allow without throwing, so read the
    // record back: if this retry did not land, stop the agent it just spawned.
    const after = context.runtimeStore.getState().tasks.tasks.get(taskId);
    if (after?.owner !== spawnResult.id) {
      context.agentManager.cancel(spawnResult.id);
      return jsonErrorResponse({ error: RETRY_REFUSED_MESSAGE }, { status: 400 });
    }
    return Response.json({
      retried: true,
      task: after,
      agentId: spawnResult.id,
    });
  }
  // Exhaustive: a new action literal on the handler interface fails to compile here.
  const unsupported: never = action;
  return jsonErrorResponse({ error: `Unsupported task action: ${String(unsupported)}` }, { status: 400 });
}

function handleGetTaskStatus(context: DaemonRuntimeRouteContext, agentId: string): Response {
  const record = context.agentManager.getStatus(agentId);
  if (!record) {
    return jsonErrorResponse({ error: `Agent not found: ${agentId}` }, { status: 404 });
  }
  if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') {
    context.syncFinishedAgentTask(record);
  }
  const durationMs = record.completedAt !== undefined
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  return Response.json({
    agentId: record.id,
    task: record.task,
    status: record.status,
    model: record.model ?? null,
    tools: record.tools,
    durationMs,
    toolCallCount: record.toolCallCount,
    progress: record.progress ?? null,
    error: record.error ?? null,
  });
}
