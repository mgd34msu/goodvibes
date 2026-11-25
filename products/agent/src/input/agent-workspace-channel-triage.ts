import { daemonChannelDeliveryReceiptPath, formatAgentChannelDeliveryReceiptLine, readAgentChannelDeliveryReceipts } from '@goodvibes/engine/terminal-shell/agent-turn/channel-delivery-receipts';
import type { CommandContext } from './command-registry.ts';
import {
  readConnectedHostMethod,
  resolveConnectedHostConnection,
  type ConnectedHostConnection,
  type ConnectedHostRouteFailure,
  type ConnectedHostRouteResult,
} from './connected-host-routes.ts';
import type { AgentWorkspaceChannelStatus } from './agent-workspace-channels.ts';
import { buildAgentWorkspaceChannels } from './agent-workspace-channels.ts';
import { createChannelPrincipalAttributionResolver, type ChannelPrincipalAttributionResolver } from '../agent/principal-attribution.ts';
import { UNKNOWN_SENDER_LABEL } from '@goodvibes/engine/platform/platform/channels';
import { renderForModel, untrustedFrom } from '../agent/untrusted-content.ts';
import { clampReadLimit } from '@goodvibes/engine/terminal-shell/agent-turn/read-helpers';

type JsonRecord = Record<string, unknown>;

type TriageRouteState = 'ready' | 'empty' | 'unavailable';

export interface AgentWorkspaceChannelTriageArgs {
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
}

export interface AgentWorkspaceChannelTriage {
  readonly mode: 'channel_triage';
  readonly status: 'ready' | 'attention' | 'blocked';
  readonly summary: string;
  readonly readiness: Record<string, unknown>;
  readonly deliveries: Record<string, unknown>;
  readonly surfaceMessages: Record<string, unknown>;
  readonly routeBindings: Record<string, unknown>;
  readonly receipts: Record<string, unknown>;
  readonly inboundFeed: Record<string, unknown>;
  readonly connectedHost: Record<string, unknown>;
  readonly routes: Record<string, unknown>;
  readonly policy: string;
}

interface DeliveryAttemptView {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly status: string;
  readonly target: Record<string, unknown>;
  readonly startedAt?: number;
  readonly endedAt?: number;
  /** The target label and the provider's error text, inside the untrusted-content frame. */
  readonly untrustedContent?: string;
  readonly responseId?: string;
  readonly inspectRoute: string;
  readonly modelRoute: string;
}

// A delivery that is queued or on its way is working, not failing; only a terminal failure needs a person.
const DELIVERY_ATTENTION_STATUSES = new Set(['failed', 'dead_lettered']);
const DELIVERY_IN_PROGRESS_STATUSES = new Set(['pending', 'sending']);

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: JsonRecord, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readRecord(record: JsonRecord, key: string): JsonRecord {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function readRecordArray(record: JsonRecord, key: string): readonly JsonRecord[] {
  const value = record[key];
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 100);
}

function boundedText(value: string, max = 160): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, Math.max(0, max - 1))}...`;
}

function redactText(value: string, max = 160): string {
  return boundedText(value
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .replace(/\b([A-Z0-9_]*(TOKEN|SECRET|PASSWORD|API[_-]?KEY)[A-Z0-9_]*)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$3[redacted]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]+)/g, '[redacted-token]'), max);
}

function redactedAddress(value: string): Record<string, unknown> {
  if (!value.trim()) return {};
  let display = '[redacted-address]';
  try {
    const parsed = new URL(value);
    display = `${parsed.protocol}//${parsed.host}/...`;
  } catch {
    display = '[redacted-address]';
  }
  return { address: display };
}

/**
 * The redacted plain text of a view built here that someone outside the owner's
 * control wrote (a message title and body, a delivery target label and error, a
 * binding title, a host's error message). The views carry it only inside the
 * untrusted-content frame; a caller that frames the text itself reads it here.
 */
export interface TriageViewText {
  readonly title?: string;
  readonly bodyPreview?: string;
  readonly label?: string;
  readonly error?: string;
  readonly message?: string;
}

const triageViewTexts = new WeakMap<object, TriageViewText>();

/** The plain text {@link TriageViewText} kept for a view (or a section holding a route failure) built here. */
export function readTriageViewText(view: object): TriageViewText | undefined {
  return triageViewTexts.get(view);
}

