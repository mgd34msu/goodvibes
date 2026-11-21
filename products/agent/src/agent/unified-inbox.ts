/**
 * unified-inbox.ts
 *
 * Agent-side unified inbox read-model. Aggregates four daemon-exposed sources:
 *
 *   1. /api/deliveries          , outbound delivery attempts (status / failures)
 *   2. /api/control-plane/messages, surface messages visible to the TUI client
 *   3. /api/routes/bindings     , live route binding continuity records
 *   4. channels.inbox.list      , provider-specific inbound messages
 *
 * The first three arrive already fetched, in an `AgentWorkspaceChannelTriage`.
 * The fourth is fetched here, by `fetchInboundChannelFeed`, because it is a
 * method call rather than one of triage's routes.
 *
 * When that call does not produce a feed, the reason says what actually
 * happened, the daemon's own answer, classified. It does not say the contract
 * is unpublished, because it is published: an inbox reporting a cause it did
 * not observe sends whoever reads it to fix the wrong thing.
 */

import { readTriageViewText, type AgentWorkspaceChannelTriage } from '../input/agent-workspace-channel-triage.ts';
import type { DaemonInvokeFailureKind, DaemonOperatorInvoke } from '@goodvibes/engine/terminal-shell/agent-turn/daemon-operator-client';
import { UNKNOWN_PRINCIPAL_LABEL } from './principal-attribution.ts';
import { renderForModel, untrustedFrom } from './untrusted-content.ts';
import type { Page } from '@goodvibes/engine/errors';

/** The daemon method that serves provider inbound feeds. */
export const CHANNEL_INBOX_LIST_METHOD = 'channels.inbox.list';

// ---------------------------------------------------------------------------
// Item kinds
// ---------------------------------------------------------------------------

/** An outbound delivery attempt reported by /api/deliveries. */
export interface UnifiedInboxDeliveryItem {
  readonly kind: 'delivery';
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly status: 'queued' | 'sending' | 'completed' | 'failed' | 'dead_lettered' | string;
  readonly target: UnifiedInboxTarget;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly error?: string;
  readonly responseId?: string;
  /** Inspect route for the daemon UI / model tool. */
  readonly inspectRoute: string;
}

/** A control-plane surface message reported by /api/control-plane/messages. */
export interface UnifiedInboxSurfaceMessageItem {
  readonly kind: 'surface_message';
  readonly id: string;
  readonly surface: string;
  readonly level: 'info' | 'warning' | 'error' | string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly routeId: string | null;
  readonly surfaceId: string | null;
  readonly clientId: string | null;
  readonly attachmentCount: number;
  readonly createdAt: number | null;
}

/** A route binding reported by /api/routes/bindings. */
export interface UnifiedInboxRouteBindingItem {
  readonly kind: 'route_binding';
  readonly id: string;
  readonly bindingKind: string;
  readonly surfaceKind: string;
  readonly surfaceId: string | null;
  /** Resolved sender principal, when the channel identity maps to one. Never a guess. */
  readonly principal: { readonly id: string; readonly name: string; readonly kind: string } | null;
  /** Human-facing sender label, the resolved principal's "name (id)", or "unknown principal". */
  readonly principalLabel: string;
  readonly sessionPolicy: string | null;
  readonly threadPolicy: string | null;
  readonly deliveryGuarantee: string | null;
  readonly lastSeenAt: number | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly jobId: string | null;
}

/**
 * An inbound message reported by `channels.inbox.list`.
 *
 * The sender is carried as the daemon reports it rather than digested. The
 * route-binding item above digests its external id because that id is a
 * third-party correlation key nobody asked to read; this is the operator's own
 * inbox being shown back to the operator, where a sender they cannot identify
 * is not an inbox.
 */
export interface UnifiedInboxInboundMessageItem {
  readonly kind: 'inbound_message';
  readonly id: string;
  readonly provider: string;
  /** The provider's own kind for this item (dm, channel, thread, email, …). */
  readonly messageKind: string;
  readonly from: string;
  readonly fromAddress: string | null;
  readonly subject: string | null;
  readonly bodyPreview: string;
  readonly receivedAt: number;
  readonly unread: boolean;
  readonly routeId: string | null;
  readonly threadId: string | null;
  readonly attachmentCount: number;
  /** The inbox's triage label for this message's current content; null until it is scored. */
  readonly triageLabel: 'spam' | 'priority' | 'normal' | null;
  /** Whether privacy screening read its text (`not-screened`: only code checked it); null when the provider does not say. */
  readonly screening: 'screened' | 'not-screened' | null;
  /** Why it was not screened; null unless `screening` is `not-screened`. */
  readonly screeningReason: string | null;
}

