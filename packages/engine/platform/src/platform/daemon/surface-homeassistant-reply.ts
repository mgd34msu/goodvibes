/**
 * surface-homeassistant-reply.ts, the Home Assistant half of the daemon's
 * surface actions: run a chat turn for an inbound HA message and publish the
 * assistant's reply back as a Home Assistant event.
 *
 * Split out of `surface-actions.ts`, which had reached the 800-line source cap
 * exactly. This is the largest coherent piece of that file that is about ONE
 * surface rather than about surface actions in general, everything left behind
 * (the ingress hook, control commands, interactive actions, the ntfy pending-
 * reply machinery) is either shared across surfaces or genuinely ntfy-specific
 * state held on the helper instance. Moving it took the file from 799 lines to
 * well under the cap, which is why the card gate could be installed on
 * `authorizeSurfaceIngress` without grandfathering a file over the limit.
 *
 * A turn that outlasts the wait is not reported as a failure: Home Assistant
 * hears "Still working on that." (status `running`) and the final reply is
 * published as a second event when the turn ends. Failures and stops are
 * spoken as short sentences, never as internal error text.
 */
import {
  HOME_ASSISTANT_DEFAULT_EVENT_TYPE,
  resolveHomeAssistantAccessToken,
  resolveHomeAssistantBaseUrl,
} from '../channels/builtin/homeassistant.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import { HomeAssistantIntegration } from '../integrations/homeassistant.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import {
  homeAssistantReplyOutcome,
  postHomeAssistantChatMessage as postHomeAssistantChatTurn,
  readHomeAssistantRemoteSessionTtlMs,
  type HomeAssistantChatPostResult,
} from './homeassistant-chat.js';
import type { CompanionChatTurnEvent } from '../companion/companion-chat-types.js';

/** How long a Home Assistant message waits for its reply before Home Assistant is told the turn is still running. */
const HOME_ASSISTANT_REPLY_WAIT_MS = 120_000;

/** The final result of a turn, read from its terminal event. */
function finishedTurn(event: CompanionChatTurnEvent): Pick<HomeAssistantChatPostResult, 'response' | 'error' | 'cancelled' | 'assistantMessageId'> | undefined {
  if (event.type === 'turn.completed') return { response: event.envelope.body, assistantMessageId: event.assistantMessageId };
  if (event.type === 'turn.error') return { error: event.error, ...(event.assistantMessageId ? { assistantMessageId: event.assistantMessageId } : {}) };
  if (event.type === 'turn.cancelled') return { cancelled: true, error: 'cancelled', ...(event.assistantMessageId ? { assistantMessageId: event.assistantMessageId } : {}) };
  return undefined;
}

/** The slice of the daemon surface-action context this module consults. */
export interface HomeAssistantReplyDeps {
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly companionChatManager: CompanionChatManager | null;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
}

export interface HomeAssistantSurfaceChatInput {
  readonly body: string;
  readonly messageId: string;
  readonly conversationId: string;
  readonly surfaceId: string;
  readonly channelId: string;
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  /** One-to-one with its user (`direct`), a shared room or device (`channel`), or a thread; the owner's notice routes are read from it. */
  readonly conversationKind?: 'direct' | 'channel' | 'group' | 'thread' | 'service' | undefined;
  readonly title: string;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly tools?: readonly string[] | undefined;
  readonly context?: Record<string, unknown> | undefined;
  readonly remoteSessionTtlMs?: number | undefined;
  readonly publishEvent?: boolean | undefined;
}