function keepViewText<T extends object>(view: T, text: TriageViewText): T {
  triageViewTexts.set(view, text);
  return view;
}

function framed(surfaceId: string, origin: string, lines: readonly string[], receivedAt: number | undefined): string {
  return renderForModel(untrustedFrom({
    surfaceId,
    origin: origin || surfaceId,
    text: lines.join('\n'),
    receivedAt: receivedAt !== undefined && Number.isFinite(new Date(receivedAt).getTime()) ? new Date(receivedAt).toISOString() : 'unknown',
  }));
}

/** A host's error message is its own text, echoed from whatever failed; it goes out framed. */
function routeFailureView(failure: ConnectedHostRouteFailure): Record<string, unknown> {
  const message = redactText(failure.message);
  return keepViewText({
    route: failure.route,
    status: 'unavailable',
    kind: failure.kind,
    baseUrl: failure.baseUrl,
    ...(message ? { untrustedContent: framed('connected-host', failure.baseUrl || failure.route, [`message: ${message}`], undefined) } : {}),
  }, { message });
}

/** A section for a route that could not be read; its failure message is kept for {@link readTriageViewText}. */
function unavailableSection(failure: ConnectedHostRouteFailure, empty: Record<string, unknown>): Record<string, unknown> {
  const view = routeFailureView(failure);
  return keepViewText({ route: failure.route, state: 'unavailable', ...view, ...empty }, readTriageViewText(view) ?? {});
}

function routeState(result: ConnectedHostRouteResult, empty: boolean): TriageRouteState {
  if (!result.ok) return 'unavailable';
  return empty ? 'empty' : 'ready';
}

function channelTriageReadiness(channels: readonly AgentWorkspaceChannelStatus[], limit: number): Record<string, unknown> {
  const ready = channels.filter((channel) => channel.ready);
  const enabled = channels.filter((channel) => channel.enabled);
  const needsConfig = channels.filter((channel) => channel.setupState === 'needs-config');
  const needsTarget = channels.filter((channel) => channel.setupState === 'needs-target');
  // A channel with no default target still sends to an explicit target, so it is counted
  // on its own line rather than as a blocker. An unreadable configuration is a blocker.
  const attention = channels.filter((channel) => channel.setupState === 'unknown' || (channel.enabled && channel.setupState === 'needs-config'));
  return {
    totalChannels: channels.length,
    enabled: enabled.length,
    ready: ready.length,
    needsConfig: needsConfig.length,
    needsTarget: needsTarget.length,
    attention: attention.length,
    attentionChannels: attention.slice(0, limit).map((channel) => ({
      channelId: channel.id,
      label: channel.label,
      setupState: channel.setupState,
      delivery: channel.delivery,
      nextStep: channel.nextStep,
      userRoute: `Mail, calendar and channels, Channels: select ${channel.label}, "how it is configured" (channels.configured)`,
      modelRoute: `channels action:"channel" channelId:"${channel.id}"`,
    })),
    routes: {
      readiness: 'Mail, calendar and channels, Channels: "which are set up" (channels.readiness)',
      attention: 'Mail, calendar and channels, Channels: "which are set up" (channels.readiness)',
      guide: 'Mail, calendar and channels, Channels: "what to set up next" (channels.guide)',
    },
  };
}

/** The target without its label: the label is outside text and travels framed on the attempt. */
function deliveryTargetView(target: JsonRecord): Record<string, unknown> {
  const address = readString(target, 'address');
  return {
    kind: readString(target, 'kind', 'unknown'),
    surfaceKind: readString(target, 'surfaceKind') || null,
    routeId: readString(target, 'routeId') || null,
    ...redactedAddress(address),
  };
}

