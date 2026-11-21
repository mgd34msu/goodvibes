import { logger } from '../utils/logger.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { CommunicationKind, CommunicationScope } from '../../events/communication.js';
import { emitCommunicationBlocked, emitCommunicationDelivered, emitCommunicationSent } from '../runtime/emitters/index.js';
import { summarizeError } from '../utils/error-display.js';
import {
  communicationRoleForTemplate,
  evaluateCommunicationRoute,
  type AgentCommunicationMetadata,
} from './communication-policy.js';

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  ttlMs: number;
  kind: CommunicationKind;
  scope: CommunicationScope;
  fromRole?: string | undefined;
  toRole?: string | undefined;
  cohort?: string | undefined;
  contractId?: string | undefined;
  parentAgentId?: string | undefined;
}

export type MessageCallback = (message: AgentMessage) => void;

type MessageOptions = {
  /**
   * Caller-supplied message id. Lets a caller (e.g. ProcessRegistry.steer())
   * learn the id synchronously from its own return value instead of from
   * send()'s boolean result. Defaults to a fresh crypto.randomUUID() when
   * omitted, existing callers are unaffected.
   */
  id?: string | undefined;
  ttlMs?: number | undefined;
  kind?: CommunicationKind | undefined;
  scope?: CommunicationScope | undefined;
  cohort?: string | undefined;
  contractId?: string | undefined;
  parentAgentId?: string | undefined;
};

const DEFAULT_TTL_MS = 5 * 60 * 1000;
/** Sender id of the operator's own steering messages. */
const OPERATOR_SENDER_ID = 'operator';
/** Identities the bus itself provides; never removed with an agent. */
const BUILT_IN_IDENTITIES: ReadonlySet<string> = new Set(['orchestrator', OPERATOR_SENDER_ID]);

const UNREGISTERED_SENDER_REASON = 'the sender is not a registered agent; register it before it sends';
const UNKNOWN_RECIPIENT_REASON = 'no such agent (it may have finished); list running agents and send to one of them';
const EXPIRED_REASON = 'not delivered: it expired before the recipient took it into a turn; send it again if it still applies';
const RECIPIENT_GONE_REASON = 'not delivered: the recipient finished before taking it into a turn';

export class AgentMessageBus {
  private messages = new Map<string, AgentMessage[]>();
  private subscriptions = new Map<string, Set<MessageCallback>>();
  private identities = new Map<string, AgentCommunicationMetadata>([
    ['orchestrator', { agentId: 'orchestrator', role: 'orchestrator' }],
    [OPERATOR_SENDER_ID, { agentId: OPERATOR_SENDER_ID, role: 'orchestrator' }],
  ]);
  private runtimeBus: RuntimeEventBus | null = null;
  /** Direct messages the recipient took into a turn; a discarded message not in here was never delivered. */
  private delivered = new Set<string>();
  /** Messages a recipient drained into a request it sent: their receipt is consumed, never blocked (see markTaken). */
  private readonly taken = new Map<string, AgentMessage>();

  setRuntimeBus(runtimeBus: RuntimeEventBus | null): void {
    this.runtimeBus = runtimeBus;
  }

  registerAgent(meta: {
    agentId: string;
    template?: string | undefined;
    role?: AgentCommunicationMetadata['role'] | undefined;
    parentAgentId?: string | undefined;
    cohort?: string | undefined;
    contractId?: string | undefined;
  }): void {
    this.identities.set(meta.agentId, {
      agentId: meta.agentId,
      role: meta.role ?? communicationRoleForTemplate(meta.template),
      ...(meta.parentAgentId !== undefined ? { parentAgentId: meta.parentAgentId } : {}),
      ...(meta.cohort !== undefined ? { cohort: meta.cohort } : {}),
      ...(meta.contractId !== undefined ? { contractId: meta.contractId } : {}),
    });
  }

  /**
   * Forget a finished agent: its identity (so the map does not grow with every
   * spawn) and the messages still waiting for it. Subscriptions are released by
   * the unsubscribe function `subscribe` returned.
   */
  unregisterAgent(agentId: string): void {
    if (BUILT_IN_IDENTITIES.has(agentId)) return;
    this.identities.delete(agentId);
    this.discard(this.messages.get(agentId) ?? [], RECIPIENT_GONE_REASON);
    this.messages.delete(agentId);
  }

