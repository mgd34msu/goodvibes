/**
 * The one sequence every chat surface runs for an inbound message:
 * channel policy, route binding, control command (`status`, `cancel` or
 * `retry <id>`), session submission, spawn, agent binding and reply queue.
 *
 * An adapter supplies only what is its own: authentication, reading the
 * provider payload, and the answer the provider expects. Every surface
 * therefore gets the same control commands, the same origin rule for them
 * (a conversation acts only on what it started) and the same handling of the
 * conversation gate's answers.
 */
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { UpsertRouteBindingInput } from '../channels/route-manager.js';
import type { SharedSessionSubmission } from '../control-plane/session-types.js';
import type { SurfaceAdapterContext, SurfaceIngressDecision, TrySpawnAgentResult } from './types.js';
import { ingressAnswerResponse, type IngressAudience } from './helpers.js';
import { duplicateDeliveryResponse, surfaceInboundDedup } from './inbound-dedup.js';

type IngressInput = Parameters<SurfaceAdapterContext['authorizeSurfaceIngress']>[0];

/**
 * Where the answer to a control command is shown. `response`: the provider
 * renders the HTTP answer (a slash command, Google Chat, Teams, Mattermost,
 * Home Assistant, a webhook caller). `notice`: the provider discards it
 * (Slack and Discord events, Telegram, WhatsApp, SMS, Signal, iMessage,
 * BlueBubbles, Matrix, ntfy), so the answer is sent to the conversation.
 */
export type ControlAnswerChannel = 'response' | 'notice';

export interface SurfaceControlDeps {
  readonly parseSurfaceControlCommand?: SurfaceAdapterContext['parseSurfaceControlCommand'] | undefined;
  readonly performSurfaceControlCommand?: SurfaceAdapterContext['performSurfaceControlCommand'] | undefined;
  readonly deliverSurfaceNotice?: SurfaceAdapterContext['deliverSurfaceNotice'] | undefined;
}

export interface SurfaceControlInput {
  readonly surface: string;
  readonly text: string;
  /** The conversation the message arrived on; a function when the binding is only needed for a command. */
  readonly binding: AutomationRouteBinding | (() => Promise<AutomationRouteBinding>);
  readonly userId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly answer: ControlAnswerChannel;
  readonly signal?: AbortSignal | undefined;
}

export interface SurfaceControlAnswer {
  readonly message: string;
  readonly bindingId: string;
  /** Set for `notice`: whether the answer reached the conversation. */
  readonly delivered?: boolean | undefined;
}

/**
 * Answers `status`, `cancel` or `retry <id>` when the text is one. Only text
 * naming an id the daemon knows can be a command, so ordinary messages cost
 * map lookups and no model request.
 */
export async function answerSurfaceControl(
  context: SurfaceControlDeps,
  input: SurfaceControlInput,
): Promise<SurfaceControlAnswer | null> {
  if (!context.parseSurfaceControlCommand || !context.performSurfaceControlCommand || !input.text.trim()) return null;
  const command = await context.parseSurfaceControlCommand(input.text, input.signal ? { signal: input.signal } : {});
  if (!command) return null;
  const binding = typeof input.binding === 'function' ? await input.binding() : input.binding;
  const message = await context.performSurfaceControlCommand(command, {
    surface: input.surface,
    routeId: binding.id,
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.channelId ? { channelId: input.channelId } : {}),
  });
  if (input.answer === 'response') return { message, bindingId: binding.id };
  let delivered = false;
  try {
    delivered = context.deliverSurfaceNotice ? (await context.deliverSurfaceNotice(binding, message)).delivered : false;
  } catch {
    delivered = false;
  }
  return { message, bindingId: binding.id, delivered };
}

export interface SurfaceMessageDeps extends SurfaceControlDeps {
  readonly sessionBroker: Pick<SurfaceAdapterContext['sessionBroker'], 'submitMessage' | 'bindAgent'>;
  readonly trySpawnAgent: (...args: Parameters<SurfaceAdapterContext['trySpawnAgent']>) => TrySpawnAgentResult | Promise<TrySpawnAgentResult>;
  readonly queueSurfaceReplyFromBinding?: SurfaceAdapterContext['queueSurfaceReplyFromBinding'] | undefined;
}

export interface SurfaceMessageInput {
  readonly surface: AutomationRouteBinding['surfaceKind'];
  readonly text: string;
  readonly logLabel: string;
  /** `false` when the caller has already answered control commands, or the surface has none. */
  readonly control: ControlAnswerChannel | false;
  readonly providerMessageId?: string | undefined;
  readonly sessionId?: string | undefined;
  /** Defaults to the binding's. */
  readonly externalId?: string | undefined;
  /** Defaults to the binding's thread, then its channel. */
  readonly threadId?: string | undefined;
  readonly userId?: string | undefined;
  readonly displayName?: string | undefined;
  readonly channelId?: string | undefined;
  /** Defaults to the binding's title. */
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Called once the message is held by a live agent or a new one started: a redelivery must not repeat it. */
  readonly committed?: (() => void) | undefined;
  /** The binding the agent's answer goes to, when this message carries a one-shot reply credential. */
  readonly replyBinding?: ((binding: AutomationRouteBinding) => AutomationRouteBinding) | undefined;
  /** Hands the agent's task and contract to the reply queue so a contract's later reports reach this conversation (ntfy). */
  readonly trackContract?: boolean | undefined;
  /** Replaces the route reply queue (the generic webhook answers through its callback). */
  readonly queueReply?: ((started: { readonly agentId: string; readonly sessionId: string; readonly submission: SharedSessionSubmission }) => void) | undefined;
}

