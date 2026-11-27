/**
 * inbox.* gateway handlers over the daemon's one owner inbox.
 *
 * Who answered is the authenticated caller on the invocation (principal and
 * client kind), never a field of the body.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import {
  OWNER_ANSWER_AGENT_METADATA,
  OWNER_ANSWER_SESSION_METADATA,
  OWNER_ASKER_HOST_METADATA,
  OWNER_ASKER_SESSION_FILE_METADATA,
  OWNER_ITEM_KINDS,
  OwnerInboxInputError,
  type NewOwnerItem,
  type OwnerAnswerOutcome,
  type OwnerAnswerSource,
  type OwnerInbox,
  type OwnerItemKind,
} from '../owner-inbox.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { nativeIdentityIsCaller } from './native-owner.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';
import { callerKey, isLocalOwnerCaller } from '../../pairing/principal-ids.js';
import { registrantMayName } from '../session-broker-sessions.js';
import { ownersProgramCaller } from '../../daemon/method-owner-decision.js';

export type OwnerInboxGatewayService = Pick<OwnerInbox, 'listNow' | 'listPageNow' | 'get' | 'answer' | 'postNow' | 'withdraw' | 'reportDelivery' | 'postedBy' | 'revision' | 'subscribe' | 'viewerOf'>;

/** Who registered a session (the session broker's `registrantOf`); undefined for a session nobody registered. */
export type SessionRegistrantLookup = (sessionId: string) => string | undefined;

/** The metadata naming who asked a question and where its answer goes back to (owner-inbox.ts `askerOf`). */
const ASKER_KEYS: readonly string[] = [OWNER_ANSWER_SESSION_METADATA, OWNER_ANSWER_AGENT_METADATA, OWNER_ASKER_SESSION_FILE_METADATA, OWNER_ASKER_HOST_METADATA];

/**
 * The caller as the registrant record keys it (pairing/principal-ids.ts `callerKey`), by the kind of credential first:
 * a sign-in user named `shared-token` is `user:shared-token`, never this machine's operator token.
 */
function principalKey(invocation: GatewayMethodInvocation): string {
  return callerKey(invocation.context);
}

/**
 * A posted question's metadata with its asker kept only when the poster may be it. A question's asker is the principal
 * that posted it, and a session is named as the asker only by the principal that registered that session
 * (`sessions.register`, kept by the broker): nobody takes a session by naming it first, and a caller that holds no
 * conversation whose answers it takes itself (a model acting for the owner with the Agent's credential, a web sign-in)
 * names none. An asker with no session (an agent, a session file, a host) is kept only from this machine's own
 * programs (the operator token); a paired device's is dropped. Undefined when nothing is left.
 */
function askerKeptFrom(invocation: GatewayMethodInvocation, metadata: Record<string, string | number | boolean>, registrantOf: SessionRegistrantLookup | undefined): Record<string, string | number | boolean> | undefined {
  const names = ASKER_KEYS.some((key) => metadata[key] !== undefined);
  if (!names) return Object.keys(metadata).length > 0 ? metadata : undefined;
  const kind = invocation.context.credentialKind;
  const principal = principalKey(invocation);
  const session = metadata[OWNER_ANSWER_SESSION_METADATA];
  const holdsNone = kind === 'agent' || kind === 'user-session';
  const registrant = typeof session === 'string' ? registrantOf?.(session) : undefined;
  // The registering program too: holders of one operator token are told apart by their registrations.
  // An asker with no session: only from the owner's own program by who it is (his registered terminal program, a turn
  // the daemon hosts; method-owner-decision.ts `ownersProgramCaller`), never from the operator token alone.
  const context = invocation.context;
  const mayAsk = !holdsNone && (typeof session === 'string'
    ? registrantMayName(registrant, { key: principal, registration: context.call?.registration })
    : session === undefined && isLocalOwnerCaller(context) && ownersProgramCaller({ actor: context.actor, credentialKind: kind ?? undefined,
      registration: context.call?.registration, daemonHosted: context.call?.daemonHosted === true }));
  if (mayAsk) return metadata;
  const kept = Object.fromEntries(Object.entries(metadata).filter(([key]) => !ASKER_KEYS.includes(key)));
  return Object.keys(kept).length > 0 ? kept : undefined;
}

