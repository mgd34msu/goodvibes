import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';
import type { AutomationRouteBinding } from '../../automation/routes.js';
import { HOME_ASSISTANT_SURFACE } from '../../channels/builtin/homeassistant.js';
import type { RouteBindingManager } from '../../channels/index.js';
import type { CompanionChatManager } from '../../companion/companion-chat-manager.js';
import type { CompanionChatTurnEvent } from '../../companion/companion-chat-types.js';
import type { ConfigManager } from '../../config/manager.js';
import { serviceFailureStatus } from './error-response.js';
import {
  homeAssistantReplyOutcome,
  isHomeAssistantChatSession,
  postHomeAssistantChatMessage,
  readHomeAssistantRemoteSessionTtlMs,
  type HomeAssistantChatInput,
  type HomeAssistantChatPostResult,
  type HomeGraphGroundingReader,
  type HomeAssistantChatRuntime,
} from '../homeassistant-chat.js';
import type { HomeGraphSpaceInput } from '../../knowledge/home-graph/types.js';

const DEFAULT_WAIT_TIMEOUT_MS = 120_000;
const MAX_WAIT_TIMEOUT_MS = 10 * 60_000;

type JsonRecord = Record<string, unknown>;

interface HomeAssistantMessageIndex {
  /** The message's key: its installation, conversation and messageId (see messageKey). */
  readonly key: string;
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly sessionId: string;
  readonly routeId: string;
  readonly conversationId: string;
  readonly createdAt: number;
  /** The chat manager's id for the posted user message; the key to the reply in the session transcript. */
  readonly chatMessageId?: string | undefined;
  /** The turn that answers it, once the chat manager has started it; a cancel by messageId targets only this turn. */
  readonly turnId?: string | undefined;
  /** Set when that turn's end (completed, error or cancelled) was seen. */
  readonly ended?: true | undefined;
  /** How an earlier attempt ended when it ended badly, so a retry with the same messageId reports it instead of posting again. */
  readonly failure?: { readonly status: 'failed' | 'cancelled'; readonly error: string } | undefined;
}

interface HomeAssistantSubmitResult {
  readonly ok: boolean;
  readonly acknowledged: true;
  readonly messageId: string;
  readonly conversationId: string;
  readonly sessionId: string;
  readonly routeId: string;
  readonly mode: 'remote-chat' | 'rejected';
  readonly newSession: boolean;
  readonly sessionExpired: boolean;
  readonly status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'rejected' | 'timeout';
  readonly assistant?: HomeAssistantAssistantResult | undefined;
  readonly timeoutMs?: number | undefined;
  readonly error?: string | undefined;
  /** The chat manager's id for the posted message; read the outcome from the companion chat API with it, notably after `wait: false`. */
  readonly chatMessageId?: string | undefined;
  /** True when this messageId was already submitted: nothing was posted again and the result describes the earlier turn. */
  readonly duplicate?: true | undefined;
}

interface HomeAssistantAssistantResult {
  readonly text: string;
  readonly speechText: string;
  readonly status: string;
  readonly completedAt?: number | undefined;
}

interface HomeAssistantRouteContext {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly routeBindings: Pick<RouteBindingManager, 'start' | 'upsertBinding' | 'patchBinding'>;
  readonly chatManager: CompanionChatManager;
  readonly parseJsonBody: (req: Request) => Promise<JsonRecord | Response>;
  /** Null when the caller holds the scope (the admin token holds every scope), else the 403 naming it. */
  readonly requireScope: (req: Request, scope: string) => Response | null;
  /** Null for an admin caller, else the refusal. */
  readonly requireAdmin: (req: Request) => Response | null;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /** Optional home-graph reader so a turn can ground itself in its pre-registered space. */
  readonly homeGraph?: HomeGraphGroundingReader | undefined;
  /** The Home Assistant channel's policy, for "Treat my own messages here as me" (HomeAssistantChatRuntime.channelPolicy). */
  readonly channelPolicy?: HomeAssistantChatRuntime['channelPolicy'];
}

