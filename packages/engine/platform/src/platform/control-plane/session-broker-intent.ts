import { EngineErrorCodes } from '@goodvibes-jev/engine/errors';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type {
  SharedSessionInputIntent,
  SharedSessionInputRecord,
  SharedSessionSurfaceReplyBinding,
} from './session-intents.js';
import type {
  CreateSharedSessionInput,
  ParticipantRouteAttachInput,
  SharedSessionMessage,
  SharedSessionParticipant,
  SharedSessionRecord,
  SharedSessionSubmission,
  SubmitSharedSessionMessageInput,
} from './session-types.js';
import type { SharedSessionMessageSender } from './session-broker-helpers.js';
import type { AppendSharedSessionMessageInput } from './session-broker-messages.js';
import {
  moveSharedSessionInputOrKeep,
  recordSharedSessionInput,
  updateSharedSessionInput,
  type SharedSessionInputStore,
} from './session-broker-inputs.js';
import { isSystemClosedSession, SURFACE_ROUTE_FRESHNESS_MS, shouldRouteInputToSurface } from './session-broker-sessions.js';
import { decideContinuationEscalation } from '../agents/conversation-continuation.js';
import type { ConversationGateConfigReader } from '../agents/conversation-gate.js';
import { isDelegatedSessionInput } from './session-intents.js';
import { logger } from '../utils/logger.js';

/** Max inputs retained per session bucket (moved here with handleIntent, see
 * session-broker.ts's MAX_PERSISTED_INPUTS for its former home). */
const MAX_PERSISTED_INPUTS = 500;

/**
 * What an earlier delivery of a provider message left: the message itself,
 * answered or on its way (`held`, returned as the duplicate), or a message
 * whose start failed (`retry`: answered again from the user message already
 * stored, and with `input` from the row still queued for it).
 */
export type ProviderMessageClaim =
  | { readonly kind: 'held'; readonly submission: SharedSessionSubmission }
  | { readonly kind: 'retry'; readonly sessionId: string; readonly userMessage: SharedSessionMessage; readonly input?: SharedSessionInputRecord | undefined };

export interface HandleSharedSessionIntentDeps {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messageSender: SharedSessionMessageSender;
  start(): Promise<void>;
  resolveBinding(input: SubmitSharedSessionMessageInput): Promise<AutomationRouteBinding | null>;
  createSession(input?: CreateSharedSessionInput): Promise<SharedSessionRecord>;
  /** Reopen a session the system closed (idle reaper, boot sweep), keeping its transcript. */
  reopenSession?(sessionId: string): Promise<SharedSessionRecord | null>;
  attachParticipantAndRoute(
    session: SharedSessionRecord,
    input: ParticipantRouteAttachInput,
    binding?: AutomationRouteBinding,
  ): Promise<SharedSessionRecord>;
  appendMessage(
    sessionId: string,
    input: Omit<AppendSharedSessionMessageInput, 'sessionId'>,
  ): Promise<SharedSessionMessage>;
  /** In-memory only: a delegated input binds before its message is published. */
  appendUnpublishedMessage(sessionId: string, input: Omit<AppendSharedSessionMessageInput, 'sessionId'>): SharedSessionMessage;
  sessionInputStore(): SharedSessionInputStore;
  publishInputLifecycleEvent(
    event: string,
    input: SharedSessionInputRecord,
    extra?: Record<string, unknown>,
  ): void;
  resolveActiveAgentId(session: SharedSessionRecord): string | undefined;
  /** An agent is being started for the session but is not yet bound to it. */
  hasSpawnInFlight?(sessionId: string): boolean;
  persist(durable?: boolean): Promise<void>;
  publishUpdate(event: string, payload: unknown): void;
  announceSurfaceReply(binding: SharedSessionSurfaceReplyBinding): void;
  /**
   * Put one unsolicited line on a route's channel. Optional: a host that wired
   * no delivery path (every broker-level test, an embedder with its own egress)
   * simply gets no notice, and the rollover is still logged.
   */
  sendSurfaceNotice?: ((routeId: string, text: string) => void) | undefined;
  buildContinuationTask(sessionId: string): string;
  /** Bring a session's stored messages and inputs into memory when they are on disk only; one log read, then nothing. */
  loadSessionHistory?(sessionId: string): void;
  /** What an earlier delivery recorded under this provider message key, when anything. */
  findProviderMessage?(key: string): ProviderMessageClaim | null;
  /** Remember which input holds a provider message key. */
  noteProviderMessage?(key: string, sessionId: string, inputId: string): void;
  /**
   * Reads `conversationGate.*` for the live-agent handover decision below.
   * Optional: absent means the defaults in conversation-gate.ts, which gate
   * every channel surface and exempt local ones, the safe direction, since
   * the failure mode of gating is an answer instead of a contract.
   */
  readonly conversationGateConfig?: ConversationGateConfigReader | undefined;
  /** Whether a channel sender is someone the channel admits who is not its owner (their message never directs a running agent). */
  readonly senderIsGuest?: ((surfaceKind: string, userId: string | undefined) => boolean) | undefined;
}