function deliveryAttemptView(attempt: JsonRecord): DeliveryAttemptView {
  const id = readString(attempt, 'id', 'delivery');
  const runId = readString(attempt, 'runId');
  const jobId = readString(attempt, 'jobId');
  const responseId = readString(attempt, 'responseId');
  const error = redactText(readString(attempt, 'error'));
  const targetRecord = readRecord(attempt, 'target');
  const label = redactText(readString(targetRecord, 'label'), 80);
  const surfaceKind = readString(targetRecord, 'surfaceKind', 'unknown') || 'unknown';
  const endedAt = readNumber(attempt, 'endedAt');
  const startedAt = readNumber(attempt, 'startedAt');
  const outside = [...(label ? [`label: ${label}`] : []), ...(error ? [`error: ${error}`] : [])];
  return keepViewText<DeliveryAttemptView>({
    id,
    runId,
    jobId,
    status: readString(attempt, 'status', 'unknown'),
    target: deliveryTargetView(targetRecord),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(outside.length > 0 ? { untrustedContent: framed(surfaceKind, readString(targetRecord, 'routeId'), outside, endedAt ?? startedAt) } : {}),
    ...(responseId ? { responseId } : {}),
    inspectRoute: `/api/deliveries/${encodeURIComponent(id)}`,
    modelRoute: runId
      ? `autonomy action:"queue" query:${JSON.stringify(runId)}`
      : 'autonomy action:"queue"',
  }, { ...(label ? { label } : {}), ...(error ? { error } : {}) });
}

function deliveryTriage(result: ConnectedHostRouteResult, limit: number): Record<string, unknown> {
  if (!result.ok) return unavailableSection(result, { totals: null, attempts: [], attentionCount: 0, retryCandidates: [] });
  const root = isRecord(result.body) ? result.body : {};
  const attempts = readRecordArray(root, 'attempts');
  const views = attempts.map(deliveryAttemptView);
  const attention = views.filter((attempt) => DELIVERY_ATTENTION_STATUSES.has(attempt.status));
  // Every failed or dead-lettered attempt is both the attention list and the
  // retry list; one filter, one count.
  const retryCandidates = attention;
  const inProgress = views.filter((attempt) => DELIVERY_IN_PROGRESS_STATUSES.has(attempt.status));
  return {
    route: result.route,
    state: routeState(result, attempts.length === 0),
    totals: isRecord(root.totals) ? root.totals : null,
    totalAttempts: attempts.length,
    attentionCount: attention.length,
    inProgressCount: inProgress.length,
    retryCandidateCount: retryCandidates.length,
    retryCandidates: retryCandidates.slice(0, limit),
    attempts: views.slice(0, limit),
    policy: 'Read-only delivery attempt snapshot. Retry decisions should inspect the owning automation run/job before any confirmed mutation.',
  };
}

function surfaceMessageView(message: JsonRecord): Record<string, unknown> {
  const surface = readString(message, 'surface', 'unknown');
  const title = redactText(readString(message, 'title'), 100);
  const bodyPreview = redactText(readString(message, 'body'), 180);
  const createdAt = readNumber(message, 'createdAt');
  return keepViewText<Record<string, unknown>>({
    id: readString(message, 'id', 'message'),
    surface,
    createdAt: createdAt ?? null,
    level: readString(message, 'level', 'info'),
    // The title and body were written by whoever sent the message. They only leave this
    // function inside the untrusted-content frame, never as bare fields.
    untrustedContent: framed(surface, readString(message, 'surfaceId', surface), [`title: ${title}`, `body: ${bodyPreview}`], createdAt),
    routeId: readString(message, 'routeId') || null,
    surfaceId: readString(message, 'surfaceId') || null,
    clientId: readString(message, 'clientId') || null,
    attachmentCount: Array.isArray(message.attachments) ? message.attachments.length : 0,
  }, { title, bodyPreview });
}

function surfaceMessageTriage(result: ConnectedHostRouteResult, limit: number): Record<string, unknown> {
  if (!result.ok) return unavailableSection(result, { totalMessages: 0, messages: [] });
  const root = isRecord(result.body) ? result.body : {};
  const messages = readRecordArray(root, 'messages');
  return {
    route: result.route,
    state: routeState(result, messages.length === 0),
    totalMessages: messages.length,
    messages: messages.slice(0, limit).map(surfaceMessageView),
    policy: 'Read-only control-plane surface messages. This is a visible surface message feed, not provider-specific inbox polling.',
  };
}