interface ParsedHomeAssistantInput extends HomeAssistantChatInput {
  /** True when the caller chose the messageId (a generated one cannot repeat). */
  readonly clientMessageId: boolean;
  readonly wait: boolean;
  readonly waitTimeoutMs: number;
}

/**
 * The paths the Home Assistant conversation routes serve.
 * Read by the capability-route reconcile, which cannot see a sub-router that is
 * dispatched ahead of the shared route table. `{param}` is one path segment.
 */
export const HOME_ASSISTANT_CONVERSATION_ROUTES: readonly { readonly method: string; readonly path: string }[] = [
  { method: 'GET', path: '/api/homeassistant' },
  { method: 'GET', path: '/api/homeassistant/health' },
  { method: 'POST', path: '/api/homeassistant/conversation' },
  { method: 'POST', path: '/api/homeassistant/conversation/stream' },
  { method: 'POST', path: '/api/homeassistant/conversation/cancel' },
];

/** How many messages the in-memory index keeps before it drops the oldest that have ended. */
const MESSAGE_INDEX_LIMIT = 500;
const MESSAGE_INDEX_PRUNE = 100;

/**
 * One message's key: a messageId is the caller's and only unique within its
 * Home Assistant installation and conversation, so two installations (or two
 * conversations) using the same messageId are different messages.
 */
function messageKey(address: { readonly surfaceId: string; readonly conversationId: string }, messageId: string): string {
  return [address.surfaceId, address.conversationId, messageId].join('\u0000');
}

export class HomeAssistantConversationRoutes {
  /** By messageKey. Restart-safe dedupe lives in the chat transcript (the message keeps the caller's id); this is the running view. */
  private readonly messageIndex = new Map<string, HomeAssistantMessageIndex>();
  private readonly inflight = new Map<string, Promise<HomeAssistantSubmitResult>>();
  /** The HTTP status a rejected submit answers with, kept off the wire body. */
  private readonly rejectionStatus = new WeakMap<HomeAssistantSubmitResult, number>();

  constructor(private readonly context: HomeAssistantRouteContext) {}

  async handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/homeassistant')) return null;

    if ((url.pathname === '/api/homeassistant' || url.pathname === '/api/homeassistant/health') && req.method === 'GET') {
      const denied = this.context.requireScope(req, 'read:sessions');
      if (denied) return denied;
      return Response.json(this.describeHealth());
    }

    if (url.pathname === '/api/homeassistant/conversation' && req.method === 'POST') {
      const denied = this.gateConversation(req);
      if (denied) return denied;
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const refused = this.gateRoutingOverride(req, body);
      if (refused) return refused;
      return this.respondToSubmit(await this.submitConversation(body));
    }

    if (url.pathname === '/api/homeassistant/conversation/stream' && req.method === 'POST') {
      const denied = this.gateConversation(req);
      if (denied) return denied;
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      const refused = this.gateRoutingOverride(req, body);
      if (refused) return refused;
      return this.streamConversation(body);
    }

    if (url.pathname === '/api/homeassistant/conversation/cancel' && req.method === 'POST') {
      const denied = this.gateConversation(req);
      if (denied) return denied;
      const body = await this.context.parseJsonBody(req);
      if (body instanceof Response) return body;
      return await this.cancelConversation(body);
    }

