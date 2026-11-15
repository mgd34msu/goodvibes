import { inboundIntent } from './batteries/conversation-gate.js';
import { decisionOrClassic, isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { assertSynchronousCurrent, daemonReadingPort } from './reading-lifetime.js';
import { captureOwnedJson, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { CallOptions } from '@goodvibes-jev/judgment/decisions';
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
  renderWorkProposalMessage,
  summarizeWorkRequest,
  type ConversationGateConfigReader,
} from '../agents/conversation-gate.js';
import type { WorkProposalRecord, WorkProposalStore } from '../agents/work-proposal-store.js';
import type { SurfaceNoticeDelivery } from './types.js';
import {
  conversationalTurnCapabilities,
  conversationalTurnConfigReaderFrom,
  conversationalTurnSpawnOptions,
} from '../personal-capture/spawn-contract.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

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
}

export type SpawnInput = Parameters<AgentManager['spawn']>[0];

export interface ConversationGateDeps {
  readonly readingOptions?: CallOptions | undefined;
  readonly captureReadingSource?: ((origin: SurfaceIngressOrigin | null) => () => void) | undefined;
  readonly configManager: ConversationGateConfigReader;
  readonly routeBindings: Pick<RouteBindingManager, 'getBinding' | 'resolve'>;
  readonly sessionBroker: Pick<SharedSessionBroker, 'getSession' | 'bindAgent'>
    & Partial<Pick<SharedSessionBroker, 'getInputs' | 'failInput' | 'beginSpawn'>>;
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
  const source = JSON.stringify(captureOwnedJson(origin));
  const sourceCurrent = deps.captureReadingSource?.(origin);
  const inputSource = JSON.stringify(captureOwnedJson(input));
  const configSource = JSON.stringify(config);
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    assertSynchronousCurrent(options.beforeAttempt);
    assertSynchronousCurrent(sourceCurrent);
    if (JSON.stringify(origin) !== source || JSON.stringify(input) !== inputSource
      || JSON.stringify(readConversationGateConfig(deps.configManager)) !== configSource) {
      throw new Error('Conversation gate source is no longer current');
    }
  };
  assertCurrent();
  const spawnClassic = async () => {
    assertCurrent();
    // No semantic statement about the message. Keep the same native first-turn
    // channel capabilities as conversation, with no autonomous contract launch.
    const spawnInput = { ...input, ...conversationalFirstTurnOptions(deps, origin, input.tools, sessionId),
      outsideContract: true, replyStyle: 'conversational' as const };
    assertCurrent(); return spawn(spawnInput);
  };
  if (classic) return spawnClassic();
  let inboundText = '';
  const result = await decisionOrClassic<Awaited<ReturnType<typeof inboundIntent.run>> | null>(async () => {
    inboundText = snapshotJudgmentInput(origin?.text ?? input.task ?? '') as string;
    // Also screen the actual task before retaining it in a pending proposal.
    snapshotJudgmentInput(input.task);
    return inboundIntent.run(daemonReadingPort('daemon.inbound-intent', assertCurrent, options.signal), { message: inboundText }, { ...options, beforeAttempt: assertCurrent });
  }, () => { assertCurrent(); return null; }, () => { assertCurrent(); return true; });
  assertCurrent();
  if (result === null) return spawnClassic();
  if (result.readings.reading.outcome !== 'act') {
    result.recordAction('held: inbound intent unsettled');
    // Nothing was started; tell the sender, once, so the message does not vanish.
    await deliverProposalNotice(deps, resolveOriginBinding(deps, origin, sessionId), 'I could not read that message just now. Please send it again.');
    await failHeldInput(deps, origin, sessionId, 'The message was not acted on because it could not be read. Send it again.');
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-intent-unsettled' }, { status: 202 });
  }
  const needsAgreement = config.mode === 'confirm-all' || result.readings.reading.choice === 'work';
  result.recordAction(needsAgreement ? 'propose-work' : 'conversational-response');
  assertCurrent();

  if (!needsAgreement) {
    // Conversation still gets a real reply, it just must not become a
    // contract. Keeping the spawn outside every contract is the difference
    // between answering "Testing" and planning and checking work against it.
    //
    // `replyStyle` carries the SAME decision through to the system prompt. The
    // gate had already classified this as conversation and then spawned an
    // agent still under instructions to file a completion report, so "Hey, are
    // you there?" was answered with a Summary/Changes/Decisions form. What the
    // message IS and what the reply should LOOK like are one decision, made
    // here, once.
    return spawn({
      ...input,
      ...conversationalFirstTurnOptions(deps, origin, input.tools, sessionId),
      outsideContract: true,
      replyStyle: 'conversational',
    });
  }

  if (!store) throw new Error('Conversation gate proposal store is unavailable');
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
  const delivery = await deliverProposalNotice(deps, binding, renderWorkProposalMessage({ summary: proposal.summary, expiresInMs: config.proposalTtlMs, requestCount: proposal.requestCount }));
  try { assertCurrent(); }
  catch (error) { store.markUndeliverable(proposal.id, 'source-invalidated'); throw error; }
  if (!delivery.delivered) {
    store.markUndeliverable(proposal.id, delivery.reason);
    await failHeldInput(deps, origin, sessionId, 'The message was not acted on because the work proposal could not be shown. Send it again.', inputId);
    return Response.json({ acknowledged: true, queued: false, outcome: 'work-proposal-undelivered' }, { status: 202 });
  }
  const delivered = store.markDelivered(proposal.id);
  if (!delivered || !store.listPending().includes(delivered)) {
    await failHeldInput(deps, origin, sessionId, 'The work proposal expired before it could be answered. Send the message again.', inputId);
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

/** Close the row of a proposal that will not run (declined, or its agent could not start). */
export async function settleUnstartedWork(
  deps: Pick<ConversationGateDeps, 'sessionBroker'>,
  proposal: WorkProposalRecord,
  reason: string,
): Promise<void> {
  if (!proposal.sessionId || !proposal.inputId) return;
  await failHeldInput(deps, null, proposal.sessionId, reason, proposal.inputId);
}

/** Spawn through the shared path; a refusal closes the message's row, since no agent will answer it. */
async function spawnOrSettle(
  deps: ConversationGateDeps,
  origin: SurfaceIngressOrigin | null,
  input: SpawnInput,
  logLabel: string | undefined,
  sessionId: string | undefined,
): Promise<AgentRecord | Response> {
  const spawned = deps.trySpawnAgent(input, logLabel, sessionId);
  if (spawned instanceof Response) {
    await failHeldInput(deps, origin, sessionId, `The message was not acted on: the agent could not be started (HTTP ${spawned.status}). Send it again.`);
  }
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
 * agreement IS the authorization, so re-gating it here would ask twice.
 */
export async function startAgreedWork(
  deps: ConversationGateDeps,
  proposal: WorkProposalRecord,
  note?: string,
): Promise<void> {
  deps.readingOptions?.signal?.throwIfAborted();
  assertSynchronousCurrent(deps.readingOptions?.beforeAttempt);
  requireDecisionFeature('starting agreed autonomous work; continue through an ordinary Classic conversation and its native tool approvals');
  const task = note ? `${proposal.task}\n\nAdditional direction from the owner: ${note}` : proposal.task;
  const spawned = deps.trySpawnAgent({ mode: 'spawn', task }, 'ConversationGate.startAgreedWork', proposal.sessionId);
  const binding = proposal.routeId ? deps.routeBindings.getBinding(proposal.routeId) : undefined;
  if (spawned instanceof Response) {
    logger.warn('Agreed work could not be started', { proposalId: proposal.id, status: spawned.status });
    await deliverProposalNotice(deps, binding, `Could not start: ${proposal.summary}`);
    await settleUnstartedWork(deps, proposal, 'The agreed work could not be started. Send the message again.');
    return;
  }
  if (proposal.sessionId) {
    await deps.sessionBroker.bindAgent(proposal.sessionId, spawned.id, proposal.inputId).catch((error: unknown) => {
      logger.warn('Agreed work session binding failed', { proposalId: proposal.id, error: summarizeError(error) });
    });
  }
  deps.queueSurfaceReplyFromBinding(binding, {
    agentId: spawned.id,
    task: proposal.summary,
    ...(proposal.sessionId ? { sessionId: proposal.sessionId } : {}),
    ...(typeof spawned.contractId === 'string' && spawned.contractId.length > 0 ? { contractId: spawned.contractId } : {}),
  });
}