export type UnifiedInboxItem =
  | UnifiedInboxDeliveryItem
  | UnifiedInboxSurfaceMessageItem
  | UnifiedInboxRouteBindingItem
  | UnifiedInboxInboundMessageItem;

export interface UnifiedInboxTarget {
  readonly kind: string;
  readonly surfaceKind: string | null;
  readonly routeId: string | null;
  readonly label: string | null;
  readonly address?: string;
}

// ---------------------------------------------------------------------------
// Aggregate model
// ---------------------------------------------------------------------------

/** `partial`: the source answered, but part of what it holds is missing (a provider whose last sync failed). */
export type UnifiedInboxSourceState = 'ready' | 'empty' | 'partial' | 'unavailable';

export interface UnifiedInboxSource {
  readonly name: string;
  readonly route: string;
  readonly state: UnifiedInboxSourceState;
  readonly itemCount: number;
  readonly error?: string;
}

export interface UnifiedInboxSummary {
  readonly totalItems: number;
  readonly deliveryItems: number;
  readonly surfaceMessageItems: number;
  readonly routeBindingItems: number;
  readonly inboundMessageItems: number;
  readonly attentionCount: number;
  readonly failureCount: number;
}

/**
 * Why the inbound feed is not here, when it is not.
 *
 * Each value names something that was actually observed:
 *
 *  `not_attempted`  , no connected-host caller was supplied, so nothing was
 *                      asked and nothing is claimed.
 *  `auth_required`  , no operator token, or the daemon rejected the one there.
 *  `daemon_unreachable`, the call did not complete.
 *  `method_unavailable`, the daemon answered, and its answer was that it does
 *                      not serve this method (a 404 or METHOD_NOT_FOUND, or the
 *                      route-unavailable answer for a cataloged method it does not
 *                      dispatch). A daemon serves `channels.inbox.list` only when
 *                      it composes an inbox; one that answers 501 NOT_INVOKABLE
 *                      is classified as a connected-host error and lands in
 *                      `daemon_error` below, with its own detail.
 *  `daemon_error`   , it answered with something else.
 */
export type InboundChannelFeedUnavailableReason =
  | 'not_attempted'
  | 'auth_required'
  | 'daemon_unreachable'
  | 'method_unavailable'
  | 'daemon_error';

export type InboundChannelFeedState =
  | {
      readonly available: false;
      readonly reason: InboundChannelFeedUnavailableReason;
      readonly methodId: typeof CHANNEL_INBOX_LIST_METHOD;
      /** What the daemon said, verbatim, when it said anything. */
      readonly detail: string;
    }
  | {
      readonly available: true;
      readonly methodId: typeof CHANNEL_INBOX_LIST_METHOD;
      /** The page the host returned: `more` and `next` say a further page is there to read. */
      readonly page: Page<UnifiedInboxInboundMessageItem>;
      readonly total: number;
      readonly truncated: boolean;
      /** True when a configured provider's items are missing because its last sync failed. */
      readonly partial: boolean;
      /** Each provider's own state as the host reported it. */
      readonly providers: readonly InboundProviderStatus[];
    };

/** One provider of the inbound feed, as the host reported it. */
export interface InboundProviderStatus {
  readonly provider: string;
  readonly state: string;
  /** What the host said failed, when the state is `error` (third-party text: shown only in the untrusted frame). */
  readonly error?: string;
}

function readInboundProviders(value: unknown): InboundProviderStatus[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).flatMap((entry) => (typeof entry.provider === 'string' && typeof entry.state === 'string'
    ? [{ provider: entry.provider, state: entry.state, ...(typeof entry.error === 'string' ? { error: entry.error } : {}) }]
    : []));
}

