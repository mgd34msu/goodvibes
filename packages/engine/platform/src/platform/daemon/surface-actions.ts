import { randomUUID } from 'node:crypto';
import { assertSynchronousCurrent, daemonReadingPort } from './reading-lifetime.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import type { CallOptions } from '@goodvibes/judgment/decisions';
import { assertJudgmentInput } from '../gate/judgment-input.js';
import { surfaceControl, type SurfaceControlTarget, type SurfaceControlReading } from './batteries/surface-control.js';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import type { ServiceRegistry } from '../config/service-registry.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { AgentManager } from '../tools/agent/index.js';
import type { ControlPlaneGateway, SharedSessionBroker } from '../control-plane/index.js';
import type { RouteBindingManager, ChannelPolicyManager } from '../channels/index.js';
import { channelSenderActor } from '../channels/policy-manager.js';
import { admitEffects, type EffectId } from '../security/effect-authority.js';
import type { Actor } from '@goodvibes/engine/daemon-api/http-policy';
import type { GenericWebhookAdapterContext, SurfaceAdapterContext, SurfaceControlCommand, SurfaceControlOrigin, SurfaceIngressDecision } from '../adapters/index.js';
import type { AutomationManager } from '../automation/index.js';
import type { ChannelPolicyDecision, ChannelIngressPolicyInput } from '../channels/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { NtfyIntegration, ntfyBaseUrl, resolveNtfyDefaultPriority } from '../integrations/ntfy.js';
import {
  postHomeAssistantSurfaceChatMessage,
  type HomeAssistantSurfaceChatInput,
  type HomeAssistantSurfaceChatResult,
} from './surface-homeassistant-reply.js';
import type { CompanionChatManager } from '../companion/companion-chat-manager.js';
import { readSecretProviderHostConfig, resolveSecretInput } from '../config/secret-refs.js';
import { logger } from '../utils/logger.js';
import { holdCompanionTurn, type HeldCompanionTurn } from './held-companion-turn.js';
import { agentRetrySpawnInput } from '@goodvibes/engine/daemon-api/tasks';
import { toAgentSpawnInput } from './http/runtime-routes.js';
import { summarizeError } from '../utils/error-display.js';
import { approvalProposal, approvalReplyCandidates, tryResolveApprovalReplyFromChannel, type ApprovalReplyBroker } from './approval-reply.js';
import { proposalAnswerLiterally, proposalReplyTarget, tryResolveWorkProposalReplyFromChannel } from './work-proposal-reply.js';
import { tryResolvePaymentReplyFromChannel } from './payment-reply.js';
import { PaymentReplyInbox, type PaymentReplyOffer } from '../payments/reply-inbox.js';
import { refuseCardShapedIngress, refuseCardTalk, CARD_SHAPES_REFUSED_REASON, JUDGMENT_INPUT_REFUSED_REASON } from './surface-card-gate.js';
import { readInboundMessage, type InboundReading } from './inbound-reading.js';
import { isGatedSurface, readConversationGateConfig } from '../agents/conversation-gate.js';
import {
  deliverProposalNotice,
  settleUnstartedWork,
  gateSurfaceSpawn,
  startAgreedWork,
  WORK_PROPOSAL_ITEM_KEY,
  type OwnerConversation,
  type SurfaceIngressOrigin,
} from './surface-conversation-gate.js';
import type { OwnerAnswer, OwnerInbox, OwnerItem } from '../control-plane/owner-inbox.js';
import { isOwnerConversation, orderOwnerAlertRoutes } from './owner-alert.js';
import { isChannelSurfaceKind } from '../../events/surfaces.js';
import type { WorkProposalStore } from '../agents/work-proposal-store.js';

/**
 * Where to answer the owner who wrote `input`. Purchase notices go out by
 * surface kind, so the chat they were answered in may have no bound route; the
 * message carries everything a one-off reply needs, and a reply with nowhere to
 * go would leave the owner unaware their answer was set aside.
 */
export function ownerReplyBinding(
  bindings: readonly AutomationRouteBinding[],
  input: Pick<ChannelIngressPolicyInput, 'surface' | 'channelId' | 'threadId'>,
): AutomationRouteBinding | undefined {
  const bound = bindings.find(candidate => candidate.surfaceKind === input.surface
    && (candidate.channelId ?? candidate.externalId) === input.channelId && candidate.threadId === input.threadId);
  if (bound) return bound;
  if (!input.channelId) return undefined;
  const now = Date.now();
  return {
    id: `owner-reply:${input.surface}:${input.channelId}${input.threadId ? `:${input.threadId}` : ''}`,
    kind: input.threadId ? 'thread' : 'channel',
    surfaceKind: input.surface as AutomationRouteBinding['surfaceKind'],
    surfaceId: input.surface,
    externalId: input.channelId,
    channelId: input.channelId,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    lastSeenAt: now, createdAt: now, updatedAt: now,
    metadata: {},
  };
}

