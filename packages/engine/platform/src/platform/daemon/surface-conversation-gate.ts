import { isClassicOperation, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assertSynchronousCurrent } from './reading-lifetime.js';
import { snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { CallOptions } from '@goodvibes/judgment/decisions';
import { readInboundMessage, type InboundReading } from './inbound-reading.js';
import { withGuestTurn } from '../security/turn-boundary.js';
/**
 * The conversation-first spawn gate, at the shared surface spawn boundary.
 *
 * Every channel surface adapter converges on ONE construction site for its
 * adapter context (DaemonSurfaceActionHelper.buildSurfaceAdapterContext), and
 * this module is what that site installs in place of a bare spawn. Putting the
 * rule here rather than in an adapter is deliberate: a gate added to ntfy
 * alone would leave Telegram, Slack, and Home Assistant behaving exactly as
 * they did before.
 *
 * The rule: an inbound message gets a conversational reply. If it reads as a
 * work request, the gate PROPOSES a workstream over the channel it arrived on
 * and starts nothing. Agreement (daemon/work-proposal-reply.ts) is what starts
 * the work.
 *
 * Not gated:
 * - goodvibes-tui and other local surfaces, the operator typed it while
 *   sitting in front of the terminal. They never build a surface adapter
 *   context, so they never reach this module.
 * - Pre-authorized work, schedules, triggers, on-exit chains, an agreed
 *   proposal, and the explicit `retry <id>` control command. Those go through
 *   the raw trySpawnAgent, never this wrapper.
 * - Generic webhooks, machine automation, authorized at registration.
 */
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/index.js';
import type { SharedSessionBroker } from '../control-plane/index.js';
import type { AgentManager, AgentRecord } from '../tools/agent/index.js';
import {
  isGatedSurface,
  readConversationGateConfig,
  renderGuestProposalAskedMessage,
  renderGuestWorkProposalMessage,
  renderWorkProposalMessage,
  summarizeWorkRequest,
  type ConversationGateConfigReader,
} from '../agents/conversation-gate.js';
import type { WorkProposalAnswerFrom, WorkProposalRecord, WorkProposalStore } from '../agents/work-proposal-store.js';
import type { SurfaceNoticeDelivery } from './types.js';
import type { OwnerInbox } from '../control-plane/owner-inbox.js';
import {
  conversationalTurnCapabilities,
  conversationalTurnConfigReaderFrom,
  conversationalTurnSpawnOptions,
} from '../personal-capture/spawn-contract.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { isAdmissionRefusal } from './work-admission.js';

/**
 * The identity of the inbound message currently being handled.
 *
 * The adapter context is built once per inbound message, so a cell holding
 * this is scoped to exactly that message. Every adapter runs its ingress
 * policy check before it spawns anything, which is what makes that check the
 * one place the originating channel is still known, by the time the spawn
 * call happens the adapter has thrown the identity away.
 */
export interface SurfaceIngressOrigin {
  readonly surface: string;
  readonly text?: string | undefined;
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly threadId?: string | undefined;
  /** The intent the message's one inbound reading gave, when ingress already asked it. */
  readonly intent?: InboundReading['intent'];
  /**
   * The sender is admitted by the channel but is not its owner (`isChannelOwner`).
   * Their turn runs as a guest's (security/turn-boundary.ts, withGuestTurn): it
   * may read and answer, every change is put to the owner, and work they ask
   * for is proposed to the owner, never to them.
   */
  readonly guest?: true | undefined;
}

/** One of the owner's own conversations, with the id he writes from there. */
export interface OwnerConversation {
  readonly binding: AutomationRouteBinding;
  /** The channel owner's user id on that surface; absent where the surface has no sender ids (ntfy). */
  readonly ownerId?: string | undefined;
}

export type SpawnInput = Parameters<AgentManager['spawn']>[0];

export interface ConversationGateDeps {
  readonly readingOptions?: CallOptions | undefined;
  readonly captureReadingSource?: ((origin: SurfaceIngressOrigin | null) => () => void) | undefined;
  readonly configManager: ConversationGateConfigReader;
  readonly routeBindings: Pick<RouteBindingManager, 'getBinding' | 'resolve'>;
  readonly sessionBroker: Pick<SharedSessionBroker, 'getSession' | 'bindAgent'>
    & Partial<Pick<SharedSessionBroker, 'getInputs' | 'failInput' | 'beginSpawn' | 'holdForCapacity'>>;
  readonly trySpawnAgent: (input: SpawnInput, logLabel?: string, sessionId?: string) => AgentRecord | Response;
  readonly queueSurfaceReplyFromBinding: (
    binding: AutomationRouteBinding | undefined,
    input: {
      readonly agentId: string;
      readonly task: string;
      readonly agentTask?: string | undefined;
      readonly contractId?: string | undefined;
      readonly sessionId?: string | undefined;
    },
  ) => void;
  readonly workProposals?: WorkProposalStore | undefined;
  readonly deliverSurfaceNotice?:
    | ((binding: AutomationRouteBinding | undefined, text: string) => Promise<SurfaceNoticeDelivery>)
    | undefined;
  /**
   * The owner's own conversations (owner-alert.ts, isOwnerConversation), the
   * ones on `surface` first, newest first. A guest's work proposal is put to
   * the first that accepts it. Absent: a guest's work is not proposed anywhere
   * and their message is answered as conversation.
   */
  readonly ownerConversations?: ((surface: string) => readonly OwnerConversation[]) | undefined;
  /**
   * The owner inbox (Waiting for you). The owner's own request made in a conversation not his alone, when none of
   * his own conversations takes its proposal, is put here as an item he accepts or dismisses (the answer is applied
   * by the surface-action helper's WORK_PROPOSAL_ITEM_KEY effect). Absent: such a proposal is not acted on.
   */
  readonly ownerInbox?: Pick<OwnerInbox, 'postNow'> | undefined;
  /**
   * Whether the daemon takes new work now (work-admission.ts). False during a
   * self-update's hold: the message is kept, queued, and read and started after
   * the restart, so nothing (not even a proposal) answers it before then.
   */
  readonly workAdmitted?: (() => boolean) | undefined;
}

/**
 * Gate one surface spawn.
 *
 * A proposal is returned as a `Response`, which every adapter already
 * early-returns on, so no adapter needs gate-specific code and a new adapter
 * cannot forget to participate.
 */
export async function gateSurfaceSpawn(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin | null,
  input: SpawnInput,
  logLabel?: string,
  sessionId?: string,
): Promise<AgentRecord | Response> {
  // The broker is told a spawn is under way, so a second message for this session is queued behind it
  // instead of starting a second agent; `bindAgent` ends the claim, and an answered gate ends it here.
  const release = sessionId ? deps.sessionBroker.beginSpawn?.(sessionId) : undefined;
  let result: AgentRecord | Response;
  try {
    result = await withConfiguredDecisionModelPolicy(() => gateOwnedSurfaceSpawn(deps, origin, input, logLabel, sessionId));
  } catch (error) {
    release?.();
    throw error;
  }
  if (result instanceof Response) release?.();
  return result;
}

async function gateOwnedSurfaceSpawn(
  deps: ConversationGateDeps, origin: SurfaceIngressOrigin | null, input: SpawnInput, logLabel?: string, sessionId?: string,
): Promise<AgentRecord | Response> {
  // Held for the restart before anything reads or answers it; it is read and started once, after the restart.
  if (deps.workAdmitted?.() === false) {
    const held = await holdForRestart(deps, origin, sessionId);
    if (held) return held;
  }
  const classic = isClassicOperation();
  const store = deps.workProposals;
  const spawn = (spawnInput: SpawnInput) => spawnOrSettle(deps, origin, spawnInput, logLabel, sessionId);
  if (!store && !classic) return spawn(input);

  const config = readConversationGateConfig(deps.configManager);
  if (!isGatedSurface(config, origin?.surface) && !classic) {
    return spawn(input);
  }

  // Classify the message the OWNER sent, not the enriched prompt the broker
  // built from it, the enrichment adds framing that would read as work.
  const options = deps.readingOptions ?? {};
  const sourceCurrent = deps.captureReadingSource?.(origin);
  options.signal?.throwIfAborted();
  const spawnConversational = () => spawn({ ...input, ...conversationalFirstTurnOptions(deps, origin, input.tools, sessionId),
    outsideContract: true, replyStyle: 'conversational' as const });
  // No semantic statement about the message: the same native first-turn channel
  // capabilities as conversation, with no autonomous contract launch.
  if (classic) return spawnConversational();
  const inboundText = origin?.text ?? input.task ?? '';
  // Screen the actual task before it can be retained in a pending proposal.
  snapshotJudgmentInput(input.task);
  // Ingress asks the intent in the message's one reading; a spawn that did not
  // come through ingress (a continuation) asks it here, alone.
  const intent = origin?.intent
    ?? (await readInboundMessage({ message: inboundText, intent: true }, { signal: options.signal })).intent;
  // The policy that admitted the message is compared once, at the point the reading is acted on.
  options.signal?.throwIfAborted();
  assertSynchronousCurrent(options.beforeAttempt);
  assertSynchronousCurrent(sourceCurrent);
  // Only a confident work reading proposes work. An unsure or missing reading
  // gets a conversational reply, which starts nothing and can ask what was meant.
  const needsAgreement = config.mode === 'confirm-all' || intent === 'work';
  logger.debug('Conversation gate read the message', { surface: origin?.surface ?? 'unknown', intent: intent ?? 'unsure',
    action: needsAgreement ? 'propose-work' : intent === 'conversation' ? 'conversational-response' : 'conversation: intent unsettled' });

  if (!needsAgreement) {
    // Conversation still gets a real reply, it just must not become a
    // contract. Keeping the spawn outside every contract is the difference
    // between answering "Testing" and planning and checking work against it.
    //
    // `replyStyle` carries the SAME decision through to the system prompt, so
    // "Hey, are you there?" is not answered with a completion report. What the
    // message IS and what the reply should LOOK like are one decision, made
    // here, once.
    return spawnConversational();
  }

  if (!store) throw new Error('Conversation gate proposal store is unavailable');
  // A guest's work is the owner's to agree to: with no conversation of his to
  // put it to, the guest's message is answered as conversation instead.
  if (origin?.guest === true && !deps.ownerConversations) return spawnConversational();
  const summary = summarizeWorkRequest(inboundText);
  const binding = resolveOriginBinding(deps, origin, sessionId);
  const inputId = findHeldInput(deps, origin, sessionId)?.id;
  const proposal = store.create({
    surfaceKind: origin?.surface ?? 'unknown',
    task: input.task ?? inboundText ?? '',
    summary,
    ttlMs: config.proposalTtlMs,
    ...(binding?.surfaceId ? { surfaceId: binding.surfaceId } : {}),
    ...(binding?.id ? { routeId: binding.id } : {}),
    ...(binding?.externalId ? { externalId: binding.externalId } : {}),
    ...(origin?.threadId ? { threadId: origin.threadId } : {}),
    ...(origin?.channelId ? { channelId: origin.channelId } : {}),
    ...(origin?.userId ? { userId: origin.userId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(inputId ? { inputId } : {}),
  });

  // A proposal becomes answerable only once its notice is confirmed on the
  // wire. Until then listPending excludes it, so a message arriving in the
  // meantime is treated as what it is rather than as an answer to something
  // the owner was never shown. Fails closed: any refusal drops the proposal.
  // The store may have folded an earlier pending request from this conversation into this proposal; the notice names both.
  // A guest's proposal goes to the owner's own conversation, the only place it
  // can be answered; the guest is told it was put to the owner.
  // The owner's own request in a conversation not proven his alone (a group, a shared channel): as an approval, the
  // proposal is never posted there for the others to see; it goes to his own conversations, answered from there.
  const ownersElsewhere = origin !== null && origin.guest !== true && binding !== undefined && deps.ownerConversations !== undefined
    && !deps.ownerConversations(origin.surface).some((conversation) => conversation.binding.id === binding.id);
  const guestAsk = origin?.guest === true
    ? await deliverGuestProposal(deps, origin, proposal, config.proposalTtlMs)
    : ownersElsewhere && origin !== null
      // None of his own conversations took it: it waits for him in Waiting for you instead.
      ? await deliverOwnersProposalElsewhere(deps, origin, proposal, config.proposalTtlMs)
        .then((sent) => sent.delivery.delivered ? sent : putOwnersProposalInInbox(deps, origin, proposal, sent))
      : undefined;
  const delivery = guestAsk
    ? guestAsk.delivery
    : await deliverProposalNotice(deps, binding, renderWorkProposalMessage({ summary: proposal.summary, expiresInMs: config.proposalTtlMs, requestCount: proposal.requestCount }));
  try { options.signal?.throwIfAborted(); assertSynchronousCurrent(sourceCurrent); }
  catch (error) { store.markUndeliverable(proposal.id, 'source-invalidated'); throw error; }
  if (!delivery.delivered) {
    store.markUndeliverable(proposal.id, delivery.reason);
    const reason = origin?.guest === true
      ? 'The message was not acted on because the owner could not be asked to agree to it. Send it again later.'
      : 'The message was not acted on because the work proposal could not be shown. Send it again.';
    // Said in the guest's conversation; the owner's own request in a group says nothing there.
    if (origin?.guest === true) await deliverProposalNotice(deps, binding, `Not started: the owner could not be asked about this: ${proposal.summary}`);
    await failHeldInput(deps, origin, sessionId, reason, inputId);
    await failFoldedInputs(deps, proposal, reason);
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-proposal-undelivered' }, { status: 202 });
  }
  const delivered = store.markDelivered(proposal.id, guestAsk?.answerFrom);
  if (origin?.guest === true && guestAsk && delivered) {
    await deliverProposalNotice(deps, binding, renderGuestProposalAskedMessage(proposal.summary));
  }
  if (!delivered || !store.listPending().includes(delivered)) {
    await failHeldInput(deps, origin, sessionId, 'The work proposal expired before it could be answered. Send the message again.', inputId);
    await failFoldedInputs(deps, proposal, 'The work proposal expired before it could be answered. Send the message again.');
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-proposal-expired' }, { status: 202 });
  }

  logger.info('Conversation gate proposed a workstream instead of starting one', {
    surface: origin?.surface ?? 'unknown',
    proposalId: proposal.id,
    reason: config.mode === 'confirm-all' ? 'confirm-all-mode' : 'jev-work-intent',
  });

  return Response.json({
    acknowledged: true,
    queued: false,
    outcome: 'work-proposed',
    proposalId: proposal.id,
    expiresAt: proposal.expiresAt,
    summary: proposal.summary,
    ...(proposal.requestCount ? { requestCount: proposal.requestCount } : {}),
    ...(sessionId ? { sessionId } : {}),
  }, { status: 202 });
}

/**
 * The session input that carries the message being gated: the newest one still
 * queued from this channel (the adapter records it just before it spawns), so a
 * held message is settled by its own row and never by an older one.
 */
function findHeldInput(
  deps: Pick<ConversationGateDeps, 'sessionBroker'>,
  origin: SurfaceIngressOrigin | null,
  sessionId: string | undefined,
): { readonly id: string } | undefined {
  if (!sessionId) return undefined;
  const queued = (deps.sessionBroker.getInputs?.(sessionId, 1_000) ?? []).filter((entry) => entry.state === 'queued'
    && (origin?.surface === undefined || entry.surfaceKind === undefined || entry.surfaceKind === origin.surface)
    && (origin?.text === undefined || entry.body === origin.text));
  return queued.at(-1);
}

/** Close the row of a message that will not be acted on, with the reason, so it does not read as work waiting. */
async function failHeldInput(
  deps: Pick<ConversationGateDeps, 'sessionBroker'>,
  origin: SurfaceIngressOrigin | null,
  sessionId: string | undefined,
  reason: string,
  inputId?: string,
): Promise<void> {
  const id = inputId ?? findHeldInput(deps, origin, sessionId)?.id;
  if (!sessionId || !id) return;
  await deps.sessionBroker.failInput?.(sessionId, id, reason)?.catch((error: unknown) => {
    logger.warn('A held message could not be closed', { sessionId, inputId: id, error: summarizeError(error) });
  });
}

/** Close the rows of earlier requests folded into this proposal. */
async function failFoldedInputs(
  deps: Pick<ConversationGateDeps, 'sessionBroker'>,
  proposal: WorkProposalRecord,
  reason: string,
): Promise<void> {
  if (!proposal.sessionId) return;
  for (const inputId of proposal.foldedInputIds ?? []) await failHeldInput(deps, null, proposal.sessionId, reason, inputId);
}

/** Close the rows of a proposal that will not run (declined, expired, or its agent could not start), folded requests included. */
export async function settleUnstartedWork(
  deps: Pick<ConversationGateDeps, 'sessionBroker'>,
  proposal: WorkProposalRecord,
  reason: string,
): Promise<void> {
  if (!proposal.sessionId) return;
  if (proposal.inputId) await failHeldInput(deps, null, proposal.sessionId, reason, proposal.inputId);
  await failFoldedInputs(deps, proposal, reason);
}

/** The outcome of a message kept for after the daemon's restart: saved and acknowledged, started by the broker after it. */
export const WAITING_FOR_RESTART_OUTCOME = 'waiting-for-restart';

/**
 * Keep a message that arrived while the daemon takes no new work: its row stays
 * queued with the broker's wait mark (it survives the restart), and the broker
 * starts it after the restart or when admission reopens. No notice is sent: the
 * answer after the restart is the one reply. Null when there is no row to keep.
 */
async function holdForRestart(
  deps: Pick<ConversationGateDeps, 'sessionBroker'>,
  origin: SurfaceIngressOrigin | null,
  sessionId: string | undefined,
): Promise<Response | null> {
  const held = sessionId ? findHeldInput(deps, origin, sessionId) : undefined;
  const waiting = held && sessionId ? await deps.sessionBroker.holdForCapacity?.(sessionId, held.id, origin?.intent) : null;
  if (!held || !waiting) return null;
  return Response.json({ ok: true, acknowledged: true, queued: true, outcome: WAITING_FOR_RESTART_OUTCOME, sessionId, inputId: held.id }, { status: 202 });
}

/** What the sender is told when the message waits for a free agent. */
export const WAITING_FOR_CAPACITY_NOTICE = 'All agents are busy right now. Your message is queued and will be answered as soon as one is free.';

/**
 * Spawn through the shared path. A full fleet is not a refusal: the message's
 * row stays queued with the session broker, which starts it when an agent
 * ends, and the transport is answered as accepted so it does not deliver the
 * message again. Any other refusal closes the row, since no agent will answer it.
 */
async function spawnOrSettle(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin | null,
  input: SpawnInput,
  logLabel: string | undefined,
  sessionId: string | undefined,
): Promise<AgentRecord | Response> {
  // A guest's message starts a guest's turn: the spawn runs in that scope, so the
  // agent (and any agent it starts) carries it to every tool call it makes.
  const spawned = origin?.guest === true
    ? withGuestTurn(origin.surface, () => deps.trySpawnAgent(input, logLabel, sessionId), origin.userId)
    : deps.trySpawnAgent(input, logLabel, sessionId);
  if (!(spawned instanceof Response)) return spawned;
  if (isAdmissionRefusal(spawned)) {
    const kept = await holdForRestart(deps, origin, sessionId);
    if (kept) return kept;
  }
  const held = spawned.status === 429 && sessionId ? findHeldInput(deps, origin, sessionId) : undefined;
  // The arrival reading waits with the row, so starting it later reads nothing again.
  const waiting = held && sessionId ? await deps.sessionBroker.holdForCapacity?.(sessionId, held.id, origin?.intent) : null;
  if (held && waiting) {
    if (waiting === 'held') {
      void deps.deliverSurfaceNotice?.(resolveOriginBinding(deps, origin, sessionId), WAITING_FOR_CAPACITY_NOTICE)
        .catch((error: unknown) => logger.debug('The queued-message notice was not delivered', { sessionId, error: summarizeError(error) }));
    }
    return Response.json({
      ok: true, acknowledged: true, queued: true, outcome: 'waiting-for-capacity',
      sessionId, inputId: held.id, message: WAITING_FOR_CAPACITY_NOTICE,
    }, { status: 202 });
  }
  await failHeldInput(deps, origin, sessionId, `The message was not acted on: the agent could not be started (HTTP ${spawned.status}). Send it again.`);
  return spawned;
}

/** Bind the current ingress identity, never another route in the same session. */
function conversationalFirstTurnOptions(
  deps: Pick<ConversationGateDeps, 'configManager'>,
  origin: SurfaceIngressOrigin | null,
  tools: readonly string[] | undefined,
  sessionId: string | undefined,
): Partial<SpawnInput> {
  const channel = {
    routed: true,
    ...(origin?.surface ? { surfaceKind: origin.surface } : {}),
    ...(origin?.channelId ? { address: origin.channelId } : {}),
    ...(origin?.guest === true ? { guest: true as const } : {}),
  };
  const options = { configReader: conversationalTurnConfigReaderFrom(deps.configManager), tools };
  // Even a sessionless or unidentified ingress gets an explicit bound authority;
  // the profile tool's local-owner default must not leak into a channel turn.
  return sessionId
    ? conversationalTurnSpawnOptions({ sessionId, surfaceKind: origin?.surface }, { ...options, channel })
    : conversationalTurnCapabilities(channel, options);
}

/**
 * The route binding for the channel a message arrived on. Prefers a binding
 * already attached to the session (the adapter just upserted it), then falls
 * back to resolving one from the surface identity.
 */
export function resolveOriginBinding(
  deps: Pick<ConversationGateDeps, 'routeBindings' | 'sessionBroker'>,
  origin: SurfaceIngressOrigin | null,
  sessionId?: string,
): AutomationRouteBinding | undefined {
  if (!origin) return undefined;
  if (sessionId) {
    const session = deps.sessionBroker.getSession(sessionId);
    for (const routeId of session?.routeIds ?? []) {
      const binding = deps.routeBindings.getBinding(routeId);
      if (binding?.surfaceKind === origin.surface
        && (binding.channelId ?? binding.externalId) === origin.channelId
        && binding.threadId === origin.threadId) return binding;
    }
  }
  if (!origin.channelId) return undefined;
  const resolved = deps.routeBindings.resolve(
    origin.surface as Parameters<RouteBindingManager['resolve']>[0],
    origin.channelId,
    origin.threadId,
  );
  return resolved?.surfaceKind === origin.surface
    && (resolved.channelId ?? resolved.externalId) === origin.channelId
    && resolved.threadId === origin.threadId ? resolved : undefined;
}

/**
 * Put a guest's proposal to the owner: his own conversations, those on the
 * guest's surface first, until one accepts it. The one that did is the only
 * conversation that answers it (`answerFrom`).
 */
async function deliverGuestProposal(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin,
  proposal: WorkProposalRecord,
  ttlMs: number,
): Promise<{ readonly delivery: SurfaceNoticeDelivery; readonly answerFrom?: WorkProposalAnswerFrom | undefined }> {
  const conversations = deps.ownerConversations?.(origin.surface) ?? [];
  const text = renderGuestWorkProposalMessage({
    summary: proposal.summary, expiresInMs: ttlMs, requestCount: proposal.requestCount,
    surface: origin.surface, ...(origin.userId ? { sender: origin.userId } : {}),
  });
  let last: SurfaceNoticeDelivery = { delivered: false, reason: 'no-route-binding' };
  for (const { binding, ownerId } of conversations) {
    last = await deliverProposalNotice(deps, binding, text);
    if (!last.delivered) continue;
    const channelId = binding.channelId ?? binding.externalId;
    return { delivery: last, answerFrom: {
      surfaceKind: binding.surfaceKind,
      routeId: binding.id,
      ...(ownerId ? { userId: ownerId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    } };
  }
  return { delivery: last };
}

/**
 * The owner's own request made in a conversation that is not his alone (a group, a shared channel): the proposal is
 * put to his own conversations (owner-alert.ts isOwnerConversation), those on the same surface first, naming where it
 * was asked, and answered from the one that took it. Nothing is posted where others can read it.
 */
async function deliverOwnersProposalElsewhere(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin,
  proposal: WorkProposalRecord,
  ttlMs: number,
): Promise<{ readonly delivery: SurfaceNoticeDelivery; readonly answerFrom?: WorkProposalAnswerFrom | undefined }> {
  const conversations = deps.ownerConversations?.(origin.surface) ?? [];
  const text = `${renderWorkProposalMessage({ summary: proposal.summary, expiresInMs: ttlMs, requestCount: proposal.requestCount })}\n`
    + `You asked for it in a conversation on ${origin.surface} that is not yours alone, so it is answered here.`;
  let last: SurfaceNoticeDelivery = { delivered: false, reason: 'no-route-binding' };
  for (const { binding, ownerId } of conversations) {
    last = await deliverProposalNotice(deps, binding, text);
    if (!last.delivered) continue;
    const channelId = binding.channelId ?? binding.externalId;
    return { delivery: last, answerFrom: {
      surfaceKind: binding.surfaceKind,
      routeId: binding.id,
      ...(ownerId ? { userId: ownerId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(binding.threadId ? { threadId: binding.threadId } : {}),
    } };
  }
  return { delivery: last };
}

/** The key prefix of a proposal put in the owner inbox; the answer is applied by the item's effect (surface-actions.ts). */
export const WORK_PROPOSAL_ITEM_KEY = 'work-proposal:';
/** Where a proposal answered in the owner inbox is answered from: no channel conversation matches it. */
export const OWNER_INBOX_ANSWER_SURFACE = 'owner-inbox';

/**
 * The owner's own request in a conversation not his alone, when none of his own conversations took the proposal: it
 * is put in the owner inbox (Waiting for you, Questions) as an item he accepts or dismisses there, answered from there
 * only. Nothing is posted in the conversation it was asked in. The earlier refusal stands when there is no inbox or
 * the item could not be posted.
 */
function putOwnersProposalInInbox(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin,
  proposal: WorkProposalRecord,
  refused: { readonly delivery: SurfaceNoticeDelivery },
): { readonly delivery: SurfaceNoticeDelivery; readonly answerFrom?: WorkProposalAnswerFrom | undefined } {
  if (!deps.ownerInbox) return refused;
  try {
    const posted = deps.ownerInbox.postNow({
      kind: 'question',
      key: `${WORK_PROPOSAL_ITEM_KEY}${proposal.id}`,
      title: `Start this work? ${proposal.summary}`,
      detail: `You asked for it in a conversation on ${origin.surface} that is not yours alone, and none of your own conversations `
        + 'could take the question, so it waits here; nothing was posted in that conversation. Accept starts the work; dismiss leaves it undone.',
      options: ['accept', 'dismiss'],
      askedBy: `your ${origin.surface} conversation`,
      expiresAt: proposal.expiresAt,
      metadata: { proposalId: proposal.id, surface: origin.surface },
    }, 'conversation gate');
    return {
      delivery: { delivered: true },
      // Answered only from the inbox item: no channel reply matches this surface. The asker's own id is kept, so the
      // agreed work starts as the owner's, not a guest's.
      answerFrom: { surfaceKind: OWNER_INBOX_ANSWER_SURFACE, routeId: posted.item.id, ...(proposal.userId ? { userId: proposal.userId } : {}) },
    };
  } catch (error) {
    logger.error('The owner\'s work proposal could not be put in Waiting for you', { proposalId: proposal.id, error: summarizeError(error) });
    return refused;
  }
}

/**
 * Put the proposal on the owner's channel and report whether it got there.
 *
 * The result is the caller's business, not this function's: a proposal whose
 * notice never arrived must not stay answerable, because the owner has not
 * seen it and their NEXT message, whatever it is about, would otherwise be
 * matchable against it. Discarding this outcome is exactly the defect that
 * let an unseen proposal be "accepted".
 */
export async function deliverProposalNotice(
  deps: Pick<ConversationGateDeps, 'deliverSurfaceNotice'>,
  binding: AutomationRouteBinding | undefined,
  message: string,
): Promise<SurfaceNoticeDelivery> {
  const deliver = deps.deliverSurfaceNotice;
  if (!deliver) {
    logger.error('Conversation gate has no surface delivery function; the proposal cannot be shown', {
      surface: binding?.surfaceKind ?? null,
      routeId: binding?.id ?? null,
    });
    return { delivered: false, reason: 'no-deliverable-target' };
  }
  try {
    return await deliver(binding, message);
  } catch (error) {
    const summary = summarizeError(error);
    logger.error('Conversation gate could not deliver the proposal', {
      surface: binding?.surfaceKind ?? null,
      routeId: binding?.id ?? null,
      error: summary,
    });
    return { delivered: false, reason: 'delivery-failed', error: summary };
  }
}

/**
 * Start work the owner just agreed to. Goes through the RAW spawn path: the
 * agreement IS the authorization, so re-gating it here would ask twice. It
 * needs no decision model: the owner's yes is the fact that starts it, and the
 * work runs on the session's model whether or not a decision model is in use.
 */
export async function startAgreedWork(
  deps: ConversationGateDeps,
  proposal: WorkProposalRecord,
  note?: string,
): Promise<'started' | 'held' | 'not-started'> {
  deps.readingOptions?.signal?.throwIfAborted();
  assertSynchronousCurrent(deps.readingOptions?.beforeAttempt);
  const task = note ? `${proposal.task}\n\nAdditional direction from the owner: ${note}` : proposal.task;
  // A guest's agreed work is still the guest's turn: the owner agreed to the
  // request, not to letting its text direct changes, so each change is still his.
  const start = () => deps.trySpawnAgent({ mode: 'spawn', task }, 'ConversationGate.startAgreedWork', proposal.sessionId);
  // A guest's proposal is answered from elsewhere by someone else (the owner); the owner's own proposal answered from
  // his own conversation or from Waiting for you keeps his id, and his agreed work is his turn.
  const guest = proposal.answerFrom !== undefined && proposal.answerFrom.userId !== proposal.userId;
  const spawned = guest ? withGuestTurn(proposal.surfaceKind, start) : start();
  const binding = proposal.routeId ? deps.routeBindings.getBinding(proposal.routeId) : undefined;
  // The daemon is restarting into an update: the proposal stays accepted and unstarted, and is started after the restart.
  if (spawned instanceof Response && isAdmissionRefusal(spawned)) return 'held';
  if (spawned instanceof Response) {
    logger.warn('Agreed work could not be started', { proposalId: proposal.id, status: spawned.status });
    await deliverProposalNotice(deps, binding, `Could not start: ${proposal.summary}`);
    await settleUnstartedWork(deps, proposal, 'The agreed work could not be started. Send the message again.');
    return 'not-started';
  }
  if (proposal.sessionId) {
    // Earlier requests folded into this proposal are answered by the same agent and settle with it.
    await deps.sessionBroker.bindAgent(proposal.sessionId, spawned.id, proposal.inputId, proposal.foldedInputIds).catch((error: unknown) => {
      logger.warn('Agreed work session binding failed', { proposalId: proposal.id, error: summarizeError(error) });
    });
  }
  deps.queueSurfaceReplyFromBinding(binding, {
    agentId: spawned.id,
    task: proposal.summary,
    ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
    ...(typeof spawned.contractId === 'string' && spawned.contractId.length > 0 ? { contractId: spawned.contractId } : {}),
  });
  return 'started';
}