export interface UnifiedInbox {
  readonly mode: 'unified_inbox';
  readonly status: 'ready' | 'attention' | 'blocked';
  readonly summary: UnifiedInboxSummary;
  readonly items: readonly UnifiedInboxItem[];
  readonly sources: readonly UnifiedInboxSource[];
  /** Outbound delivery attempts. Subset of items where kind === 'delivery'. */
  readonly deliveryItems: readonly UnifiedInboxDeliveryItem[];
  /** Control-plane surface messages. Subset of items where kind === 'surface_message'. */
  readonly surfaceMessageItems: readonly UnifiedInboxSurfaceMessageItem[];
  /** Route binding continuity. Subset of items where kind === 'route_binding'. */
  readonly routeBindingItems: readonly UnifiedInboxRouteBindingItem[];
  /** Provider inbound messages. Subset of items where kind === 'inbound_message'. */
  readonly inboundMessageItems: readonly UnifiedInboxInboundMessageItem[];
  /** The inbound feed, or the observed reason there is none. */
  readonly inboundChannelFeed: InboundChannelFeedState;
  readonly policy: string;
}

// ---------------------------------------------------------------------------
// Internal helpers, converting triage sub-records to typed items
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string, fallback = ''): string {
  const value = record[key];
  return typeof value === 'string' ? value : fallback;
}

function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readStringOrNull(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value ? value : null;
}

function toDeliveryItem(raw: Record<string, unknown>): UnifiedInboxDeliveryItem {
  const target = isRecord(raw.target) ? raw.target : {};
  // A triage built from a real feed carries the target label and the error only
  // inside the untrusted frame, so the plain text comes from the side channel it keeps.
  const text = readTriageViewText(raw);
  const label = text?.label ?? readStringOrNull(target, 'label');
  const error = text?.error ?? readString(raw, 'error');
  return {
    kind: 'delivery',
    id: readString(raw, 'id', 'delivery'),
    runId: readString(raw, 'runId'),
    jobId: readString(raw, 'jobId'),
    status: readString(raw, 'status', 'unknown'),
    target: {
      kind: readString(target, 'kind', 'unknown'),
      surfaceKind: readStringOrNull(target, 'surfaceKind'),
      routeId: readStringOrNull(target, 'routeId'),
      label: label || null,
      ...(typeof target.address === 'string' && target.address ? { address: target.address } : {}),
    },
    ...(readNumber(raw, 'startedAt') !== null ? { startedAt: readNumber(raw, 'startedAt') as number } : {}),
    ...(readNumber(raw, 'endedAt') !== null ? { endedAt: readNumber(raw, 'endedAt') as number } : {}),
    ...(error ? { error } : {}),
    ...(readString(raw, 'responseId') ? { responseId: readString(raw, 'responseId') } : {}),
    inspectRoute: readString(raw, 'inspectRoute', `/api/deliveries/${encodeURIComponent(readString(raw, 'id', 'delivery'))}`),
  };
}

/** A triage section's host error message: kept off the section by the triage, which carries it only framed. */
function sectionError(section: Record<string, unknown>): string | undefined {
  const message = readTriageViewText(section)?.message ?? (typeof section.message === 'string' ? section.message : undefined);
  return message || undefined;
}

function toSurfaceMessageItem(raw: Record<string, unknown>): UnifiedInboxSurfaceMessageItem {
  // A triage built from a real feed carries its text only inside the untrusted frame,
  // so the plain title and preview come from the side channel it keeps.
  const text = readTriageViewText(raw);
  return {
    kind: 'surface_message',
    id: readString(raw, 'id', 'message'),
    surface: readString(raw, 'surface', 'unknown'),
    level: readString(raw, 'level', 'info'),
    title: text?.title ?? readString(raw, 'title'),
    bodyPreview: text?.bodyPreview ?? readString(raw, 'bodyPreview'),
    routeId: readStringOrNull(raw, 'routeId'),
    surfaceId: readStringOrNull(raw, 'surfaceId'),
    clientId: readStringOrNull(raw, 'clientId'),
    attachmentCount: typeof raw.attachmentCount === 'number' ? raw.attachmentCount : 0,
    createdAt: readNumber(raw, 'createdAt'),
  };
}

function toPrincipalOrNull(raw: Record<string, unknown>): { readonly id: string; readonly name: string; readonly kind: string } | null {
  const principalRaw = isRecord(raw.principal) ? raw.principal : null;
  if (!principalRaw) return null;
  const id = readString(principalRaw, 'id');
  const name = readString(principalRaw, 'name');
  const kind = readString(principalRaw, 'kind');
  return id && name && kind ? { id, name, kind } : null;
}

