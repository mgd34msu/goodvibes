/**
 * routes/rewind-conversation-hosts.ts, the surface-facing half of
 * conversation-scope rewind.
 *
 * `rewind.plan` and `rewind.apply` (routes/rewind.ts) are the CALLER's side:
 * anyone with the scopes can ask for a rewind of any session. These five verbs
 * are the other side, and only one kind of caller uses them, the surface that
 * is actually running a session's conversation. It offers that conversation,
 * takes the questions the daemon puts to it, and answers them.
 *
 * Why a surface has to be involved at all: the workspace checkpoint store is
 * the daemon's, so files rewind works from anywhere, but the messages live in
 * whichever process runs the loop. Once the surfaces became pure clients that
 * process is not the daemon, and the daemon's in-process conversation registry
 *, which nothing outside the daemon could populate, answered "0 messages to
 * drop" for every one of them. The mechanics of the offer, the lease and the
 * bounded wait are in platform/rewind/conversation-host-broker.ts; this module
 * is the wire shape and the honest refusals.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import {
  CONVERSATION_ANSWER_TIMEOUT_MS,
  CONVERSATION_HOST_MAX_WAIT_MS,
  ConversationRewindHostBroker,
  ConversationRewindHostError,
  type ConversationRewindAnswer,
  type ConversationRewindHostBrokerOptions,
  type ConversationRewindRequestKind,
} from '../../rewind/conversation-host-broker.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';

/** Build the broker the verbs and the rewind service share. */
export function createConversationRewindHostBroker(
  options: ConversationRewindHostBrokerOptions = {},
): ConversationRewindHostBroker {
  return new ConversationRewindHostBroker(options);
}

function requireString(value: unknown, field: string): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) {
    throw new GatewayVerbError(`Missing required field: ${field}`, 'INVALID_ARGUMENT', 400, field);
  }
  return text;
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new GatewayVerbError(`Invalid ${field}: expected a number`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

function requireCount(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new GatewayVerbError(`Invalid ${field}: expected a whole number of messages, zero or more`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

/**
 * Who registered each host, per broker. A host answers rewind questions with
 * counts and a snapshot id the daemon trusts, so only the principal that holds
 * a host may renew it, poll it, answer for it or release it, and a second
 * principal may not take its session over by registering without a hostId.
 * Kept here, not in the broker, because the broker has no notion of a caller.
 */
const hostOwners = new WeakMap<ConversationRewindHostBroker, Map<string, string>>();

function ownersOf(broker: ConversationRewindHostBroker): Map<string, string> {
  let owners = hostOwners.get(broker);
  if (!owners) {
    owners = new Map();
    hostOwners.set(broker, owners);
  }
  return owners;
}

function callerKey(invocation: GatewayMethodInvocation): string | undefined {
  const { principalId, principalKind } = invocation.context;
  return principalId ? `${principalKind ?? 'unknown'}:${principalId}` : undefined;
}

function assertHostOwner(broker: ConversationRewindHostBroker, hostId: string, invocation: GatewayMethodInvocation, what: string): void {
  const owner = ownersOf(broker).get(hostId);
  if (owner !== undefined && owner !== callerKey(invocation)) {
    throw new GatewayVerbError(
      `Host ${JSON.stringify(hostId)} was registered by a different principal, so this caller cannot ${what} it. Register this surface's own host for the session instead.`,
      'FORBIDDEN',
      403,
      'hostId',
    );
  }
}

/**
 * Every broker refusal is about the caller's input, a host id that is not the
 * host, a request that is no longer waiting, so each carries the field it is
 * about and a 409: the call was well-formed, the world had moved on. The code
 * is the broker's, so a surface told its session was taken over can stop
 * without reading the sentence.
 */
function asVerbError(error: unknown): never {
  if (error instanceof ConversationRewindHostError) {
    throw new GatewayVerbError(error.message, error.code, 409, error.field);
  }
  throw error;
}

/**
 * Read the answer a host is reporting, in the shape the REQUEST calls for.
 *
 * The kind comes from the request the broker raised, never from the caller. An
 * answer that restated it could only ever disagree with it, and the disagreement
 * would be silent, a preview answer accepted for a rewind request would report
 * a truncation that never happened.
 */
function readAnswer(
  params: Record<string, unknown>,
  kind: ConversationRewindRequestKind,
): ConversationRewindAnswer {
  // Checked first, and for either kind: a surface that cannot serve the request
  // says so, and saying so is more useful than any number it could invent.
  const unavailableReason = typeof params.unavailableReason === 'string' ? params.unavailableReason.trim() : '';
  if (unavailableReason) return { kind: 'unavailable', reason: unavailableReason };

  if (kind === 'preview') {
    return {
      kind: 'preview',
      messagesToDrop: requireCount(params.messagesToDrop, 'messagesToDrop'),
      messagesRemaining: requireCount(params.messagesRemaining, 'messagesRemaining'),
    };
  }
  return {
    kind: 'rewind',
    droppedMessages: requireCount(params.droppedMessages, 'droppedMessages'),
    undoSnapshotId: requireString(params.undoSnapshotId, 'undoSnapshotId'),
  };
}

export function createConversationHostRegisterHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireString(params.sessionId, 'sessionId');
    const hostId = typeof params.hostId === 'string' ? params.hostId.trim() : '';
    const label = typeof params.label === 'string' ? params.label.trim() : '';
    const leaseMs = optionalNumber(params.leaseMs, 'leaseMs');
    const owners = ownersOf(broker);
    const held = broker.listHosts();
    for (const hostIdKnown of [...owners.keys()]) {
      if (!held.some((host) => host.hostId === hostIdKnown)) owners.delete(hostIdKnown);
    }
    if (hostId) {
      assertHostOwner(broker, hostId, invocation, 'renew');
    } else {
      const current = held.find((host) => host.sessionId === sessionId);
      const owner = current ? owners.get(current.hostId) : undefined;
      if (current && owner !== undefined && owner !== callerKey(invocation)) {
        throw new GatewayVerbError(
          `Session ${JSON.stringify(sessionId)} is already served by ${JSON.stringify(current.label)}, registered by a different principal, so it was not replaced. Wait for its lease to lapse, or have that principal release it.`,
          'FORBIDDEN',
          403,
          'sessionId',
        );
      }
    }
    try {
      const caller = callerKey(invocation);
      const host = broker.registerHost({
        sessionId,
        ...(caller === undefined ? {} : { principalId: caller }),
        ...(hostId ? { hostId } : {}),
        ...(label ? { label } : {}),
        ...(leaseMs === undefined ? {} : { leaseMs }),
      });
      if (caller !== undefined) owners.set(host.hostId, caller);
      return {
        host,
        renewed: hostId.length > 0,
        maxWaitMs: CONVERSATION_HOST_MAX_WAIT_MS,
        answerTimeoutMs: CONVERSATION_ANSWER_TIMEOUT_MS,
      };
    } catch (error) {
      asVerbError(error);
    }
  };
}

export function createConversationHostReleaseHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = requireString(params.sessionId, 'sessionId');
    const hostId = requireString(params.hostId, 'hostId');
    assertHostOwner(broker, hostId, invocation, 'release');
    try {
      return { released: true, host: broker.releaseHost({ sessionId, hostId }) };
    } catch (error) {
      asVerbError(error);
    }
  };
}

