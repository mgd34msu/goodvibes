import type { AgentManager } from '../tools/agent/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import type { ChannelConversationKind, ChannelPolicyDecision, RouteBindingManager } from '../channels/index.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { ConversationMessageEnvelope } from '../control-plane/conversation-message.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';

/**
 * What an adapter learns from an ingress authorization.
 *
 * Every adapter in packages/platform/src/platform/adapters reads `allowed` and
 * `reason`, 19 sites each, and none reads `policy`, `matchedGroupPolicy`,
 * `matchedScope`, `effectiveRequireMention` or `effectiveAllowedCommands`. The
 * seam returned the whole `ChannelPolicyDecision`, so every adapter test double
 * had to produce a full `ChannelPolicyRecord` it would never look at, and the
 * ones that did not were cast through `unknown` instead, which is how a
 * decision missing its required `policy` field passed for a real one.
 *
 * The production implementation still returns the full decision; it remains
 * assignable.
 */
export interface SurfaceIngressDecision extends Pick<ChannelPolicyDecision, 'allowed' | 'reason'> {
  /**
   * Set when the message was an answer that has been acted on: a permission
   * ask, a purchase window or a work proposal took it. Nothing else is to be
   * done with it, and the provider is told it was received.
   */
  readonly consumed?: { readonly by: 'approval' | 'payment' | 'work-proposal'; readonly answer: string } | undefined;
}

/** What ingress did with a message: admitted to the conversation, consumed as an answer, or refused. */
export type IngressDisposition = 'admitted' | 'consumed' | 'refused';

export function ingressDisposition(decision: SurfaceIngressDecision): IngressDisposition {
  if (decision.allowed) return 'admitted';
  return decision.consumed ? 'consumed' : 'refused';
}

export interface SurfaceControlCommand {
  readonly action: 'status' | 'cancel' | 'retry';
  readonly id: string;
}

/** Which conversation a control command arrived from, so the owner of the command can check the target belongs to it. */
export interface SurfaceControlOrigin {
  readonly surface: string;
  /** The route binding the message arrived on. */
  readonly routeId: string;
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
}

export interface QueueSurfaceReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly agentTask?: string | undefined;
  readonly contractId?: string | undefined;
  readonly sessionId?: string | undefined;
}

export interface QueueNtfyChatReplyInput {
  readonly sessionId: string;
  readonly topic: string;
  readonly body: string;
  readonly title?: string | undefined;
  readonly messageId: string;
}