function toRouteBindingItem(raw: Record<string, unknown>): UnifiedInboxRouteBindingItem {
  return {
    kind: 'route_binding',
    id: readString(raw, 'id', 'binding'),
    bindingKind: readString(raw, 'kind', 'unknown'),
    surfaceKind: readString(raw, 'surfaceKind', 'unknown'),
    surfaceId: readStringOrNull(raw, 'surfaceId'),
    principal: toPrincipalOrNull(raw),
    principalLabel: readString(raw, 'principalLabel', UNKNOWN_PRINCIPAL_LABEL),
    sessionPolicy: readStringOrNull(raw, 'sessionPolicy'),
    threadPolicy: readStringOrNull(raw, 'threadPolicy'),
    deliveryGuarantee: readStringOrNull(raw, 'deliveryGuarantee'),
    lastSeenAt: readNumber(raw, 'lastSeenAt'),
    sessionId: readStringOrNull(raw, 'sessionId'),
    runId: readStringOrNull(raw, 'runId'),
    jobId: readStringOrNull(raw, 'jobId'),
  };
}

function toInboundMessageItem(raw: Record<string, unknown>): UnifiedInboxInboundMessageItem {
  return {
    kind: 'inbound_message',
    id: readString(raw, 'id', 'inbound'),
    provider: readString(raw, 'provider', 'unknown'),
    messageKind: readString(raw, 'kind', 'unknown'),
    from: readString(raw, 'from', UNKNOWN_PRINCIPAL_LABEL),
    fromAddress: readStringOrNull(raw, 'fromAddress'),
    subject: readStringOrNull(raw, 'subject'),
    bodyPreview: readString(raw, 'bodyPreview'),
    receivedAt: readNumber(raw, 'receivedAt') ?? 0,
    unread: raw.unread === true,
    routeId: readStringOrNull(raw, 'routeId'),
    threadId: readStringOrNull(raw, 'threadId'),
    attachmentCount: typeof raw.attachmentCount === 'number' ? raw.attachmentCount : 0,
    triageLabel: raw.triageLabel === 'spam' || raw.triageLabel === 'priority' || raw.triageLabel === 'normal' ? raw.triageLabel : null,
    screening: raw.screening === 'screened' || raw.screening === 'not-screened' ? raw.screening : null,
    screeningReason: raw.screening === 'not-screened' ? readStringOrNull(raw, 'screeningReason') : null,
  };
}

/** Map a transport failure onto the reason an operator should act on. */
function inboundFailureReason(kind: DaemonInvokeFailureKind): InboundChannelFeedUnavailableReason {
  if (kind === 'auth_required') return 'auth_required';
  if (kind === 'connected_host_unavailable') return 'daemon_unreachable';
  if (kind === 'connected_host_route_unavailable') return 'method_unavailable';
  return 'daemon_error';
}

/**
 * Ask the daemon for the provider inbound feed.
 *
 * Separate from `aggregateUnifiedInbox` so that function stays a pure
 * transformation of things already fetched, the property its tests rely on.
 * A caller with no daemon to ask simply does not call this, and the aggregate
 * says `not_attempted` rather than inventing a cause.
 */
export async function fetchInboundChannelFeed(
  invoke: DaemonOperatorInvoke,
  options: { readonly provider?: string; readonly limit?: number; readonly since?: number } = {},
): Promise<InboundChannelFeedState> {
  const result = await invoke(CHANNEL_INBOX_LIST_METHOD, {
    ...(options.provider ? { provider: options.provider } : {}),
    ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
    ...(typeof options.since === 'number' ? { since: options.since } : {}),
  });
  if (!result.ok) {
    return {
      available: false,
      reason: inboundFailureReason(result.kind),
      methodId: CHANNEL_INBOX_LIST_METHOD,
      detail: result.error,
    };
  }
  if (!isRecord(result.body) || !Array.isArray(result.body.items)) {
    return {
      available: false,
      reason: 'daemon_error',
      methodId: CHANNEL_INBOX_LIST_METHOD,
      detail: `${CHANNEL_INBOX_LIST_METHOD} answered without an items array`,
    };
  }
  const items = (result.body.items as unknown[]).filter(isRecord).map(toInboundMessageItem);
  const nextCursor = typeof result.body.nextCursor === 'string' && result.body.nextCursor.length > 0 ? result.body.nextCursor : undefined;
  return {
    available: true,
    methodId: CHANNEL_INBOX_LIST_METHOD,
    page: { items, more: result.body.hasMore === true || nextCursor !== undefined, ...(nextCursor !== undefined ? { next: nextCursor } : {}) },
    total: typeof result.body.total === 'number' ? result.body.total : items.length,
    truncated: result.body.truncated === true,
    partial: result.body.partial === true,
    providers: readInboundProviders(result.body.providers),
  };
}

