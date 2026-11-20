/**
 * inbox.* gateway handlers over the daemon's one owner inbox.
 *
 * Who answered is the authenticated caller on the invocation (principal and
 * client kind), never a field of the body.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import {
  OWNER_ITEM_KINDS,
  OwnerInboxInputError,
  type NewOwnerItem,
  type OwnerAnswerOutcome,
  type OwnerAnswerSource,
  type OwnerInbox,
  type OwnerItemKind,
} from '../owner-inbox.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { missingScopes } from '@goodvibes-jev/engine/daemon-api/route-helpers';

export type OwnerInboxGatewayService = Pick<OwnerInbox, 'listNow' | 'get' | 'answer' | 'postNow' | 'withdraw' | 'reportDelivery' | 'postedBy' | 'revision' | 'subscribe'>;

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
  return {
    actor: invocation.context.principalId ?? 'operator',
    surface: invocation.context.clientKind ?? 'web',
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
    if (itemId !== undefined) {
      const item = inbox.get(itemId);
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
    return {
      items: inbox.listNow({
        ...(status !== undefined ? { status: status as 'open' | 'closed' | 'all' } : {}),
        ...(rawKinds !== undefined ? { kinds: rawKinds as OwnerItemKind[] } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(typeof limit === 'number' ? { limit } : {}),
      }),
      revision: inbox.revision(),
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
  const forbidden = () => new GatewayVerbError('Answering a purchase window is the owner\'s own act: it needs an app on the daemon\'s own machine '
    + 'or a paired device, with admin and write:payments. Nothing was answered.', 'FORBIDDEN', 403);
  const context = invocation.context ?? {};
  const authority = invocation.nativeExecutionAuthority;
  let expected: ReturnType<NonNullable<typeof authority>['current']> | undefined;
  try { expected = authority?.current(); } catch { throw forbidden(); }
  let authorized = false;
  try { authorized = invocation.isAuthorized?.(['write:payments']) === true; } catch { authorized = false; }
  if (!authority || !expected || (expected.kind !== 'pairing-token' && expected.kind !== 'local') || context.admin !== true
    || context.principalKind !== 'token' || context.principalId !== expected.principalId
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
    const answer = {
      ...(option !== undefined ? { option } : {}),
      ...(text !== undefined ? { text } : {}),
    };
    const field = option !== undefined ? 'option' : 'text';
    if (inbox.get(itemId)?.kind === 'purchase') {
      const { authority, expected, forbidden } = purchaseAnswerAuthority(invocation);
      let answering = false;
      let outcome: OwnerAnswerOutcome;
      try {
        outcome = await authority.withCurrent(expected, async (assertCurrent) => {
          assertCurrent();
          answering = true;
          return await inbox.answer(itemId, answer, answerSource(invocation));
        });
      } catch (error) {
        // The owner's authority lapsing before the answer is a refusal; a failure of the answer itself is reported as it is.
        if (answering || error instanceof GatewayVerbError) throw error;
        throw forbidden();
      }
      return outcomeResponse(outcome, field);
    }
    const outcome = await inbox.answer(itemId, answer, answerSource(invocation));
    return outcomeResponse(outcome, field);
  };
}

export function createOwnerInboxPostHandler(inbox: OwnerInboxGatewayService): GatewayMethodHandler {
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
    const detail = optionalString(params['detail'], 'detail');
    const sessionId = optionalString(params['sessionId'], 'sessionId');
    const askedBy = optionalString(params['askedBy'], 'askedBy');
    const key = optionalString(params['key'], 'key');
    const input: NewOwnerItem = {
      kind: kind as NewOwnerItem['kind'],
      title: requireStringValue(params['title'], 'title'),
      ...(detail !== undefined ? { detail } : {}),
      ...(options !== undefined ? { options: options as string[] } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(askedBy !== undefined ? { askedBy } : {}),
      ...(key !== undefined ? { key } : {}),
      ...(typeof expiresAt === 'number' ? { expiresAt } : {}),
      ...(metadata !== undefined ? { metadata: metadata as Record<string, string | number | boolean> } : {}),
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

/** Attach the inbox.* handlers to their descriptors. A missing descriptor is skipped. */
export function registerOwnerInboxGatewayMethods(catalog: GatewayMethodCatalog, inbox: OwnerInboxGatewayService): void {
  const handlers: Record<string, GatewayMethodHandler> = {
    'inbox.list': createOwnerInboxListHandler(inbox),
    'inbox.answer': createOwnerInboxAnswerHandler(inbox),
    'inbox.post': createOwnerInboxPostHandler(inbox),
    'inbox.withdraw': createOwnerInboxWithdrawHandler(inbox),
    'inbox.delivery': createOwnerInboxDeliveryHandler(inbox),
  };
  for (const [id, handler] of Object.entries(handlers)) {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  }
}