export type SurfaceMessageOutcome =
  | { readonly kind: 'control'; readonly message: string; readonly bindingId: string; readonly delivered?: boolean | undefined }
  /** A live agent took the message, it waits behind one, or it went to a surface that is attached to the session. */
  | { readonly kind: 'continued'; readonly bindingId: string; readonly sessionId: string; readonly agentId: string | null; readonly submission: SharedSessionSubmission }
  | { readonly kind: 'started'; readonly bindingId: string; readonly sessionId: string; readonly agentId: string; readonly submission: SharedSessionSubmission }
  /** The conversation gate answered the sender itself (a work proposal, a reading it could not make); nothing failed. */
  | { readonly kind: 'answered'; readonly response: Response; readonly outcome: string }
  /** Nothing was started, for the reason in `error`. */
  | { readonly kind: 'not-started'; readonly response: Response; readonly error: string };

/** Everything after the route binding, for a message that has text. */
export async function submitSurfaceMessage(
  context: SurfaceMessageDeps,
  binding: AutomationRouteBinding,
  input: SurfaceMessageInput,
): Promise<SurfaceMessageOutcome> {
  if (input.control) {
    const control = await answerSurfaceControl(context, {
      surface: input.surface,
      text: input.text,
      binding,
      userId: input.userId,
      channelId: input.channelId ?? binding.channelId,
      answer: input.control,
      signal: input.signal,
    });
    if (control) return { kind: 'control', ...control };
  }

  const submission = await context.sessionBroker.submitMessage({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    routeId: binding.id,
    ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
    surfaceKind: input.surface,
    surfaceId: binding.surfaceId,
    externalId: input.externalId ?? binding.externalId,
    threadId: input.threadId ?? binding.threadId ?? binding.channelId,
    userId: input.userId,
    displayName: input.displayName ?? input.userId,
    title: input.title ?? binding.title,
    body: input.text,
    metadata: input.metadata ?? binding.metadata,
  });
  if (submission.mode === 'rejected') {
    const error = submission.input.error ?? 'The session did not accept the message.';
    return { kind: 'not-started', error, response: Response.json({ error, sessionId: submission.session.id }, { status: 409 }) };
  }
  if (submission.mode !== 'spawn') {
    input.committed?.();
    return { kind: 'continued', bindingId: binding.id, sessionId: submission.session.id, agentId: submission.activeAgentId ?? null, submission };
  }

  const spawned = await context.trySpawnAgent({ mode: 'spawn', task: submission.task ?? input.text }, input.logLabel, submission.session.id);
  if (spawned instanceof Response) return readSpawnAnswer(spawned);
  input.committed?.();
  await context.sessionBroker.bindAgent(submission.session.id, spawned.id, submission.input.id);
  if (input.queueReply) {
    input.queueReply({ agentId: spawned.id, sessionId: submission.session.id, submission });
  } else {
    const replyTo = submission.routeBinding ?? binding;
    context.queueSurfaceReplyFromBinding?.(input.replyBinding ? input.replyBinding(replyTo) : replyTo, {
      agentId: spawned.id,
      task: input.text,
      ...(input.trackContract && submission.task ? { agentTask: submission.task } : {}),
      ...(input.trackContract && typeof spawned.contractId === 'string' && spawned.contractId ? { contractId: spawned.contractId } : {}),
      sessionId: submission.session.id,
    });
  }
  return { kind: 'started', bindingId: binding.id, sessionId: submission.session.id, agentId: spawned.id, submission };
}

export interface SurfaceIngressMessage extends Omit<SurfaceMessageInput, 'surface'> {
  readonly ingress: IngressInput;
  readonly binding: UpsertRouteBindingInput;
}

export type SurfaceIngressOutcome =
  /** Not admitted: refused by the channel policy, or consumed as an answer to something pending. */
  | { readonly kind: 'refused'; readonly reason: string; readonly decision: SurfaceIngressDecision }
  /** Admitted and bound, but there is no text to act on (an attachment, an empty message). */
  | { readonly kind: 'no-text'; readonly binding: AutomationRouteBinding }
  /** A redelivery of a provider message this daemon is handling or has handled; nothing was done again. */
  | { readonly kind: 'duplicate' }
  | SurfaceMessageOutcome;

/**
 * Whether handling a provider message ended in a state a redelivery must not
 * repeat: a command ran, a gate or ingress answer was given, the message was
 * taken by an agent, or an admitted message had nothing to act on. A refusal
 * that consumed nothing, a failed start or a throw before the message was
 * taken lets a redelivery do the work again.
 */