/** The providers whose last sync failed (their names are the host's own provider ids). */
function failedInboundProviders(feed: Extract<InboundChannelFeedState, { readonly available: true }>): string[] {
  return feed.providers.filter((provider) => provider.state === 'error').map((provider) => provider.provider);
}

const DELIVERY_ATTENTION_STATUSES = new Set(['failed', 'dead_lettered', 'pending', 'sending']);

const INBOUND_FEED_NOT_ATTEMPTED: InboundChannelFeedState = {
  available: false,
  reason: 'not_attempted',
  methodId: CHANNEL_INBOX_LIST_METHOD,
  detail: 'no connected-host caller was supplied, so the daemon was not asked for an inbound feed',
};

// ---------------------------------------------------------------------------
// Public aggregation API
// ---------------------------------------------------------------------------

/**
 * Build a UnifiedInbox from an already-fetched AgentWorkspaceChannelTriage.
 *
 * This is intentionally a pure transformation, it does not perform any I/O.
 * The caller (command handler or tool) is responsible for calling
 * `buildAgentWorkspaceChannelTriage` first.
 */
export function aggregateUnifiedInbox(
  triage: AgentWorkspaceChannelTriage,
  options: {
    readonly limit?: number;
    /** The feed a caller already fetched. Absent means it never asked. */
    readonly inboundChannelFeed?: InboundChannelFeedState;
  } = {},
): UnifiedInbox {
  const limit = typeof options.limit === 'number' && options.limit > 0 ? Math.min(options.limit, 200) : 50;
  const inboundChannelFeed = options.inboundChannelFeed ?? INBOUND_FEED_NOT_ATTEMPTED;
  const inboundMessageItems = inboundChannelFeed.available
    ? inboundChannelFeed.page.items.slice(0, limit)
    : [];

  // --- Delivery items ---
  const deliveriesSection = triage.deliveries;
  const rawAttempts = Array.isArray(deliveriesSection.attempts)
    ? (deliveriesSection.attempts as unknown[]).filter(isRecord)
    : [];
  const deliveryItems = rawAttempts.slice(0, limit).map(toDeliveryItem);
  const deliveriesState: UnifiedInboxSourceState = deliveriesSection.state === 'unavailable'
    ? 'unavailable'
    : deliveriesSection.state === 'empty' || deliveryItems.length === 0
      ? 'empty'
      : 'ready';

  // --- Surface message items ---
  const messagesSection = triage.surfaceMessages;
  const rawMessages = Array.isArray(messagesSection.messages)
    ? (messagesSection.messages as unknown[]).filter(isRecord)
    : [];
  const surfaceMessageItems = rawMessages.slice(0, limit).map(toSurfaceMessageItem);
  const messagesState: UnifiedInboxSourceState = messagesSection.state === 'unavailable'
    ? 'unavailable'
    : messagesSection.state === 'empty' || surfaceMessageItems.length === 0
      ? 'empty'
      : 'ready';

  // --- Route binding items ---
  const bindingsSection = triage.routeBindings;
  const rawBindings = Array.isArray(bindingsSection.bindings)
    ? (bindingsSection.bindings as unknown[]).filter(isRecord)
    : [];
  const routeBindingItems = rawBindings.slice(0, limit).map(toRouteBindingItem);
  const bindingsState: UnifiedInboxSourceState = bindingsSection.state === 'unavailable'
    ? 'unavailable'
    : bindingsSection.state === 'empty' || routeBindingItems.length === 0
      ? 'empty'
      : 'ready';

  const items: UnifiedInboxItem[] = [
    ...deliveryItems,
    ...surfaceMessageItems,
    ...routeBindingItems,
    ...inboundMessageItems,
  ];

  const attentionCount = deliveryItems.filter((item) => DELIVERY_ATTENTION_STATUSES.has(item.status)).length;
  const failureCount = deliveryItems.filter((item) => item.status === 'failed' || item.status === 'dead_lettered').length;

  const sources: UnifiedInboxSource[] = [
    {
      name: 'deliveries',
      route: '/api/deliveries',
      state: deliveriesState,
      itemCount: deliveryItems.length,
      ...(deliveriesState === 'unavailable' && sectionError(deliveriesSection) ? { error: sectionError(deliveriesSection) } : {}),
    },
    {
      name: 'surface_messages',
      route: '/api/control-plane/messages',
      state: messagesState,
      itemCount: surfaceMessageItems.length,
      ...(messagesState === 'unavailable' && sectionError(messagesSection) ? { error: sectionError(messagesSection) } : {}),
    },
    {
      name: 'route_bindings',
      route: '/api/routes/bindings',
      state: bindingsState,
      itemCount: routeBindingItems.length,
      ...(bindingsState === 'unavailable' && sectionError(bindingsSection) ? { error: sectionError(bindingsSection) } : {}),
    },
    {
      name: 'inbound_messages',
      route: CHANNEL_INBOX_LIST_METHOD,
      // A provider whose sync failed makes the feed partial, never empty or ready.
      state: inboundChannelFeed.available
        ? (inboundChannelFeed.partial ? 'partial' : inboundMessageItems.length === 0 ? 'empty' : 'ready')
        : 'unavailable',
      itemCount: inboundMessageItems.length,
      ...(inboundChannelFeed.available
        ? inboundChannelFeed.partial ? { error: `provider sync failed: ${failedInboundProviders(inboundChannelFeed).join(', ') || 'a provider'}` } : {}
        : { error: inboundChannelFeed.detail }),
    },
  ];

  const blockedSources = sources.filter((s) => s.state === 'unavailable').length;
  const overallStatus: UnifiedInbox['status'] =
    blockedSources === sources.length ? 'blocked' : attentionCount > 0 || sources.some((s) => s.state === 'partial') ? 'attention' : 'ready';

  return {
    mode: 'unified_inbox',
    status: overallStatus,
    summary: {
      totalItems: items.length,
      deliveryItems: deliveryItems.length,
      surfaceMessageItems: surfaceMessageItems.length,
      routeBindingItems: routeBindingItems.length,
      inboundMessageItems: inboundMessageItems.length,
      attentionCount,
      failureCount,
    },
    items,
    sources,
    deliveryItems,
    surfaceMessageItems,
    routeBindingItems,
    inboundMessageItems,
    inboundChannelFeed,
    policy: inboundChannelFeed.available
      ? 'Read-only unified inbox. Aggregates daemon-exposed delivery attempts, control-plane surface messages, route bindings, and provider inbound messages.'
      : 'Read-only unified inbox. Aggregates daemon-exposed delivery attempts, control-plane surface messages, and route bindings. '
        + `The provider inbound feed is absent (${inboundChannelFeed.reason}); the daemon's own wording is in the inbox's formatted text.`,
  };
}

