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
import type { BuiltinChannelRuntimeDeps } from './shared.js';
import { isManagedSurface } from './surfaces.js';
import { isTruncatedDirectory } from './targets.js';

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
  const responseId = await router.deliver({
    target: buildDeliveryTarget(surface, request, binding),
    body: request.text,
    title: request.title,
    jobId: binding?.jobId ?? request.routeId ?? `channel:${surface}`,
    runId: binding?.runId ?? request.agentId ?? request.sessionId ?? `${surface}:${Date.now()}`,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    status: renderStatus(request),
    includeLinks: request.phase !== 'progress',
    ...(binding ? { binding: surface === 'webhook' ? withoutCallbackUrl(toDeliveryRouteBinding(binding)) : toDeliveryRouteBinding(binding) } : {}),
    metadata: {
      phase: request.phase,
      pending: request.pending ?? {},
      renderMetadata: request.metadata,
      eventKinds: request.events.map((event) => event.kind),
    },
  });
  return {
    delivered: true,
    ...(responseId ? { responseId } : {}),
    ...(binding?.threadId ? { threadId: binding.threadId } : {}),
    metadata: {
      surface,
      phase: request.phase,
      via: 'channel-delivery-router',
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
  await router.deliver({
    target: buildDeliveryTarget(surface, { pending: {} }, binding),
    body: formatApprovalMessage(approval),
    title: `Approval ${approval.status}: ${approval.request.tool}`,
    jobId: binding.jobId ?? `approval:${approval.id}`,
    runId: binding.runId ?? approval.id,
    status,
    includeLinks: true,
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

function formatApprovalMessage(approval: SharedApprovalRecord): string {
  const lines = [
    `Approval ${approval.status}: ${approval.id}`,
    `Tool: ${approval.request.tool}`,
    approval.request.analysis.summary,
    approval.request.analysis.target ? `Target: ${approval.request.analysis.target}` : '',
    approval.resolvedBy ? `Resolved by: ${approval.resolvedBy}` : '',
  ].filter((line) => line.trim().length > 0);
  return lines.join('\n');
}

function readPendingString(pending: Record<string, unknown>, key: string): string | undefined {
  const value = pending[key]!;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}
