import { createHmac } from 'crypto';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { ChannelPluginRegistry, ChannelReplyPipeline, RouteBindingManager } from '../channels/index.js';
import type { ChannelPolicyManager, ChannelSurface } from '../channels/index.js';
import { daemonReceiptStoreAt, daemonReceiptsPath } from './receipts.js';
import { deliverOwnerAlert } from './owner-alert.js';
import type { DeliveredChannelReply, UndeliveredChannelReply } from '../channels/reply-pipeline.js';
import type { SharedSessionSurfaceReplyBinding } from '../control-plane/session-intents.js';
import { BOOT_RECONCILE_CANCEL_REASON } from '../control-plane/session-broker-state.js';
import { CHANNEL_REPLY_METADATA_KEY } from '../control-plane/session-broker-inputs.js';
import { logger } from '../utils/logger.js';
import { webAppLink } from './web-app-link.js';
import type { SharedApprovalRecord } from '../control-plane/index.js';
import type { PendingSurfaceReply, SurfaceNoticeDelivery, SurfaceNoticeRefusal } from './types.js';
import { summarizeError } from '../utils/error-display.js';
import { renderNoticeForSurface } from '../email/inbound-notice-channels.js';
import type { StructuredNotice } from '../email/inbound-notice.js';
import { resolveSecretInput } from '../config/secret-refs.js';
import { resolveSurfaceSecret } from '../channels/builtin/surface-secrets.js';
import { renderAgentCompletionAnswer } from '../agents/completion-answer.js';
import {
  deliverDiscordAgentReply,
  deliverNtfyAgentReply,
  deliverSlackAgentReply,
  deliverSurfaceProgress,
  deliverWebhookAgentReply,
  type SurfaceDirectDeliveryDeps,
} from './surface-direct-delivery.js';
import {
  deliverDiscordApprovalUpdate,
  deliverNtfyApprovalUpdate,
  deliverSlackApprovalUpdate,
  deliverWebhookApprovalUpdate,
  type SurfaceApprovalDeliveryDeps,
} from './surface-approval-delivery.js';

type DeliverySurface =
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
  | 'matrix';

type RouteBinding = import('../automation/routes.js').AutomationRouteBinding;

/**
 * Title carried on a gate notice. Surfaces that render a heading (ntfy, Slack
 * blocks) show this; chat surfaces that only take a body ignore it.
 */
const NOTICE_TITLE = 'goodvibes';
/** First-party surfaces a person reads; a session one of them is attached to shows its approvals on screen. */
const INTERACTIVE_SURFACE_KINDS: ReadonlySet<string> = new Set(['tui', 'web', 'agent', 'webui', 'companion']);

function isSupportedDeliverySurface(surface: string): surface is DeliverySurface {
  return surface === 'slack'
    || surface === 'discord'
    || surface === 'ntfy'
    || surface === 'webhook'
    || surface === 'homeassistant'
    || surface === 'telegram'
    || surface === 'google-chat'
    || surface === 'signal'
    || surface === 'whatsapp'
    || surface === 'telephony'
    || surface === 'imessage'
    || surface === 'msteams'
    || surface === 'bluebubbles'
    || surface === 'mattermost'
    || surface === 'matrix';
}

interface SurfaceReplyInput {
  readonly agentId: string;
  readonly task: string;
  readonly agentTask?: string | undefined;
  readonly contractId?: string | undefined;
  readonly sessionId?: string | undefined;
}

interface WebhookReplyInput extends SurfaceReplyInput {
  readonly routeId?: string | undefined;
  readonly callbackUrl?: string | undefined;
  readonly callbackCorrelationId?: string | undefined;
  readonly callbackSignature?: PendingSurfaceReply['callbackSignature'] | undefined;
}

interface DaemonSurfaceDeliveryContext {
  readonly pendingSurfaceReplies: Map<string, PendingSurfaceReply>;
  readonly channelReplyPipeline: ChannelReplyPipeline;
  readonly configManager: ConfigManager;
  /** Required: surface credentials that are `goodvibes://secrets/...` references resolve through this. */
  readonly secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'>;
  readonly serviceRegistry: ServiceRegistry;
  readonly agentManager: AgentManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly routeBindings: RouteBindingManager;
  readonly channelPlugins: ChannelPluginRegistry;
  readonly authToken: () => string | null;
  readonly surfaceDeliveryEnabled: (surface: DeliverySurface) => boolean;
  /** Records surface reply attempts in the shared delivery ledger. */
  readonly recordDeliveryAttempt?: SurfaceDeliveryLedgerRecorder | undefined;
  /** Names each surface's owner, so an owner alert goes only to the owner's own conversations. */
  readonly channelPolicy?: Pick<ChannelPolicyManager, 'getPolicy'> | undefined;
  /**
   * Marks an approval whose prompt could not be shown where it was raised, so
   * every attached surface and the waiting agent can see it. The approval
   * broker's remote update when wired.
   */
  readonly recordApprovalPromptUndelivered?: ((approvalId: string, detail: ApprovalPromptUndelivered) => Promise<unknown>) | undefined;
  /** Syncs a finished agent's task record; used when a reply is registered after its agent already ended. */
  readonly syncFinishedAgentTask?: ((record: import('../tools/agent/index.js').AgentRecord) => void) | undefined;
}

/** What `metadata.promptDelivery` holds on an approval whose prompt did not reach its conversation. */
export interface ApprovalPromptUndelivered {
  readonly delivered: false;
  /** Why the prompt's own conversation did not get it. */
  readonly reason: string;
  /** The owner conversation the prompt was taken to instead, or null when none took it. */
  readonly reachedSurface: string | null;
  readonly at: number;
}