interface DaemonSurfaceActionContext {
  /** Whether the daemon takes new work (work-admission.ts): a message that arrives while it does not is held for after the restart. */
  readonly workAdmission?: Pick<import('./work-admission.js').DaemonWorkAdmission, 'open' | 'refusalResponse'> | undefined;
  readonly telegramSourceAccounts?: import('../channels/telegram/source-account.js').TelegramSourceAccountReader | undefined;
  readonly delegatedTelegram?: import('./delegated-telegram-intake.js').DelegatedTelegramIntake | undefined;
  readonly serviceRegistry: ServiceRegistry;
  readonly secretsManager: Pick<SecretsManager, 'get' | 'getGlobalHome'> & Partial<Pick<SecretsManager, 'onDidChange'>>;
  readonly configManager: ConfigManager;
  readonly routeBindings: RouteBindingManager;
  readonly sessionBroker: SharedSessionBroker;
  readonly channelPolicy: ChannelPolicyManager;
  readonly controlPlaneGateway: ControlPlaneGateway;
  readonly runtimeBus: RuntimeEventBus;
  readonly companionChatManager: CompanionChatManager | null;
  readonly automationManager: AutomationManager;
  readonly agentManager: AgentManager;
  readonly trySpawnAgent: (
    input: Parameters<AgentManager['spawn']>[0],
    logLabel?: string,
    sessionId?: string,
  ) => AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: import('../automation/routes.js').AutomationRouteBinding | undefined,
    input: { readonly agentId: string; readonly task: string; readonly agentTask?: string | undefined; readonly contractId?: string | undefined; readonly sessionId?: string | undefined },
  ) => void;
  readonly queueWebhookReply: (input: {
    readonly agentId: string;
    readonly task: string;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly callbackUrl?: string | undefined;
    readonly callbackCorrelationId?: string | undefined;
    readonly callbackSignature?: import('./types.js').PendingSurfaceReply['callbackSignature'] | undefined;
  }) => void;
  readonly surfaceDeliveryEnabled: (
    surface: 'slack' | 'discord' | 'ntfy' | 'webhook' | 'homeassistant' | 'telegram' | 'google-chat' | 'signal' | 'whatsapp' | 'telephony' | 'imessage' | 'msteams' | 'bluebubbles' | 'mattermost' | 'matrix',
  ) => boolean;
  readonly signWebhookPayload: (body: string, secret: string) => string;
  readonly handleApprovalAction: (
    approvalId: string,
    action: 'claim' | 'approve' | 'deny' | 'cancel',
    req: Request,
    interaction?: { readonly surface: string; readonly userId: string } | undefined,
  ) => Promise<Response>;
  /**
   * Shared pending-approval broker, the same machinery the TUI and webui
   * resolve asks through. Lets a paired channel owner approve, deny, or
   * steer a pending ask by replying in the channel.
   */
  readonly approvalBroker?: ApprovalReplyBroker | undefined;
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string } | null) | undefined;
  /**
   * Pending work proposals for the conversation-first gate. Absent = the gate
   * is not installed and inbound messages spawn as they always did, which is
   * what isolated contexts and older embedders get.
   */
  readonly workProposals?: WorkProposalStore | undefined;
  /** Purchase windows waiting for the owner's answer; the helper makes its own when absent. */
  readonly paymentReplies?: PaymentReplyInbox | undefined;
  /**
   * The owner inbox (Waiting for you): the owner's own work proposal that none of his conversations took waits there,
   * accepted or dismissed as an item (surface-conversation-gate.ts WORK_PROPOSAL_ITEM_KEY).
   */
  readonly ownerInbox?: Pick<OwnerInbox, 'postNow' | 'handleAnswers'> | undefined;
  /**
   * Put one short line on the channel a binding points at, and say whether it
   * got there. The outcome is discriminated rather than boolean so a caller
   * can log WHICH guard refused, see SurfaceNoticeRefusal.
   */
  readonly deliverSurfaceNotice?: ((binding: import('../automation/routes.js').AutomationRouteBinding | undefined, text: string) => Promise<import('./types.js').SurfaceNoticeDelivery>) | undefined;
  /**
   * The per-surface ingress alarm, handed to adapters so the two DETACHED
   * inbound paths (Slack and Discord slash commands, which answer the provider
   * before doing the work) can report a failure the shared webhook seam in
   * `ChannelPluginRegistry` cannot see.
   */
  readonly ingressAlarm?: import('../channels/ingress-alarm.js').ChannelIngressAlarm | undefined;
  /** Where a channel conversation's work runs when its channel has no project (surface-conversation-gate.ts). */
  readonly projectForWork?: import('./surface-conversation-gate.js').ConversationGateDeps['projectForWork'];
}

/**
 * What ingress decided about one message: the policy decision, whether the
 * message was consumed as an answer (and by what), and the intent its one
 * reading gave, which the gated spawn uses instead of asking again.
 */
export type AuthorizedIngress = ChannelPolicyDecision & SurfaceIngressDecision & {
  readonly intent?: InboundReading['intent'];
};

export class DaemonSurfaceActionHelper {
  private controlAbort = new AbortController();
  private readonly controlTargets = new WeakMap<SurfaceControlReading, () => void>();
  private ntfyRemoteSessionId: string | null = null;
  /**
   * Purchase windows waiting for the owner's answer over a channel, read on
   * the shared ingress hook below. The payments notifier's reply source.
   */
  readonly paymentReplies: PaymentReplyInbox;

  constructor(private readonly context: DaemonSurfaceActionContext) {
    this.paymentReplies = context.paymentReplies ?? new PaymentReplyInbox();
    this.paymentReplies.bindTelegramSource(context.telegramSourceAccounts, this.controlAbort.signal);
    // The owner's answer to a work proposal waiting in Waiting for you: recorded as applied only once it is acted on.
    if (context.ownerInbox && context.workProposals) {
      this.stopProposalAnswers = context.ownerInbox.handleAnswers(WORK_PROPOSAL_ITEM_KEY, (item, answer) => this.answerProposalFromInbox(item, answer));
    }
  }

  private stopProposalAnswers: (() => void) | null = null;

  /** Stop applying answers given in the owner inbox (the daemon is stopping). */
  closeProposalAnswers(): void {
    this.stopProposalAnswers?.();
    this.stopProposalAnswers = null;
  }

  /**
   * The owner accepted or dismissed, in Waiting for you, his own work proposal that none of his conversations took.
   * Saved before it is acted on; accepted work is claimed, started and recorded as the channel reply does
   * (work-proposal-reply.ts). A proposal that expired or was answered already refuses the answer with the reason.
   */
  private async answerProposalFromInbox(item: OwnerItem, answer: OwnerAnswer): Promise<void> {
    const store = this.context.workProposals;
    const id = item.metadata?.['proposalId'];
    if (!store || typeof id !== 'string') throw new Error('This item names no work proposal; nothing was started.');
    const accepted = answer.option === 'accept';
    const resolved = await store.resolve(id, accepted ? 'accepted' : 'declined');
    if (!resolved) {
      throw new Error(store.get(id)?.status === 'accepted' ? 'It was agreed already and is under way.' : 'The proposal expired before it was answered; send the request again.');
    }
    const deps = this.conversationGateDeps();
    if (!accepted) {
      await settleUnstartedWork(deps, resolved, 'The owner dismissed this work.');
      return;
    }
    // Null: a start already under way in this process (the start-up pass) took it.
    if (await store.markStarting(resolved.id) === null) return;
    let started: 'started' | 'held' | 'not-started';
    try {
      started = await startAgreedWork(deps, resolved);
    } catch (error) {
      await settleUnstartedWork(deps, resolved, 'The agreed work could not be started. Send the message again.').catch(() => undefined);
      await store.markStarted(resolved.id).catch(() => undefined);
      throw new Error(`Accepted, but the work could not be started: ${summarizeError(error)}. Send the request again.`);
    }
    // Held: the daemon is restarting into an update; the claim is given back and the work starts after the restart.
    await (started === 'held' ? store.releaseStart(resolved.id) : store.markStarted(resolved.id));
  }

