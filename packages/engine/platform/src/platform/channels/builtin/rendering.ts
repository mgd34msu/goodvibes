import type { AutomationRouteBinding } from '../../automation/routes.js';
import type { SharedApprovalRecord } from '../../control-plane/index.js';
import type { Tool } from '../../types/tools.js';
import type { ChannelDeliveryRouteBinding } from '../delivery-router.js';
import type { ChannelDeliveryRequest } from '../delivery/types.js';
import type {
  ChannelRenderRequest,
  ChannelRenderResult,
  ChannelSurface,
  ChannelToolDescriptor,
} from '../types.js';
import { describeActionFailure, type ChannelActionOutcome } from '../action-outcome.js';
import { hostApprovalPresentation } from '../../permissions/ask-facts-host.js';
import { ONCE_LABEL, type AskPresentation } from '../../permissions/ask-presentation.js';
import type { BuiltinChannelRuntimeDeps } from './shared.js';
import { isManagedSurface } from './surfaces.js';
import { isTruncatedDirectory } from './targets.js';
import { isClassicOperation } from '../../runtime/decision-policy.js';

interface BuiltinRenderingContext {
  readonly deps: BuiltinChannelRuntimeDeps;
  readonly listTools: (surface: ChannelSurface) => ChannelToolDescriptor[];
  readonly invokeTool: (surface: ChannelSurface, toolId: string, input?: Record<string, unknown>) => Promise<ChannelActionOutcome>;
}

export async function renderBuiltinChannelEvent(
  context: BuiltinRenderingContext,
  surface: ChannelSurface,
  request: ChannelRenderRequest,
): Promise<ChannelRenderResult> {
  const router = context.deps.deliveryRouter;
  const binding = request.routeId ? context.deps.routeBindings.getBinding(request.routeId) : undefined;
  const announces = typeof request.metadata.announces === 'string' && request.metadata.announces
    ? request.metadata.announces
    : undefined;
  const result = await router.deliverWithReceipt({
    target: buildDeliveryTarget(surface, request, binding),
    body: request.text,
    title: request.title,
    jobId: binding?.jobId ?? request.routeId ?? `channel:${surface}`,
    runId: binding?.runId ?? request.agentId ?? request.sessionId ?? `${surface}:${Date.now()}`,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    status: renderStatus(request),
    includeLinks: request.phase !== 'progress',
    ...(announces ? { announces } : {}),
    ...(binding ? { binding: surface === 'webhook' ? withoutCallbackUrl(toDeliveryRouteBinding(binding)) : toDeliveryRouteBinding(binding) } : {}),
    metadata: {
      phase: request.phase,
      pending: request.pending ?? {},
      renderMetadata: request.metadata,
      eventKinds: request.events.map((event) => event.kind),
    },
  });
  const responseId = result.responseId;
  return {
    delivered: true,
    ...(responseId ? { responseId } : {}),
    ...(binding?.threadId ? { threadId: binding.threadId } : {}),
    metadata: {
      surface,
      phase: request.phase,
      via: 'channel-delivery-router',
      // The same announcement already reached this target; nothing new went out.
      ...(result.suppressed ? { suppressed: true } : {}),
    },
  };
}

export async function notifyBuiltinApprovalViaRouter(
  context: BuiltinRenderingContext,
  surface: ChannelSurface,
  approval: SharedApprovalRecord,
  binding: AutomationRouteBinding,
): Promise<void> {
  const router = context.deps.deliveryRouter;
  const status = approval.status === 'approved'
    ? 'completed'
    : approval.status === 'denied' || approval.status === 'cancelled' || approval.status === 'expired'
      ? 'failed'
      : 'running';
  // The ask's own words (permissions/ask-presentation.ts), the same as every other surface shows.
  const presentation = hostApprovalPresentation({ configManager: context.deps.configManager }, approval.request, approval.sessionId);
  await router.deliver({
    target: buildDeliveryTarget(surface, { pending: {} }, binding),
    body: formatApprovalMessage(approval, presentation),
    title: presentation.title,
    jobId: binding.jobId ?? `approval:${approval.id}`,
    runId: binding.runId ?? approval.id,
    status,
    includeLinks: true,
    announces: `approval:${approval.id}:${approval.status}`,
    binding: toDeliveryRouteBinding(binding),
  });
}