function keepsDeliveryClaim(outcome: SurfaceIngressOutcome): boolean {
  switch (outcome.kind) {
    case 'refused': return outcome.decision.consumed !== undefined;
    case 'not-started': return false;
    default: return true;
  }
}

/**
 * The whole sequence: policy, binding, then {@link submitSurfaceMessage}, once
 * per provider message. Every surface's pipeline claims the provider's own
 * message id here, so no adapter keeps a claim of its own: a redelivery
 * arriving while the first is handled, or after it, answers `duplicate`. The
 * session broker keeps the durable claim for a submitted message (its stored
 * input row, read across a restart); this one covers what happens before the
 * broker (a control command, an ingress answer, an attachment notice) for as
 * long as a provider redelivers (inbound-dedup.ts). A message without a
 * provider id is not deduplicated.
 */
export async function runSurfaceMessage(
  context: SurfaceAdapterContext,
  input: SurfaceIngressMessage,
): Promise<SurfaceIngressOutcome> {
  const providerId = input.providerMessageId?.trim();
  const key = providerId
    ? `${input.binding.surfaceKind}:${input.binding.surfaceId}:${input.externalId ?? input.binding.externalId}:${providerId}`
    : '';
  if (!surfaceInboundDedup.claim(key)) return { kind: 'duplicate' };
  let kept = false;
  try {
    const outcome = await runSurfaceMessageOnce(context, {
      ...input,
      committed: () => { kept = true; input.committed?.(); },
    });
    if (keepsDeliveryClaim(outcome)) kept = true;
    return outcome;
  } finally {
    if (!kept) surfaceInboundDedup.release(key);
  }
}

async function runSurfaceMessageOnce(
  context: SurfaceAdapterContext,
  input: SurfaceIngressMessage,
): Promise<SurfaceIngressOutcome> {
  const policy = await context.authorizeSurfaceIngress(input.ingress);
  if (!policy.allowed) return { kind: 'refused', reason: policy.reason, decision: policy };
  const binding = await context.routeBindings.upsertBinding(input.binding);
  if (!input.text) return { kind: 'no-text', binding };
  return submitSurfaceMessage(context, binding, {
    ...input,
    surface: input.binding.surfaceKind,
    userId: input.userId ?? input.ingress.userId,
    channelId: input.channelId ?? input.ingress.channelId,
  });
}

/**
 * The answer most surfaces give for a message outcome. A refusal is answered
 * for the surface's {@link IngressAudience}: acknowledged to a provider that
 * redelivers, refused with 403 to a caller that reads the answer.
 */
export function surfaceOutcomeResponse(
  outcome: Exclude<SurfaceIngressOutcome, { kind: 'no-text' }>,
  audience: IngressAudience,
  extra: Record<string, unknown> = {},
): Response {
  switch (outcome.kind) {
    case 'duplicate':
      return duplicateDeliveryResponse();
    case 'refused':
      return ingressAnswerResponse(outcome.decision, audience);
    case 'control':
      return Response.json({
        ok: true, acknowledged: true, control: true, message: outcome.message, bindingId: outcome.bindingId,
        ...(outcome.delivered === undefined ? {} : { delivered: outcome.delivered }), ...extra,
      });
    case 'continued':
      return Response.json({ ok: true, acknowledged: true, continued: true, bindingId: outcome.bindingId, sessionId: outcome.sessionId, agentId: outcome.agentId, ...extra });
    case 'started':
      return Response.json({ ok: true, acknowledged: true, queued: true, bindingId: outcome.bindingId, sessionId: outcome.sessionId, agentId: outcome.agentId, ...extra });
    case 'answered':
    case 'not-started':
      return outcome.response;
  }
}

/** The one line a person sees when the conversation gate answered instead of starting work. */
export function gateAnswerText(outcome: string): string {
  switch (outcome) {
    case 'work-proposed': return 'This reads as work, so I proposed it instead of starting it. Answer the proposal to start it.';
    case 'work-proposal-undelivered': return 'The work proposal could not be shown here, so nothing was started. Send the request again.';
    case 'work-proposal-expired': return 'The work proposal expired before it could be answered. Send the request again.';
    case 'waiting-for-capacity': return 'All agents are busy right now. Your message is queued and will be answered as soon as one is free.';
    default: return 'Received; nothing was started.';
  }
}

/**
 * A spawn answered with a Response either came from the conversation gate,
 * which already answered the sender (2xx), or is a real failure to start.
 */
async function readSpawnAnswer(response: Response): Promise<SurfaceMessageOutcome> {
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.clone().json() as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (response.ok) {
    return { kind: 'answered', response, outcome: typeof body.outcome === 'string' ? body.outcome : 'answered' };
  }
  const error = typeof body.error === 'string' && body.error.trim()
    ? body.error
    : `The agent could not be started (HTTP ${response.status}).`;
  return { kind: 'not-started', response, error };
}