export interface HomeAssistantSurfaceChatResult {
  readonly sessionId: string;
  readonly routeId?: string | undefined;
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

/** Run one inbound Home Assistant message as a chat turn and publish the reply. */
export async function postHomeAssistantSurfaceChatMessage(
  deps: HomeAssistantReplyDeps,
  input: HomeAssistantSurfaceChatInput,
): Promise<HomeAssistantSurfaceChatResult> {
  const manager = deps.companionChatManager;
  if (!manager) {
    return {
      sessionId: '',
      messageId: input.messageId,
      delivered: false,
      error: 'Home Assistant remote chat manager is unavailable',
    };
  }

  // The turn's terminal event, kept for a reply that arrives after the wait has ended.
  type Finished = NonNullable<ReturnType<typeof finishedTurn>>;
  const turn: { finished?: Finished; late?: (result: Finished) => void } = {};
  const publish = async (result: Pick<HomeAssistantChatPostResult, 'response' | 'error' | 'cancelled' | 'timedOut' | 'assistantMessageId'>,
    session: { readonly sessionId: string; readonly routeId?: string | undefined }): Promise<string | undefined> => {
    if (input.publishEvent === false) return undefined;
    const outcome = homeAssistantReplyOutcome(result);
    try {
      await publishHomeAssistantChatReply(deps, input, {
        ...session,
        ...(result.assistantMessageId ? { assistantMessageId: result.assistantMessageId } : {}),
        response: outcome.speech,
        status: outcome.status === 'timeout' ? 'running' : outcome.status,
        ...(result.error && outcome.status !== 'completed' ? { error: result.error } : {}),
      });
      return undefined;
    } catch (caught) {
      logger.warn('DaemonSurfaceActionHelper: failed to publish Home Assistant chat reply', {
        conversationId: input.conversationId,
        sessionId: session.sessionId,
        error: summarizeError(caught),
      });
      return `The reply was produced but could not be published to Home Assistant: ${summarizeError(caught)}`;
    }
  };
  try {
    const result = await postHomeAssistantChatTurn(
      {
        configManager: deps.configManager,
        routeBindings: deps.routeBindings,
        chatManager: manager,
        resolveDefaultProviderModel: deps.resolveDefaultProviderModel,
      },
      {
        text: input.body,
        messageId: input.messageId,
        conversationId: input.conversationId,
        surfaceId: input.surfaceId,
        channelId: input.channelId,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.displayName ? { displayName: input.displayName } : {}),
        ...(input.conversationKind ? { conversationKind: input.conversationKind } : {}),
        title: input.title,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.tools?.length ? { tools: input.tools } : {}),
        ...(input.context ? { context: input.context } : {}),
        remoteSessionTtlMs: readHomeAssistantRemoteSessionTtlMs(deps.configManager, input.remoteSessionTtlMs),
      },
      {
        wait: true,
        timeoutMs: HOME_ASSISTANT_REPLY_WAIT_MS,
        clientId: `homeassistant:${input.surfaceId}:${input.conversationId}`,
        // The listener rides the turn for its whole life, past the wait, so a late reply still reaches Home Assistant.
        onTurnEvent: (event) => {
          const done = finishedTurn(event);
          if (!done || turn.finished) return;
          turn.finished = done;
          turn.late?.(done);
        },
      },
    );
    const session = { sessionId: result.session.id, routeId: result.binding.id };
    const response = result.response?.trim();
    if (result.timedOut) {
      const finished = turn.finished;
      if (finished) {
        // The turn ended between the deadline and this line: its reply is the answer.
        const publishError = await publish(finished, session);
        const failure = finished.error ?? publishError;
        return { ...session, messageId: input.messageId, ...(finished.response ? { response: finished.response } : {}),
          delivered: !failure, ...(failure ? { error: failure } : {}) };
      }
      turn.late = (done) => { void publish(done, session); };
      const publishError = await publish({ timedOut: true }, session);
      // Still running, not failed: the final reply follows as its own event when the turn ends.
      return { ...session, messageId: input.messageId, delivered: !publishError, ...(publishError ? { error: publishError } : {}) };
    }
    const error = result.error ?? (response ? undefined : 'No response from Home Assistant remote chat');
    // The turn ran. A failure to publish its reply must not be reported as a failed turn
    // (a second event, an empty session id): the session and answer are kept.
    const publishError = await publish({ ...result, ...(error ? { error } : {}) }, session);
    const reportedError = error ?? publishError;
    return {
      ...session,
      messageId: input.messageId,
      ...(result.assistantMessageId ? { assistantMessageId: result.assistantMessageId } : {}),
      ...(response ? { response } : {}),
      delivered: !reportedError,
      ...(reportedError ? { error: reportedError } : {}),
    };
  } catch (error) {
    const errorMessage = summarizeError(error);
    await publish({ error: errorMessage }, { sessionId: '' });
    return {
      sessionId: '',
      messageId: input.messageId,
      delivered: false,
      error: errorMessage,
    };
  }
}

/** Publish the assistant's reply back to Home Assistant as a GoodVibes event. */
export async function publishHomeAssistantChatReply(
  deps: HomeAssistantReplyDeps,
  input: Pick<
    HomeAssistantSurfaceChatInput,
    'body' | 'messageId' | 'conversationId' | 'surfaceId' | 'channelId' | 'threadId' | 'userId' | 'displayName' | 'title' | 'context'
  >,
  result: {
    readonly sessionId: string;
    readonly routeId?: string | undefined;
    readonly assistantMessageId?: string | undefined;
    /** What Home Assistant shows and speaks: the reply, or a short sentence for a turn still running, stopped or failed. */
    readonly response: string;
    readonly status: string;
    /** The internal reason a turn failed, kept in the event's metadata and never spoken. */
    readonly error?: string | undefined;
  },
): Promise<void> {
  const baseUrl = resolveHomeAssistantBaseUrl(deps.configManager, deps.serviceRegistry);
  const accessToken = await resolveHomeAssistantAccessToken(deps);
  if (!baseUrl || !accessToken) {
    throw new Error('Home Assistant instance URL or access token is not configured.');
  }
  const eventType = String(deps.configManager.get('surfaces.homeassistant.eventType') || HOME_ASSISTANT_DEFAULT_EVENT_TYPE);
  const client = new HomeAssistantIntegration({ baseUrl, accessToken });
  await client.publishGoodVibesEvent(eventType, {
    type: 'message',
    title: input.title || 'GoodVibes',
    body: result.response,
    speechText: result.response,
    status: result.status,
    sessionId: result.sessionId,
    ...(result.routeId ? { routeId: result.routeId } : {}),
    surfaceId: input.surfaceId,
    externalId: input.conversationId,
    ...(result.assistantMessageId ? { messageId: result.assistantMessageId } : {}),
    replyToMessageId: input.messageId,
    conversationId: input.conversationId,
    metadata: {
      threadId: input.threadId ?? null,
      channelId: input.channelId,
      userId: input.userId ?? null,
      displayName: input.displayName ?? null,
      inboundMessageId: input.messageId,
      conversationId: input.conversationId,
      ...(result.error ? { error: result.error } : {}),
      ...(input.context ? { homeAssistantContext: input.context } : {}),
    },
  });
}