/**
 * A surface's channel tools as agent tools, offered only while the surface is
 * switched on: a disabled surface's thirteen-odd definitions are cost on every
 * request and a call to any of them could only fail.
 *
 * The result says what happened. Only an `ok` outcome is `success: true`; a
 * refusal, a missing record and an unknown action each carry their reason and
 * the next step, and a directory search cut short says so.
 */
export function listBuiltinAgentTools(
  context: BuiltinRenderingContext,
  surface: ChannelSurface,
): readonly Tool[] {
  if (!isManagedSurface(surface) || !context.deps.surfaceDeliveryEnabled(surface)) return [];
  return context.listTools(surface).map((descriptor): Tool => ({
    definition: {
      name: descriptor.name,
      description: descriptor.metadata.dangerous === true
        ? `${descriptor.description} This changes who can reach the agent or acts on an external system: call it only when the owner asked for exactly this.`
        : descriptor.description,
      parameters: descriptor.inputSchema ?? {
        type: 'object',
        additionalProperties: false,
      },
      sideEffects: ['network', 'state'],
      concurrency: 'serial',
      ...(descriptor.metadata.dangerous === true ? { dangerous: true } : {}),
    },
    execute: async (args) => {
      const outcome = await context.invokeTool(surface, descriptor.id, args);
      if (outcome.status !== 'ok') {
        return {
          success: false,
          error: describeActionFailure(outcome),
          output: JSON.stringify({
            surface,
            toolId: descriptor.id,
            outcome: outcome.status,
            refusal: outcome.refusal,
            ...(outcome.status === 'unknown-action' ? { known: outcome.known } : {}),
            ...(outcome.status === 'refused' && outcome.detail !== undefined ? { detail: outcome.detail } : {}),
          }, null, 2),
        };
      }
      return {
        success: true,
        output: JSON.stringify({
          surface,
          toolId: descriptor.id,
          result: outcome.result,
          ...(Array.isArray(outcome.result) && isTruncatedDirectory(outcome.result) ? { truncated: true, note: 'The provider directory search stopped at its page limit; a narrower query may find more.' } : {}),
        }, null, 2),
      };
    },
  }));
}

function buildDeliveryTarget(
  surface: ChannelSurface,
  request: { readonly pending?: Record<string, unknown> | undefined },
  binding?: AutomationRouteBinding,
): ChannelDeliveryRequest['target'] {
  const pending = request.pending ?? {};
  const address = surface === 'webhook'
    ? readPendingString(pending, 'callbackUrl')
    : readPendingString(pending, 'targetAddress')
      ?? readPendingString(pending, 'responseUrl')
      ?? readPendingString(pending, 'channelId')
      ?? readPendingString(pending, 'topic')
      ?? binding?.channelId
      ?? binding?.externalId;
  if (surface === 'webhook') {
    return {
      kind: 'webhook',
      surfaceKind: 'webhook',
      ...(address ? { address } : {}),
    };
  }
  return {
    kind: 'surface',
    surfaceKind: surface,
    ...(address ? { address } : {}),
  };
}

function toDeliveryRouteBinding(binding: AutomationRouteBinding): ChannelDeliveryRouteBinding {
  return {
    id: binding.id,
    surfaceKind: binding.surfaceKind,
    surfaceId: binding.surfaceId,
    externalId: binding.externalId,
    ...(binding.threadId ? { threadId: binding.threadId } : {}),
    ...(binding.channelId ? { channelId: binding.channelId } : {}),
    ...(binding.title ? { title: binding.title } : {}),
    metadata: { ...binding.metadata },
  };
}

/**
 * A webhook reply answers its own request. The shared binding holds whichever callback the last
 * request left, so a reply without its own must not inherit it (automation and approval
 * deliveries still read the binding).
 */
function withoutCallbackUrl(binding: ChannelDeliveryRouteBinding): ChannelDeliveryRouteBinding {
  const { callbackUrl: _callbackUrl, ...metadata } = binding.metadata;
  return { ...binding, metadata };
}