  /**
   * A broadcast stamped with a contract (or, failing that, a cohort) reaches only
   * members of it; an unscoped one, from a coordinator outside any contract, reaches everyone.
   */
  private receivesBroadcast(message: AgentMessage, recipientId: string): boolean {
    const recipient = this.identities.get(recipientId);
    if (message.contractId !== undefined) return recipient?.contractId === message.contractId;
    if (message.cohort !== undefined) return recipient?.cohort === message.cohort;
    return true;
  }

  private resolveOptions(ttlOrOptions: number | MessageOptions | undefined): Required<Pick<MessageOptions, 'ttlMs' | 'kind' | 'scope'>> & Omit<MessageOptions, 'ttlMs' | 'kind' | 'scope'> {
    if (typeof ttlOrOptions === 'number') {
      return { ttlMs: ttlOrOptions, kind: 'directive', scope: 'direct' };
    }
    return {
      ttlMs: ttlOrOptions?.ttlMs ?? DEFAULT_TTL_MS,
      kind: ttlOrOptions?.kind ?? 'directive',
      scope: ttlOrOptions?.scope ?? 'direct',
      ...(ttlOrOptions?.cohort !== undefined ? { cohort: ttlOrOptions.cohort } : {}),
      ...(ttlOrOptions?.contractId !== undefined ? { contractId: ttlOrOptions.contractId } : {}),
      ...(ttlOrOptions?.parentAgentId !== undefined ? { parentAgentId: ttlOrOptions.parentAgentId } : {}),
      ...(ttlOrOptions?.id !== undefined ? { id: ttlOrOptions.id } : {}),
    };
  }

  send(fromId: string, toId: string, content: string, ttlOrOptions: number | MessageOptions = DEFAULT_TTL_MS): boolean {
    this.cleanup();
    const options = this.resolveOptions(ttlOrOptions);
    const fromMeta = this.identities.get(fromId);
    const toMeta = this.identities.get(toId);

    if (!fromMeta) {
      this.emitBlocked(crypto.randomUUID(), fromId, toId, content, options, UNREGISTERED_SENDER_REASON, undefined, toMeta);
      return false;
    }
    // A message to an id nobody holds (a finished agent, a mistyped id) would wait unread until it expired.
    if (!toMeta) {
      this.emitBlocked(crypto.randomUUID(), fromId, toId, content, options, UNKNOWN_RECIPIENT_REASON, fromMeta);
      return false;
    }
    const decision = evaluateCommunicationRoute({
      from: fromMeta,
      to: toMeta,
      kind: options.kind!,
      scope: 'direct',
    });
    if (!decision.allowed) {
      const blockedId = crypto.randomUUID();
      this.emitBlocked(blockedId, fromId, toId, content, options, decision.reason ?? 'communication blocked by policy', fromMeta, toMeta);
      return false;
    }

    const message: AgentMessage = {
      id: options.id ?? crypto.randomUUID(),
      from: fromId,
      to: toId,
      content,
      timestamp: Date.now(),
      ttlMs: options.ttlMs!,
      kind: options.kind!,
      scope: 'direct',
      ...(fromMeta?.role !== undefined ? { fromRole: fromMeta.role } : {}),
      ...(toMeta?.role !== undefined ? { toRole: toMeta.role } : {}),
      ...this.pickRoutingFields(options, fromMeta, toMeta),
    };

    this.store(toId, message);
    this.deliver(toId, message);
    this.emitSent(message);
    return true;
  }

  broadcast(fromId: string, content: string, ttlOrOptions: number | MessageOptions = DEFAULT_TTL_MS): boolean {
    this.cleanup();
    const options = this.resolveOptions(ttlOrOptions);
    const fromMeta = this.identities.get(fromId);
    if (!fromMeta) {
      this.emitBlocked(crypto.randomUUID(), fromId, '*', content, { ...options, scope: 'broadcast' }, UNREGISTERED_SENDER_REASON);
      return false;
    }
    const decision = evaluateCommunicationRoute({
      from: fromMeta,
      to: { agentId: '*', role: 'general', ...(fromMeta.cohort !== undefined ? { cohort: fromMeta.cohort } : {}) },
      kind: options.kind!,
      scope: 'broadcast',
    });
    if (!decision.allowed) {
      const blockedId = crypto.randomUUID();
      this.emitBlocked(blockedId, fromId, '*', content, { ...options, scope: 'broadcast' }, decision.reason ?? 'broadcast blocked by policy', fromMeta);
      return false;
    }

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      from: fromId,
      to: '*',
      content,
      timestamp: Date.now(),
      ttlMs: options.ttlMs!,
      kind: options.kind!,
      scope: 'broadcast',
      ...(fromMeta?.role !== undefined ? { fromRole: fromMeta.role } : {}),
      ...(options.cohort ?? fromMeta?.cohort ? { cohort: options.cohort ?? fromMeta?.cohort } : {}),
      ...(options.contractId ?? fromMeta?.contractId ? { contractId: options.contractId ?? fromMeta?.contractId } : {}),
      ...(options.parentAgentId ?? fromMeta?.parentAgentId ? { parentAgentId: options.parentAgentId ?? fromMeta?.parentAgentId } : {}),
    };