/** One entry the delivery ledger should show for a surface reply. */
export interface SurfaceDeliveryLedgerEntry {
  readonly deliveryId: string;
  readonly agentId: string;
  readonly sessionId?: string | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceKind: string;
  readonly targetId: string;
  readonly phase: 'queued' | 'started' | 'succeeded' | 'failed';
  readonly error?: string | undefined;
}

export type SurfaceDeliveryLedgerRecorder = (entry: SurfaceDeliveryLedgerEntry) => void;

/** Why a surface reply could not be created, carried into the log line. */
type SurfaceReplyRefusal =
  | 'no-route-binding'
  | 'unsupported-delivery-surface'
  | 'surface-delivery-disabled'
  | 'no-deliverable-target';

/**
 * How long a pending surface reply may wait for an agent this process cannot
 * see. A turn run by another process (a TUI that died before reporting back)
 * or a record the agent manager already evicted never becomes terminal here,
 * so without a bound its entry was polled every two seconds until the daemon
 * stopped. Agents this process can see keep their entry while they run.
 */
export const ORPHANED_SURFACE_REPLY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const UNDELIVERED_BODY_EXCERPT_CHARS = 2000;
const MAX_RECOVERED_REPLIES = 1_000;

function truncateUndeliveredBody(body: string): string {
  return body.length <= UNDELIVERED_BODY_EXCERPT_CHARS
    ? body
    : `${body.slice(0, UNDELIVERED_BODY_EXCERPT_CHARS)}... [${body.length - UNDELIVERED_BODY_EXCERPT_CHARS} more characters not kept]`;
}

export class DaemonSurfaceDeliveryHelper {
  /** Agents whose final answer a surface is reporting right now; a retried report waits its turn. */
  private readonly finalizingReplies = new Set<string>();
  /** Agents whose answer this process handed to its channel or recovered from the session; see `recoverPendingReply`. */
  private readonly recoveredReplies = new Set<string>();

