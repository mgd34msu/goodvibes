import type {
  ChannelDeliveryRequest,
  ChannelDeliveryRouter,
  ChannelDeliverySurfaceKind,
  ChannelDeliveryTarget,
} from '@goodvibes-jev/engine/platform/platform/channels';
import {
  CardMaterialRefusedError,
  resolveDeliverySurfaceName,
  screenOutboundForCardMaterial,
} from './payments-channel-guard.js';
import { parseChannelDeliveryTarget, parseRouteDeliveryTarget, type RoutineScheduleDeliveryTargetSpec } from './schedule-delivery-targets.js';
import { randomUUID } from 'node:crypto';

type AgentChannelDeliveryRouter = Pick<ChannelDeliveryRouter, 'deliver' | 'listStrategies'>;
type AgentChannelDeliverySurfaceKind = ChannelDeliverySurfaceKind | 'telephony';
type AgentChannelDeliveryTarget = Omit<ChannelDeliveryTarget, 'surfaceKind'> & {
  readonly surfaceKind?: AgentChannelDeliverySurfaceKind | undefined;
};
type AgentChannelDeliveryRequest = Omit<ChannelDeliveryRequest, 'target'> & {
  readonly target: AgentChannelDeliveryTarget;
};

export interface AgentChannelDeliveryInput {
  readonly message: string;
  readonly title?: string | undefined;
  readonly channel?: string | undefined;
  readonly route?: string | undefined;
  readonly webhook?: string | undefined;
  readonly link?: string | undefined;
}

export interface AgentChannelDeliveryPreview {
  readonly message: string;
  readonly title: string;
  readonly target: AgentChannelDeliveryTarget;
  readonly request: AgentChannelDeliveryRequest;
}

export interface AgentChannelDeliveryResult {
  readonly responseId?: string | undefined;
  readonly message: string;
  readonly title: string;
  readonly target: AgentChannelDeliveryTarget;
  readonly strategyCount: number;
}

function readText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// An immediate send and a schedule read a channel or route target with the one
// parser in schedule-delivery-targets.ts, over the one list of surfaces.
function surfaceTarget(parsed: RoutineScheduleDeliveryTargetSpec | string): AgentChannelDeliveryTarget {
  if (typeof parsed === 'string') throw new Error(parsed);
  return {
    kind: 'surface',
    ...(parsed.surfaceKind ? { surfaceKind: parsed.surfaceKind } : {}),
    ...(parsed.routeId ? { routeId: parsed.routeId } : {}),
    ...(parsed.label ? { label: parsed.label } : {}),
  };
}

function parseChannelTarget(raw: string): AgentChannelDeliveryTarget {
  return surfaceTarget(parseChannelDeliveryTarget(raw));
}

function parseRouteTarget(raw: string): AgentChannelDeliveryTarget {
  return surfaceTarget(parseRouteDeliveryTarget(raw));
}

function parseWebhookTarget(raw: string): AgentChannelDeliveryTarget {
  const normalized = readText(raw);
  if (!normalized) throw new Error('Webhook delivery target requires a URL.');
  try {
    const url = new URL(normalized);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    throw new Error('Webhook delivery target must be a valid http(s) URL.');
  }
  return { kind: 'webhook', address: normalized };
}

function parseLinkTarget(raw: string): AgentChannelDeliveryTarget {
  const normalized = readText(raw);
  if (!normalized) throw new Error('Link delivery target requires a URL or label.');
  return { kind: 'link', address: normalized };
}

function selectedTargetInputs(input: Pick<AgentChannelDeliveryInput, 'channel' | 'route' | 'webhook' | 'link'>): readonly string[] {
  return [input.channel, input.route, input.webhook, input.link].map(readText).filter((value): value is string => Boolean(value));
}

/**
 * The one rule for a delivery target: exactly one of channel, route, webhook
 * or link. With none or several, which recipient was meant is unknown, so
 * nothing is sent.
 */
export function requireOneDeliveryTarget(input: Pick<AgentChannelDeliveryInput, 'channel' | 'route' | 'webhook' | 'link'>): void {
  const count = selectedTargetInputs(input).length;
  if (count === 0) throw new Error('No delivery target was given, so nothing was sent. Give exactly one of channel, route, webhook or link.');
  if (count > 1) throw new Error(`${count} delivery targets were given, so the recipient is unclear and nothing was sent. Give exactly one of channel, route, webhook or link.`);
}