/**
 * Whether a route binding's OWN session policy permits pointing it at a fresh
 * session. `create-or-bind` says exactly that, and it is what
 * `RouteBindingManager.upsertBinding` writes for every binding that does not
 * pick something else (channels/route-manager.ts), so it covers every chat a
 * channel adapter opens. `continue-existing` and `require-existing` were chosen
 * to mean this route speaks only to the session it names, so they keep the
 * honest closed-session error rather than silently moving the conversation.
 */
function bindingMayRebind(binding: AutomationRouteBinding): boolean {
  return (binding.sessionPolicy ?? 'create-or-bind') === 'create-or-bind';
}

/**
 * Why the session a route binding names cannot carry this message, or `null`
 * when it can.
 *
 * A binding's `sessionId` is a ROUTING HINT, not a fact. It is written once and
 * then outlives everything it points at: the session gets closed, a GC sweep
 * deletes it, the node is restored from a backup taken before the session
 * existed, a surface is elected to a machine whose store never held it. Every
 * one of those leaves a binding naming something this node cannot use, and the
 * conversation on the other end has no way to know or to say so.
 *
 * Two of those deserve naming precisely, because the cluster layer decides
 * them and its answer is short. Sessions do not replicate, the store is
 * `~/.goodvibes/control-plane/sessions.json` on ONE machine, and
 * cluster/index.ts says so outright ("sessions... never pass through here").
 * Neither does `automation-routes.json`. What a surface election moves is the
 * right to READ the inbox, nothing else. So a promotion or a reconnect never
 * produces "a session owned elsewhere", there is no node-identity field on
 * either record to express such a thing. It produces exactly one observable:
 * a binding naming a session this node's store does not have. Which is the
 * first branch below, and which used to be absorbed in silence.
 *
 * So the hint is CHECKED on every resolve, and the check is written as
 * "prove it is usable", not "rule out the failures I have seen". The last two
 * branches are belt-and-braces: the store loader sets a record it cannot read
 * aside (session-broker-state.ts), so a record here is normally well-formed by
 * construction. They exist so that an in-process
 * writer, or a status this enum grows later, cannot strand the channel just
 * because nobody predicted it.
 */
function describeUnusableBoundSession(session: SharedSessionRecord | undefined): string | null {
  if (!session) return 'the earlier conversation is not on this machine';
  if (typeof session.id !== 'string' || session.id.length === 0) return 'the earlier conversation has no id';
  if (session.status === 'closed') return 'the earlier conversation was closed';
  if (session.status !== 'active') return `the record it named has an unusable status (${String(session.status)})`;
  return null;
}

/**
 * Say out loud that a conversation is moving to a new session, and name any
 * still-'active' sessions this same route is listed on while doing it.
 *
 * Those stranded actives are a real and separate problem, sessions whose host
 * process is long gone and which nothing will ever close, so they sit 'active'
 * forever. Reaping them belongs to session GC, not here. But the rollover is
 * the one moment the code can prove it is stepping over them, and a log line
 * costs nothing.
 */
function logChannelSessionRollover(
  deps: HandleSharedSessionIntentDeps,
  binding: AutomationRouteBinding,
  boundSessionId: string,
  reason: string,
  input: SubmitSharedSessionMessageInput,
): void {
  const strandedActiveSessionIds: string[] = [];
  for (const entry of deps.sessions.values()) {
    if (entry.status === 'active' && entry.routeIds.includes(binding.id)) strandedActiveSessionIds.push(entry.id);
  }
  logger.warn('Channel route named an unusable session; rebinding the conversation to a new one', {
    routeId: binding.id,
    surfaceKind: input.surfaceKind,
    boundSessionId,
    reason,
    sessionPolicy: binding.sessionPolicy ?? 'create-or-bind',
    ...(strandedActiveSessionIds.length > 0 ? { strandedActiveSessionIds } : {}),
  });
}