export interface NtfyRemoteChatResult {
  readonly sessionId: string;
  readonly messageId: string;
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

export interface HomeAssistantRemoteChatResult {
  readonly sessionId: string;
  readonly routeId?: string | undefined;
  readonly messageId: string;
  readonly assistantMessageId?: string | undefined;
  readonly response?: string | undefined;
  readonly delivered: boolean;
  readonly error?: string | undefined;
}

export type TrySpawnAgentInput = Parameters<AgentManager['spawn']>[0];
export type TrySpawnAgentResult = AgentRecord | Response;
export type TrySpawnAgentFn = (
  input: TrySpawnAgentInput,
  logLabel: string,
  sessionId?: string,
) => TrySpawnAgentResult | Promise<TrySpawnAgentResult>;

export interface SurfaceAdapterContext {
  /**
   * The daemon's "not taking new work" refusal while a self-update's restart
   * holds admission (daemon/work-admission.ts), else null. A path that cannot
   * keep its message through the restart (delegated Telegram review, whose
   * source text never leaves the process) answers it, so the provider keeps the message.
   */
  readonly workRefusal?: (() => Response | null) | undefined;
  /** Avoid provider identity I/O for ordinary messages without payment waits. */
  readonly hasPaymentReplyWindow?: (() => boolean) | undefined;
  /** Explicit daemon-owned selected lane; absence preserves existing Telegram behavior. */
  readonly delegatedTelegram?: import('../daemon/delegated-telegram-intake.js').DelegatedTelegramAdapter | undefined;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager?: (Pick<SecretsManager, 'get' | 'getGlobalHome'> & Partial<Pick<SecretsManager, 'onDidChange'>>) | undefined;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    /** Host-only Telegram account acquisition; never part of message metadata. */
    acquireTelegramAccount?: (() => Promise<import('../channels/telegram/source-account.js').TelegramSourceAccountHandle | null>) | undefined;
    surface: Extract<AutomationSurfaceKind, 'slack' | 'discord' | 'ntfy' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix'>;
    userId?: string | undefined;
    channelId?: string | undefined;
    groupId?: string | undefined;
    threadId?: string | undefined;
    workspaceId?: string | undefined;
    conversationKind?: ChannelConversationKind | undefined;
    parentConversationKind?: Exclude<ChannelConversationKind, 'thread'> | undefined;
    hasAnyMention?: boolean | undefined;
    text?: string | undefined;
    controlCommand?: string | undefined;
    mentioned?: boolean | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<SurfaceIngressDecision>;
  /**
   * Report that an inbound message on this surface could not be processed.
   *
   * For the DETACHED paths only, Slack's and Discord's slash commands answer
   * the provider immediately and then work in the background, so a failure
   * there is invisible to the shared inbound seam in `ChannelPluginRegistry`
   * that covers every other webhook surface. Optional so an embedder that
   * wires no alarm is unaffected.
   */
  readonly reportIngressFailure?: ((surface: import('../channels/types.js').ChannelSurface, detail: string) => void) | undefined;
  /**
   * Sends one short notice to the conversation a route binding points at. A refusal comes back
   * as a result naming its reason; it never throws. Absent when the embedder wires no delivery.
   */
  readonly deliverSurfaceNotice?: ((binding: AutomationRouteBinding | undefined, text: string) => Promise<import('../daemon/types.js').SurfaceNoticeDelivery>) | undefined;
  readonly parseSurfaceControlCommand: (text: string, options?: import('@goodvibes-jev/judgment/decisions').CallOptions) => SurfaceControlCommand | null | Promise<SurfaceControlCommand | null>;
  readonly performSurfaceControlCommand: (command: SurfaceControlCommand, origin?: SurfaceControlOrigin) => Promise<string>;
  readonly performInteractiveSurfaceAction: (
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
    /** The platform user id the surface's verified payload names as the person who pressed the button. */
    userId?: string | undefined,
  ) => Promise<string>;
  readonly trySpawnAgent: (...args: Parameters<TrySpawnAgentFn>) => TrySpawnAgentResult | Promise<TrySpawnAgentResult>;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: QueueSurfaceReplyInput,
  ) => void;
  readonly publishConversationFollowup?: (
    sessionId: string,
    envelope: Omit<ConversationMessageEnvelope, 'sessionId'>,
  ) => void;
  readonly queueNtfyChatReply?: ((input: QueueNtfyChatReplyInput) => void) | undefined;
  readonly postNtfyRemoteChatMessage?: (input: {
    readonly topic: string;
    readonly body: string;
    readonly title?: string | undefined;
    /** The inbound ntfy message id; the reply announces itself as the answer to it. */
    readonly messageId?: string | undefined;
  }) => Promise<NtfyRemoteChatResult>;
  readonly postHomeAssistantChatMessage?: (input: {
    readonly body: string;
    readonly messageId: string;
    readonly conversationId: string;
    readonly surfaceId: string;
    readonly channelId: string;
    readonly threadId?: string | undefined;
    readonly userId?: string | undefined;
    readonly displayName?: string | undefined;
    readonly title: string;
    readonly providerId?: string | undefined;
    readonly modelId?: string | undefined;
    readonly tools?: readonly string[] | undefined;
    readonly context?: Record<string, unknown> | undefined;
    readonly remoteSessionTtlMs?: number | undefined;
    readonly publishEvent?: boolean | undefined;
  }) => Promise<HomeAssistantRemoteChatResult>;
}

export interface GenericWebhookReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackCorrelationId?: string | undefined;
  readonly callbackSignature?: 'shared-secret' | 'hmac-sha256' | undefined;
}

export interface GenericWebhookAdapterContext {
  /**
   * The store a `goodvibes://secrets/…` config reference resolves against.
   *
   * `surfaces.webhook.secret` is swept into the secret store like every other
   * surface credential, so without this the generic webhook adapter holds a
   * reference it cannot resolve and refuses every caller.
   */
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly configManager: {
    get(key: string): unknown;
  };
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly authorizeSurfaceIngress: (input: {
    surface: Extract<AutomationSurfaceKind, 'webhook'>;
    userId?: string | undefined;
    channelId?: string | undefined;
    groupId?: string | undefined;
    threadId?: string | undefined;
    workspaceId?: string | undefined;
    conversationKind?: ChannelConversationKind | undefined;
    parentConversationKind?: Exclude<ChannelConversationKind, 'thread'> | undefined;
    hasAnyMention?: boolean | undefined;
    text?: string | undefined;
    controlCommand?: string | undefined;
    mentioned?: boolean | undefined;
    metadata?: Record<string, unknown> | undefined;
  }) => Promise<SurfaceIngressDecision>;
  readonly trySpawnAgent: TrySpawnAgentFn;
  /** `status`, `cancel` and `retry <id>`, as on the chat surfaces; absent when the embedder wires none. */
  readonly parseSurfaceControlCommand?: SurfaceAdapterContext['parseSurfaceControlCommand'] | undefined;
  readonly performSurfaceControlCommand?: SurfaceAdapterContext['performSurfaceControlCommand'] | undefined;
  readonly surfaceDeliveryEnabled: (surface: Extract<AutomationSurfaceKind, 'webhook'>) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly queueWebhookReply: (input: GenericWebhookReplyInput) => void;
}
