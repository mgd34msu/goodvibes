import type { RuntimeEventDomain } from '../runtime/events/index.js';
import type { ChannelSurface } from '../channels/index.js';
import type { ConfigManager } from '../config/manager.js';
import type { UserAuthManager } from '../security/user-auth.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { RuntimeServices } from '../runtime/services.js';

export interface DaemonConfig {
  port?: number | undefined;
  host?: string | undefined;
  workingDir?: string | undefined;
  homeDirectory?: string | undefined;
  /**
   * Absolute path to the daemon home directory (`daemon.homeDir`).
   * Resolved from --daemon-home CLI flag, GOODVIBES_DAEMON_HOME env, or
   * ~/.goodvibes/daemon/ default. Holds immutable-after-startup identity state:
   * auth-users.json, auth-bootstrap.txt, daemon-settings.json, operator-tokens.json.
   */
  daemonHomeDir?: string | undefined;
  configManager?: ConfigManager | undefined;
  githubWebhookSecret?: string | undefined;
  agentManager?: AgentManager | undefined;
  serveFactory?: typeof Bun.serve | undefined;
  userAuth?: UserAuthManager | undefined;
  runtimeBus?: RuntimeEventBus | null | undefined;
  runtimeServices?: RuntimeServices | undefined;
  /** The composing executable drains its borrowed runtime and other listeners
   * before native update/rollback handover. Ordinary listener stop never
   * disposes an injected runtime. This callback must not await host startup. */
  drainForNativeHandover?: (() => Promise<void>) | undefined;
  /** A composing host starts additional listeners and boot work after start().
   * It must call completeHostStartup() before native updates or service
   * promotion may drain that graph and hand over to a replacement. */
  deferNativeActivationUntilHostReady?: boolean | undefined;
  /**
   * The host's payment-window inbox, shared with its notifier. Borrowed only:
   * the host owns and awaits close() on full graph teardown, never a listener
   * restart. Omitted preserves the facade's existing private inbox behavior.
   */
  paymentReplies?: import('../payments/reply-inbox.js').PaymentReplyInbox | undefined;
  /**
   * Override companion-chat rate-limiter thresholds from daemon config.
   * Takes precedence over GOODVIBES_CHAT_LIMITER_THRESHOLD env var.
   */
  companionChatRateLimiterOptions?: { threshold?: number } | undefined;
  /**
   * WorkspaceSwapManager instance to handle runtime.workingDir transitions.
   * When provided, POST /config runtime.workingDir requests are delegated
   * to the swap manager rather than rejected. Injected by cli.ts at startup;
   * omitted in embedded/test contexts where workspace swaps are not supported.
   */
  swapManager?: import('./http/system-route-types.js').WorkspaceSwapManagerLike | null | undefined;
  /**
   * Identity of the RUNNING artifact for the auto-update loop: its version
   * (compared against release tags) and optionally the executable the swap
   * replaces. The daemon executable passes its release version; an
   * embedding host passes ITS artifact identity. Absent, the embedded
   * default, means the host manages updates and the loop stays off (the
   * platform library version is never assumed to be the shipped artifact).
   */
  updateArtifact?: import('./facade-lifecycle.js').DaemonUpdateArtifact | undefined;
  /**
   * True when this process was told to run out of a home that is NOT the
   * machine's default (`--daemon-home`, `GOODVIBES_DAEMON_HOME`, a test
   * harness's temp tree). Such a daemon never adopts the machine's service
   * unit, see DaemonLifecycleRuntimeOptions.hasOverriddenHome for the
   * incident that made this necessary.
   */
  hasOverriddenHome?: boolean | undefined;
  /**
   * An already-composed LAN leader-election coordinator to REUSE.
   *
   * A process has exactly one. A host that gates its own inbound consumers
   * (goodvibes-tui's daemon gates its inbox poller) builds the coordinator
   * itself, registers its gates, and passes it here so the daemon's Telegram
   * and ntfy consumers ride the same leadership. Absent, the embedded
   * default, means the daemon composes its own from `cluster.*` config.
   *
   * Passing one that is ALREADY started is fine: start() is idempotent.
   */
  clusterCoordinator?: import('../cluster/index.js').ClusterCoordinator | undefined;
  /**
   * The LAN group verbs to serve on `/api/cluster/*`.
   *
   * These are the single implementation behind the `cluster` CLI subcommands,
   * the TUI's `/cluster` command and any web UI, which is what makes a command
   * run against a REMOTE daemon behave exactly like one run on that machine.
   * Absent means those paths are simply unrouted, which is the honest answer
   * for an embedder that composes no group runtime.
   */
  clusterGroupVerbs?: import('./http/cluster-group-routes.js').ClusterGroupVerbs | undefined;
  /**
   * Turn on daemon-hosted sessions (`sessions.hosted.*`).
   *
   * Absent means this daemon hosts no conversation loops and the verbs refuse
   * honestly, which is the right answer for an embedder that has not stated
   * how a workspace floor is built, because that statement is where its trust
   * posture lives. See daemon/hosted-sessions-composition.ts.
   */
  hostedSessions?: import('./hosted-sessions-composition.js').DaemonHostedSessionsOptions | undefined;
}