const LIST_STATUSES = new Set(['open', 'closed', 'all']);
/** Every kind the list can filter by, decision included (the schema's enum). */
const KINDS: ReadonlySet<string> = new Set<string>(OWNER_ITEM_KINDS);
/** What a process outside the daemon may post; claims and purchase windows come from the daemon's own subsystems. */
const WIRE_POSTABLE = new Set<string>(['question', 'queued-action']);

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new GatewayVerbError(`Invalid ${field}: expected text`, 'INVALID_ARGUMENT', 400, field);
  return value;
}

function answerSource(invocation: GatewayMethodInvocation): OwnerAnswerSource {
  const actor = invocation.context.actor;
  return {
    // A sign-in named like this machine's token is told apart by kind (`user:<name>`), never read as "you".
    actor: actor !== undefined && actor.class !== 'peer' && actor.class !== 'system' ? actor.id : invocation.context.principalId ?? 'operator',
    surface: invocation.context.clientKind ?? 'web',
    // Whether the owner himself answered, from the actor the transport established (never a model acting for him).
    ...(actor?.class === 'owner' && actor.agentFor === undefined ? { owner: true as const } : {}),
  };
}

/** An unknown id or a malformed answer is the caller's error; a raced answer is a 200 with `applied: false`. */
function outcomeResponse(outcome: OwnerAnswerOutcome, field: string): OwnerAnswerOutcome {
  if (!outcome.applied && outcome.refusal.code === 'NOT_FOUND') {
    throw new GatewayVerbError(outcome.refusal.reason, 'NOT_FOUND', 404);
  }
  if (!outcome.applied && outcome.refusal.code === 'OWNER_ONLY') {
    throw new GatewayVerbError(outcome.refusal.reason, 'OWNER_ONLY', 403);
  }
  if (!outcome.applied && outcome.refusal.code === 'INVALID_ARGUMENT') {
    throw new GatewayVerbError(`${outcome.refusal.reason} ${outcome.refusal.next[0] ?? ''}`.trim(), 'INVALID_ARGUMENT', 400, field);
  }
  return outcome;
}

function rethrowInput(error: unknown): never {
  if (error instanceof OwnerInboxInputError) throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400, error.field);
  throw error;
}

export function createOwnerInboxListHandler(inbox: OwnerInboxGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const itemId = optionalString(params['itemId'], 'itemId');
    // An approval item carries its reading for this caller: an agent reading the inbox is offered no answer.
    const viewer = inbox.viewerOf(invocation.context.actor);
    if (itemId !== undefined) {
      const item = inbox.get(itemId, viewer);
      return { items: item ? [item] : [], revision: inbox.revision() };
    }
    const status = optionalString(params['status'], 'status');
    if (status !== undefined && !LIST_STATUSES.has(status)) {
      throw new GatewayVerbError('Invalid status: expected open, closed or all', 'INVALID_ARGUMENT', 400, 'status');
    }
    const rawKinds = params['kinds'];
    if (rawKinds !== undefined && (!Array.isArray(rawKinds) || !rawKinds.every((kind) => typeof kind === 'string' && KINDS.has(kind)))) {
      throw new GatewayVerbError(`Invalid kinds: expected a list of ${OWNER_ITEM_KINDS.join(', ')}`, 'INVALID_ARGUMENT', 400, 'kinds');
    }
    const limit = params['limit'];
    if (limit !== undefined && (typeof limit !== 'number' || !Number.isFinite(limit) || limit < 1)) {
      throw new GatewayVerbError('Invalid limit: expected a positive number', 'INVALID_ARGUMENT', 400, 'limit');
    }
    const sessionId = optionalString(params['sessionId'], 'sessionId');
    const cursor = optionalString(params['cursor'], 'cursor');
    let page: ReturnType<OwnerInboxGatewayService['listPageNow']>;
    try {
      page = inbox.listPageNow({
        ...(status !== undefined ? { status: status as 'open' | 'closed' | 'all' } : {}),
        ...(rawKinds !== undefined ? { kinds: rawKinds as OwnerItemKind[] } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
        viewer,
      });
    } catch (error) {
      if (error instanceof OwnerInboxInputError) throw new GatewayVerbError(error.message, 'INVALID_CURSOR', 400, error.field);
      throw error;
    }
    return {
      items: page.items,
      revision: inbox.revision(),
      hasMore: page.nextCursor !== undefined,
      ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    };
  };
}