  constructor(
    private readonly context: DaemonSurfaceDeliveryContext,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Track the reply an agent owes a conversation.
   *
   * Idempotent by agent id. Several paths legitimately reach here for the same
   * agent, the broker announces the pairing centrally and the adapter that
   * spawned it also asks, and re-tracking would reset the pipeline's event
   * buffer and republish everything already sent. First writer wins.
   */
  queueSurfaceReplyFromBinding(binding: RouteBinding | undefined, input: SurfaceReplyInput): boolean {
    if (!binding) return false;
    if (!isSupportedDeliverySurface(binding.surfaceKind)) return false;
    if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return false;
    if (this.context.pendingSurfaceReplies.has(input.agentId)) return true;
    const pending = this.buildPendingSurfaceReply(binding, input);
    if (!pending) return false;
    this.dropOrphanedReplies();
    this.context.pendingSurfaceReplies.set(input.agentId, pending);
    this.context.channelReplyPipeline.trackPending(pending);
    this.recordLedger({
      deliveryId: `surface-reply:${input.agentId}`,
      agentId: input.agentId,
      sessionId: input.sessionId,
      routeId: binding.id,
      surfaceKind: binding.surfaceKind,
      targetId: binding.channelId ?? binding.externalId ?? binding.id,
      phase: 'queued',
    });
    this.settleIfAlreadyFinished(input.agentId);
    return true;
  }

  /**
   * A reply registered after its agent already ended (one that failed at once:
   * no usable model, a refused spawn) has no terminal event still coming, so it
   * is settled here: the person gets the answer or the failure. One status
   * read per registration; after the current event's handlers, like the
   * event-driven settlement, so an end being announced right now settles once.
   */
  private settleIfAlreadyFinished(agentId: string): void {
    const status = this.context.agentManager.getStatus(agentId)?.status;
    if (status !== 'completed' && status !== 'failed' && status !== 'cancelled') return;
    const sync = this.context.syncFinishedAgentTask ?? (() => {});
    setTimeout(() => {
      void this.settleFinishedAgent(agentId, sync).catch((error: unknown) => {
        logger.warn('A channel reply registered after its agent ended could not be settled', { agentId, error: summarizeError(error) });
      });
    }, 0);
  }

  /**
   * The shared reply-routing point: an agent is going to answer a message that
   * arrived over a channel, so make sure its answer has somewhere to go.
   *
   * Wired to SharedSessionBroker.setSurfaceReplyBinder, which announces the
   * pairing from inside the broker, the one place every ingress converges on.
   * Fixing it here rather than in an adapter is what makes a message landing in
   * an EXISTING live session get an answer, on all fifteen delivery surfaces,
   * without each adapter having to remember.
   *
   * Never silent: when no delivery can be created for a message that demonstrably
   * came from a channel, that is a produced answer with nowhere to go, and it is
   * reported at error with the surface, session, binding and reason, plus a
   * failed ledger entry so "should have sent, did not" is visible rather than
   * indistinguishable from "nothing happened".
   */
  ensureSurfaceReply(binding: SharedSessionSurfaceReplyBinding): boolean {
    if (this.context.pendingSurfaceReplies.has(binding.agentId)) return true;
    const route = binding.routeId ? this.context.routeBindings.getBinding(binding.routeId) : undefined;
    const resolved = route ?? this.resolveBindingFromSession(binding);
    const refusal = this.describeRefusal(resolved);
    if (!refusal) {
      return this.queueSurfaceReplyFromBinding(resolved, {
        agentId: binding.agentId,
        task: binding.task,
        ...(binding.sessionId ? { sessionId: binding.sessionId } : {}),
      });
    }
    // 'no-route-binding' for a surface we cannot deliver to at all (a local
    // terminal, a surface with no egress) is not a failure, there was never a
    // conversation to answer into. Everything else is a dropped reply.
    if (refusal === 'unsupported-delivery-surface' && !binding.routeId) return false;
    logger.error('An answer was produced for a channel message but no delivery could be created', {
      surface: binding.surfaceKind ?? resolved?.surfaceKind ?? 'unknown',
      sessionId: binding.sessionId,
      agentId: binding.agentId,
      bindingId: binding.routeId ?? resolved?.id ?? null,
      pairedBy: binding.reason,
      reason: refusal,
    });
    this.recordLedger({
      deliveryId: `surface-reply:${binding.agentId}`,
      agentId: binding.agentId,
      sessionId: binding.sessionId,
      routeId: binding.routeId ?? resolved?.id,
      surfaceKind: binding.surfaceKind ?? resolved?.surfaceKind ?? 'unknown',
      targetId: resolved?.channelId ?? resolved?.externalId ?? binding.routeId ?? 'unknown',
      phase: 'failed',
      error: `no surface reply could be created (${refusal})`,
    });
    return false;
  }

  /** Record a reply that reached its conversation. */
  recordDeliveredReply(reply: DeliveredChannelReply): void {
    const route = reply.routeId ? this.context.routeBindings.getBinding(reply.routeId) : undefined;
    this.recordLedger({
      deliveryId: `surface-reply:${reply.agentId}`,
      agentId: reply.agentId,
      sessionId: reply.sessionId,
      routeId: reply.routeId,
      surfaceKind: reply.surfaceKind,
      targetId: route?.channelId ?? route?.externalId ?? reply.responseId ?? reply.routeId ?? 'unknown',
      phase: 'succeeded',
    });
  }

  /** Record a reply that reached the pipeline but never reached the conversation. */
  recordUndeliveredReply(reply: UndeliveredChannelReply, options: { readonly sessionCopyKept?: boolean } = {}): void {
    if (reply.phase !== 'final') return;
    // The session broker stores every final from the agent's terminal event.
    const sessionCopyKept = options.sessionCopyKept ?? reply.sessionId !== undefined;
    const route = reply.routeId ? this.context.routeBindings.getBinding(reply.routeId) : undefined;
    this.recordLedger({
      deliveryId: `surface-reply:${reply.agentId}`,
      agentId: reply.agentId,
      sessionId: reply.sessionId,
      routeId: reply.routeId,
      surfaceKind: reply.surfaceKind,
      targetId: route?.channelId ?? route?.externalId ?? reply.routeId ?? 'unknown',
      phase: 'failed',
      // Point at the session copy only when one exists; otherwise the ledger is the last place the answer survives, so carry a bounded excerpt.
      error: reply.sessionId && sessionCopyKept
        ? `${reply.reason} (the answer is kept in session ${reply.sessionId})`
        : `${reply.reason} (no session copy exists; the answer began: ${truncateUndeliveredBody(reply.body)})`,
    });
  }

  private describeRefusal(binding: RouteBinding | undefined): SurfaceReplyRefusal | null {
    if (!binding) return 'no-route-binding';
    if (!isSupportedDeliverySurface(binding.surfaceKind)) return 'unsupported-delivery-surface';
    if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return 'surface-delivery-disabled';
    if (!this.buildPendingSurfaceReply(binding, { agentId: binding.id, task: '' })) return 'no-deliverable-target';
    return null;
  }

  /**
   * Fall back to the session's own route bindings when the announcement did not
   * carry one, a follow-up typed into a session that a channel is attached to
   * still belongs to that channel.
   */
  private resolveBindingFromSession(binding: SharedSessionSurfaceReplyBinding): RouteBinding | undefined {
    const session = this.context.sessionBroker.getSession(binding.sessionId);
    for (const routeId of session?.routeIds ?? []) {
      const candidate = this.context.routeBindings.getBinding(routeId);
      if (!candidate) continue;
      if (binding.surfaceKind && candidate.surfaceKind !== binding.surfaceKind) continue;
      return candidate;
    }
    return undefined;
  }

  private recordLedger(entry: SurfaceDeliveryLedgerEntry): void {
    try {
      this.context.recordDeliveryAttempt?.(entry);
    } catch (error) {
      logger.warn('Surface delivery ledger update failed', {
        agentId: entry.agentId,
        phase: entry.phase,
        error: summarizeError(error),
      });
    }
  }

  /**
   * Send a single short message to whatever surface a binding points at,
   * without creating a tracked agent reply.
   *
   * This is what the conversation-first gate uses to put a work proposal (and
   * its accept/decline acknowledgement) on the channel the message arrived on.
   *
   * It sends through the SAME channel render path a conversational reply takes
   *, `channelPlugins.render` -> the surface's renderEvent -> the channel
   * delivery router, which is why a proposal is deliverable on every surface
   * the platform can already talk to. Telegram is the case that proves it: the
   * bot could always answer a chat message, because that answer went through
   * the router's `sendMessage` strategy, while the gate's notice went through
   * `deliverSurfaceProgress`, which is implemented for slack/discord/ntfy only.
   * A gated surface with no notice path is a black hole, the owner is asked
   * nothing and the daemon waits for an answer to a question never posed.
   *
   * `deliverSurfaceProgress` remains only as the fallback for a surface whose
   * plugin is not registered at all (an embedder with its own registry).
   */
  /**
   * Deliver a notice that is still STRUCTURE, escaping it for whatever surface
   * the binding points at.
   *
   * This is the entry point anything holding a `StructuredNotice` must use,
   * and the reason it exists rather than leaving callers to render first is
   * that the destination is not knowable at the call site. The binding is
   * resolved here, so the escaper is chosen from the surface the message will
   * actually land on, a caller cannot pick the wrong one, and cannot skip
   * escaping, because it never holds a string to pass.
   *
   * That is the same structural-over-conventional rule the inbound-mail path
   * runs on elsewhere: the producer (`renderInboundMailNotice`) cannot emit a
   * channel-formatted string, and this is the only place one is made.
   *
   * A surface with no verified escaper gets fully-neutralized plain text, not
   * the raw span concatenation, see `noticeChannelForSurface`.
   */
  async deliverStructuredNotice(
    binding: RouteBinding | undefined,
    notice: StructuredNotice,
    announces?: string,
  ): Promise<SurfaceNoticeDelivery> {
    if (!binding) {
      // Refused for the same reason and by the same name as below; rendering
      // first would mean escaping text for a surface that does not exist.
      return this.deliverSurfaceNotice(binding, '');
    }
    return this.deliverSurfaceNotice(binding, renderNoticeForSurface(notice, binding.surfaceKind), announces);
  }

  /**
   * The surface's owner: the policy's explicit owner (a policy saved before
   * owners were recorded is given its first allowlisted user when it loads).
   * Undefined when the surface has no owner.
   */
  channelOwner(surface: string): string | undefined {
    return this.context.channelPolicy?.getPolicy(surface as ChannelSurface).ownerId;
  }

  /** Keeps an owner alert that reached no conversation, for the next attached terminal or web UI to show. */
  recordOwnerReceipt(text: string): void {
    daemonReceiptStoreAt(daemonReceiptsPath(this.context.configManager)).record(text);
  }

  /**
   * `announces` names what the notice is about (for example `proposal:<id>`):
   * a surface that suppresses repeats does so on that identity, so two notices
   * about different things are both delivered even when their words match.
   */
  async deliverSurfaceNotice(binding: RouteBinding | undefined, text: string, announces?: string): Promise<SurfaceNoticeDelivery> {
    const refuse = (reason: SurfaceNoticeRefusal, error?: string): SurfaceNoticeDelivery => {
      // ERROR, not warn, and never a silent `return false`: a notice the owner
      // does not receive is the difference between a proposal they can answer
      // and one the system holds open while they see nothing. Every guard here
      // names itself so the log says which one refused.
      logger.error('Surface notice was not delivered', {
        surface: binding?.surfaceKind ?? null,
        routeId: binding?.id ?? null,
        reason,
        ...(error ? { error } : {}),
      });
      return { delivered: false, reason, ...(error ? { error } : {}) };
    };
    if (!binding) return refuse('no-route-binding');
    if (!text.trim()) return refuse('empty-text');
    try {
      if (!isSupportedDeliverySurface(binding.surfaceKind)) return refuse('unsupported-delivery-surface');
      if (!this.context.surfaceDeliveryEnabled(binding.surfaceKind)) return refuse('surface-delivery-disabled');
      const pending = this.buildPendingSurfaceReply(binding, {
        agentId: `notice:${binding.id}:${Date.now()}`,
        task: text,
      });
      if (!pending) return refuse('no-deliverable-target');
      const rendered = await this.context.channelPlugins.render(binding.surfaceKind as ChannelSurface, {
        surface: binding.surfaceKind as ChannelSurface,
        // 'progress' rather than 'final': a notice is not an agent's answer, and
        // the final phase decorates the message with control-plane links and
        // completion framing that do not belong on a question.
        phase: 'progress',
        agentId: pending.agentId,
        routeId: binding.id,
        title: NOTICE_TITLE,
        text,
        events: [],
        pending: { ...pending, ...(announces ? { announces } : {}) },
        metadata: { notice: true, ...(announces ? { announces } : {}) },
      });
      if (rendered?.delivered) return rendered.metadata.suppressed === true ? { delivered: true, suppressed: true } : { delivered: true };
      if (rendered) {
        return refuse('delivery-failed', String(rendered.metadata.reason ?? 'channel-reported-not-delivered'));
      }
      // No plugin is registered for this surface, so there is no render path to
      // use. Fall back to the direct per-surface push, which throws by name for
      // any surface it does not implement.
      await this.deliverSurfaceProgress({ ...pending, ...(announces ? { announces } : {}) }, text);
      return { delivered: true };
    } catch (error) {
      return refuse('delivery-failed', summarizeError(error));
    }
  }

  queueWebhookReply(input: WebhookReplyInput): void {
    const callback = {
      callbackUrl: input.callbackUrl,
      callbackCorrelationId: input.callbackCorrelationId,
      callbackSignature: input.callbackSignature,
    };
    // bindAgent may already have queued this agent's reply from the shared binding. The callback
    // belongs to this request alone, so it is written onto that entry in place: what the reply
    // pipeline has collected for the agent, and any delivery already in flight, stay on it.
    const existing = this.context.pendingSurfaceReplies.get(input.agentId);
    if (existing) {
      Object.assign(existing, callback);
      if (!this.context.channelReplyPipeline.has(input.agentId)) this.context.channelReplyPipeline.trackPending(existing);
      return;
    }
    const pending: PendingSurfaceReply = {
      agentId: input.agentId,
      surfaceKind: 'webhook',
      task: input.task,
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: input.routeId,
      ...callback,
    };
    this.context.pendingSurfaceReplies.set(input.agentId, pending);
    this.context.channelReplyPipeline.trackPending(pending);
    this.settleIfAlreadyFinished(input.agentId);
  }

  /**
   * A surface that ran the turn in ITS OWN process reports the answer.
   *
   * The agent's terminal event cannot reach this daemon for an agent another
   * process ran, so the report is that event: write the answer into the shared
   * session, push it down the reply pipeline, drop the pending entry. When the
   * daemon restarted since the reply was queued, the route is read back from
   * the session input the agent was started for. The stored answer marks its
   * channel rows owed and the send marks them sent, so a restart between the
   * two still sends it, and a restart after the send does not send it again.
   *
   * Returns whether a channel delivery was attempted. `false` is the ordinary
   * outcome for a session with no channel behind it (a local terminal), and is
   * not an error, the session message is still written.
   */
  async completeSurfaceReplyFromSurface(input: {
    readonly agentId: string;
    readonly sessionId?: string | undefined;
    readonly body: string;
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  }): Promise<boolean> {
    // A repeated report (a retried POST) must not deliver or store the answer a
    // second time while the first is still awaiting its session write or channel.
    if (this.finalizingReplies.has(input.agentId)) return false;
    this.finalizingReplies.add(input.agentId);
    try { return await this.completeSurfaceReplyOnce(input); }
    finally { this.finalizingReplies.delete(input.agentId); }
  }

  private async completeSurfaceReplyOnce(input: {
    readonly agentId: string;
    readonly sessionId?: string | undefined;
    readonly body: string;
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
  }): Promise<boolean> {
    const held = this.context.pendingSurfaceReplies.get(input.agentId);
    // Claimed before the first await so the terminal-event path cannot also deliver it.
    if (held) this.context.pendingSurfaceReplies.delete(input.agentId);
    const status = input.status ?? 'completed';
    const sessionId = input.sessionId ?? held?.sessionId;
    // Recovered before the answer is stored, while the session input still says
    // whether an earlier report settled this agent's answer (see recoverPendingReply).
    const recovered = held ? null : this.recoverPendingReply(input.agentId, sessionId);
    const pending = held ?? recovered;
    if (sessionId) {
      try {
        await this.context.sessionBroker.completeAgent(sessionId, input.agentId, input.body, {
          status,
          ...(pending?.routeId ? { routeId: pending.routeId } : {}),
        }, { channelReplyOwed: pending !== null && pending !== undefined });
      } catch (error) {
        // Nothing was delivered: hand the entry back so a retried report still can.
        if (held) this.context.pendingSurfaceReplies.set(input.agentId, held);
        if (recovered) {
          this.recoveredReplies.delete(input.agentId);
          this.context.channelReplyPipeline.untrack(input.agentId);
        }
        throw error;
      }
    }
    if (!pending) return false;
    this.recordReplyPhase(pending, 'started');
    try {
      await this.context.channelReplyPipeline.deliverFinal(input.agentId, input.body, {
        keepTracking: pending.surfaceKind === 'ntfy' && typeof pending.contractId === 'string',
      });
    } catch (error) {
      logger.error('Agent reply delivery failed, the answer did not reach its conversation', {
        surface: pending.surfaceKind,
        agentId: input.agentId,
        sessionId: sessionId ?? null,
        bindingId: pending.routeId ?? null,
        reason: summarizeError(error),
      });
      this.recordUndeliveredReply({
        surfaceKind: pending.surfaceKind as ChannelSurface,
        agentId: input.agentId,
        sessionId: pending.sessionId,
        routeId: pending.routeId,
        phase: 'final',
        body: input.body,
        reason: summarizeError(error),
      }, { sessionCopyKept: sessionId !== undefined });
    }
    // Handed to the channel, accepted or not (a final is sent once): a repeated report finds it settled.
    this.recoveredReplies.add(input.agentId);
    while (this.recoveredReplies.size > MAX_RECOVERED_REPLIES) this.recoveredReplies.delete(this.recoveredReplies.values().next().value!);
    if (sessionId) {
      await this.context.sessionBroker.settleChannelReply(sessionId, input.agentId).catch((error: unknown) => {
        logger.warn('A sent channel answer could not be marked sent; a report repeated after a restart may send it again', {
          agentId: input.agentId, sessionId, error: summarizeError(error),
        });
      });
    }
    return true;
  }

  /**
   * Drop every pending reply, recording each as failed with the reason, so a
   * stop or a failed start never makes a queued answer vanish without a trace.
   */
  abandonPendingSurfaceReplies(reason: string): void {
    for (const pending of this.context.pendingSurfaceReplies.values()) {
      this.recordReplyPhase(pending, 'failed', reason);
      try { this.context.channelReplyPipeline.untrack(pending.agentId); }
      catch (error) { logger.warn('Surface reply could not be untracked', { agentId: pending.agentId, error: summarizeError(error) }); }
    }
    this.context.pendingSurfaceReplies.clear();
  }

  /** Ledger bookkeeping only: it never throws into the delivery it describes. */
  private recordReplyPhase(pending: PendingSurfaceReply, phase: 'started' | 'failed', error?: string): void {
    let route: ReturnType<RouteBindingManager['getBinding']>;
    try { route = pending.routeId ? this.context.routeBindings.getBinding(pending.routeId) : undefined; }
    catch { route = undefined; }
    this.recordLedger({
      deliveryId: `surface-reply:${pending.agentId}`,
      agentId: pending.agentId,
      sessionId: pending.sessionId,
      routeId: pending.routeId,
      surfaceKind: pending.surfaceKind,
      targetId: route?.channelId ?? route?.externalId ?? pending.channelId ?? pending.routeId ?? 'unknown',
      phase,
      ...(error !== undefined ? { error } : {}),
    });
  }

  /**
   * An agent ended: its terminal event is the one owner of the answer. The
   * reply pipeline renders and sends the final from that event and the session
   * broker stores it from the same event, each once; this closes the pending
   * entry and syncs the task record. It sends the answer itself only when the
   * pipeline took up no final (an end whose event carried no answer).
   * Progress needs nothing here: the pipeline sends owner-facing progress from
   * the agent's progress events.
   */
  async settleFinishedAgent(agentId: string, syncFinishedAgentTask: (record: import('../tools/agent/index.js').AgentRecord) => void): Promise<void> {
    const pending = this.context.pendingSurfaceReplies.get(agentId);
    // A surface reporting the same answer is delivering it.
    if (!pending || this.finalizingReplies.has(agentId)) return;
    const record = this.context.agentManager.getStatus(agentId);
    if (!record || (record.status !== 'completed' && record.status !== 'failed' && record.status !== 'cancelled')) return;
    this.context.pendingSurfaceReplies.delete(agentId);
    syncFinishedAgentTask(record);
    if (this.context.channelReplyPipeline.finalOwner(agentId) !== 'none') return;
    const message = this.renderAgentCompletionForSurface(record);
    this.recordReplyPhase(pending, 'started');
    try {
      await this.context.channelReplyPipeline.deliverFinal(agentId, message, {
        keepTracking: pending.surfaceKind === 'ntfy' && typeof pending.contractId === 'string',
      });
    } catch (error) {
      // The reply exists, the conversation is known, and it did not arrive.
      logger.error('Agent reply delivery failed, the answer did not reach its conversation', {
        surface: pending.surfaceKind,
        agentId,
        sessionId: pending.sessionId ?? null,
        bindingId: pending.routeId ?? null,
        reason: summarizeError(error),
      });
      this.recordUndeliveredReply({
        surfaceKind: pending.surfaceKind as ChannelSurface,
        agentId,
        sessionId: pending.sessionId,
        routeId: pending.routeId,
        phase: 'final',
        body: message,
        reason: summarizeError(error),
      });
    }
  }

  /**
   * Entries for agents this daemon does not know (run by another process that
   * never reported back) are closed after a long wait, so the map cannot grow
   * without end. Looked at when a reply is queued; costs one pass over the map.
   */
  private dropOrphanedReplies(): void {
    const now = this.now();
    for (const pending of [...this.context.pendingSurfaceReplies.values()]) {
      if (now - pending.createdAt <= ORPHANED_SURFACE_REPLY_MAX_AGE_MS || this.context.agentManager.getStatus(pending.agentId)) continue;
      logger.warn('Surface reply abandoned: its agent is not known to this daemon and never reported back', {
        surface: pending.surfaceKind,
        agentId: pending.agentId,
        sessionId: pending.sessionId ?? null,
        bindingId: pending.routeId ?? null,
      });
      this.recordReplyPhase(pending, 'failed', 'no answer arrived: the agent is not known to this daemon and never reported back');
      try { this.context.channelReplyPipeline.untrack(pending.agentId); }
      catch (error) { logger.warn('Surface reply could not be untracked', { agentId: pending.agentId, error: summarizeError(error) }); }
      this.context.pendingSurfaceReplies.delete(pending.agentId);
    }
  }

  /**
   * The reply route of an agent whose pending entry this process does not hold
   * (it was queued before a daemon restart): read from the session input the
   * agent was started for, which the session broker persists with its route.
   * Only while that input still waits for this answer: running, cancelled by
   * the restart's own reconcile (which a completion report revives), or with
   * the answer stored and its send not yet made (a daemon that stopped between
   * the two). Once the answer was handed to the channel the rows say `sent`,
   * and a report repeated after a restart (the surface never heard back) must
   * not send it again. Once per agent per process, so a repeated report cannot
   * send it twice.
   */
  private recoverPendingReply(agentId: string, sessionId: string | undefined): PendingSurfaceReply | null {
    if (!sessionId || this.recoveredReplies.has(agentId)) return null;
    const row = this.context.sessionBroker.getInputs(sessionId, 1_000).find((entry) => entry.activeAgentId === agentId && entry.routeId
      && entry.metadata?.[CHANNEL_REPLY_METADATA_KEY] !== 'sent'
      && (entry.state === 'delivered' || entry.state === 'spawned'
        || (entry.state === 'cancelled' && entry.error === BOOT_RECONCILE_CANCEL_REASON)
        || entry.metadata?.[CHANNEL_REPLY_METADATA_KEY] === 'owed'));
    const binding = row?.routeId ? this.context.routeBindings.getBinding(row.routeId) : undefined;
    if (!row || !binding || this.describeRefusal(binding)) return null;
    const pending = this.buildPendingSurfaceReply(binding, { agentId, task: row.body, sessionId });
    if (!pending) return null;
    this.recoveredReplies.add(agentId);
    while (this.recoveredReplies.size > MAX_RECOVERED_REPLIES) this.recoveredReplies.delete(this.recoveredReplies.values().next().value!);
    this.context.channelReplyPipeline.trackPending(pending);
    return pending;
  }

  /**
   * Collaborators for the direct per-surface senders in
   * surface-direct-delivery.ts (this file was over the line cap). These stay as
   * methods because facade-composition wires them by name into the daemon route
   * context and the builtin channel plugins.
   */
  private directDeliveryDeps(): SurfaceDirectDeliveryDeps {
    return {
      serviceRegistry: this.context.serviceRegistry,
      configManager: this.context.configManager,
      agentManager: this.context.agentManager,
      resolveSlackWebhookUrl: () => this.resolveSlackWebhookUrl(),
      resolveSlackBotToken: () => this.resolveSlackBotToken(),
      resolveWebhookDefaultTarget: () => this.resolveConfigSecret(this.context.configManager.get('surfaces.webhook.defaultTarget')),
      resolveNtfyToken: () => this.resolveNtfyToken(),
      resolveDiscordBotToken: () => this.resolveDiscordBotToken(),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
    };
  }

  /**
   * Push a one-line status to a surface directly. slack/discord/ntfy only,
   * every other surface throws by name. This is the FALLBACK; the general path
   * is the channel delivery router. See surface-direct-delivery.ts.
   */
  async deliverSurfaceProgress(pending: PendingSurfaceReply, progress: string): Promise<void> {
    await deliverSurfaceProgress(this.directDeliveryDeps(), pending, progress);
  }

  async deliverSlackAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverSlackAgentReply(this.directDeliveryDeps(), pending, message);
  }