    return null;
  }

  /** Posting, streaming and cancelling a turn write to a chat session: they need the same scope as the companion chat routes. */
  private gateConversation(req: Request): Response | null {
    return this.context.requireScope(req, 'write:sessions');
  }

  /** A caller-chosen provider or model spends the operator's quota on a route the operator did not pick: admin only. */
  private gateRoutingOverride(req: Request, body: JsonRecord): Response | null {
    const chosen = readString(body.providerId ?? body.provider) !== undefined || readString(body.modelId ?? body.model) !== undefined;
    return chosen ? this.context.requireAdmin(req) : null;
  }

  private describeHealth(): JsonRecord {
    const enabled = Boolean(this.context.configManager.get('surfaces.homeassistant.enabled'));
    return {
      ok: enabled,
      surface: HOME_ASSISTANT_SURFACE,
      enabled,
      defaultConversationId: String(this.context.configManager.get('surfaces.homeassistant.defaultConversationId') || 'goodvibes'),
      eventType: String(this.context.configManager.get('surfaces.homeassistant.eventType') || 'goodvibes_message'),
      remoteSessionTtlMs: this.readRemoteSessionTtlMs({}),
      endpoints: {
        conversation: '/api/homeassistant/conversation',
        stream: '/api/homeassistant/conversation/stream',
        cancel: '/api/homeassistant/conversation/cancel',
        webhook: '/webhook/homeassistant',
      },
      capabilities: [
        'conversation-submit-wait',
        'conversation-stream',
        'conversation-cancel',
        'stable-correlation',
        'isolated-remote-chat-session',
        'remote-session-ttl',
        'homeassistant-event-delivery',
      ],
    };
  }

  private async submitConversation(
    body: JsonRecord,
    onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined,
    onSessionResolved?: ((sessionId: string) => void) | undefined,
  ): Promise<HomeAssistantSubmitResult> {
    if (!Boolean(this.context.configManager.get('surfaces.homeassistant.enabled'))) {
      return {
        ok: false,
        acknowledged: true,
        messageId: '',
        conversationId: '',
        sessionId: '',
        routeId: '',
        mode: 'rejected',
        newSession: false,
        sessionExpired: false,
        status: 'rejected',
        error: 'Home Assistant surface is disabled.',
      };
    }

    const input = this.parseInput(body);
    if (!input.text) {
      return {
        ok: false,
        acknowledged: true,
        messageId: input.messageId,
        conversationId: input.conversationId,
        sessionId: '',
        routeId: '',
        mode: 'rejected',
        newSession: false,
        sessionExpired: false,
        status: 'rejected',
        error: 'Missing Home Assistant conversation message.',
      };
    }

    // A turn always offers the full tool registry; accepting a list that narrows nothing would let a caller assume a read-only turn.
    if (input.tools?.length) {
      return {
        ok: false,
        acknowledged: true,
        messageId: input.messageId,
        conversationId: input.conversationId,
        sessionId: '',
        routeId: '',
        mode: 'rejected',
        newSession: false,
        sessionExpired: false,
        status: 'rejected',
        error: 'A tools list is not supported on a Home Assistant conversation: every turn offers the full tool registry. Remove "tools" and resubmit.',
      };
    }

    if (!input.clientMessageId) return this.postTurn(input, onTurnEvent, onSessionResolved);
    const key = messageKey(input, input.messageId);
    // A retry of a submit that is still waiting shares its outcome; a retry of one that already
    // returned (a 202 timeout, say) is answered from the transcript. Neither posts the utterance again.
    // After a restart the chat transcript answers instead (postTurn finds the message by its id there).
    const running = this.inflight.get(key);
    if (running) return this.markDuplicate(await running);
    const known = this.messageIndex.get(key);
    // An entry with no chat message id is only the provisional one made before posting: that attempt never posted, so this one may.
    if (known?.chatMessageId) return this.describeKnownMessage(input, known);
    const turn = this.postTurn(input, onTurnEvent, onSessionResolved);
    const settle = (): void => { this.inflight.delete(key); };
    this.inflight.set(key, turn);
    turn.then(settle, settle);
    return turn;
  }

  private markDuplicate(result: HomeAssistantSubmitResult): HomeAssistantSubmitResult {
    const copy = { ...result, duplicate: true as const };
    const status = this.rejectionStatus.get(result);
    if (status !== undefined) this.rejectionStatus.set(copy, status);
    return copy;
  }

  /** What an earlier submit with this messageId came to, read from the transcript; nothing is posted. */
  private describeKnownMessage(input: ParsedHomeAssistantInput, known: HomeAssistantMessageIndex): HomeAssistantSubmitResult {
    const base = {
      acknowledged: true as const,
      messageId: input.messageId,
      conversationId: input.conversationId,
      sessionId: known.sessionId,
      routeId: known.routeId,
      mode: 'remote-chat' as const,
      newSession: false,
      sessionExpired: false,
      duplicate: true as const,
      ...(known.chatMessageId ? { chatMessageId: known.chatMessageId } : {}),
    };
    return { ...base, ...this.messageOutcome(known) };
  }

  /** What a known message came to, read from its recorded failure and the session transcript. */
  private messageOutcome(known: HomeAssistantMessageIndex): Pick<HomeAssistantSubmitResult, 'ok' | 'status' | 'assistant' | 'error'> {
    if (known.failure) return { ok: false, status: known.failure.status, error: known.failure.error };
    const chat = this.context.chatManager;
    if (!chat.getSession(known.sessionId)) {
      return { ok: false, status: 'failed', error: 'The chat session for this message no longer exists.' };
    }
    const transcript = known.chatMessageId ? chat.getMessages(known.sessionId) : [];
    const reply = transcript.find((message) => message.role === 'assistant' && message.inReplyTo === known.chatMessageId);
    if (reply?.deliveryState === 'cancelled') return { ok: false, status: 'cancelled', error: 'Turn cancelled' };
    if (reply) return { ok: true, status: 'completed', assistant: buildAssistantResult(reply.content) };
    if (transcript.find((message) => message.id === known.chatMessageId)?.deliveryState === 'unanswered') {
      return { ok: false, status: 'failed', error: 'The message was never answered.' };
    }
    return { ok: true, status: 'running' };
  }

  private async postTurn(
    input: ParsedHomeAssistantInput,
    onTurnEvent?: ((event: CompanionChatTurnEvent) => void) | undefined,
    onSessionResolved?: ((sessionId: string) => void) | undefined,
  ): Promise<HomeAssistantSubmitResult> {
    const key = messageKey(input, input.messageId);
    let posted: HomeAssistantChatPostResult;
    try {
      posted = await postHomeAssistantChatMessage(
        {
          configManager: this.context.configManager,
          routeBindings: this.context.routeBindings,
          chatManager: this.context.chatManager,
          resolveDefaultProviderModel: this.context.resolveDefaultProviderModel,
          ...(this.context.homeGraph ? { homeGraph: this.context.homeGraph } : {}),
          ...(this.context.channelPolicy ? { channelPolicy: this.context.channelPolicy } : {}),
        },
        input,
        {
          wait: input.wait,
          timeoutMs: input.waitTimeoutMs,
          clientId: `homeassistant:${input.surfaceId}:${input.conversationId}`,
          ...(input.clientMessageId ? { clientMessageId: input.messageId } : {}),
          onTurnEvent: (event) => {
            if (event.type === 'turn.started') this.rememberTurn(key, event.turnId);
            if (event.type === 'turn.completed' || event.type === 'turn.error' || event.type === 'turn.cancelled') this.rememberTurnEnded(key);
            onTurnEvent?.(event);
          },
          // Indexed as soon as the session is known, so a cancel by messageId works while the turn runs.
          onResolved: (resolution) => {
            this.indexMessage(input, { ...resolution, messageId: '' });
            onSessionResolved?.(resolution.session.id);
          },
        },
      );
    } catch (error) {
      // The error's own status stays (a rate limit is 429, a closed session 409); an error that
      // names none is a server fault, not a mistake in the request.
      if (!this.messageIndex.get(key)?.chatMessageId) this.messageIndex.delete(key);
      const httpStatus = serviceFailureStatus(error, 500);
      const result: HomeAssistantSubmitResult = {
        ok: false,
        acknowledged: true,
        messageId: input.messageId,
        conversationId: input.conversationId,
        sessionId: '',
        routeId: '',
        mode: 'rejected',
        newSession: false,
        sessionExpired: false,
        status: httpStatus >= 500 ? 'failed' : 'rejected',
        error: error instanceof Error ? error.message : String(error),
      };
      this.rejectionStatus.set(result, httpStatus);
      return result;
    }

    this.indexMessage(input, posted);
    // The chat already held this message (a retry after a restart): it was not posted again.
    if (posted.replayed) {
      const known = this.messageIndex.get(key);
      if (known) return this.describeKnownMessage(input, known);
    }
    const base = {
      ok: true,
      acknowledged: true as const,
      messageId: input.messageId,
      conversationId: input.conversationId,
      sessionId: posted.session.id,
      routeId: posted.binding.id,
      mode: 'remote-chat' as const,
      newSession: posted.newSession,
      sessionExpired: posted.sessionExpired,
      chatMessageId: posted.messageId,
    };

    if (!input.wait) {
      return { ...base, status: 'running' };
    }
    if (posted.error) {
      const status = homeAssistantReplyOutcome(posted).status;
      return {
        ...base,
        ok: false,
        status: status === 'completed' ? 'failed' : status,
        ...(status === 'timeout' ? { timeoutMs: input.waitTimeoutMs } : {}),
        error: posted.error,
      };
    }
    return {
      ...base,
      status: 'completed',
      assistant: buildAssistantResult(posted.response ?? ''),
    };
  }

  private respondToSubmit(result: HomeAssistantSubmitResult): Response {
    if (result.error === 'Home Assistant surface is disabled.') return Response.json(result, { status: 503 });
    if (result.status === 'rejected') return Response.json(result, { status: result.ok ? 202 : this.rejectionStatus.get(result) ?? 400 });
    if (result.status === 'timeout') return Response.json(result, { status: 202 });
    if (result.status === 'failed') return Response.json(result, { status: this.rejectionStatus.get(result) ?? 500 });
    if (result.status === 'cancelled') return Response.json(result, { status: 409 });
    return Response.json(result, { status: result.status === 'completed' ? 200 : 202 });
  }

  private streamConversation(body: JsonRecord): Response {
    const encoder = new TextEncoder();
    const conversationId = readString(body.conversationId ?? body.conversation_id);
    const messageId = readString(body.messageId ?? body.message_id);
    let closed = false;
    let resolvedSessionId: string | undefined;
    let startedTurnId: string | undefined;
    // Only this stream's own turn: its message may be queued behind another utterance's turn, which a
    // bare session cancel would stop instead. A client that leaves before its turn starts has it
    // cancelled the moment it does.
    const cancelOwnTurn = (): void => {
      const sessionId = resolvedSessionId;
      const turnId = startedTurnId;
      if (!closed || !sessionId || !turnId) return;
      void this.context.chatManager.cancelTurn(sessionId, { turnId }).catch((error: unknown) => {
        const code = (error as { code?: string }).code;
        // TURN_STOPPING: the stop was accepted and the turn ends when its running tool call does.
        if (code !== 'NO_ACTIVE_TURN' && code !== 'TURN_MISMATCH' && code !== 'TURN_STOPPING') logger.warn('[homeassistant] could not cancel the turn of a closed stream', { sessionId, error: summarizeError(error) });
      });
    };
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: string, data: unknown): void => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            closed = true;
          }
        };
        const close = (): void => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* the client already went away */ }
        };
        // Bridge the platform's per-turn streaming events into incremental SSE
        // `delta` frames as the model produces text. The terminal `final`/`error`
        // frame contract below is unchanged, so older consumers that ignore
        // `delta` events still see exactly one terminal frame.
        let accumulated = '';
        const onTurnEvent = (event: CompanionChatTurnEvent): void => {
          if (event.type === 'turn.started') {
            startedTurnId = event.turnId;
            cancelOwnTurn();
          }
          if (event.type === 'turn.delta' && event.delta) {
            accumulated += event.delta;
            send('delta', {
              ok: true,
              delta: event.delta,
              text: accumulated,
              turnId: event.turnId,
              ...(conversationId ? { conversationId } : {}),
              ...(messageId ? { messageId } : {}),
            });
          }
        };
        try {
          const result = await this.submitConversation({ ...body, wait: true }, onTurnEvent, (id) => { resolvedSessionId = id; });
          if (closed) return;
          send(result.status === 'completed' ? 'final' : 'error', result);
          close();
        } catch (error) {
          send('error', { ok: false, error: error instanceof Error ? error.message : String(error) });
          close();
        }
      },
      // The client went away: stop the turn that is answering nobody, so it stops spending
      // tokens and the session is free for the next utterance.
      cancel: () => {
        closed = true;
        cancelOwnTurn();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  }

  /**
   * Cancel the in-flight turn for a Home Assistant conversation, the session
   * STAYS OPEN so the next utterance keeps its conversation context. (Before
   * the turns.cancel verb existed this closed the whole session: the only
   * available hammer, and the next message silently started a fresh session
   * with no memory of the exchange.) "Nothing running" is a success, the
   * user's intent (stop) is already true, and the answer says what is true:
   * a known messageId reports what that message came to (completed with its
   * reply, cancelled or failed), a sessionId alone reports `not-running`.
   */
  private async cancelConversation(body: JsonRecord): Promise<Response> {
    // The message is found by the same installation and conversation a submit
    // used, with the same defaults, so one installation on the defaults still
    // cancels by messageId alone.
    const cancelMessageId = readString(body.messageId ?? body.message_id);
    const indexed = cancelMessageId ? this.messageIndex.get(messageKey(this.parseAddress(body), cancelMessageId)) : undefined;
    const sessionId = readString(body.sessionId ?? body.session_id) ?? indexed?.sessionId;
    if (!sessionId) {
      return Response.json({ ok: false, error: 'sessionId or known messageId is required.' }, { status: 400 });
    }
    // Only a chat session this surface created: the route credential must not be able to stop a
    // TUI, web or other operator's chat by naming its id.
    const session = this.context.chatManager.getSession(sessionId);
    if (!session || !isHomeAssistantChatSession(session)) {
      return Response.json({
        ok: false,
        sessionId,
        error: `No Home Assistant conversation has session ${sessionId}; this route stops only conversations Home Assistant started. Pass the sessionId or messageId from that conversation's reply.`,
      }, { status: 404 });
    }
    // Named by messageId only: stop that turn, not whatever newer utterance now holds the session.
    const byMessageOnly = !readString(body.sessionId ?? body.session_id) && indexed !== undefined;
    if (byMessageOnly && !indexed.turnId) {
      // Its turn has not started (it is queued behind another), so there is no turn to name; a bare
      // cancel would stop the utterance that is running instead.
      return Response.json({
        ok: false,
        sessionId,
        status: 'queued',
        error: 'That message has not started yet, so it cannot be cancelled by messageId. Cancel again once it starts, or pass sessionId to stop whatever turn is running.',
      }, { status: 409 });
    }
    const guard = byMessageOnly && indexed.turnId ? { turnId: indexed.turnId } : {};
    try {
      await this.context.chatManager.cancelTurn(sessionId, guard);
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code === 'TURN_STOPPING') {
        // The stop was accepted; a tool call or the provider is still ending, and the turn
        // finishes as cancelled when it does.
        return Response.json({ ok: true, sessionId, status: 'stopping' });
      }
      if (code !== 'NO_ACTIVE_TURN' && code !== 'TURN_MISMATCH') {
        return Response.json(
          { ok: false, sessionId, error: error instanceof Error ? error.message : String(error) },
          { status: 500 },
        );
      }
      // Nothing of it was running, so nothing was cancelled: a known message answers what it
      // actually came to (a reply that was stored is reported as completed, with its text), and
      // a session named alone answers that no turn was running.
      if (!indexed) return Response.json({ ok: true, sessionId, status: 'not-running' });
      const outcome = this.messageOutcome(indexed);
      return Response.json({
        ok: true,
        sessionId,
        messageId: indexed.messageId,
        status: outcome.status,
        ...(outcome.assistant ? { assistant: outcome.assistant } : {}),
        ...(outcome.status === 'failed' && outcome.error ? { error: outcome.error } : {}),
      });
    }
    return Response.json({ ok: true, sessionId, status: 'cancelled' });
  }

  private parseInput(body: JsonRecord): ParsedHomeAssistantInput {
    const threadId = readString(body.threadId ?? body.thread_id);
    const userId = readString(body.userId ?? body.user_id);
    const displayName = readString(body.displayName ?? body.userName ?? body.user_name);
    const providerId = readString(body.providerId ?? body.provider);
    const modelId = readString(body.modelId ?? body.model);
    const tools = readStringList(body.tools);
    const haContext = readRecord(body.context);
    const { conversationId, surfaceId } = this.parseAddress(body);
    const channelId = readString(body.areaId ?? body.area_id)
      ?? readString(body.entityId ?? body.entity_id)
      ?? conversationId;
    const grounding = this.parseGroundingReference(body);
    return {
      text: readString(body.body ?? body.message ?? body.text ?? body.prompt ?? body.task) ?? '',
      messageId: readString(body.messageId ?? body.message_id) ?? `ha-${randomUUID()}`,
      conversationId,
      surfaceId,
      channelId,
      ...(threadId ? { threadId } : {}),
      ...(userId ? { userId } : {}),
      ...(displayName ? { displayName } : {}),
      title: readString(body.title) ?? 'Home Assistant',
      ...(providerId ? { providerId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(tools.length ? { tools } : {}),
      ...(haContext ? { context: haContext } : {}),
      inputKind: this.parseInputKind(body, haContext),
      ...(grounding ? { grounding } : {}),
      clientMessageId: readString(body.messageId ?? body.message_id) !== undefined,
      wait: body.wait !== false,
      waitTimeoutMs: clampNumber(body.timeoutMs ?? body.waitTimeoutMs, DEFAULT_WAIT_TIMEOUT_MS, 1_000, MAX_WAIT_TIMEOUT_MS),
      remoteSessionTtlMs: this.readRemoteSessionTtlMs(body),
    };
  }

  /**
   * Typed or spoken. Home Assistant's own conversation input carries no such field (text, context, conversation_id,
   * device_id, satellite_id, language, agent_id, extra_system_prompt), so: the integration's `input` field
   * (`"typed"` / `"spoken"`, also `inputKind`) when sent; otherwise a request that names a voice satellite or a device
   * (at the top or in `context`: what a voice pipeline names, the device that heard it) is spoken, and one that names
   * neither is typed. A `spoken` field always wins over a `typed` reading; a request naming a device or satellite is
   * never read as typed whatever it says.
   */
  private parseInputKind(body: JsonRecord, context: JsonRecord | undefined): 'typed' | 'spoken' {
    const named = (record: JsonRecord | undefined): boolean => record !== undefined && [
      record.satelliteId, record.satellite_id, record.deviceId, record.device_id, record.pipelineId, record.pipeline_id,
    ].some((value) => readString(value) !== undefined);
    if (named(body) || named(context)) return 'spoken';
    const said = readString(body.input ?? body.inputKind ?? body.input_kind)?.toLowerCase();
    return said === 'typed' ? 'typed' : said === undefined ? 'typed' : 'spoken';
  }

  /** The installation and conversation a request names, with the defaults a submit and a cancel both apply. */
  private parseAddress(body: JsonRecord): { readonly conversationId: string; readonly surfaceId: string } {
    const conversationId = readString(body.conversationId ?? body.conversation_id)
      ?? readString(body.threadId ?? body.thread_id)
      ?? readString(body.deviceId ?? body.device_id)
      ?? String(this.context.configManager.get('surfaces.homeassistant.defaultConversationId') || 'goodvibes');
    const surfaceId = readString(body.surfaceId ?? body.instanceId ?? body.instance_id)
      ?? readString(body.hassInstanceId ?? body.hass_instance_id)
      ?? 'homeassistant';
    return { conversationId, surfaceId };
  }

  /**
   * Read an optional grounding reference, the pre-registered home-graph
   * knowledge space / Home Assistant installation this turn should consult.
   * Accepts a nested `grounding` object or top-level `knowledgeSpaceId` /
   * `installationId` (with snake_case variants); returns undefined when neither
   * id is supplied, so an un-grounded turn stays un-grounded.
   */
  private parseGroundingReference(body: JsonRecord): HomeGraphSpaceInput | undefined {
    const nested = readRecord(body.grounding);
    const source = nested ?? body;
    const knowledgeSpaceId = readString(source.knowledgeSpaceId ?? source.knowledge_space_id);
    const installationId = readString(source.installationId ?? source.installation_id);
    if (!knowledgeSpaceId && !installationId) return undefined;
    return {
      ...(installationId ? { installationId } : {}),
      ...(knowledgeSpaceId ? { knowledgeSpaceId } : {}),
    };
  }

  private rememberTurn(key: string, turnId: string): void {
    const entry = this.messageIndex.get(key);
    if (entry) this.messageIndex.set(key, { ...entry, turnId });
  }

  private rememberTurnEnded(key: string): void {
    const entry = this.messageIndex.get(key);
    if (entry) this.messageIndex.set(key, { ...entry, ended: true });
  }

  private indexMessage(input: ParsedHomeAssistantInput, posted: HomeAssistantChatPostResult): void {
    const key = messageKey(input, input.messageId);
    const previous = this.messageIndex.get(key);
    this.messageIndex.set(key, {
      ...(previous?.turnId ? { turnId: previous.turnId } : {}),
      ...(previous?.ended ? { ended: true as const } : {}),
      key,
      messageId: input.messageId,
      ...(posted.assistantMessageId ? { assistantMessageId: posted.assistantMessageId } : {}),
      sessionId: posted.session.id,
      routeId: posted.binding.id,
      conversationId: input.conversationId,
      createdAt: Date.now(),
      ...(posted.messageId ? { chatMessageId: posted.messageId } : {}),
      ...(input.wait && posted.error && posted.timedOut !== true
        ? { failure: { status: posted.cancelled ? 'cancelled' as const : 'failed' as const, error: posted.error } }
        : {}),
    });
    if (this.messageIndex.size > MESSAGE_INDEX_LIMIT) this.pruneMessageIndex();
  }

  /**
   * Drops the oldest entries whose turn has ended. One still being submitted
   * or still running stays, so a retry still shares it and a cancel by its
   * messageId still names its turn.
   */
  private pruneMessageIndex(): void {
    let dropped = 0;
    for (const entry of [...this.messageIndex.values()].sort((a, b) => a.createdAt - b.createdAt)) {
      if (dropped >= MESSAGE_INDEX_PRUNE) return;
      if (this.inflight.has(entry.key) || !entry.chatMessageId) continue;
      // An end seen as an event is enough; otherwise the transcript says whether it still runs.
      if (!entry.ended && !entry.failure && this.messageOutcome(entry).status === 'running') continue;
      this.messageIndex.delete(entry.key);
      dropped += 1;
    }
  }

  private readRemoteSessionTtlMs(body: JsonRecord): number {
    return readHomeAssistantRemoteSessionTtlMs(this.context.configManager, body.remoteSessionTtlMs);
  }
}

function buildAssistantResult(text: string): HomeAssistantAssistantResult {
  return {
    text,
    speechText: text,
    status: 'completed',
    completedAt: Date.now(),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
    : [];
}

function readRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : fallback;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}