  startDelegatedTelegram(): void {
    if (this.controlAbort.signal.aborted) {
      this.controlAbort = new AbortController();
      this.paymentReplies.bindTelegramSource(this.context.telegramSourceAccounts, this.controlAbort.signal);
    }
    this.context.delegatedTelegram?.startLifecycle();
  }
  closeDelegatedTelegram(): void {
    this.controlAbort.abort();
    this.context.delegatedTelegram?.close();
  }

  /**
   * The per-message ingress scope: the policy check, the control commands it
   * admits, and the gated spawn, sharing one authorization cell. Built once per
   * inbound message.
   */
  private createIngressScope() {
    // One cell per inbound message (see SurfaceIngressOrigin). authorizeSurfaceIngress
    // fills it; the gated trySpawnAgent below reads it.
    const origin: { current: SurfaceIngressOrigin | null } = { current: null };
    const lifecycle = this.controlAbort.signal;
    // The surface policy revision the message was admitted under: one integer compare says whether it moved.
    const policyRevision = (surface: ChannelIngressPolicyInput['surface']) => this.context.channelPolicy.revision(surface);
    let authorization: { text: string; surface: ChannelIngressPolicyInput['surface']; revision: number; actor: Actor } | null = null;
    const commands = new WeakMap<SurfaceControlReading, () => void>();
    // Who sent each command read from an admitted message: run control is admitted for that sender.
    const commandSenders = new WeakMap<SurfaceControlReading, Actor>();
    const authorizationCurrent = (accepted: typeof authorization) => {
      lifecycle.throwIfAborted();
      if (!accepted || accepted !== authorization || policyRevision(accepted.surface) !== accepted.revision) {
        throw new Error('Surface ingress authorization is no longer current');
      }
    };
    return {
      authorizeSurfaceIngress: async (input: ChannelIngressPolicyInput): Promise<AuthorizedIngress> => {
        authorization = null;
        origin.current = {
          surface: input.surface,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.userId !== undefined ? { userId: input.userId } : {}),
          ...(input.channelId !== undefined ? { channelId: input.channelId } : {}),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
        };
        const decision = await this.authorizeSurfaceIngress(input);
        if (decision.allowed) {
          // A sender with no identity is admitted by its surface secret, which only an
          // empty allowlist allows (the generic webhook, Home Assistant naming no user): a
          // guest, since the secret proves the surface, not the person; every chat adapter
          // passes its sender. An identified sender is the operator only as the owner.
          // A guest's turn (`turn.start` asks the owner) runs with everything beyond a plain read put to him.
          const actor = channelSenderActor(decision, input.surface, input.userId);
          const operator = admitEffects(actor, ['turn.start']).kind === 'allowed';
          authorization = { text: input.text ?? '', surface: input.surface, revision: policyRevision(input.surface), actor };
          if (decision.intent !== undefined && origin.current) origin.current = { ...origin.current, intent: decision.intent };
          // Authority belongs to the person: anyone else the channel admits starts a guest's turn.
          if (!operator && origin.current) origin.current = { ...origin.current, guest: true };
        }
        // A protected-input refusal must not stay readable from the cell the gated
        // spawn path reads.
        if (!decision.allowed && (decision.reason.startsWith(CARD_SHAPES_REFUSED_REASON)
          || decision.reason.startsWith(JUDGMENT_INPUT_REFUSED_REASON))) {
          origin.current = null;
        }
        return decision;
      },
      parseSurfaceControlCommand: async (text: string, options: CallOptions = {}): Promise<SurfaceControlReading | null> => {
        const accepted = authorization;
        const signal = options.signal ? AbortSignal.any([options.signal, lifecycle]) : lifecycle;
        const assertCurrent = () => {
          signal.throwIfAborted();
          assertSynchronousCurrent(options.beforeAttempt);
          authorizationCurrent(accepted);
          if (accepted?.text !== text) throw new Error('Surface control source is no longer authorized');
        };
        assertCurrent();
        const command = await this.parseSurfaceControlCommand(text, { ...options, signal, beforeAttempt: assertCurrent });
        if (command && accepted) commandSenders.set(command, accepted.actor);
        if (command) commands.set(command, () => {
          assertCurrent();
          const targetCurrent = this.controlTargets.get(command);
          if (!targetCurrent) throw new Error('Surface control target reading is no longer current');
          targetCurrent();
        });
        return command;
      },
      performSurfaceControlCommand: async (command: SurfaceControlCommand, controlOrigin?: SurfaceControlOrigin): Promise<string> => {
        const assertCurrent = commands.get(command);
        if (!assertCurrent) throw new Error('Surface control has no current source reading');
        commands.delete(command);
        assertCurrent();
        this.controlTargets.delete(command);
        const sender = commandSenders.get(command);
        if (!sender) throw new Error('Surface control has no admitted sender');
        return this.performRunControl(sender, command, controlOrigin);
      },
      // The shared spawn boundary: every channel surface adapter routes its
      // spawn through the conversation-first gate (surface-conversation-gate.ts).
      trySpawnAgent: (input: Parameters<AgentManager['spawn']>[0], logLabel?: string, sessionId?: string) => {
        const accepted = authorization;
        const capturedOrigin = origin.current;
        const assertCurrent = () => {
          authorizationCurrent(accepted);
          if (capturedOrigin !== origin.current) throw new Error('Conversation gate source is no longer authorized');
        };
        return gateSurfaceSpawn(this.conversationGateDeps({ signal: lifecycle, beforeAttempt: assertCurrent }), capturedOrigin, input, logLabel, sessionId);
      },
    };
  }

  buildSurfaceAdapterContext(): SurfaceAdapterContext {
    const scope = this.createIngressScope();
    return {
      delegatedTelegram: this.context.delegatedTelegram,
      ...(this.context.deliverSurfaceNotice ? { deliverSurfaceNotice: this.context.deliverSurfaceNotice } : {}),
      hasPaymentReplyWindow: () => this.paymentReplies.pending > 0,
      workRefusal: () => this.context.workAdmission?.refusalResponse() ?? null,
      serviceRegistry: this.context.serviceRegistry,
      secretsManager: this.context.secretsManager,
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      ...(this.context.ingressAlarm
        ? {
          reportIngressFailure: (surface: import('../channels/types.js').ChannelSurface, detail: string) => {
            // Reported after the request was answered: nothing sends the message again.
            this.context.ingressAlarm?.recordFailure(surface, detail, 'skipped');
          },
        }
        : {}),
      ...scope,
      performInteractiveSurfaceAction: (actionId, surface, request, userId) => this.performInteractiveSurfaceAction(actionId, surface, request, userId),
      queueSurfaceReplyFromBinding: (binding, input) => this.context.queueSurfaceReplyFromBinding(binding, input),
      postNtfyRemoteChatMessage: (input) => this.postNtfyRemoteChatMessage(input),
      postHomeAssistantChatMessage: (input) => this.postHomeAssistantChatMessage(input),
    };
  }

  buildGenericWebhookAdapterContext(): GenericWebhookAdapterContext {
    // The same scope as the chat surfaces, so `status`, `cancel` and `retry <id>`
    // work over the webhook under the same rules. Its spawn stays ungated: a
    // webhook is authorized when it is configured.
    const scope = this.createIngressScope();
    return {
      secretsManager: this.context.secretsManager,
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      authorizeSurfaceIngress: (input) => scope.authorizeSurfaceIngress(input),
      parseSurfaceControlCommand: scope.parseSurfaceControlCommand,
      performSurfaceControlCommand: scope.performSurfaceControlCommand,
      trySpawnAgent: (input, logLabel, sessionId) => this.context.trySpawnAgent(input, logLabel, sessionId),
      surfaceDeliveryEnabled: (surface) => this.context.surfaceDeliveryEnabled(surface),
      signWebhookPayload: (body, secret) => this.context.signWebhookPayload(body, secret),
      queueWebhookReply: (input) => this.context.queueWebhookReply(input),
    };
  }

  /** The slice of this helper's context the conversation gate consults. Public
   * so the shared-session continuation runner gates through the SAME deps. */
  /**
   * At start-up (and when admission reopens): work the owner agreed to that
   * never started (the daemon stopped between saving the "yes" and starting
   * it) is started now, once. Each start is claimed with a saved write first
   * and recorded as started after, so a restart never starts it twice. A start
   * a previous process had claimed when it stopped is not run again (its agent
   * died with it): the owner is told to send it again. One pass runs at a time;
   * a second caller shares the running one.
   */
  resumeAgreedWork(): Promise<number> {
    this.resumingAgreedWork ??= this.resumeAgreedWorkOnce().finally(() => { this.resumingAgreedWork = null; });
    return this.resumingAgreedWork;
  }

  private resumingAgreedWork: Promise<number> | null = null;

  private async resumeAgreedWorkOnce(): Promise<number> {
    const store = this.context.workProposals;
    if (!store) return 0;
    for (const interrupted of store.listInterruptedStarts()) {
      try {
        const deps = this.conversationGateDeps();
        const binding = interrupted.routeId ? deps.routeBindings.getBinding(interrupted.routeId) : undefined;
        await deliverProposalNotice(deps, binding, `The agreed work was interrupted by a restart: ${interrupted.summary}. Send the message again.`);
        await settleUnstartedWork(deps, interrupted, 'The agreed work was interrupted by a restart. Send the message again.');
        await store.markStarted(interrupted.id);
      } catch (settleError) {
        logger.error('Agreed work interrupted by a restart could not be settled', { proposalId: interrupted.id, error: summarizeError(settleError) });
      }
    }
    let resumed = 0;
    for (const proposal of store.listAcceptedUnstarted()) {
      let outcome: 'started' | 'held' | 'not-started';
      try {
        // Another start in this process (a channel reply) took it.
        if (await store.markStarting(proposal.id) === null) continue;
        outcome = await startAgreedWork(this.conversationGateDeps(), proposal, proposal.agreedNote);
      } catch (error) {
        logger.error('Agreed work saved before a restart could not be started', { proposalId: proposal.id, error: summarizeError(error) });
        // Settled, never silently dropped: the owner is told and its held input
        // is closed, then the record is no longer owed work.
        try {
          const deps = this.conversationGateDeps();
          const binding = proposal.routeId ? deps.routeBindings.getBinding(proposal.routeId) : undefined;
          await deliverProposalNotice(deps, binding, `Could not start: ${proposal.summary}. Send the message again.`);
          await settleUnstartedWork(deps, proposal, 'The agreed work could not be started. Send the message again.');
          await store.markStarted(proposal.id);
        } catch (settleError) {
          logger.error('Agreed work that could not be started could not be settled', { proposalId: proposal.id, error: summarizeError(settleError) });
        }
        continue;
      }
      try {
        // Held again (admission closed meanwhile): the claim is given back for the next start.
        if (outcome === 'held') { await store.releaseStart(proposal.id); continue; }
        await store.markStarted(proposal.id);
        if (outcome === 'started') resumed += 1;
      } catch (markError) {
        // The claim stays saved: a restart settles it as interrupted rather than running it twice.
        logger.error('Agreed work start could not be recorded', { proposalId: proposal.id, error: summarizeError(markError) });
      }
    }
    return resumed;
  }

  conversationGateDeps(readingOptions: CallOptions = {}) {
    const signal = readingOptions.signal ? AbortSignal.any([readingOptions.signal, this.controlAbort.signal]) : this.controlAbort.signal;
    return {
      configManager: this.context.configManager,
      routeBindings: this.context.routeBindings,
      sessionBroker: this.context.sessionBroker,
      trySpawnAgent: this.context.trySpawnAgent,
      queueSurfaceReplyFromBinding: this.context.queueSurfaceReplyFromBinding,
      workProposals: this.context.workProposals,
      readingOptions: { ...readingOptions, signal },
      // The policy revision a gated message was admitted under: one integer compare where the reading is acted on.
      captureReadingSource: (origin: SurfaceIngressOrigin | null) => {
        const surface = origin?.surface as ChannelIngressPolicyInput['surface'] | undefined;
        const revision = surface ? this.context.channelPolicy.revision(surface) : 0;
        return () => {
          signal.throwIfAborted();
          if (surface && this.context.channelPolicy.revision(surface) !== revision) {
            throw new Error('Conversation source policy changed');
          }
        };
      },
      deliverSurfaceNotice: this.context.deliverSurfaceNotice,
      workAdmitted: () => this.context.workAdmission?.open !== false,
      ownerConversations: (surface: string) => this.ownerConversations(surface),
      ownerInbox: this.context.ownerInbox,
      senderIsGuest: (surface: string, userId: string | undefined) => this.senderIsGuest(surface, userId),
      projectForWork: this.context.projectForWork,
    };
  }

  /**
   * Whether a sender on a channel is someone it admits who is not its owner,
   * the same rule ingress applies (`channelSenderActor`): a sender with no id
   * (the generic webhook, Home Assistant naming no user) is a guest, never the
   * owner; a chat adapter always passes its sender.
   */
  senderIsGuest(surface: string, userId: string | undefined): boolean {
    if (!isChannelSurfaceKind(surface)) return false;
    return channelSenderActor({ policy: this.context.channelPolicy.getPolicy(surface) }, surface, userId).class === 'guest';
  }

  /** The owner's own conversations, those on `surface` first, newest first (owner-alert.ts). */
  ownerConversations(surface: string): OwnerConversation[] {
    let bindings: readonly AutomationRouteBinding[];
    try { bindings = this.context.routeBindings.listBindings(); }
    catch { return []; }
    const owners = new Map<string, string | undefined>();
    const ownerOf = (kind: string): string | undefined => {
      if (!owners.has(kind)) owners.set(kind, isChannelSurfaceKind(kind) ? this.context.channelPolicy.getPolicy(kind).ownerId : undefined);
      return owners.get(kind);
    };
    const preferred = isChannelSurfaceKind(surface) ? surface : null;
    return orderOwnerAlertRoutes(bindings.filter((binding) => isOwnerConversation(binding, ownerOf(binding.surfaceKind))), preferred)
      .map((binding) => ({ binding, ...(ownerOf(binding.surfaceKind) ? { ownerId: ownerOf(binding.surfaceKind) } : {}) }));
  }

  /**
   * The shared ingress hook every surface adapter calls. Code decides first
   * (source admission, a card number by its checksum, protected input), then
   * one inbound reading answers every question that applies to the message
   * (inbound-reading.ts), and the answers are acted on in order: card details
   * refused, a work proposal, a purchase window or a permission ask answered.
   * A message that answered something is reported `consumed`; anything else
   * goes on to the conversation carrying the intent its reading gave.
   */
  async authorizeSurfaceIngress(input: ChannelIngressPolicyInput): Promise<AuthorizedIngress> {
    // Source admission must precede every semantic reader.
    // This shares the policy owner's rules but cannot seed, audit or retain text.
    const checked = await this.context.channelPolicy.evaluateIngress(input, { admit: false });
    if (!checked.allowed) {
      const denial = await this.context.channelPolicy.recordDeniedIngress(input, checked);
      if (!denial.allowed) return denial;
    }
    // A card number or protected credential input is refused before anything
    // below can store, log or transcribe the message (docs/decisions/2026-07-27-inbound-email-design.md §11.0).
    // Approvals and vetoes themselves keep working over remote channels: a
    // remote surface has authority to say yes or no about a purchase, and no
    // path for entering the instrument.
    const cardDeps = { ...this.conversationGateDeps(), channelPolicy: this.context.channelPolicy };
    const cardRefusal = await refuseCardShapedIngress(cardDeps, input);
    if (cardRefusal) return cardRefusal;
    // The audit record this writes masks every digit, so it holds no card value whatever the reading says.
    // The decision made above is reused while the surface's policy revision has not moved.
    const decision = await this.context.channelPolicy.evaluateIngress(input, { recordDenied: false, decided: checked });
    if (!decision.allowed) { await this.context.channelPolicy.recordDeniedIngress(input, decision); return decision; }
    const lifecycle = this.controlAbort.signal;
    const admittedUnder = this.context.channelPolicy.revision(input.surface);
    // The policy that admitted the message is compared once, where an answer is about to be acted on.
    const assertReplyCurrent = () => {
      lifecycle.throwIfAborted();
      if (this.context.channelPolicy.revision(input.surface) !== admittedUnder) {
        throw new Error('The original reply owner policy is no longer current');
      }
    };
    // The conversation the owner wrote from: a route already bound for it, or one made from the message itself.
    const replyToOwner = async (text: string): Promise<unknown> => deliverProposalNotice(
      this.context, ownerReplyBinding(this.context.routeBindings.listBindings(), input), text);
    const paymentConsumed = (offer: PaymentReplyOffer): AuthorizedIngress | undefined => {
      if (offer.consumed) return { ...decision, allowed: false, reason: `payment-reply-${offer.answer}`, consumed: { by: 'payment', answer: offer.answer } };
      if (offer.reason === 'recorded') return { ...decision, allowed: false, reason: 'payment-reply-recorded', consumed: { by: 'payment', answer: 'recorded' } };
      return undefined;
    };
    // Code decides which questions apply; one request asks them all.
    const text = input.text ?? '';
    const interactive = input.metadata?.['interactive'] === true;
    const proposal = interactive ? undefined : proposalReplyTarget(input, this.context.workProposals);
    const approvalDeps = { approvalBroker: this.context.approvalBroker, routeBindings: this.context.routeBindings, sessions: this.context.sessionBroker };
    const asks = interactive ? [] : approvalReplyCandidates(input, decision, approvalDeps);
    const ask = asks.length === 1 ? asks[0] : undefined;
    const gated = this.context.workProposals !== undefined && !interactive
      && isGatedSurface(readConversationGateConfig(this.context.configManager), input.surface);
    const reading = text.trim().length === 0 || interactive
      ? undefined
      : await readInboundMessage({
        message: text,
        intent: gated,
        ...(proposal ? { proposal: { task: proposal.task, summary: proposal.summary } } : {}),
        ...(ask ? { approval: approvalProposal(ask) } : {}),
      }, { signal: lifecycle });

    // Card details are refused before any handler keeps the text: the payment
    // reply inbox records a reply in its history.
    const cardTalk = reading ? await refuseCardTalk(cardDeps, input, reading) : null;
    if (cardTalk) return cardTalk;

    let addressedPayment: PaymentReplyOffer | undefined;
    if (typeof input.metadata?.['replyToMessageId'] === 'string') {
      // An explicit provider reply names its notice before another pending
      // dialogue can interpret the same short answer against different text.
      addressedPayment = await tryResolvePaymentReplyFromChannel(input, decision, this.paymentReplies, this.context.telegramSourceAccounts,
        { assertCurrent: assertReplyCurrent, signal: lifecycle, replyToOwner });
      const consumed = paymentConsumed(addressedPayment);
      if (consumed) return consumed;
    }

    // An answer to a pending work proposal is consumed here, on the shared
    // ingress hook every surface adapter already calls, which is what makes
    // agreement answerable over whatever channel the proposal went out on.
    if (proposal) {
      const proposalReply = await tryResolveWorkProposalReplyFromChannel(input, {
        readingOptions: { signal: lifecycle, beforeAttempt: assertReplyCurrent },
        proposals: this.context.workProposals,
        // A reading no decision model made is replaced by the reply read literally (a plain yes or no).
        reading: { target: proposal, answer: reading?.source === 'fallback' && reading.proposal === 'unsure' ? proposalAnswerLiterally(text) : reading?.proposal },
        captureProposalSource: (target) => {
          const route = target.routeId ? this.context.routeBindings.getBinding(target.routeId) : undefined;
          return () => {
            const current = target.routeId ? this.context.routeBindings.getBinding(target.routeId) : undefined;
            if (current !== route || (target.routeId && (!current || current.surfaceKind !== target.surfaceKind
              || (current.channelId ?? current.externalId) !== target.channelId || current.threadId !== target.threadId))) {
              throw new Error('Work proposal route is no longer current');
            }
          };
        },
        startAgreedWork: (agreed, note) => startAgreedWork(this.conversationGateDeps(), agreed, note),
        settleUnstartedWork: (unstarted, reason) => settleUnstartedWork(this.conversationGateDeps(), unstarted, reason),
        replyOnChannel: async (target, notice) => {
          const binding = target.routeId ? this.context.routeBindings.getBinding(target.routeId) : undefined;
          await deliverProposalNotice(this.context, binding, notice);
          // A guest's proposal was answered by the owner in his own conversation: he hears the outcome there too.
          const answering = target.answerFrom?.routeId ? this.context.routeBindings.getBinding(target.answerFrom.routeId) : undefined;
          if (answering && answering !== binding) await deliverProposalNotice(this.context, answering, notice);
        },
      });
      // The answer has already been acted on: the adapter neither creates a session nor sends a chat turn.
      if (proposalReply.consumed) {
        return { ...decision, allowed: false, reason: `work-proposal-${proposalReply.action}`, consumed: { by: 'work-proposal', answer: proposalReply.action } };
      }
    }
    // An answer to a purchase approval or veto notice, read against the notice
    // it follows (the purchase window's own reading, only while one is open).
    if (!addressedPayment) {
      const consumed = paymentConsumed(await tryResolvePaymentReplyFromChannel(input, decision, this.paymentReplies, this.context.telegramSourceAccounts,
        { assertCurrent: assertReplyCurrent, signal: lifecycle, replyToOwner }));
      if (consumed) return consumed;
    }
    if (asks.length > 0) {
      assertReplyCurrent();
      const answered = await tryResolveApprovalReplyFromChannel(input, decision, {
        ...approvalDeps,
        ...(ask ? { reading: { approvalId: ask.id, answer: reading?.approval } } : {}),
      });
      // The approval machinery publishes its own resolution events; the message is not a chat turn.
      if (answered) return { ...decision, allowed: false, reason: 'approval-reply-consumed', consumed: { by: 'approval', answer: 'answered' } };
    }
    return { ...decision, ...(reading?.intent !== undefined ? { intent: reading.intent } : {}) };
  }

  async parseSurfaceControlCommand(text: string, options: CallOptions = {}): Promise<SurfaceControlReading | null> {
    options.signal?.throwIfAborted();
    assertSynchronousCurrent(options.beforeAttempt);
    assertJudgmentInput(text);
    // Lexical ID candidates only. No keyword or token position decides intent.
    // Store equality proves existence; no hidden task/session contents are sent.
    const targets: SurfaceControlTarget[] = [];
    const records = new Map<string, object>();
    const currentTarget = (id: string) => {
      const run = this.context.automationManager.getRun(id);
      if (run) return { kind: 'run' as const, record: run };
      const agent = this.context.agentManager.getStatus(id);
      if (agent) return { kind: 'agent' as const, record: agent };
      const session = this.context.sessionBroker.getSession(id);
      return session ? { kind: 'session' as const, record: session } : undefined;
    };
    for (const id of new Set(text.match(/[a-z0-9:_-]+/gi) ?? [])) {
      const target = currentTarget(id);
      if (target) { targets.push({ id, kind: target.kind }); records.set(id, target.record); }
    }
    if (targets.length === 0) return null;
    const assertCurrent = () => {
      options.signal?.throwIfAborted();
      assertSynchronousCurrent(options.beforeAttempt);
      for (const target of targets) {
        const current = currentTarget(target.id);
        if (!current || current.kind !== target.kind || current.record !== records.get(target.id)) throw new Error('Surface control target is no longer available');
      }
    };
    const command = await decisionOrClassic<SurfaceControlReading | null>(async () => {
      const reading = await surfaceControl.read(daemonReadingPort('daemon.surface-control', assertCurrent, options.signal), text, targets, { ...options, beforeAttempt: assertCurrent });
      return reading.command;
    }, () => {
      assertCurrent();
      const literal = /^\/(status|cancel|retry)\s+([a-z0-9:_-]+)$/iu.exec(text.trim());
      const action = literal?.[1]?.toLowerCase(), id = literal?.[2];
      return id && targets.some(target => target.id === id) && (action === 'status' || action === 'cancel' || action === 'retry')
        ? Object.freeze({ action, id }) : null;
    });
    if (command) this.controlTargets.set(command, assertCurrent);
    return command;
  }

  /** Whether a run, agent or session was started from the conversation (route binding) a control command arrived on. */
  private controlTargetBelongsToRoute(id: string, routeId: string): boolean {
    const run = this.context.automationManager.getRun(id);
    if (run) return run.routeId === routeId || run.route?.id === routeId;
    const { sessionBroker } = this.context;
    for (const session of sessionBroker.listSessions(500)) {
      if (!session.routeIds.includes(routeId)) continue;
      if (session.id === id || session.activeAgentId === id || session.lastAgentId === id) return true;
      if (sessionBroker.getInputs(session.id, 500).some(input => input.routeId === routeId && input.activeAgentId === id)) return true;
    }
    return false;
  }

  /**
   * The one way a chat sender controls a run, an agent or a session, for a
   * typed command and a button alike: the effect (`run.cancel`, `run.retry`,
   * or reading its status) is admitted for the sender (a channel's owner may;
   * a guest may not), and a control that names its conversation acts only on
   * what that conversation started. The reply is the same for a target that
   * exists elsewhere and one that does not.
   */
  async performRunControl(
    sender: Actor,
    command: { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string },
    origin?: { readonly routeId: string } | undefined,
    cancelReason = 'surface-cancelled',
  ): Promise<string> {
    const effect: EffectId = command.action === 'cancel' ? 'run.cancel' : command.action === 'retry' ? 'run.retry' : 'automation.read';
    if (admitEffects(sender, [effect]).kind !== 'allowed') {
      return `Not done: ${command.action} ${command.id} was refused. Status, cancel and retry act on the owner's runs and agents, so only the owner of this channel may send them. Ask the owner, or have them change the channel's owner.`;
    }
    if (origin && !this.controlTargetBelongsToRoute(command.id, origin.routeId)) {
      return `Not done: ${command.action} ${command.id} was refused. This conversation did not start ${command.id}, so it cannot act on it. Send the command from the conversation that did.`;
    }
    return this.performSurfaceControlCommand(command, cancelReason);
  }

  async performSurfaceControlCommand(
    command: { readonly action: 'status' | 'cancel' | 'retry'; readonly id: string },
    cancelReason = 'surface-cancelled',
  ): Promise<string> {
    if (command.action === 'status') {
      const run = this.context.automationManager.getRun(command.id);
      if (run) {
        return `Run ${run.id}: ${run.status}${run.agentId ? ` agent=${run.agentId}` : ''}`;
      }
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        return `Agent ${agent.id}: ${agent.status}${agent.progress ? ` (${agent.progress})` : ''}`;
      }
      const session = this.context.sessionBroker.getSession(command.id);
      if (session) {
        return `Session ${session.id}: ${session.status} messages=${session.messageCount}${session.activeAgentId ? ` activeAgent=${session.activeAgentId}` : ''}`;
      }
      return `Unknown run, agent, or session: ${command.id}`;
    }

    if (command.action === 'cancel') {
      const run = await this.context.automationManager.cancelRun(command.id, cancelReason);
      if (run) {
        return `Cancelled run ${run.id}`;
      }
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        this.context.agentManager.cancel(command.id);
        return `Cancelled agent ${command.id}`;
      }
      return `Unknown run or agent: ${command.id}`;
    }

    try {
      const run = await this.context.automationManager.retryRun(command.id);
      return `Retried run ${run.id}`;
    } catch {
      const agent = this.context.agentManager.getStatus(command.id);
      if (agent) {
        // The same work on the same model, tools and routing, in the session that started it.
        const retried = this.context.trySpawnAgent(toAgentSpawnInput(agentRetrySpawnInput(agent)),
          'DaemonSurfaceActionHelper.performSurfaceControlCommand', agent.sessionId);
        if (!(retried instanceof Response)) {
          return `Retried agent ${command.id} as ${retried.id}`;
        }
      }
      return `Unable to retry ${command.id}`;
    }
  }

  async performInteractiveSurfaceAction(
    actionId: string,
    surface: 'slack' | 'discord',
    req: Request,
    userId?: string | undefined,
  ): Promise<string> {
    const approvalMatch = actionId.match(/^gv:approval:(approve|deny|claim):(.+)$/);
    if (approvalMatch) {
      const [, action, approvalId] = approvalMatch;
      const result = await this.context.handleApprovalAction(
        approvalId!,
        action as 'approve' | 'deny' | 'claim',
        new Request(req.url, {
          method: 'POST',
          headers: req.headers,
        }),
        // The approval's audit names who pressed the button, not the daemon token the callback rode in on.
        // A press whose sender could not be read is still a chat press: the owner check refuses it.
        { surface, userId: userId?.trim() ?? '' },
      );
      const body = await result.json().catch(() => ({} as Record<string, unknown>));
      return result.ok
        ? `Approval ${action}d: ${approvalId}`
        : String((body as Record<string, unknown>).error ?? `Failed to ${action} approval ${approvalId}`);
    }
    const runMatch = actionId.match(/^gv:run:(cancel|retry):(.+)$/);
    if (runMatch) {
      const [, action, runId] = runMatch;
      // A run button is the same control as the typed command, admitted the same way:
      // a press whose sender could not be read is refused, and a guest is refused.
      if (!userId?.trim()) return `Not done: ${action} ${runId} was refused. Only the owner of this channel may cancel or retry a run.`;
      const sender = channelSenderActor({ policy: this.context.channelPolicy.getPolicy(surface) }, surface, userId.trim());
      return this.performRunControl(sender, { action: action as 'cancel' | 'retry', id: runId! }, undefined, 'interactive-surface-cancel');
    }
    return `No handler for ${surface} action ${actionId}`;
  }

  private async postNtfyRemoteChatMessage(input: {
    readonly topic: string;
    readonly body: string;
    readonly title?: string | undefined;
    readonly messageId?: string | undefined;
  }): Promise<{ readonly sessionId: string; readonly messageId: string; readonly delivered: boolean; readonly error?: string }> {
    // A self-update's restart holds admission: the message is kept (a held broker input) and answered after it.
    if (this.context.workAdmission?.open === false) {
      const held = await holdCompanionTurn(this.context, { kind: 'ntfy-remote', input });
      if (held) return { sessionId: held.sessionId, messageId: '', delivered: true };
    }
    // What the reply announces: the answer to this inbound message. Two
    // messages answered with the same words are two notifications.
    const replyIdentity = `ntfy:${input.messageId ?? randomUUID()}`;
    const manager = this.context.companionChatManager;
    if (!manager) {
      return {
        sessionId: '',
        messageId: '',
        delivered: false,
        error: 'ntfy remote chat manager is unavailable',
      };
    }

    let sessionId = this.ntfyRemoteSessionId ?? '';
    try {
      await manager.init();
      let session = sessionId ? manager.getSession(sessionId) : null;
      const defaultProviderModel = this.context.resolveDefaultProviderModel?.() ?? null;
      if (!session || session.status === 'closed') {
        session = manager.createSession({
          title: input.title ?? 'GoodVibes ntfy',
          ...(defaultProviderModel
            ? {
                provider: defaultProviderModel.provider,
                model: defaultProviderModel.model,
              }
            : {}),
        });
        this.ntfyRemoteSessionId = session.id;
      } else if (defaultProviderModel) {
        session = manager.updateSession(session.id, {
          provider: defaultProviderModel.provider,
          model: defaultProviderModel.model,
        });
      }
      sessionId = session.id;
      void this.runNtfyRemoteChatTurn(manager, sessionId, input, replyIdentity).catch((error: unknown) => {
        logger.warn('DaemonSurfaceActionHelper: ntfy remote chat turn failed', {
          sessionId,
          topic: input.topic,
          error: summarizeError(error),
        });
      });
      return {
        sessionId,
        messageId: '',
        delivered: true,
      };
    } catch (error) {
      const errorMessage = summarizeError(error);
      try {
        await this.publishNtfyReply(input.topic, `Error: ${errorMessage}`, input.title ?? 'GoodVibes ntfy', `${replyIdentity}:error`);
      } catch (publishError) {
        logger.warn('DaemonSurfaceActionHelper: failed to publish ntfy remote chat error', {
          topic: input.topic,
          error: summarizeError(publishError),
        });
      }
      return {
        sessionId,
        messageId: '',
        delivered: false,
        error: errorMessage,
      };
    }
  }

  private async runNtfyRemoteChatTurn(
    manager: CompanionChatManager,
    sessionId: string,
    input: {
      readonly topic: string;
      readonly body: string;
      readonly title?: string | undefined;
    },
    replyIdentity: string,
  ): Promise<void> {
    try {
      // No `ownerDirect`: an ntfy topic is a channel, so the untrusted-content window stays open (security/turn-boundary.ts).
      const result = await manager.postMessageAndWaitForReply(
        sessionId,
        input.body,
        `ntfy:${input.topic}`,
        { timeoutMs: 120_000 },
      );
      const response = result.response?.trim();
      const resultError = result.error ?? (response ? undefined : 'No response from ntfy remote chat');
      const outbound = response || `Error: ${resultError}`;
      await this.publishNtfyReply(input.topic, outbound, input.title ?? 'GoodVibes ntfy', `${replyIdentity}:reply`);
    } catch (error) {
      const errorMessage = summarizeError(error);
      try {
        await this.publishNtfyReply(input.topic, `Error: ${errorMessage}`, input.title ?? 'GoodVibes ntfy', `${replyIdentity}:error`);
      } catch (publishError) {
        logger.warn('DaemonSurfaceActionHelper: failed to publish ntfy remote chat error', {
          topic: input.topic,
          error: summarizeError(publishError),
        });
      }
    }
  }

  /**
   * Run an inbound Home Assistant message as a chat turn and publish the reply.
   * The work lives in surface-homeassistant-reply.ts; this stays so the adapter
   * context keeps the same shape.
   */
  private async postHomeAssistantChatMessage(
    input: HomeAssistantSurfaceChatInput,
  ): Promise<HomeAssistantSurfaceChatResult> {
    // A self-update's restart holds admission: the message is kept (a held broker input) and its reply is
    // published to Home Assistant as an event after the restart.
    if (this.context.workAdmission?.open === false) {
      const held = await holdCompanionTurn(this.context, { kind: 'homeassistant', input });
      if (held) return { sessionId: held.sessionId, routeId: held.routeId, messageId: input.messageId, delivered: true };
    }
    return postHomeAssistantSurfaceChatMessage(this.context, input);
  }

  /**
   * Run a companion chat turn held through a restart (held-companion-turn.ts),
   * called by the broker's continuation runner for its input. `held` while
   * admission is still closed; otherwise the turn is started (its reply goes
   * out as it always does) and the input is consumed.
   */
  async runHeldCompanionTurn(turn: HeldCompanionTurn): Promise<'started' | 'held'> {
    if (this.context.workAdmission?.open === false) return 'held';
    if (turn.kind === 'ntfy-remote') {
      await this.postNtfyRemoteChatMessage(turn.input);
      return 'started';
    }
    // The Home Assistant caller is gone: the reply reaches it only as the published event, so the wait is not awaited.
    void this.postHomeAssistantChatMessage(turn.input).catch((error: unknown) => {
      logger.warn('A Home Assistant message held for a restart could not be answered', { error: summarizeError(error) });
    });
    return 'started';
  }

  /** `announces` names what the reply answers, so ntfy suppresses only a repeat of the same reply. */
  private async publishNtfyReply(topic: string, message: string, title: string, announces: string): Promise<void> {
    if (!topic || !message.trim()) return;
    const ntfy = new NtfyIntegration(
      ntfyBaseUrl(this.context.configManager),
      await this.resolveNtfyToken() ?? undefined,
    );
    const priority = resolveNtfyDefaultPriority(this.context.configManager.get('surfaces.ntfy.defaultPriority'));
    await ntfy.publish(topic, message, {
      title,
      ...(priority === undefined ? {} : { priority }),
      announces,
      markGoodVibesOrigin: true,
    });
  }

  private async resolveNtfyToken(): Promise<string | null> {
    return await this.context.serviceRegistry.resolveSecret('ntfy', 'primary')
      || await resolveSecretInput(this.context.configManager.get('surfaces.ntfy.token'), {
        resolveLocalSecret: (key) => this.context.secretsManager.get(key),
        homeDirectory: this.context.secretsManager.getGlobalHome?.() ?? undefined,
        providers: readSecretProviderHostConfig(this.context.configManager),
      }, 'dispatch')
      || process.env.NTFY_ACCESS_TOKEN
      || null;
  }
}