/**
 * The text in an inbox that someone outside the owner's control wrote: a
 * delivery error echoed from a provider, a surface message's title, a
 * route-binding sender name, and an inbound message's sender, subject and body.
 * One list so the model-facing frame and the exposure record a caller makes for
 * the ledger cover exactly the same text.
 */
function thirdPartyInboxLines(inbox: UnifiedInbox): readonly string[] {
  const { deliveryItems, surfaceMessageItems, routeBindingItems, inboundMessageItems } = inbox;
  const lines: string[] = [];

  const sourceErrors = inbox.sources.filter((source) => source.error && source.name !== 'inbound_messages');
  // The not-attempted detail is the product's own sentence; every other detail may be daemon text.
  const feedDetail = inbox.inboundChannelFeed.available || inbox.inboundChannelFeed.reason === 'not_attempted'
    ? ''
    : inbox.inboundChannelFeed.detail;
  if (sourceErrors.length > 0 || feedDetail) {
    lines.push('Source Errors');
    for (const source of sourceErrors) lines.push(`- ${source.name}: ${source.error}`);
    if (feedDetail) lines.push(`- inbound channel feed: ${feedDetail}`);
  }

  if (deliveryItems.length > 0) {
    lines.push('Delivery Attempts');
    for (const item of deliveryItems.slice(0, 10)) {
      const targetDesc = [item.target.surfaceKind, item.target.routeId, item.target.label].filter(Boolean).join('/');
      lines.push(`- [${item.status}] ${item.id} target=${targetDesc || item.target.kind}${item.error ? ` err=${item.error}` : ''}`);
    }
  }

  if (surfaceMessageItems.length > 0) {
    lines.push('Surface Messages');
    for (const item of surfaceMessageItems.slice(0, 10)) {
      lines.push(`- [${item.level}] ${item.surface}: ${item.title}`);
    }
  }

  if (routeBindingItems.length > 0) {
    lines.push('Route Bindings');
    for (const item of routeBindingItems.slice(0, 10)) {
      lines.push(`- ${item.id}: ${item.surfaceKind} ${item.bindingKind} sender=${item.principalLabel}`);
    }
  }

  if (inboundMessageItems.length > 0) {
    lines.push('Inbound Messages');
    for (const item of inboundMessageItems.slice(0, 10)) {
      const heading = item.subject ?? item.bodyPreview.slice(0, 60);
      lines.push(`- [${item.provider}${item.unread ? ' unread' : ''}${item.screening === 'not-screened' ? ' not screened' : ''}] ${item.from}: ${heading}`);
    }
  }

  return lines;
}