export function createConversationHostsListHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return () => ({ hosts: broker.listHosts() });
}

export function createConversationRequestsTakeHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const hostId = requireString(params.hostId, 'hostId');
    assertHostOwner(broker, hostId, invocation, 'poll');
    const waitMs = optionalNumber(params.waitMs, 'waitMs');
    const limit = optionalNumber(params.limit, 'limit');
    try {
      const taken = await broker.takeRequests({
        hostId,
        ...(waitMs === undefined ? {} : { waitMs }),
        ...(limit === undefined ? {} : { limit }),
      });
      return { requests: taken.requests, host: taken.host };
    } catch (error) {
      asVerbError(error);
    }
  };
}

export function createConversationRequestsAnswerHandler(broker: ConversationRewindHostBroker): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const hostId = requireString(params.hostId, 'hostId');
    const requestId = requireString(params.requestId, 'requestId');
    assertHostOwner(broker, hostId, invocation, 'answer for');
    // Which request this is, and whether this surface may answer it at all,
    // is settled before the payload is read, so a caller answering something
    // that is no longer waiting is told that, rather than being marched through
    // a field check for a question nobody is listening to.
    let kind: ConversationRewindRequestKind;
    try {
      kind = broker.describeRequest({ hostId, requestId }).kind;
    } catch (error) {
      asVerbError(error);
    }
    const answer = readAnswer(params, kind);
    try {
      return { accepted: true, request: broker.answerRequest({ hostId, requestId, answer }) };
    } catch (error) {
      asVerbError(error);
    }
  };
}

/** Attach the conversation-host handlers to their descriptors (missing = no-op). */
export function registerRewindConversationHostGatewayMethods(
  catalog: GatewayMethodCatalog,
  broker: ConversationRewindHostBroker,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('rewind.conversation.host.register', createConversationHostRegisterHandler(broker));
  attach('rewind.conversation.host.release', createConversationHostReleaseHandler(broker));
  attach('rewind.conversation.hosts.list', createConversationHostsListHandler(broker));
  attach('rewind.conversation.requests.take', createConversationRequestsTakeHandler(broker));
  attach('rewind.conversation.requests.answer', createConversationRequestsAnswerHandler(broker));
}