  async deliverDiscordAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverDiscordAgentReply(this.directDeliveryDeps(), pending, message);
  }

  async deliverNtfyAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverNtfyAgentReply(this.directDeliveryDeps(), pending, message);
  }

  async deliverWebhookAgentReply(pending: PendingSurfaceReply, message: string): Promise<void> {
    await deliverWebhookAgentReply(this.directDeliveryDeps(), pending, message);
  }

  /**
   * Show an approval update on the conversation it belongs to (its route, else
   * its session's first route). When a prompt that still waits for an answer
   * did not get there (a refused or failed send, a binding that is gone, or no
   * one attached to see it), it is taken to the owner's other conversations
   * through the owner-alert path, and the approval record says the prompt was
   * not delivered, once. A prompt of a session open in a terminal app, the
   * Agent or the web UI is on the owner's screen already: nothing more is done.
   */
  async notifyApprovalUpdate(approval: SharedApprovalRecord): Promise<void> {
    await this.context.sessionBroker.start();
    await this.context.routeBindings.start();
    const outcome = await this.deliverApprovalToItsRoute(approval);
    if (outcome.delivered || (approval.status !== 'pending' && approval.status !== 'claimed')) return;
    if (!this.approvalNeedsOwnerAlert(approval)) return;
    // Marked already: the record update that said so is itself published here.
    const marked = approval.metadata['promptDelivery'];
    if (typeof marked === 'object' && marked !== null && (marked as { delivered?: unknown }).delivered === false) return;
    const reason = outcome.reason === 'delivery-failed' && outcome.error ? `delivery-failed: ${outcome.error}` : outcome.reason;
    const webUrl = this.controlPlaneWebUrl({ approvalId: approval.id, sessionId: approval.sessionId });
    const text = `Approval required for ${approval.request.tool}: ${approval.request.analysis.summary}. `
      + 'It could not be shown in the conversation it came from. '
      + `Answer it in the terminal app or the web UI${webUrl ? `: ${webUrl}` : ''}.`;
    const reached = await deliverOwnerAlert(this.context.routeBindings, this, null, text);
    logger.warn('An approval prompt did not reach its conversation', {
      approvalId: approval.id, reason, reachedSurface: reached?.surfaceKind ?? null,
    });
    await this.context.recordApprovalPromptUndelivered?.(approval.id, {
      delivered: false, reason, reachedSurface: reached?.surfaceKind ?? null, at: Date.now(),
    })?.catch((error: unknown) => {
      logger.warn('An undelivered approval prompt could not be marked on its record', { approvalId: approval.id, error: summarizeError(error) });
    });
  }

  /**
   * Whether an approval that did not reach a channel conversation must be taken
   * to the owner. It must when it belonged to a conversation (its route or its
   * session's routes) and the send failed or the binding is gone, and when no
   * one is attached to see it (no session, or a session with only background
   * participants). A session a terminal app, the Agent or the web UI is
   * attached to already shows the prompt on the owner's screen: nothing is
   * sent and the record is not rewritten.
   */
  private approvalNeedsOwnerAlert(approval: SharedApprovalRecord): boolean {
    if (approval.routeId !== undefined) return true;
    if (approval.sessionId === undefined) return true;
    const session = this.context.sessionBroker.getSession(approval.sessionId);
    // A session this daemon does not hold is not known to be unattended.
    if (!session) return false;
    if (session.routeIds.length > 0) return true;
    return !session.participants.some((participant) => INTERACTIVE_SURFACE_KINDS.has(participant.surfaceKind));
  }

  private async deliverApprovalToItsRoute(approval: SharedApprovalRecord): Promise<SurfaceNoticeDelivery> {
    const routeId = approval.routeId
      ?? this.context.sessionBroker.getSession(approval.sessionId ?? '')?.routeIds[0];
    if (!routeId) return { delivered: false, reason: 'no-route-binding' };
    const binding = this.context.routeBindings.getBinding(routeId);
    if (!binding) return { delivered: false, reason: 'no-route-binding' };
    // The four surfaces rendered here say whether the prompt got there.
    const deps = this.approvalDeliveryDeps();
    switch (binding.surfaceKind) {
      case 'slack': return deliverSlackApprovalUpdate(deps, approval, binding);
      case 'discord': return deliverDiscordApprovalUpdate(deps, approval, binding);
      case 'ntfy': return deliverNtfyApprovalUpdate(deps, approval, binding);
      case 'webhook': return deliverWebhookApprovalUpdate(deps, approval, binding);
      case 'service': return { delivered: false, reason: 'unsupported-delivery-surface' };
      default: {
        const plugin = await this.context.channelPlugins.notifyApproval(binding.surfaceKind, approval, binding);
        if (!plugin.handled) return { delivered: false, reason: 'unsupported-delivery-surface' };
        return plugin.delivered ? { delivered: true } : { delivered: false, reason: 'delivery-failed', ...(plugin.error ? { error: plugin.error } : {}) };
      }
    }
  }

  /** The web app opened on this approval or session (web-app-link.ts); undefined when no address a phone can reach is known. */
  controlPlaneWebUrl(input: { readonly approvalId?: string; readonly sessionId?: string | undefined }): string | undefined {
    return webAppLink(this.context.configManager, input);
  }

  signWebhookPayload(body: string, secret: string): string {
    const digest = createHmac('sha256', secret).update(body).digest('hex');
    return `sha256=${digest}`;
  }

  private buildPendingSurfaceReply(binding: RouteBinding, input: SurfaceReplyInput): PendingSurfaceReply | null {
    // A row persisted before bindings carried metadata has none.
    const metadata: Readonly<Record<string, unknown>> = binding.metadata ?? {};
    const shared = {
      agentId: input.agentId,
      task: input.task,
      ...(input.agentTask ? { agentTask: input.agentTask } : {}),
      ...(input.contractId ? { contractId: input.contractId } : {}),
      createdAt: Date.now(),
      sessionId: input.sessionId,
      routeId: binding.id,
      threadId: binding.threadId,
    } as const;

    switch (binding.surfaceKind) {
      case 'slack':
        return {
          ...shared,
          surfaceKind: 'slack',
          responseUrl: typeof metadata.responseUrl === 'string' ? metadata.responseUrl : undefined,
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'discord':
        return {
          ...shared,
          surfaceKind: 'discord',
          channelId: binding.channelId,
          applicationId: typeof metadata.applicationId === 'string' ? metadata.applicationId : undefined,
          interactionToken: typeof metadata.interactionToken === 'string' ? metadata.interactionToken : undefined,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'ntfy':
        return {
          ...shared,
          surfaceKind: 'ntfy',
          topic: binding.channelId ?? binding.externalId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'webhook':
        return {
          ...shared,
          surfaceKind: 'webhook',
          // The binding is shared by every call on the route and may hold another caller's callback;
          // a webhook reply carries only the callback its own request supplied (queueWebhookReply).
        };
      case 'homeassistant':
        return {
          ...shared,
          surfaceKind: 'homeassistant',
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
          surfaceId: binding.surfaceId,
          externalId: binding.externalId,
          conversationId: typeof metadata.conversationId === 'string'
            ? metadata.conversationId
            : binding.externalId,
          messageId: typeof metadata.messageId === 'string' ? metadata.messageId : undefined,
          replyToMessageId: typeof metadata.messageId === 'string' ? metadata.messageId : undefined,
        };
      case 'telegram':
      case 'google-chat':
      case 'signal':
      case 'whatsapp':
      case 'telephony':
      case 'imessage':
      case 'msteams':
      case 'bluebubbles':
      case 'mattermost':
      case 'matrix':
        return {
          ...shared,
          surfaceKind: binding.surfaceKind,
          channelId: binding.channelId,
          targetAddress: binding.channelId ?? binding.externalId,
        };
      case 'service':
        return null;
      default:
        return null;
    }
  }

  /**
   * Per-surface approval rendering lives in surface-approval-delivery.ts (this
   * file was over the 800-line cap). These stay as methods because
   * facade-composition wires them by name into the daemon route context.
   */
  private approvalDeliveryDeps(): SurfaceApprovalDeliveryDeps {
    return {
      serviceRegistry: this.context.serviceRegistry,
      configManager: this.context.configManager,
      controlPlaneWebUrl: (input) => this.controlPlaneWebUrl(input),
      resolveSlackWebhookUrl: () => this.resolveSlackWebhookUrl(),
      resolveSlackBotToken: () => this.resolveSlackBotToken(),
      resolveNtfyToken: () => this.resolveNtfyToken(),
      resolveDiscordBotToken: () => this.resolveDiscordBotToken(),
      signWebhookPayload: (body, secret) => this.signWebhookPayload(body, secret),
    };
  }

  async deliverSlackApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverSlackApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  async deliverDiscordApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverDiscordApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  async deliverNtfyApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverNtfyApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  async deliverWebhookApprovalUpdate(approval: SharedApprovalRecord, binding: RouteBinding): Promise<void> {
    await deliverWebhookApprovalUpdate(this.approvalDeliveryDeps(), approval, binding);
  }

  // Every surface credential is read through the setup schema's statement of
  // where it lives (channels/builtin/surface-secrets.ts), the reader setup uses.
  private async resolveSlackWebhookUrl(): Promise<string | null> {
    return resolveSurfaceSecret(this.context, 'slack', 'webhookUrl');
  }

  private async resolveSlackBotToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.context, 'slack', 'primary');
  }

  private async resolveNtfyToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.context, 'ntfy', 'primary');
  }

  private async resolveDiscordBotToken(): Promise<string | null> {
    return resolveSurfaceSecret(this.context, 'discord', 'primary');
  }

  private async resolveConfigSecret(value: unknown): Promise<string | null> {
    return resolveSecretInput(value, {
      resolveLocalSecret: (key) => this.context.secretsManager.get(key),
      homeDirectory: this.context.secretsManager.getGlobalHome?.() ?? undefined,
    });
  }

  private renderAgentCompletionForSurface(
    record: import('../tools/agent/index.js').AgentRecord,
  ): string {
    // ntfy used to take a branch of its own here that never looked at the
    // agent's output at all: a completed run was announced as
    // `Agent agent-1a2b3c completed.`, an id and a past-tense verb, on the
    // owner's primary surface, in place of the answer they asked for. Every
    // other surface was already handed `record.fullOutput`. There is no reason
    // for the answer to depend on which app is displaying it, so the branch is
    // gone and ntfy renders what everyone else renders.
    //
    // The rule itself lives in agents/completion-answer.ts, because a surface
    // that ran a dispatched turn in its own process renders the same answer
    // before reporting it back, see runtime/client/session-dispatch.ts.
    return renderAgentCompletionAnswer(record);
  }
}