async function routeBindingView(binding: JsonRecord, resolvePrincipal: ChannelPrincipalAttributionResolver): Promise<Record<string, unknown>> {
  const externalId = readString(binding, 'externalId');
  const surfaceKind = readString(binding, 'surfaceKind', 'unknown');
  const attribution = await resolvePrincipal(surfaceKind, externalId);
  // The title is a chat title, sender name or channel name an adapter copied from outside.
  const title = redactText(readString(binding, 'title'), 100);
  const surfaceId = readString(binding, 'surfaceId');
  return keepViewText<Record<string, unknown>>({
    id: readString(binding, 'id', 'binding'),
    kind: readString(binding, 'kind', 'unknown'),
    surfaceKind,
    surfaceId: surfaceId || null,
    ...(title ? { untrustedContent: framed(surfaceKind, surfaceId, [`title: ${title}`], readNumber(binding, 'lastSeenAt')) } : {}),
    principal: attribution.principal,
    principalLabel: attribution.label,
    ...(attribution.error ? { principalResolutionError: attribution.error } : {}),
    sessionPolicy: readString(binding, 'sessionPolicy') || null,
    threadPolicy: readString(binding, 'threadPolicy') || null,
    deliveryGuarantee: readString(binding, 'deliveryGuarantee') || null,
    lastSeenAt: readNumber(binding, 'lastSeenAt') ?? null,
    sessionId: readString(binding, 'sessionId') || null,
    runId: readString(binding, 'runId') || null,
    jobId: readString(binding, 'jobId') || null,
  }, title ? { title } : {});
}

async function routeBindingTriage(
  result: ConnectedHostRouteResult,
  limit: number,
  connection: ConnectedHostConnection,
): Promise<Record<string, unknown>> {
  if (!result.ok) return unavailableSection(result, { totalBindings: 0, bindings: [] });
  const root = isRecord(result.body) ? result.body : {};
  const bindings = readRecordArray(root, 'bindings');
  const sliced = bindings.slice(0, limit);
  const resolvePrincipal = createChannelPrincipalAttributionResolver(connection);
  const bindingViews = await Promise.all(sliced.map((binding) => routeBindingView(binding, resolvePrincipal)));
  return {
    route: result.route,
    state: routeState(result, bindings.length === 0),
    totalBindings: bindings.length,
    bindings: bindingViews,
    policy: `Read-only route continuity. External ids are digested so channel identifiers are not printed into chat. Each sender shows as the person or device its channel identity belongs to, and as "${UNKNOWN_SENDER_LABEL}" otherwise.`,
  };
}

function receiptTriage(context: CommandContext, limit: number): Record<string, unknown> {
  const shellPaths = context.workspace?.shellPaths;
  if (!shellPaths) {
    return {
      state: 'unavailable',
      totalReceipts: 0,
      receipts: [],
      reason: 'Agent shell paths unavailable.',
    };
  }
  // The sends are the daemon's now (its receipts store; the Agent's own were carried into it once).
  const snapshot = readAgentChannelDeliveryReceipts(shellPaths, daemonChannelDeliveryReceiptPath(shellPaths));
  return {
    state: snapshot.parseError ? 'attention' : snapshot.exists ? 'ready' : 'empty',
    path: snapshot.path,
    totalReceipts: snapshot.receipts.length,
    receipts: snapshot.receipts.slice(0, limit).map((receipt) => ({
      receiptId: receipt.id,
      line: formatAgentChannelDeliveryReceiptLine(receipt),
      createdAt: receipt.createdAt,
      source: receipt.source,
      status: receipt.status,
      target: receipt.target,
      messagePreview: receipt.messagePreview,
    })),
    ...(snapshot.parseError ? { parseError: snapshot.parseError } : {}),
  };
}

function routeFailureCount(results: readonly ConnectedHostRouteResult[]): number {
  return results.filter((result) => !result.ok).length;
}

function triageStatus(input: {
  readonly readinessAttention: number;
  readonly deliveryAttention: number;
  readonly routeFailures: number;
}): AgentWorkspaceChannelTriage['status'] {
  if (input.routeFailures > 0) return 'blocked';
  if (input.readinessAttention > 0 || input.deliveryAttention > 0) return 'attention';
  return 'ready';
}