export function buildAgentChannelDeliveryPreview(input: AgentChannelDeliveryInput): AgentChannelDeliveryPreview {
  const message = readText(input.message);
  if (!message) throw new Error('Channel delivery message is required.');
  requireOneDeliveryTarget(input);

  const channel = readText(input.channel);
  const route = readText(input.route);
  const webhook = readText(input.webhook);
  const link = readText(input.link);
  const target = channel
    ? parseChannelTarget(channel)
    : route
      ? parseRouteTarget(route)
      : webhook
        ? parseWebhookTarget(webhook)
        : parseLinkTarget(link ?? '');
  const title = readText(input.title) ?? 'GoodVibes Agent message';
  return {
    message,
    title,
    target,
    request: {
      target,
      body: message,
      title,
      jobId: 'agent-channel-send',
      runId: `agent-channel-send-${randomUUID()}`,
      status: 'completed',
      includeLinks: true,
      metadata: {
        product: 'goodvibes-agent',
        source: 'agent-channel-send',
      },
    },
  };
}

/**
 * How many channel deliveries are awaiting their strategy right now.
 *
 * Every send in the agent funnels through deliverAgentChannelMessage below, so
 * one counter here is the whole in-flight picture. It exists because a
 * long-running agent may replace its own binary and restart while it is
 * running: "is this agent busy?" has to include a message that has left the
 * conversation but has not reached the person yet, or a self-update could
 * restart the process between the send and its delivery.
 */
let inFlightDeliveries = 0;

export function channelDeliveriesInFlight(): number {
  return inFlightDeliveries;
}

export async function deliverAgentChannelMessage(
  router: AgentChannelDeliveryRouter,
  input: AgentChannelDeliveryInput,
  options: { readonly signal?: AbortSignal; readonly assertCurrent?: () => void } = {},
): Promise<AgentChannelDeliveryResult> {
  const assertCurrent = () => { options.signal?.throwIfAborted(); options.assertCurrent?.(); };
  assertCurrent();
  const preview = buildAgentChannelDeliveryPreview(input);

  // Counted from here, not from router.deliver: the screening below can await
  // a model, and a send waiting inside it has already left the conversation. A
  // self-update that checked the counter in that window would restart the
  // process under it. Decremented on every path, refusal and throw included, so
  // a leaked counter cannot pin the agent "busy" forever.
  inFlightDeliveries += 1;
  let responseId: string | undefined;
  try {
    // Card material never leaves this program toward a remote channel. This is
    // the single outbound funnel (see channelDeliveriesInFlight above), so one
    // check here covers every send: a model composing a message, a routine, a
    // person answering a prompt in the wrong place.
    //
    // It refuses BEFORE router.deliver, so nothing reaches a provider, and it
    // throws rather than returning a result, so no caller can treat a refusal as
    // a successful send. The thrown message is the platform's refusal wording and
    // contains no part of what was refused, see agent/payments-channel-guard.ts.
    const refusal = await screenOutboundForCardMaterial({
      surface: resolveDeliverySurfaceName(preview.target),
      message: preview.message,
      title: preview.title,
    }, options);
    if (refusal) throw new CardMaterialRefusedError(refusal);
    assertCurrent();

    responseId = await router.deliver({ ...preview.request,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.assertCurrent ? { assertCurrent } : {}),
    } as ChannelDeliveryRequest);
  } finally {
    inFlightDeliveries = Math.max(0, inFlightDeliveries - 1);
  }
  return {
    responseId,
    message: preview.message,
    title: preview.title,
    target: preview.target,
    strategyCount: strategyCountOf(router),
  };
}

// Display-only. The provider has already accepted the message by now, so a throw
// here would make callers treat a delivered message as failed and resend it.
function strategyCountOf(router: Pick<ChannelDeliveryRouter, 'listStrategies'>): number {
  try {
    return router.listStrategies().length;
  } catch {
    return 0;
  }
}

function formatTarget(target: AgentChannelDeliveryTarget): string {
  if (target.kind === 'surface') {
    const base = target.surfaceKind ?? 'route';
    const details = [
      target.routeId ? `route ${target.routeId}` : '',
      target.label ? `label ${target.label}` : '',
    ].filter(Boolean);
    return `${base}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
  }
  return target.address ? `${target.kind} ${target.address}` : target.kind;
}

export function formatAgentChannelDeliveryPreview(preview: AgentChannelDeliveryPreview, strategyCount: number): string {
  return [
    'Agent channel delivery preview',
    `  title ${preview.title}`,
    `  target ${formatTarget(preview.target)}`,
    `  strategies ${strategyCount}`,
    `  message ${preview.message}`,
    '  policy external delivery requires current authority and destination checks',
  ].join('\n');
}

export function formatAgentChannelDeliveryResult(result: AgentChannelDeliveryResult): string {
  return [
    'Agent channel delivery sent',
    `  title ${result.title}`,
    `  target ${formatTarget(result.target)}`,
    `  strategies ${result.strategyCount}`,
    ...(result.responseId ? [`  response ${result.responseId}`] : []),
  ].join('\n');
}