/**
 * A purchase window answered here is the owner's own act, held to the authority
 * payments.purchase.approve takes for the same answer: the transport's native
 * owner (an app on the daemon's own machine or a paired device), admin, with
 * write:payments, current when the answer is recorded. Nothing in the request
 * body can supply it. Returns the authority to answer under, or throws.
 */
function purchaseAnswerAuthority(invocation: GatewayMethodInvocation) {
  const forbidden = () => new GatewayVerbError('Answering a purchase window is the owner\'s own act: it needs an app on the daemon\'s own machine, '
    + 'a paired device or the owner\'s own sign-in, with admin and write:payments. Nothing was answered.', 'FORBIDDEN', 403);
  const context = invocation.context ?? {};
  const authority = invocation.nativeExecutionAuthority;
  let expected: ReturnType<NonNullable<typeof authority>['current']> | undefined;
  try { expected = authority?.current(); } catch { throw forbidden(); }
  let authorized = false;
  try { authorized = invocation.isAuthorized?.(['write:payments']) === true; } catch { authorized = false; }
  if (!authority || !expected || context.admin !== true || !nativeIdentityIsCaller(context, expected)
    || missingScopes(context.scopes ?? [], ['write:payments']).length > 0
    || missingScopes(expected.scopes, ['write:payments']).length > 0 || !authorized) throw forbidden();
  return { authority, expected, forbidden };
}

export function createOwnerInboxAnswerHandler(inbox: OwnerInboxGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const itemId = requireStringValue(params['itemId'], 'itemId');
    const option = optionalString(params['option'], 'option');
    const text = optionalString(params['text'], 'text');
    const expectedRevision = params['expectedRevision'];
    if (expectedRevision !== undefined && (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision))) {
      throw new GatewayVerbError('Invalid expectedRevision: expected the integer revision of the approval you were shown', 'INVALID_ARGUMENT', 400, 'expectedRevision');
    }
    const answer = {
      ...(option !== undefined ? { option } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(typeof expectedRevision === 'number' ? { expectedRevision } : {}),
    };
    const viewer = inbox.viewerOf(invocation.context.actor);
    const field = option !== undefined ? 'option' : 'text';
    if (inbox.get(itemId)?.kind === 'purchase') {
      const { authority, expected, forbidden } = purchaseAnswerAuthority(invocation);
      let answering = false;
      let outcome: OwnerAnswerOutcome;
      try {
        outcome = await authority.withCurrent(expected, async (assertCurrent) => {
          assertCurrent();
          answering = true;
          return await inbox.answer(itemId, answer, answerSource(invocation), viewer);
        });
      } catch (error) {
        // The owner's authority lapsing before the answer is a refusal; a failure of the answer itself is reported as it is.
        if (answering || error instanceof GatewayVerbError) throw error;
        throw forbidden();
      }
      return outcomeResponse(outcome, field);
    }
    const outcome = await inbox.answer(itemId, answer, answerSource(invocation), viewer);
    return outcomeResponse(outcome, field);
  };
}