export async function buildAgentWorkspaceChannelTriage(
  context: CommandContext,
  args: AgentWorkspaceChannelTriageArgs = {},
): Promise<AgentWorkspaceChannelTriage> {
  const limit = readLimit(args.limit, 12);
  const channels = buildAgentWorkspaceChannels(context);
  const connection = resolveConnectedHostConnection(context);
  const [deliveriesResult, messagesResult, bindingsResult] = await Promise.all([
    readConnectedHostMethod(context, 'deliveries.list'),
    readConnectedHostMethod(context, 'control.messages.list'),
    readConnectedHostMethod(context, 'routes.bindings.list'),
  ]);
  const readiness = channelTriageReadiness(channels, limit);
  const deliveries = deliveryTriage(deliveriesResult, limit);
  const surfaceMessages = surfaceMessageTriage(messagesResult, limit);
  const routeBindings = await routeBindingTriage(bindingsResult, limit, connection);
  const receipts = receiptTriage(context, limit);
  const routeFailures = routeFailureCount([deliveriesResult, messagesResult, bindingsResult]);
  const readinessAttention = typeof readiness.attention === 'number' ? readiness.attention : 0;
  const needsTargetCount = typeof readiness.needsTarget === 'number' ? readiness.needsTarget : 0;
  const deliveryAttention = typeof deliveries.attentionCount === 'number' ? deliveries.attentionCount : 0;
  const status = triageStatus({ readinessAttention, deliveryAttention, routeFailures });
  const messageCount = typeof surfaceMessages.totalMessages === 'number' ? surfaceMessages.totalMessages : 0;
  const bindingCount = typeof routeBindings.totalBindings === 'number' ? routeBindings.totalBindings : 0;
  return {
    mode: 'channel_triage',
    status,
    summary: `${readinessAttention} channel setup blocker(s), ${needsTargetCount} channel(s) without a default target, ${deliveryAttention} failed delivery attempt(s) to review or retry, ${messageCount} visible surface message(s), ${bindingCount} route binding(s).`,
    readiness,
    deliveries,
    surfaceMessages,
    routeBindings,
    receipts,
    inboundFeed: {
      status: messageCount > 0 ? 'visible_surface_messages' : 'no_visible_surface_messages',
      route: '/api/control-plane/messages',
      providerInboxFeed: 'not_published_by_current_channel_contract',
      summary: 'GoodVibes daemon exposes control-plane surface messages, route bindings, delivery attempts, and session/companion message APIs. It does not expose a general provider-specific channel inbox feed, so Agent triage does not claim unread Slack/Discord/email polling.',
    },
    connectedHost: {
      routesChecked: ['/api/deliveries', '/api/control-plane/messages', '/api/routes/bindings'],
      failures: [deliveriesResult, messagesResult, bindingsResult].filter((result): result is ConnectedHostRouteFailure => !result.ok).map(routeFailureView),
    },
    routes: {
      command: 'Mail, calendar and channels, Channels: "what came in" (channels.triage)',
      deliveries: 'Mail, calendar and channels, Channels: "what was sent" (channels.deliveries)',
      readiness: 'Mail, calendar and channels, Channels: "which are set up" (channels.readiness)',
      status: 'Mail, calendar and channels, Channels (channels.status)',
      policies: 'Mail, calendar and channels, Channels: "who may write" (channels.rules)',
      setupGuide: 'Mail, calendar and channels, Channels: "what to set up next" (channels.guide)',
      modelRoute: 'channels action:"triage"',
      deliveryReceipts: 'channels action:"deliveries"',
      sendTool: 'agent_channel_send',
    },
    policy: 'Read-only channel triage. It never sends messages, mutates route bindings, repairs channels, retries jobs, or prints raw external addresses; every effect remains on an explicit confirmed route.',
  };
}

function deliveryTargetLine(target: Record<string, unknown>, label: string | undefined): string {
  const parts = [
    typeof target.kind === 'string' ? target.kind : 'target',
    typeof target.surfaceKind === 'string' ? target.surfaceKind : '',
    typeof target.routeId === 'string' ? `route=${target.routeId}` : '',
    label ? `label=${label}` : '',
    typeof target.address === 'string' ? target.address : '',
  ].filter(Boolean);
  return parts.join(' ');
}

