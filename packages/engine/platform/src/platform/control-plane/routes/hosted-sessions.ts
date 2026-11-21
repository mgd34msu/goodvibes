/**
 * routes/hosted-sessions.ts, the handlers behind `sessions.hosted.*`.
 *
 * Thin on purpose: argument reading and error mapping. Everything a hosted
 * session IS lives in platform/hosted-sessions, so the verbs and the engine
 * cannot drift into two ideas of what create/attach/detach/kill mean.
 *
 * Error mapping is the part worth reading. Each of the engine's refusals has a
 * distinct wire shape, because "there is no such session", "that session ended
 * and here is why", "the path you gave is not absolute" and "you are at the
 * configured cap" want four different reactions from a client, and collapsing
 * them into one 400 is how a caller ends up retrying the one thing that will
 * never work.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { admitOnSession, mayReadSession } from './session-admission.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import {
  HostedSessionArgumentError,
  HostedSessionClientOwnerError,
  HostedSessionLastOwnerError,
  HostedSessionLimitError,
  HostedSessionNotFoundError,
  HostedSessionNotReadyError,
  HostedSessionTerminatedError,
  HostedSessionUnavailableError,
  HostedSessionUnknownPrincipalError,
} from '../../hosted-sessions/manager.js';
import type { HostedSessionAttachment } from '../../hosted-sessions/manager.js';
import { ModelReferenceError } from '../../providers/model-id-resolution.js';
import type {
  CreateHostedSessionInput,
  HostedDetachPolicy,
  HostedSessionHistoryMessage,
  HostedSessionRecord,
} from '../../hosted-sessions/types.js';

/**
 * The engine surface these verbs need. Declared here rather than importing the
 * class so a test drives the routes with a stand-in, and so the routes depend
 * on five methods instead of the whole engine.
 */
export interface HostedSessionVerbService {
  create(input: CreateHostedSessionInput): Promise<HostedSessionRecord>;
  attach(
    sessionId: string,
    clientId: string,
    options?: { readonly leaseMs?: number | undefined; readonly principalId?: string | undefined },
  ): Promise<HostedSessionAttachment>;
  detach(sessionId: string, clientId: string, principalId?: string): Promise<HostedSessionRecord>;
  kill(sessionId: string): Promise<HostedSessionRecord>;
  list(options?: { readonly includeTerminated?: boolean | undefined }): readonly HostedSessionRecord[];
  readHistory(sessionId: string): Promise<{ readonly session: HostedSessionRecord; readonly history: readonly HostedSessionHistoryMessage[] }>;
  isOwnedBy(sessionId: string, principalId: string | undefined): boolean;
  ownersOf(sessionId: string): readonly string[];
  share(sessionId: string, principalId: string): Promise<{ readonly session: HostedSessionRecord; readonly owners: readonly string[]; readonly added: boolean }>;
  unshare(sessionId: string, principalId: string): Promise<{ readonly session: HostedSessionRecord; readonly owners: readonly string[]; readonly removed: boolean }>;
}

/** What the verbs read beside the engine. */
export interface HostedSessionVerbOptions {
  /**
   * Whether a principal id names a principal this daemon knows (a sign-in user,
   * a live pairing, the owner's own credential). Absent: every id is accepted.
   */
  readonly isKnownPrincipal?: ((principalId: string) => boolean) | undefined;
}