/**
 * Tell the person on the far end that their conversation just moved.
 *
 * Without this the rollover is silent and looks like amnesia: the assistant
 * that remembered the last two days answers the next message with no idea what
 * came before, and the owner is left guessing whether it broke. One sentence
 * turns that into something comprehensible.
 *
 * Sent through the broker's surface-notice port, which the composition root
 * wires to `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice`, the same path
 * every other unsolicited message to a channel goes out on. Fire-and-forget on
 * purpose: a notice that cannot be delivered is logged by that helper, and must
 * never be a reason the owner's actual message fails to be processed.
 */
function announceRolloverOnChannel(
  deps: HandleSharedSessionIntentDeps,
  binding: AutomationRouteBinding,
  reason: string,
): void {
  if (!deps.sendSurfaceNotice) return;
  try {
    deps.sendSurfaceNotice(
      binding.id,
      `Starting a new conversation: ${reason}, so I cannot see the earlier messages. Nothing was deleted; the earlier conversation is kept as history.`,
    );
  } catch (error) {
    logger.warn('Rollover notice could not be handed to the surface delivery path', {
      routeId: binding.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Input-row metadata field holding the idempotency key of a message that carried a provider id. */
export const PROVIDER_MESSAGE_KEY_FIELD = 'providerMessageKey';

/**
 * surface kind, surface id, conversation, provider id and, when the caller
 * names one, the session: the same message is never recorded under two of
 * these. A caller addressing sessions by id numbers its messages per session
 * ("1", "msg-1"), so the same id sent to another session is another message,
 * never a duplicate of the first session's input.
 */
export function providerMessageKey(input: SubmitSharedSessionMessageInput): string | null {
  const id = input.providerMessageId?.trim();
  if (!id) return null;
  const key = `${input.surfaceKind}:${input.surfaceId}:${input.externalId ?? ''}:${id}`;
  const sessionId = input.sessionId?.trim();
  return sessionId ? `${key}:session:${sessionId}` : key;
}

export async function handleSharedSessionIntent(
  deps: HandleSharedSessionIntentDeps,
  intent: SharedSessionInputIntent,
  input: SubmitSharedSessionMessageInput,
  allowSpawnFallback: boolean,
  onQueued?: (input: SharedSessionInputRecord) => void,
): Promise<SharedSessionSubmission> {
  await deps.start();

  const binding = await deps.resolveBinding(input);
  const providerKey = providerMessageKey(input);
  if (providerKey) {
    // The session this message would land in may be closed with its history
    // still on disk (after a restart); its stored rows are what tells a
    // redelivery from a new message, so they are read before the lookup.
    for (const sessionId of new Set([input.sessionId, binding?.sessionId])) {
      if (sessionId) deps.loadSessionHistory?.(sessionId);
    }
  }
  const earlier = providerKey ? deps.findProviderMessage?.(providerKey) ?? null : null;
  if (earlier?.kind === 'held') return earlier.submission;
  const retry = earlier?.kind === 'retry' ? earlier : undefined;

  // WHERE the session came from decides what a CLOSED one means, and the two
  // sources are not interchangeable. `input.sessionId` is a caller naming one
  // specific record, it asked about THAT session, and the honest answer when
  // that session is closed is the 409 below. `binding.sessionId` is only where
  // the route last parked this conversation; the sender named nothing.
  // A retried provider message goes back to the session that already holds it.
  let session = retry ? deps.sessions.get(retry.sessionId) ?? undefined
    : input.sessionId ? deps.sessions.get(input.sessionId) ?? undefined : undefined;
  let created = false;
  let rolledOverFrom: string | undefined;
  if (!session && binding?.sessionId) {
    // A conversation the system closed (the idle timer, the boot sweep) was
    // never ended by anyone: a channel has no heartbeat, so its next message
    // is the sign of life, and it reopens with its transcript, as a terminal
    // or web session does on its next heartbeat.
    const parked = deps.sessions.get(binding.sessionId);
    if (parked && parked.status === 'closed' && isSystemClosedSession(parked) && deps.reopenSession) {
      session = (await deps.reopenSession(parked.id)) ?? undefined;
    }
  }
  if (!session && binding?.sessionId) {
    // VALIDATE THE HINT, THEN HEAL IT.
    //
    // There is no client on the far side of a channel to read an error and
    // open a new chat the way the webui companion does: every channel ingress
    // catches, logs and advances its read cursor, so an error thrown here
    // discards the sender's message AND every message after it, for as long as
    // the binding keeps naming the same dead target. One closed session
    // black-holed the owner's Telegram chat exactly this way.
    //
    // `create-or-bind` is the binding SAYING it may be re-pointed, so re-point
    // it: leave whatever it named untouched, and fall into the create branch
    // below, which mints a fresh session and rebinds the route to it durably
    // (createSession patches binding.sessionId through the store).
    const bound = deps.sessions.get(binding.sessionId);
    const unusable = describeUnusableBoundSession(bound);
    if (unusable !== null && bindingMayRebind(binding)) {
      rolledOverFrom = binding.sessionId;
      logChannelSessionRollover(deps, binding, binding.sessionId, unusable, input);
      // Only worth explaining when there WAS a conversation to lose. A binding
      // whose target merely never existed on this node still gets the notice,
      // that is the restored-backup / re-elected-node case, and it is precisely
      // the one that otherwise looks like unexplained amnesia.
      // Delegated admission has no outbound delivery authority. Ordinary
      // channel traffic retains its existing rollover explanation.
      if (!isDelegatedSessionInput(input)) announceRolloverOnChannel(deps, binding, unusable);
    } else {
      session = bound ?? undefined;
    }
  }
  // A message, task, steer or follow-up that names a session is about that
  // session. Minting a new one for an id nobody holds would answer a typo or a
  // stale id with a fresh empty conversation and start paid work in it, so the
  // id is refused and nothing is recorded or started. A new session is asked
  // for by naming none (or with sessions.create). A route binding is different:
  // it is the thing that may create its own session.
  if (!session && !binding && input.sessionId) {
    throw Object.assign(new Error(`Unknown shared session ${JSON.stringify(input.sessionId)}. Nothing was recorded or started; list the sessions and send to one that exists, or leave sessionId out to start a new session.`), { code: 'SESSION_NOT_FOUND', status: 404 });
  }
  if (!session) {
    const participant: SharedSessionParticipant = {
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      userId: input.userId,
      displayName: input.displayName,
      routeId: binding?.id,
      lastSeenAt: Date.now(),
    };
    session = await deps.createSession({
      title: input.title,
      // No resurrection: the successor is a NEW record that only NAMES the one
      // it replaced, so the closed session's messages stay its own history.
      metadata: rolledOverFrom === undefined
        ? input.metadata
        : { ...(input.metadata ?? {}), rolledOverFromSessionId: rolledOverFrom },
      routeBinding: binding ?? undefined,
      participant,
    });
    created = true;
  }

  // Closed sessions are history: steer/follow-up/submit against an EXISTING
  // closed record are rejected before mutation; auto-create for a missing session is untouched.
  // A channel binding that landed on a closed record never reaches here, it
  // rolled over above, because no channel sender can act on this error.
  if (session.status === 'closed') throw Object.assign(new Error('Session is closed'), { code: EngineErrorCodes.SESSION_CLOSED, status: 409 });
  const updatedSession = await deps.attachParticipantAndRoute(session, input, binding ?? undefined);
  const messageInput: Omit<AppendSharedSessionMessageInput, 'sessionId'> = {
    role: 'user',
    body: input.body,
    surfaceKind: input.surfaceKind,
    surfaceId: input.surfaceId,
    routeId: binding?.id,
    userId: input.userId,
    displayName: input.displayName,
    metadata: {
      ...(input.metadata ?? {}),
      sessionIntent: intent,
    },
  };
  const delegated = isDelegatedSessionInput(input);
  // A retry of a message whose start failed answers the user message already
  // stored, so a redelivery never puts it in the transcript twice.
  const reused = retry && retry.sessionId === updatedSession.id ? retry : undefined;
  const userMessage = reused ? reused.userMessage
    : delegated
      ? deps.appendUnpublishedMessage(updatedSession.id, messageInput)
      : await deps.appendMessage(updatedSession.id, messageInput);
  const queuedInput = reused?.input ?? recordSharedSessionInput(deps.sessionInputStore(), {
    sessionId: updatedSession.id,
    intent,
    message: providerKey ? { ...input, metadata: { ...(input.metadata ?? {}), [PROVIDER_MESSAGE_KEY_FIELD]: providerKey } } : input,
    routeId: binding?.id,
    causationId: userMessage.id,
    maxPersistedInputs: MAX_PERSISTED_INPUTS,
  });
  if (providerKey) deps.noteProviderMessage?.(providerKey, updatedSession.id, queuedInput.id);
  if (delegated) {
    try {
      // No await between canonical row creation and this trusted host binder.
      // Wire-supplied metadata can only reach this deny-only branch, never bind.
      onQueued?.(structuredClone(queuedInput));
      await deps.persist(true);
    } catch (error) {
      moveSharedSessionInputOrKeep(deps.sessionInputStore(), updatedSession.id, queuedInput.id, 'failed',
        { error: 'Delegated input binding or durability failed' });
      await deps.persist(true).catch(() => {});
      throw error;
    }
    deps.publishUpdate('session-message-appended', { sessionId: updatedSession.id, message: userMessage });
    deps.publishInputLifecycleEvent('session-input-queued', queuedInput, { messageId: userMessage.id });
    // This shape is private to the host submission seam. It offers neither a
    // task nor a live handover; the deny marker also excludes surface polling.
    return { session: deps.sessions.get(updatedSession.id)!, userMessage, routeBinding: binding ?? undefined,
      input: queuedInput, intent, mode: 'queued-for-surface', state: queuedInput.state, created };
  }
  if (!reused?.input) {
    deps.publishInputLifecycleEvent('session-input-queued', queuedInput, {
      messageId: userMessage.id,
    });
  }

  const activeAgentId = deps.resolveActiveAgentId(updatedSession);

  // THE LIVE-AGENT HANDOVER, and the third door into starting work.
  //
  // When a session already has a running agent, this branch hands the inbound
  // body straight to it as a `directive`. That is right for the operator typing
  // in their terminal. It was NOT right for a message arriving over a chat
  // surface: every channel adapter converges here through submitMessage, the
  // branch returns `continued-live`, and each adapter early-returns on it,
  // BEFORE the conversation gate that guards their spawn path. So a message
  // that would have been proposed if no agent were running was instead injected
  // as a directive into whatever work was already running. On a machine with a
  // live terminal session that is every inbound message, which is precisely how
  // "a note over ntfy" turned into checked work nobody agreed to.
  //
  // The rule is not invented here: `decideContinuationEscalation` already owns
  // it for the sibling continuation runner. Pre-authorized work (an agreed
  // proposal, a schedule, a trigger) and local surfaces hand over; a gated
  // channel surface does not, and falls through to the adapter's gated spawn
  // where the message is answered or proposed.
  const handover = decideContinuationEscalation(
    {
      ...(input.metadata ? { metadata: input.metadata } : {}),
      ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
      body: input.body,
    },
    deps.conversationGateConfig ? { configReader: deps.conversationGateConfig } : {},
  );
  if (intent !== 'follow-up' && activeAgentId) {
    if (!handover.startsContract) {
      logger.info('Inbound channel message was not handed to the running agent', {
        sessionId: updatedSession.id,
        surfaceKind: input.surfaceKind ?? 'unknown',
        agentId: activeAgentId,
        reason: handover.reason,
        detail: 'the conversation gate decides whether it is answered or proposed',
      });
    }
    // Only the handover is withheld. Every other decision in this block,
    // notably the steer rejection below, keeps its exact previous behavior.
    // A guest's message never directs a running agent, whoever started it.
    const fromGuest = () => input.surfaceKind !== undefined && deps.senderIsGuest?.(input.surfaceKind, input.userId) === true;
    const sent = handover.startsContract && !fromGuest()
      && deps.messageSender.send('orchestrator', activeAgentId, input.body, { kind: 'directive' });
    if (sent) {
      const delivered = moveSharedSessionInputOrKeep(deps.sessionInputStore(), updatedSession.id, queuedInput.id, 'delivered',
        { activeAgentId }) ?? queuedInput;
      await deps.persist();
      deps.publishInputLifecycleEvent('session-input-delivered', delivered, {
        agentId: activeAgentId,
        messageId: userMessage.id,
      });
      deps.publishUpdate('session-message-forwarded', {
        sessionId: updatedSession.id,
        agentId: activeAgentId,
        messageId: userMessage.id,
        inputId: delivered.id,
        intent,
      });
      // The live-session branch: no new agent is started, so no caller has an
      // agent id to bind a reply to, and every adapter early-returns here.
      // Without this announcement the running agent answers a message that
      // arrived from Telegram/Slack/ntfy and the answer never leaves the
      // daemon, the message is received, the work is done, and the sender
      // sees silence. The binder is idempotent, so an agent that already
      // carries a pending reply keeps the one it has.
      deps.announceSurfaceReply({
        sessionId: updatedSession.id,
        agentId: activeAgentId,
        ...(binding?.id ? { routeId: binding.id } : {}),
        ...(input.surfaceKind ? { surfaceKind: input.surfaceKind } : {}),
        task: input.body,
        reason: 'continued-live',
      });
      return {
        session: deps.sessions.get(updatedSession.id)!,
        userMessage,
        routeBinding: binding ?? undefined,
        input: delivered,
        intent,
        mode: 'continued-live',
        state: delivered.state,
        activeAgentId,
        created,
      };
    }
    if (intent === 'steer' && !allowSpawnFallback) {
      const rejected = moveSharedSessionInputOrKeep(deps.sessionInputStore(), updatedSession.id, queuedInput.id, 'rejected',
        { error: 'No active agent accepted the steer request.' }) ?? queuedInput;
      await deps.persist();
      deps.publishInputLifecycleEvent('session-input-rejected', rejected, {
        messageId: userMessage.id,
      });
      return {
        session: deps.sessions.get(updatedSession.id)!,
        userMessage,
        routeBinding: binding ?? undefined,
        input: rejected,
        intent,
        mode: 'rejected',
        state: rejected.state,
        created,
      };
    }
  }

  if (intent === 'follow-up' && activeAgentId) {
    await deps.persist();
    deps.publishInputLifecycleEvent('session-follow-up-queued', queuedInput, {
      agentId: activeAgentId,
      messageId: userMessage.id,
    });
    return {
      session: deps.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: queuedInput,
      intent,
      mode: 'queued-follow-up',
      state: queuedInput.state,
      activeAgentId,
      created,
    };
  }

  // An agent is being started for this session and has no id yet, so there is nothing to hand the
  // message to and starting a second agent would split the conversation. The message waits as a
  // follow-up; the agent's completion (or the end of a start that never produced one) runs it.
  if (intent === 'submit' && !activeAgentId && deps.hasSpawnInFlight?.(updatedSession.id)) {
    const waiting = updateSharedSessionInput(deps.sessionInputStore(), updatedSession.id, queuedInput.id,
      (entry) => ({ ...entry, intent: 'follow-up', updatedAt: Date.now() })) ?? queuedInput;
    await deps.persist();
    deps.publishInputLifecycleEvent('session-follow-up-queued', waiting, { messageId: userMessage.id });
    return {
      session: deps.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: waiting,
      intent: 'follow-up',
      mode: 'queued-follow-up',
      state: waiting.state,
      created,
    };
  }

  // Surface routing: a steer/follow-up with a LIVE surface participant (other than the
  // sender) queues for that surface (sessions.inputs.list/deliver); no live surface keeps the executor path below.
  // A hosted session's surface is the daemon's own hosted engine, which owns its
  // liveness, so its steers always queue for it, however old its registration.
  if (
    (intent === 'steer' || intent === 'follow-up') &&
    (updatedSession.kind === 'hosted'
      || shouldRouteInputToSurface(updatedSession, Date.now(), SURFACE_ROUTE_FRESHNESS_MS, { surfaceId: input.surfaceId }))
  ) {
    await deps.persist();
    deps.publishInputLifecycleEvent('session-input-queued-for-surface', queuedInput, {
      messageId: userMessage.id,
    });
    return {
      session: deps.sessions.get(updatedSession.id)!,
      userMessage,
      routeBinding: binding ?? undefined,
      input: queuedInput,
      intent,
      mode: 'queued-for-surface',
      state: queuedInput.state,
      created,
    };
  }

  await deps.persist();
  return {
    session: deps.sessions.get(updatedSession.id)!,
    userMessage,
    routeBinding: binding ?? undefined,
    input: queuedInput,
    intent,
    mode: 'spawn',
    state: queuedInput.state,
    task: deps.buildContinuationTask(updatedSession.id),
    created,
  };
}