export function formatAgentWorkspaceChannelTriage(triage: AgentWorkspaceChannelTriage): string {
  const readiness = triage.readiness;
  const deliveries = triage.deliveries;
  const messages = triage.surfaceMessages;
  const bindings = triage.routeBindings;
  const receipts = triage.receipts;
  const lines = [
    'Channel Triage',
    `  status: ${triage.status}`,
    `  summary: ${triage.summary}`,
    `  policy: ${triage.policy}`,
    `  inbox: ${triage.inboundFeed.status}; provider inbox feed ${triage.inboundFeed.providerInboxFeed}`,
    '',
    '  Readiness',
    `  ready: ${readiness.ready}/${readiness.totalChannels}; enabled: ${readiness.enabled}; needs config: ${readiness.needsConfig}; needs target: ${readiness.needsTarget}`,
  ];
  const attentionChannels = Array.isArray(readiness.attentionChannels) ? readiness.attentionChannels.filter(isRecord) : [];
  for (const channel of attentionChannels.slice(0, 6)) {
    lines.push(`  - ${readString(channel, 'label', readString(channel, 'channelId'))}: ${readString(channel, 'setupState')}; ${readString(channel, 'userRoute')}`);
  }
  if (attentionChannels.length === 0) lines.push('  no enabled channel setup blockers');

  lines.push('', '  Delivery Attempts');
  if (deliveries.state === 'unavailable') {
    lines.push(`  unavailable: ${deliveries.kind}; ${readTriageViewText(deliveries)?.message ?? ''}`);
  } else {
    const totals = isRecord(deliveries.totals) ? deliveries.totals : {};
    lines.push(`  state: ${deliveries.state}; total: ${deliveries.totalAttempts}; failed or dead-lettered: ${deliveries.attentionCount}; in progress: ${deliveries.inProgressCount ?? 0}`);
    lines.push(`  totals: queued=${totals.queued ?? 0}; started=${totals.started ?? 0}; succeeded=${totals.succeeded ?? 0}; failed=${totals.failed ?? 0}; dead-lettered=${totals.deadLettered ?? 0}`);
    const retryCandidates = Array.isArray(deliveries.retryCandidates) ? deliveries.retryCandidates.filter(isRecord) : [];
    for (const attempt of retryCandidates.slice(0, 5)) {
      const target = isRecord(attempt.target) ? attempt.target : {};
      const text = readTriageViewText(attempt);
      const error = text?.error;
      lines.push(`  - ${readString(attempt, 'id')}: ${readString(attempt, 'status')} ${deliveryTargetLine(target, text?.label)}${error ? ` error=${error}` : ''} inspect=${readString(attempt, 'inspectRoute')}`);
    }
    if (retryCandidates.length === 0) lines.push('  no failed or dead-lettered delivery attempts reported');
  }

  lines.push('', '  Surface Messages');
  if (messages.state === 'unavailable') {
    lines.push(`  unavailable: ${messages.kind}; ${readTriageViewText(messages)?.message ?? ''}`);
  } else {
    lines.push(`  state: ${messages.state}; total: ${messages.totalMessages}`);
    const visibleMessages = Array.isArray(messages.messages) ? messages.messages.filter(isRecord) : [];
    for (const message of visibleMessages.slice(0, 5)) {
      lines.push(`  - ${readString(message, 'surface')}: ${readString(message, 'level')} (message text withheld from this summary)${readString(message, 'routeId') ? ` route=${readString(message, 'routeId')}` : ''}`);
    }
    if (visibleMessages.length === 0) lines.push('  no visible control-plane surface messages reported');
  }

  lines.push('', '  Route Bindings');
  if (bindings.state === 'unavailable') {
    lines.push(`  unavailable: ${bindings.kind}; ${readTriageViewText(bindings)?.message ?? ''}`);
  } else {
    lines.push(`  state: ${bindings.state}; total: ${bindings.totalBindings}`);
    const routeRows = Array.isArray(bindings.bindings) ? bindings.bindings.filter(isRecord) : [];
    for (const binding of routeRows.slice(0, 5)) {
      lines.push(`  - ${readString(binding, 'id')}: ${readString(binding, 'surfaceKind')} ${readString(binding, 'kind')} sender=${readString(binding, 'principalLabel', UNKNOWN_SENDER_LABEL)}`);
    }
    if (routeRows.length === 0) lines.push('  no route bindings reported');
  }

  lines.push('', '  Agent Receipts');
  if (receipts.state === 'unavailable') {
    lines.push(`  unavailable: ${receipts.reason}`);
  } else {
    lines.push(`  state: ${receipts.state}; total: ${receipts.totalReceipts}`);
    const receiptRows = Array.isArray(receipts.receipts) ? receipts.receipts.filter(isRecord) : [];
    for (const receipt of receiptRows.slice(0, 5)) lines.push(`  - ${readString(receipt, 'line')}`);
    if (receiptRows.length === 0) lines.push('  no confirmed Agent channel sends recorded');
  }

  lines.push('', '  Next Routes');
  lines.push('  Mail, calendar and channels, the Channels tab: which are set up, what was sent, what came in');
  lines.push('  channels action:"triage"');
  return lines.join('\n');
}