function optionalString(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayVerbError(`Invalid ${field}: expected a string`, 'INVALID_ARGUMENT', 400, field);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalPositiveNumber(params: Record<string, unknown>, field: string): number | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new GatewayVerbError(`Invalid ${field}: expected a positive number of milliseconds`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function optionalDetachPolicy(params: Record<string, unknown>): HostedDetachPolicy | undefined {
  const value = params['detachPolicy'];
  if (value === undefined || value === null) return undefined;
  if (value !== 'kill' && value !== 'survive') {
    throw new GatewayVerbError(
      'Invalid detachPolicy: expected kill or survive',
      'INVALID_ARGUMENT',
      400,
      'detachPolicy',
    );
  }
  return value;
}

/** Map an engine refusal onto the wire shape a client can act on. */
export function toGatewayVerbError(error: unknown): never {
  if (error instanceof GatewayVerbError) throw error;
  if (error instanceof HostedSessionNotFoundError) {
    // SESSION_NOT_FOUND, not a hosted-specific spelling: it is the same
    // condition the rest of the session surface reports under that code, and
    // clients already branch on it. A second word for "no session with this id"
    // only means the branch that handles it misses half the cases.
    throw new GatewayVerbError(error.message, 'SESSION_NOT_FOUND', 404);
  }
  if (error instanceof HostedSessionNotReadyError) {
    // 503: the session is real and nothing ran; the same call can be sent again shortly.
    throw new GatewayVerbError(error.message, 'HOSTED_SESSION_NOT_READY', 503);
  }
  if (error instanceof HostedSessionTerminatedError) {
    // Permanent: a caller that maps a conversation to this session starts a new one.
    throw new GatewayVerbError(error.message, error.code, 409);
  }
  if (error instanceof HostedSessionUnavailableError) {
    // 409, not 404: the session exists and the caller can read why it cannot
    // serve this request. A 404 would invite a retry against an id that is
    // perfectly real.
    throw new GatewayVerbError(error.message, 'HOSTED_SESSION_UNAVAILABLE', 409);
  }
  if (error instanceof HostedSessionClientOwnerError) {
    throw new GatewayVerbError(error.message, 'HOSTED_CLIENT_FORBIDDEN', 403, 'clientId');
  }
  if (error instanceof HostedSessionLastOwnerError) {
    throw new GatewayVerbError(error.message, 'HOSTED_SESSION_LAST_OWNER', 409, 'principalId');
  }
  if (error instanceof HostedSessionUnknownPrincipalError) {
    throw new GatewayVerbError(error.message, 'PRINCIPAL_NOT_FOUND', 404, 'principalId');
  }
  if (error instanceof HostedSessionLimitError) {
    throw new GatewayVerbError(error.message, 'HOSTED_SESSION_LIMIT_REACHED', 429);
  }
  if (error instanceof ModelReferenceError) {
    // The caller's input names no model this daemon can run: a 400 naming why, never a retryable 500.
    throw new GatewayVerbError(error.message, error.code, 400, 'modelId');
  }
  if (error instanceof HostedSessionArgumentError) {
    throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400, 'workspaceRoot');
  }
  throw error;
}

const HOSTED_ORIGIN_SURFACES: readonly string[] = ['agent', 'tui', 'webui'];

export function createHostedSessionCreateHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const detachPolicy = optionalDetachPolicy(params);
    const title = optionalString(params, 'title');
    const modelId = optionalString(params, 'modelId');
    const initialPrompt = optionalString(params, 'initialPrompt');
    const clientId = optionalString(params, 'clientId');
    const principalId = invocation.context.principalId;
    // The surface the caller is creating this session FOR. It travels with the
    // create call because the host cannot infer it: every client reaches the
    // daemon the same way, so a session created by the agent and a session
    // created by the TUI are indistinguishable at this seam. Without it the
    // session took the HOST's identity and resolved the wrong surface's
    // client-owned settings for its whole life.
    const originSurface = optionalString(params, 'originSurface');
    // It selects a settings directory the session will read and write for its
    // whole life, so only a surface that exists may be named: an invented or
    // path-shaped value would create a settings tree no surface owns.
    if (originSurface !== undefined && !HOSTED_ORIGIN_SURFACES.includes(originSurface)) {
      throw new GatewayVerbError(
        `Unknown originSurface "${originSurface}". Use one of: ${HOSTED_ORIGIN_SURFACES.join(', ')}, or omit it to use the host's own surface.`,
        'INVALID_ARGUMENT',
        400,
        'originSurface',
      );
    }
    // An Agent session's operator tools reach this daemon with the Agent's
    // credentials for it (its pairing, or the daemon's own operator
    // credential), which carry full operator authority. Only a creator that
    // already holds that authority may start one, so a narrowed credential
    // cannot borrow it through the session.
    if (originSurface === 'agent' && invocation.context.admin !== true) {
      throw new GatewayVerbError(
        'Not created: a GoodVibes Agent session acts on this daemon with full operator authority, and this credential does not hold it. '
          + 'Create the session with an admin credential (the owner\'s operator token, an admin sign-in or a full pairing), '
          + 'use the GoodVibes Agent itself, or omit originSurface for a plain hosted session.',
        'HOSTED_SURFACE_FORBIDDEN',
        403,
        'originSurface',
      );
    }
    try {
      const session = await service.create({
        workspaceRoot: requireString(params, 'workspaceRoot'),
        ...(title === undefined ? {} : { title }),
        ...(modelId === undefined ? {} : { modelId }),
        ...(initialPrompt === undefined ? {} : { initialPrompt }),
        ...(detachPolicy === undefined ? {} : { detachPolicy }),
        ...(clientId === undefined ? {} : { clientId }),
        ...(principalId === undefined ? {} : { principalId }),
        ...(originSurface === undefined ? {} : { originSurface }),
      });
      return { session };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionAttachHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const leaseMs = optionalPositiveNumber(params, 'leaseMs');
    const principalId = invocation.context.principalId;
    try {
      const sessionId = requireString(params, 'sessionId');
      // Joining returns the transcript, so it is both effects, on this session's owners.
      admitOnSession(invocation, ['session.attach', 'session.transcript.read'], service.ownersOf(sessionId));
      return await service.attach(
        sessionId,
        requireString(params, 'clientId'),
        { ...(leaseMs === undefined ? {} : { leaseMs }), ...(principalId === undefined ? {} : { principalId }) },
      );
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/**
 * Add a principal to a session's owners, so it may attach, read the
 * transcript and watch its turns live. Only an owner of the session (or an
 * admin) shares it.
 */
export function createHostedSessionShareHandler(service: HostedSessionVerbService, options: HostedSessionVerbOptions = {}): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const sessionId = requireString(params, 'sessionId');
      const principalId = requireString(params, 'principalId');
      admitOnSession(invocation, ['session.share'], service.ownersOf(sessionId));
      // A mistyped id is refused, not reported as added for a principal that can never use it.
      if (options.isKnownPrincipal && !options.isKnownPrincipal(principalId)) throw new HostedSessionUnknownPrincipalError(principalId);
      return await service.share(sessionId, principalId);
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/**
 * Remove a principal from a session's owners and end its attachments. Only an
 * owner of the session (or an admin) does it; the last owner is never removed.
 */
export function createHostedSessionUnshareHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const sessionId = requireString(params, 'sessionId');
      const principalId = requireString(params, 'principalId');
      admitOnSession(invocation, ['session.share'], service.ownersOf(sessionId));
      return await service.unshare(sessionId, principalId);
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionDetachHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      return { session: await service.detach(requireString(params, 'sessionId'), requireString(params, 'clientId'), invocation.context.principalId) };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createHostedSessionKillHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const sessionId = requireString(params, 'sessionId');
      admitOnSession(invocation, ['session.end'], service.ownersOf(sessionId));
      return { session: await service.kill(sessionId) };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/** The sessions the caller may read: every one for an admin, else those it created or was shared. */
export function createHostedSessionListHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const includeTerminated = params['includeTerminated'] === true;
    return { sessions: service.list({ includeTerminated }).filter((session) => mayReadSession(invocation, service.ownersOf(session.id))) };
  };
}

/**
 * A session's transcript, live or ended. An admin reads any session; any other
 * credential reads only a session its principal created or was shared, so a
 * least-privilege client reads its own reply after the session ended.
 */
export function createHostedSessionHistoryHandler(service: HostedSessionVerbService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireString(params, 'sessionId');
    try {
      if (!mayReadSession(invocation, service.ownersOf(sessionId))) {
        throw new GatewayVerbError(
          `Hosted session ${sessionId} was not created by this credential or shared with it, so its transcript is not shown. Ask an owner of the session to share it with you (sessions.hosted.share), or read it with an admin credential.`,
          'HOSTED_SESSION_NOT_OWNED',
          403,
          'sessionId',
        );
      }
      return await service.readHistory(sessionId);
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/** Every verb this module owns, in the order a client meets them. */
export const HOSTED_SESSION_METHOD_IDS: readonly string[] = [
  'sessions.hosted.create',
  'sessions.hosted.attach',
  'sessions.hosted.detach',
  'sessions.hosted.kill',
  'sessions.hosted.list',
  'sessions.hosted.history',
  'sessions.hosted.share',
  'sessions.hosted.unshare',
];

/**
 * Attach the hosted-session handlers to their descriptors. A missing descriptor
 * is a silent no-op, matching every other route group here.
 */
export function registerHostedSessionGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: HostedSessionVerbService,
  options: HostedSessionVerbOptions = {},
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (!descriptor) return;
    // An engine arriving after `refuseHostedSessionGatewayMethods` ran undoes
    // that refusal: a registered handler is the authority on whether a verb
    // works, and leaving the flag set would refuse a call this daemon can serve.
    const invokable = descriptor.invokable === false ? { ...descriptor, invokable: true } : descriptor;
    catalog.register(invokable, handler, { replace: true });
  };
  attach('sessions.hosted.create', createHostedSessionCreateHandler(service));
  attach('sessions.hosted.attach', createHostedSessionAttachHandler(service));
  attach('sessions.hosted.detach', createHostedSessionDetachHandler(service));
  attach('sessions.hosted.kill', createHostedSessionKillHandler(service));
  attach('sessions.hosted.list', createHostedSessionListHandler(service));
  attach('sessions.hosted.history', createHostedSessionHistoryHandler(service));
  attach('sessions.hosted.share', createHostedSessionShareHandler(service, options));
  attach('sessions.hosted.unshare', createHostedSessionUnshareHandler(service));
}

/**
 * Say, in the catalog, that this daemon hosts nothing.
 *
 * The descriptors are builtins: they are present whether or not a product
 * stated how a hosted session's workspace floor is built. With no engine there
 * is no handler either, and dispatch fell through to the branch for a verb with
 * neither handler nor route, a 501 whose body carried no code, and a plain
 * `Error` for anyone calling `catalog.invoke()` directly, which is a 500. Both
 * read as "this daemon is broken" for a capability that is simply off.
 *
 * Marking them uninvokable makes the refusal the one the catalog already
 * promises for a cataloged-but-not-dispatchable verb: an honest 400 with
 * `NOT_INVOKABLE`, before any handler lookup, on every path.
 */
export function refuseHostedSessionGatewayMethods(catalog: GatewayMethodCatalog): void {
  for (const id of HOSTED_SESSION_METHOD_IDS) {
    const descriptor = catalog.get(id);
    if (!descriptor || descriptor.invokable === false) continue;
    catalog.register({ ...descriptor, invokable: false }, undefined, { replace: true });
  }
}