export function createOwnerInboxPostHandler(inbox: OwnerInboxGatewayService, registrantOf?: SessionRegistrantLookup): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const kind = requireStringValue(params['kind'], 'kind');
    if (!WIRE_POSTABLE.has(kind)) {
      throw new GatewayVerbError('Invalid kind: a surface may post question or queued-action', 'INVALID_ARGUMENT', 400, 'kind');
    }
    const options = params['options'];
    if (options !== undefined && (!Array.isArray(options) || !options.every((option) => typeof option === 'string'))) {
      throw new GatewayVerbError('Invalid options: expected a list of text', 'INVALID_ARGUMENT', 400, 'options');
    }
    const metadata = params['metadata'];
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
      throw new GatewayVerbError('Invalid metadata: expected an object', 'INVALID_ARGUMENT', 400, 'metadata');
    }
    const expiresAt = params['expiresAt'];
    if (expiresAt !== undefined && typeof expiresAt !== 'number') {
      throw new GatewayVerbError('Invalid expiresAt: expected milliseconds', 'INVALID_ARGUMENT', 400, 'expiresAt');
    }
    const given = optionalString(params['detail'], 'detail');
    // The project the posting program works in (its call context): said on the item, so the same question from two
    // projects is two questions the owner can tell apart, as an approval's "In:" line says (owner-inbox.ts).
    const project = invocation.context.call?.project;
    const where = project && !(given ?? '').includes('In: ') ? `In: ${project.split(/[\\/]/).filter(Boolean).pop() ?? project} (${project})` : undefined;
    const detail = where ? [given, where].filter(Boolean).join('\n') : given;
    const named = optionalString(params['sessionId'], 'sessionId');
    // The conversation a question is shown in (a program's question card shows it as asked there): only the principal
    // that registered that session names it, as for the asker below.
    const sessionId = named !== undefined && registrantMayName(registrantOf?.(named), { key: principalKey(invocation), registration: invocation.context.call?.registration })
      ? named : undefined;
    const askedBy = optionalString(params['askedBy'], 'askedBy');
    const key = optionalString(params['key'], 'key');
    // The asker is the principal that posted, and a session only the one that registered it: the owner's answer is
    // never delivered into a conversation that did not ask.
    const asker = metadata === undefined ? undefined : askerKeptFrom(invocation, metadata as Record<string, string | number | boolean>, registrantOf);
    const input: NewOwnerItem = {
      kind: kind as NewOwnerItem['kind'],
      title: requireStringValue(params['title'], 'title'),
      ...(detail !== undefined ? { detail } : {}),
      ...(options !== undefined ? { options: options as string[] } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(askedBy !== undefined ? { askedBy } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      ...(asker !== undefined ? { metadata: asker } : {}),
    };
    try {
      return inbox.postNow(input, invocation.context.principalId);
    } catch (error) {
      return rethrowInput(error);
    }
  };
}

/** Only the principal that posted an item may act for its asker (withdraw it, report its answer's delivery). */
function requirePoster(inbox: OwnerInboxGatewayService, itemId: string, invocation: GatewayMethodInvocation, what: string): void {
  if (!inbox.get(itemId)) throw new GatewayVerbError(`No inbox item has the id ${itemId}.`, 'NOT_FOUND', 404);
  const poster = inbox.postedBy(itemId);
  if (poster === undefined || poster !== invocation.context.principalId) {
    throw new GatewayVerbError(`Only the caller that posted this item can ${what}.`, 'FORBIDDEN', 403);
  }
}

export function createOwnerInboxWithdrawHandler(inbox: OwnerInboxGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const itemId = requireStringValue(params['itemId'], 'itemId');
    const reason = optionalString(params['reason'], 'reason') ?? '';
    requirePoster(inbox, itemId, invocation, 'withdraw it');
    return outcomeResponse(inbox.withdraw(itemId, reason), 'itemId');
  };
}

export function createOwnerInboxDeliveryHandler(inbox: OwnerInboxGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const itemId = requireStringValue(params['itemId'], 'itemId');
    const state = requireStringValue(params['state'], 'state');
    if (state !== 'delivered' && state !== 'undeliverable') {
      throw new GatewayVerbError('Invalid state: expected delivered or undeliverable', 'INVALID_ARGUMENT', 400, 'state');
    }
    const reason = optionalString(params['reason'], 'reason');
    requirePoster(inbox, itemId, invocation, 'report its delivery');
    return outcomeResponse(inbox.reportDelivery(itemId, { state, ...(reason !== undefined ? { reason } : {}) }), 'itemId');
  };
}

/**
 * Attach the inbox.* handlers to their descriptors. A missing descriptor is skipped. `registrantOf`: who registered a
 * session; absent, no posted question keeps a session as its asker.
 */
export function registerOwnerInboxGatewayMethods(catalog: GatewayMethodCatalog, inbox: OwnerInboxGatewayService, registrantOf?: SessionRegistrantLookup): void {
  const handlers: Record<string, GatewayMethodHandler> = {
    'inbox.list': createOwnerInboxListHandler(inbox),
    'inbox.answer': createOwnerInboxAnswerHandler(inbox),
    'inbox.post': createOwnerInboxPostHandler(inbox, registrantOf),
    'inbox.withdraw': createOwnerInboxWithdrawHandler(inbox),
    'inbox.delivery': createOwnerInboxDeliveryHandler(inbox),
  };
  for (const [id, handler] of Object.entries(handlers)) {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  }
}