    this.store('*', message);

    for (const [recipientId, callbacks] of this.subscriptions) {
      if (!this.receivesBroadcast(message, recipientId)) continue;
      for (const callback of callbacks) {
        try {
          callback(message);
        } catch (error) {
          logger.warn('MessageBus: subscriber error in broadcast', {
            error: summarizeError(error),
          });
        }
      }
    }
    this.emitSent(message);
    return true;
  }

  subscribe(agentId: string, callback: MessageCallback): () => void {
    if (!this.subscriptions.has(agentId)) {
      this.subscriptions.set(agentId, new Set());
    }
    this.subscriptions.get(agentId)?.add(callback);

    return () => {
      const callbacks = this.subscriptions.get(agentId);
      if (!callbacks) return;
      callbacks.delete(callback);
      if (callbacks.size === 0) {
        this.subscriptions.delete(agentId);
      }
    };
  }

  getMessages(agentId: string): AgentMessage[] {
    this.cleanup();
    const now = Date.now();
    const direct = (this.messages.get(agentId) ?? []).filter(
      (message) => now - message.timestamp < message.ttlMs,
    );
    const broadcasts = (this.messages.get('*') ?? []).filter(
      (message) => now - message.timestamp < message.ttlMs && this.receivesBroadcast(message, agentId),
    );
    return [...direct, ...broadcasts].sort((a, b) => a.timestamp - b.timestamp);
  }

  private emitSent(message: AgentMessage): void {
    if (!this.runtimeBus) return;
    emitCommunicationSent(this.runtimeBus, this.commContext(message.id, 'sent'), {
      messageId: message.id,
      fromId: message.from,
      toId: message.to,
      scope: message.scope,
      kind: message.kind,
      content: message.content,
      ...(message.fromRole !== undefined ? { fromRole: message.fromRole } : {}),
      ...(message.toRole !== undefined ? { toRole: message.toRole } : {}),
      ...(message.cohort !== undefined ? { cohort: message.cohort } : {}),
      ...(message.contractId !== undefined ? { contractId: message.contractId } : {}),
      ...(message.parentAgentId !== undefined ? { parentAgentId: message.parentAgentId } : {}),
    });
  }

  /**
   * The recipient took a stored message into a turn. `delivered` is emitted here, not when the
   * message was queued: a message waiting for a long turn to end has been sent, not delivered.
   */
  markDelivered(agentId: string, messageId: string): void {
    const message = [...(this.messages.get(agentId) ?? []), ...(this.messages.get('*') ?? [])].find((candidate) => candidate.id === messageId)
      ?? this.taken.get(messageId);
    this.taken.delete(messageId);
    if (!message) return;
    if (message.scope === 'direct') this.delivered.add(message.id);
    this.emitDelivered(message);
  }

  private emitDelivered(message: AgentMessage): void {
    if (!this.runtimeBus) return;
    emitCommunicationDelivered(this.runtimeBus, this.commContext(message.id, 'delivered'), {
      messageId: message.id,
      fromId: message.from,
      toId: message.to,
      scope: message.scope,
      kind: message.kind,
    });
  }

  private emitBlocked(
    messageId: string,
    fromId: string,
    toId: string,
    content: string,
    options: Required<Pick<MessageOptions, 'ttlMs' | 'kind' | 'scope'>> & Omit<MessageOptions, 'ttlMs' | 'kind' | 'scope'>,
    reason: string,
    fromMeta?: AgentCommunicationMetadata,
    toMeta?: AgentCommunicationMetadata,
  ): void {
    if (!this.runtimeBus) return;
    emitCommunicationBlocked(this.runtimeBus, this.commContext(messageId, 'blocked'), {
      messageId,
      fromId,
      toId,
      scope: options.scope!,
      kind: options.kind!,
      reason,
      ...(fromMeta?.role !== undefined ? { fromRole: fromMeta.role } : {}),
      ...(toMeta?.role !== undefined ? { toRole: toMeta.role } : {}),
      ...this.pickRoutingFields(options, fromMeta, toMeta),
    });
    logger.warn('MessageBus: communication blocked', {
      fromId,
      toId,
      kind: options.kind,
      scope: options.scope,
      reason,
      content,
    });
  }

  /** Build the standard runtime event context for agent-communication bus events. */
  private commContext(
    messageId: string,
    phase: 'sent' | 'delivered' | 'blocked',
  ): { sessionId: string; traceId: string; source: string } {
    return {
      sessionId: 'agent-communication',
      traceId: `agent-communication:${messageId}:${phase}`,
      source: 'agent-message-bus',
    };
  }

  /**
   * Extract optional routing fields from options + sender/receiver metadata.
   *
   * Coalescing rules (intentionally asymmetric):
   *   cohort, contractId  , options ?? fromMeta ?? toMeta
   *   parentAgentId   , options ?? fromMeta ONLY (toMeta excluded to avoid
   *                      leaking the recipient's parent onto unrelated messages).
   */
  private pickRoutingFields(
    options: { cohort?: string | undefined; contractId?: string | undefined; parentAgentId?: string | undefined },
    fromMeta: AgentCommunicationMetadata | undefined,
    toMeta: AgentCommunicationMetadata | undefined,
  ): { cohort?: string | undefined; contractId?: string | undefined; parentAgentId?: string | undefined } {
    return {
      ...(options.cohort ?? fromMeta?.cohort ?? toMeta?.cohort ? { cohort: options.cohort ?? fromMeta?.cohort ?? toMeta?.cohort } : {}),
      ...(options.contractId ?? fromMeta?.contractId ?? toMeta?.contractId ? { contractId: options.contractId ?? fromMeta?.contractId ?? toMeta?.contractId } : {}),
      ...(options.parentAgentId ?? fromMeta?.parentAgentId ? { parentAgentId: options.parentAgentId ?? fromMeta?.parentAgentId } : {}),
    };
  }

  /**
   * The recipient drained a stored message into a request it is about to send:
   * from here the message's one receipt is `consumed` (or nothing, when the
   * request fails for good), never `blocked`. Expiry passes over it, so a long
   * request cannot leave both a blocked and a consumed receipt for one message.
   */
  markTaken(messageId: string, message?: AgentMessage): void {
    const found = message ?? [...this.messages.values()].flat().find((candidate) => candidate.id === messageId);
    if (found) this.taken.set(messageId, found);
  }

  /**
   * The request these messages were taken into never succeeded (its run
   * failed): they are no longer held as taken. One still in the store then
   * expires as a message no request delivered.
   */
  releaseTaken(messageIds: readonly string[]): void {
    for (const messageId of messageIds) this.taken.delete(messageId);
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, messages] of this.messages) {
      const alive = messages.filter((message) => now - message.timestamp < message.ttlMs);
      if (alive.length !== messages.length) this.discard(messages.filter((message) => !alive.includes(message)), EXPIRED_REASON);
      if (alive.length === 0) {
        this.messages.delete(key);
        continue;
      }
      this.messages.set(key, alive);
    }
  }

  /**
   * Messages leaving the store. A direct message its recipient never took into a
   * turn ends with a blocked event naming why, so the sender's last word on it
   * is not "sent". Broadcasts have no single recipient and end silently.
   */
  private discard(messages: readonly AgentMessage[], reason: string): void {
    for (const message of messages) {
      if (message.scope !== 'direct') continue;
      if (this.delivered.delete(message.id)) continue;
      // Taken into a request already: its receipt is consumed, not blocked.
      if (this.taken.has(message.id)) continue;
      this.emitBlocked(message.id, message.from, message.to, message.content,
        { ttlMs: message.ttlMs, kind: message.kind, scope: message.scope, cohort: message.cohort, contractId: message.contractId, parentAgentId: message.parentAgentId },
        reason, this.identities.get(message.from), this.identities.get(message.to));
    }
  }

  private store(recipientId: string, message: AgentMessage): void {
    if (!this.messages.has(recipientId)) {
      this.messages.set(recipientId, []);
    }
    this.messages.get(recipientId)?.push(message);
  }

  private deliver(agentId: string, message: AgentMessage): void {
    const callbacks = this.subscriptions.get(agentId);
    if (!callbacks) return;
    for (const callback of callbacks) {
      try {
        callback(message);
      } catch (error) {
        logger.warn('MessageBus: subscriber error in deliver', {
          error: summarizeError(error),
        });
      }
    }
  }
}