function renderStatus(request: ChannelRenderRequest): string {
  if (request.events.some((event) => event.kind === 'error')) return 'failed';
  if (request.phase === 'final') return 'completed';
  if (request.phase === 'approval') return 'running';
  return 'running';
}

/**
 * Where an ask delivered to the owner's own chat is answered. A reply there
 * decides it (daemon/approval-reply.ts reads it: a plain yes or no with a
 * decision model, `/approve <id>` or `/deny <id>` without one), except for an
 * ask only the owner's own decision can approve (`requiresOwnerDecision`: a
 * held message let in from the Telegram list), which is answered in Waiting
 * for you. The same words on every channel kind.
 */
export function approvalAnswerLine(approval: Pick<SharedApprovalRecord, 'id' | 'requiresOwnerDecision'>): string {
  if (approval.requiresOwnerDecision === true) return 'Answer it in Waiting for you.';
  return isClassicOperation()
    ? `Reply /approve ${approval.id} or /deny ${approval.id}, or answer it in Waiting for you.`
    : 'Reply yes or no, or say what to change; or answer it in Waiting for you.';
}

/** The principals that are the owner's own credentials by their nature (daemon-api actor.ts: the operator token, the local one). */
const OWNERS_OWN: ReadonlySet<string> = new Set(['owner', 'shared-token', 'local', 'local-owner']);

/** Who decided, as a person reads it; nothing for an actor known only by an internal id. */
function deciderWords(actor: string | undefined): string | undefined {
  if (!actor) return undefined;
  if (OWNERS_OWN.has(actor)) return 'you';
  if (actor.startsWith('pairing:')) return `the paired device ${actor.slice('pairing:'.length)}`;
  return undefined;
}

/** A line that is data rather than words (a call's arguments as JSON): never put in a message. */
function isDataLine(line: string): boolean {
  return /^[[{]/.test(line.trim());
}

/**
 * The ask as a chat message, in the words every other surface shows it
 * (permissions/ask-presentation.ts): what is waiting, what it acts on, what it
 * will do, and where it is answered (approvalAnswerLine; no channel offers
 * "don't ask again": a channel's ask is answered one call at a time). Never
 * the arguments as JSON or an internal id. Once decided: how, and by whom
 * when that is a name a person knows.
 */
export function formatApprovalMessage(approval: SharedApprovalRecord, presentation: AskPresentation, options: { readonly withTitle?: boolean } = {}): string {
  const subject = presentation.subject;
  const lines = [
    // A surface that shows a title of its own (ntfy) leaves it out of the body.
    ...(options.withTitle === false ? [] : [presentation.title]),
    ...(subject ? subject.lines.filter((line) => !isDataLine(line)).map((line) => (subject.kind === 'command' ? `$ ${line}` : line)) : []),
    ...(presentation.consequence ? [presentation.consequence.text] : []),
  ];
  const decider = deciderWords(approval.resolvedBy);
  const by = decider ? ` by ${decider}` : '';
  const reason = approval.decision?.reason;
  switch (approval.status) {
    case 'pending':
    case 'claimed':
      lines.push(approvalAnswerLine(approval));
      break;
    case 'approved': {
      // "once" only for a call that keeps nothing in force; a standing change's consequence above says how long it lasts.
      const actsOnce = presentation.choices.some((choice) => choice.id === 'once' && choice.label === ONCE_LABEL);
      lines.push(approval.decision?.rememberTier !== undefined || approval.decision?.remember === true
        ? `Approved${by}, and remembered.`
        : `Approved${actsOnce ? ' once' : ''}${by}.`);
      break;
    }
    case 'denied':
      lines.push(`Refused${by}${reason ? `: ${reason}` : '.'}`);
      break;
    case 'expired':
      lines.push('Nobody answered in time, so it was not done.');
      break;
    case 'cancelled':
      lines.push('No longer asked: the request was withdrawn.');
      break;
  }
  return lines.filter((line) => line.trim().length > 0).join('\n');
}

function readPendingString(pending: Record<string, unknown>, key: string): string | undefined {
  const value = pending[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