/**
 * Every piece of third-party text the inbox carries, structured items included
 * (message bodies and previews as well as the lines `formatUnifiedInbox`
 * shows). This is the text to record as an untrusted ingest when the inbox is
 * handed to the model, so outward-effect gating sees that it was read.
 */
export function unifiedInboxThirdPartyText(inbox: UnifiedInbox): string {
  return [
    ...thirdPartyInboxLines(inbox),
    ...inbox.surfaceMessageItems.map((item) => item.bodyPreview),
    ...inbox.inboundMessageItems.flatMap((item) => [item.fromAddress ?? '', item.subject ?? '', item.bodyPreview]),
    ...inbox.deliveryItems.map((item) => item.error ?? ''),
  ].filter(Boolean).join('\n');
}

/**
 * Format a UnifiedInbox for the model.
 *
 * Counts, source states and routes are the product's own words. The messages
 * and errors under them were written by others, so they are emitted only inside
 * the untrusted-content frame (see untrusted-content.ts), never in the open.
 * `thirdParty: 'elsewhere'` leaves them out and says where they are, for a
 * caller that hands the model the same text once in its own untrusted envelope.
 */
export function formatUnifiedInbox(inbox: UnifiedInbox, options: { readonly thirdParty?: 'framed' | 'elsewhere' } = {}): string {
  const { summary, sources } = inbox;
  const feed = inbox.inboundChannelFeed;
  const lines: string[] = [
    'Unified Inbox',
    `  status: ${inbox.status}`,
    `  items: ${summary.totalItems} (deliveries: ${summary.deliveryItems}, surface messages: ${summary.surfaceMessageItems}, route bindings: ${summary.routeBindingItems}, inbound: ${summary.inboundMessageItems})`,
    `  attention: ${summary.attentionCount}  failures: ${summary.failureCount}`,
    `  inbound channel feed: ${feed.available
      ? `${feed.total} message(s)${feed.truncated ? ', truncated' : ''}${feed.page.more ? ', more on the next page' : ''} via ${feed.methodId}`
        + (feed.partial ? `; partial: sync failed for ${failedInboundProviders(feed).join(', ') || 'a provider'}` : '')
      : `unavailable (${feed.reason})`}`,
    `  policy: ${inbox.policy}`,
    '',
    '  Sources',
  ];

  for (const source of sources) {
    lines.push(`  ${source.name}: ${source.state} (${source.itemCount} items) route=${source.route}`);
  }
  const notScreened = inbox.inboundMessageItems.filter((item) => item.screening === 'not-screened');
  if (notScreened.length > 0) {
    const reasons = [...new Set(notScreened.map((item) => item.screeningReason).filter((reason): reason is string => reason !== null))];
    lines.push(`  Not screened: ${notScreened.length} inbound message(s) were checked by code only${reasons.length > 0 ? ` (${reasons.join('; ')})` : ''}.`);
  }

  const thirdParty = thirdPartyInboxLines(inbox);
  if (thirdParty.length > 0 && options.thirdParty === 'elsewhere') {
    lines.push('', `  Messages, senders and errors written by others (${thirdParty.length} lines): in the untrusted envelope beside this text.`);
  } else if (thirdParty.length > 0) {
    lines.push('', renderForModel(untrustedFrom({
      surfaceId: 'channel-message',
      origin: 'unified inbox: source and delivery errors, surface messages, route-binding senders and provider inbound messages',
      text: thirdParty.join('\n'),
      receivedAt: new Date().toISOString(),
    })));
  }

  return lines.join('\n');
}