export interface DaemonDangerConfig {
  daemon: boolean;
}

export interface ControlPlaneWebSocketData {
  readonly channel: 'control-plane';
  readonly authToken: string;
  readonly principalId: string;
  readonly principalKind: 'user' | 'bot' | 'service' | 'token';
  readonly admin: boolean;
  readonly scopes: readonly string[];
  readonly domains: readonly RuntimeEventDomain[];
  readonly clientKind:
    | 'tui'
    | 'web'
    | 'slack'
    | 'discord'
    | 'ntfy'
    | 'webhook'
    | 'homeassistant'
    | 'telegram'
    | 'google-chat'
    | 'signal'
    | 'whatsapp'
    | 'telephony'
    | 'imessage'
    | 'msteams'
    | 'bluebubbles'
    | 'mattermost'
    | 'matrix'
    | 'daemon';
  readonly remoteAddress?: string | undefined;
  clientId?: string | undefined;
}

export interface PendingSurfaceReply {
  readonly agentId: string;
  readonly surfaceKind: ChannelSurface;
  readonly task: string;
  readonly createdAt: number;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly responseUrl?: string | undefined;
  readonly channelId?: string | undefined;
  readonly applicationId?: string | undefined;
  readonly interactionToken?: string | undefined;
  readonly topic?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackSignature?: 'shared-secret' | 'hmac-sha256' | undefined;
  readonly callbackCorrelationId?: string | undefined;
  readonly targetAddress?: string | undefined;
  readonly threadId?: string | undefined;
  readonly agentTask?: string | undefined;
  readonly contractId?: string | undefined;
  readonly rootAgentId?: string | undefined;
  readonly surfaceId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly conversationId?: string | undefined;
  readonly messageId?: string | undefined;
  readonly replyToMessageId?: string | undefined;
  lastProgressAt?: number | undefined;
  lastProgress?: string | undefined;
}

/**
 * Why a one-off surface notice was not delivered.
 *
 * Each name is one guard in `DaemonSurfaceDeliveryHelper.deliverSurfaceNotice`.
 * They exist because those guards used to be four bare `return false`s: the
 * caller could not tell "sent" from "silently refused", so the conversation
 * gate held an answerable proposal that the owner had never been shown.
 */
export type SurfaceNoticeRefusal =
  | 'no-route-binding'
  | 'empty-text'
  | 'unsupported-delivery-surface'
  | 'surface-delivery-disabled'
  | 'no-deliverable-target'
  | 'delivery-failed';

/** The outcome of one surface notice. Never a bare boolean, see above. */
export type SurfaceNoticeDelivery =
  | { readonly delivered: true }
  | {
    readonly delivered: false;
    readonly reason: SurfaceNoticeRefusal;
    /** Present only for 'delivery-failed': the transport's own message. */
    readonly error?: string | undefined;
  };

