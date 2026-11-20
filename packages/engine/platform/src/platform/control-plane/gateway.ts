import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { AnyRuntimeEvent, RuntimeEventBus, RuntimeEventDomain, RuntimeEventEnvelope } from '../runtime/events/index.js';
import { RUNTIME_EVENT_DOMAINS } from '../runtime/events/index.js';
import type { ControlPlaneClientRecord } from '../runtime/store/domains/control-plane.js';
import {
  emitControlPlaneAuthGranted,
  emitControlPlaneClientConnected,
  emitControlPlaneClientDisconnected,
  emitControlPlaneSubscriptionCreated,
  emitControlPlaneSubscriptionDropped,
  emitStreamSubscriberConnected,
  emitStreamSubscriberDisconnected,
} from '../runtime/emitters/index.js';
import { renderControlPlaneGatewayWebUi } from './gateway-web-ui.js';
import { AppError } from '../types/errors.js';
import { buildGatewayDisabledResponseBody, controlPlaneGatewaySetting } from './gateway-disabled-response.js';
import { CONTROL_PLANE_FEATURE_FLAG } from '../runtime/surface-feature-flags.js';
import { SSE_HEARTBEAT_INTERVAL_MS } from './sse-timing.js';
import {
  clientMayReceiveEventDomain,
  grantAllowsDomain,
  grantAllowsEvent,
  grantNeedsOwnedSession,
  isEmptyEventGrant,
  resolveEventGrant,
  type EventGrant,
} from './gateway-scope-enforcement.js';
import type {
  ControlPlaneClientDescriptor,
  ControlPlaneServerConfig,
  ControlPlaneStreamClientKind,
  ControlPlaneSurfaceMessage,
} from './types.js';
import { type FeatureFlagReader, isFeatureGateEnabled, requireFeatureGate } from '../runtime/feature-flags/index.js';
import {
  DEFAULT_DOMAINS,
  DEFAULT_SERVER_CONFIG,
  createScopedSessionDelivery,
  frameSessionId,
  hasReplayScope,
  normalizeRuntimeDomains,
  pruneDisconnectedClientRecords,
  readRequestedDomains,
  replayRecentTraffic,
  resolveReplayResume,
  serializeEnvelope,
  stripReplayScope,
  toClientDescriptor,
  type ControlPlaneEventReplayScope,
  type ControlPlaneRecentEvent,
  type ScopedControlPlaneRecentEvent,
} from './gateway-utils.js';
export type { ControlPlaneRecentEvent } from './gateway-utils.js';

export interface ControlPlaneGatewayConfig {
  readonly runtimeBus?: RuntimeEventBus | null | undefined;
  readonly runtimeStore?: RuntimeStore | null | undefined;
  readonly server?: Partial<ControlPlaneServerConfig> | undefined;
  readonly featureFlags?: FeatureFlagReader | undefined;
}

export interface ControlPlaneEventStreamOptions {
  readonly clientId?: string | undefined;
  readonly clientKind?: ControlPlaneStreamClientKind;
  readonly transport?: 'local' | 'http' | 'sse' | 'ws' | 'webhook' | undefined;
  readonly label?: string | undefined;
  readonly domains?: readonly RuntimeEventDomain[] | undefined;
  /**
   * The domain names a client asked for, unchecked (the `?domains=` list).
   * When given it replaces `domains`: known names are subscribed, and names
   * that are not runtime event domains are named back in the `ready` frame
   * (all of them unknown is refused).
   */
  readonly requestedDomains?: readonly string[] | undefined;
  /** Requested names a caller already found are not domains; the `ready` frame names them back. */
  readonly unrecognisedDomains?: readonly string[] | undefined;
  readonly principalId?: string | undefined;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | undefined;
  readonly scopes?: readonly string[] | undefined;
  /** Admin token, scopes collapse; sees all channels. */
  readonly admin?: boolean | undefined;
  readonly sessionId?: string | undefined;
  /** Deliver only `sessionId`'s frames; see {@link createScopedSessionDelivery}. */
  readonly sessionScopedDelivery?: boolean | undefined;
  readonly routeId?: string | undefined;
  readonly surfaceId?: string | undefined;
  readonly remoteAddress?: string | undefined;
  readonly capabilities?: readonly string[] | undefined;
  /** SSE keep-alive interval (ms); defaults to SSE_HEARTBEAT_INTERVAL_MS. First heartbeat always fires on open. */
  readonly heartbeatIntervalMs?: number | undefined;
  /**
   * Whether the credential the stream opened with is still valid, asked before
   * every frame (an integer compare until the daemon's authentication moves).
   * False closes the stream with a `closed` frame naming the reason.
   */
  readonly isAuthorized?: (() => boolean) | undefined;
}

/** What a stream or socket closed for a revoked credential tells its client. */
const CREDENTIAL_REVOKED_FRAME = Object.freeze({
  reason: 'credential-revoked',
  next: 'Sign in again or pair this device again, then reconnect.',
});

interface LiveControlPlaneClient {
  readonly clientId: string;
  readonly kind: ControlPlaneStreamClientKind;
  readonly surfaceId?: string | undefined;
  readonly routeId?: string | undefined;
  /** What this client may receive, resolved when it subscribed or last authenticated. */
  grant: EventGrant;
  /**
   * Subscribed domains for the broadcast (`publishEvent`) fan-out. `null` =
   * deliver-all (client did not opt into narrowing); a non-null set narrows to
   * tagged events in the set. For WS this is a live ref to the subscription set.
   */
  domains: ReadonlySet<RuntimeEventDomain> | null;
  readonly send: (event: string, payload: unknown, id?: string) => void;
  /** The authenticated principal the connection belongs to, for {@link ControlPlaneGateway.closeClientsOf}; an in-band auth frame sets it. */
  principalId?: string | undefined;
  /** Ends the connection from the daemon side. */
  readonly close?: ((reason: string) => void) | undefined;
  /**
   * Asked before each frame is filtered for this client: false skips it (the
   * owner has ended the client). The owner may narrow `grant` inside it (its
   * credential's rights shrank), so the filter that follows uses the grant in
   * force when the frame is sent, never the one from when it subscribed.
   */
  readonly current?: (() => boolean) | undefined;
}

const sseEncoder = new TextEncoder();
/**
 * The encoded SSE frame of a delivered event, kept per payload object: one
 * event fans out to every stream with the same payload object and id, so it
 * is serialised and encoded once, not once per client.
 */
const sseFrames = new WeakMap<object, { readonly event: string; readonly id: string | undefined; readonly bytes: Uint8Array }>();
function sseFrame(event: string, payload: unknown, id?: string): Uint8Array {
  const encode = () => sseEncoder.encode(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  if (payload === null || typeof payload !== 'object') return encode();
  const kept = sseFrames.get(payload);
  if (kept && kept.event === event && kept.id === id) return kept.bytes;
  const bytes = encode();
  sseFrames.set(payload, { event, id, bytes });
  return bytes;
}

interface WebSocketControlPlaneClient {
  readonly clientId: string;
  readonly traceId: string;
  readonly domains: Set<RuntimeEventDomain>;
  readonly unsubscribers: Map<RuntimeEventDomain, () => void>;
  /** Turns whose full text this socket has received; their next deltas carry only the increment. */
  readonly streamBases: Set<string>;
}

/** How a retained runtime event goes out live: a stream delta's increment form, or the turn it ends. */
interface StreamDeltaWire {
  readonly turnId: string;
  /** The payload without `accumulated`; absent when this delta is a resync point. */
  readonly increment?: Record<string, unknown> | undefined;
  readonly ends?: true | undefined;
}

const STREAM_TURN_END_EVENTS: ReadonlySet<string> = new Set(['TURN_COMPLETED', 'TURN_ERROR', 'TURN_CANCEL', 'PREFLIGHT_FAIL']);
/** A delta carries the full text again once the text grew this much past the last full frame (and at least doubled). */
const STREAM_RESYNC_MIN_GROWTH = 4096;
/** Turns tracked at once, by the gateway and per connection. */
const STREAM_TURNS_TRACKED = 256;

function trackBounded<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > STREAM_TURNS_TRACKED) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export class ControlPlaneGateway {
  private runtimeBus: RuntimeEventBus | null;
  private dispatch: DomainDispatch | null;
  private readonly serverConfig: ControlPlaneServerConfig;
  private readonly featureFlags: FeatureFlagReader;
  private readonly clients = new Map<string, ControlPlaneClientRecord>();
  private readonly liveClients = new Map<string, LiveControlPlaneClient>();
  private readonly websocketClients = new Map<string, WebSocketControlPlaneClient>();
  /** One controller per principal that has a signal handed out; removed when revoked. */
  private readonly principalRevocations = new Map<string, AbortController>();
  /** Whether a principal created or joined a session; set by the composition that hosts sessions. Absent: no session is anyone's own. */
  private sessionOwnedBy: ((sessionId: string, principalId: string) => boolean) | null = null;
  private readonly recentMessages: ControlPlaneSurfaceMessage[] = [];
  private readonly _recentEventsRing: (ScopedControlPlaneRecentEvent | undefined)[];
  private _recentEventsHead = 0;
  private _recentEventsCount = 0;
  private readonly _recentEventsCapacity = 500;
  /** One replay entry/id per bus emission, shared by its host and live readers. */
  private readonly runtimeEventRecords = new WeakMap<RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>, ScopedControlPlaneRecentEvent>();
  /** Live wire form of each retained stream delta / turn end, decided once per emission. */
  private readonly streamDeltaWires = new WeakMap<ScopedControlPlaneRecentEvent, StreamDeltaWire>();
  /** Per streaming turn: the text length so far and the length at its last full frame. */
  private readonly streamTurns = new Map<string, { readonly length: number; readonly fullLength: number }>();
  /** Materialized newest-first view of the recent event ring buffer. */
  private get recentEvents(): ScopedControlPlaneRecentEvent[] {
    const out: ScopedControlPlaneRecentEvent[] = [];
    const count = this._recentEventsCount;
    const cap = this._recentEventsCapacity;
    for (let i = 0; i < count; i++) {
      const idx = (this._recentEventsHead - 1 - i + cap) % cap;
      const entry = this._recentEventsRing[idx]!;
      if (entry) {
        out.push(entry);
      } else if (process.env.NODE_ENV !== 'production') {
        logger.error('[ControlPlaneGateway] recentEvents: undefined slot at ring index', { head: this._recentEventsHead, count: this._recentEventsCount, index: idx, offset: i });
      }
    }
    return out;
  }
  /*
   * Liveness (request and error counts, last request and event times, each
   * client's last-seen time and last event) is owned here and read from here.
   * It reaches the runtime store only with a connect, an authentication or a
   * disconnect: a delivered event or an answered request is a field
   * assignment, not a store transaction that wakes every subscriber.
   */
  private requestCount = 0;
  private errorCount = 0;
  private lastRequestAt: number | undefined;
  private _lastEventAt = 0;

  constructor(config: ControlPlaneGatewayConfig = {}) {
    this._recentEventsRing = new Array(this._recentEventsCapacity);
    this.runtimeBus = config.runtimeBus ?? null;
    this.dispatch = config.runtimeStore ? createDomainDispatch(config.runtimeStore) : null;
    this.featureFlags = config.featureFlags ?? null;
    this.serverConfig = {
      ...DEFAULT_SERVER_CONFIG,
      ...config.server,
    };
    if (this.dispatch) {
      this.dispatch.syncControlPlaneState({
        enabled: this.isEnabled() && this.serverConfig.enabled,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: this.isEnabled() && this.serverConfig.enabled ? 'disconnected' : 'disabled',
      }, 'control-plane.gateway.init');
    }
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, CONTROL_PLANE_FEATURE_FLAG);
  }

  private requireEnabled(operation: string): void {
    requireFeatureGate(this.featureFlags, CONTROL_PLANE_FEATURE_FLAG, operation);
  }

  attachRuntime(config: {
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
    readonly runtimeStore?: RuntimeStore | null | undefined;
  }): void {
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
    if (config.runtimeStore) {
      this.dispatch = createDomainDispatch(config.runtimeStore);
      this.dispatch.syncControlPlaneState({
        enabled: this.isEnabled() && this.serverConfig.enabled,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: this.isEnabled() && this.serverConfig.enabled ? 'disconnected' : 'disabled',
      }, 'control-plane.gateway.attach');
      for (const client of this.clients.values()) {
        this.dispatch.syncControlPlaneClient(client, 'control-plane.gateway.attach');
      }
    }
  }

  /**
   * Whether the client's connection is open right now. `listClients` also lists
   * clients that disconnected recently, so a lease probe must ask this instead.
   */
  isClientConnected(clientId: string): boolean {
    return this.isEnabled() && this.clients.get(clientId)?.connected === true;
  }

  listClients(): ControlPlaneClientDescriptor[] {
    if (!this.isEnabled()) return [];
    pruneDisconnectedClientRecords(this.clients);
    return [...this.clients.values()]
      .sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) || a.id.localeCompare(b.id))
      .map(toClientDescriptor);
  }

  getSnapshot(): Record<string, unknown> {
    if (!this.isEnabled()) {
      return {
        server: { ...this.serverConfig, enabled: false },
        disabled: true,
        setting: controlPlaneGatewaySetting(),
        totals: {
          clients: 0,
          activeClients: 0,
          surfaceMessages: 0,
          recentEvents: 0,
          requests: 0,
          errors: 0,
        },
        clients: [],
        messages: [],
        recentEvents: [],
      };
    }
    pruneDisconnectedClientRecords(this.clients);
    const active = [...this.clients.values()].filter((client) => client.connected);
    return {
      server: this.serverConfig,
      totals: {
        clients: this.clients.size,
        activeClients: active.length,
        surfaceMessages: this.recentMessages.length,
        recentEvents: this._recentEventsCount,
        requests: this.requestCount,
        errors: this.errorCount,
      },
      clients: this.listClients(),
      messages: this.listSurfaceMessages(20),
      recentEvents: this.listRecentEvents(30),
    };
  }

  listSurfaceMessages(limit = 50): ControlPlaneSurfaceMessage[] {
    if (!this.isEnabled()) return [];
    return this.recentMessages.slice(0, Math.max(1, limit));
  }

  listRecentEvents(limit = 100): ControlPlaneRecentEvent[] {
    if (!this.isEnabled()) return [];
    return this.recentEvents.slice(0, Math.max(1, limit)).map(stripReplayScope);
  }

  publishSurfaceMessage(input: Omit<ControlPlaneSurfaceMessage, 'id' | 'createdAt'>): ControlPlaneSurfaceMessage {
    this.requireEnabled('publish surface message');
    const message: ControlPlaneSurfaceMessage = {
      id: `cpmsg-${randomUUID().slice(0, 8)}`,
      createdAt: Date.now(),
      ...input,
    };
    this.recentMessages.unshift(message);
    if (this.recentMessages.length > 200) {
      this.recentMessages.length = 200;
    }
    const record = this.rememberEvent('surface-message', message, {
      ...(message.clientId ? { clientId: message.clientId } : {}),
      ...(message.routeId ? { routeId: message.routeId } : {}),
      ...(message.surfaceId ? { surfaceId: message.surfaceId } : {}),
    });
    for (const client of this.liveClients.values()) {
      if (client.kind !== 'web') continue;
      if (message.clientId && client.clientId !== message.clientId) continue;
      if (message.routeId && client.routeId !== message.routeId) continue;
      if (message.surfaceId && client.surfaceId !== message.surfaceId) continue;
      if (client.current && !client.current()) continue;
      if (!grantAllowsEvent(client.grant, 'surface-message', Boolean(message.clientId))) continue;
      client.send('surface-message', message, record.id);
    }
    return message;
  }

  /**
   * How the gateway learns which sessions a principal owns, for clients that
   * watch their own sessions (`read:own-sessions`). One in-memory lookup per
   * frame, only for such clients.
   */
  setSessionOwnership(ownedBy: ((sessionId: string, principalId: string) => boolean) | null): void {
    this.sessionOwnedBy = ownedBy;
  }

  /** Whether a frame belongs to a session `principalId` owns; a frame naming no session belongs to none. */
  private ownsFrame(principalId: string | undefined, sessionId: string | undefined): boolean {
    if (principalId === undefined || sessionId === undefined || !this.sessionOwnedBy) return false;
    try {
      return this.sessionOwnedBy(sessionId, principalId);
    } catch {
      return false;
    }
  }

  publishEvent(event: string, payload: unknown, filter?: {
    readonly clientKind?: LiveControlPlaneClient['kind'] | undefined;
    readonly clientId?: string | undefined;
    readonly clientIdPrefix?: string | undefined;
    readonly routeId?: string | undefined;
    readonly surfaceId?: string | undefined;
  }): void {
    if (!this.isEnabled()) return;
    const record = this.rememberEvent(event, payload, filter);
    const addressed = Boolean(filter?.clientId || filter?.clientIdPrefix);
    for (const client of this.liveClients.values()) {
      if (filter?.clientKind && client.kind !== filter.clientKind) continue;
      if (filter?.clientId && client.clientId !== filter.clientId) continue;
      if (filter?.clientIdPrefix && !client.clientId.startsWith(filter.clientIdPrefix)) continue;
      if (filter?.routeId && client.routeId !== filter.routeId) continue;
      if (filter?.surfaceId && client.surfaceId !== filter.surfaceId) continue;
      if (client.current && !client.current()) continue;
      if (!grantAllowsEvent(client.grant, event, addressed)) continue;
      if (grantNeedsOwnedSession(client.grant, event) && !this.ownsFrame(client.principalId, ownedFrameSessionId(payload))) continue;
      // Domain filter, AND-ed with the grant (null = deliver-all; untagged = delivered).
      if (!clientMayReceiveEventDomain(client.domains, event)) continue;
      client.send(event, payload, record.id);
    }
  }

  /**
   * Retain an owned runtime frame before any client subscribes. This does not
   * broadcast: the existing domain subscriptions remain the sole live path.
   */
  retainRuntimeEvent(domain: 'turn' | 'tools', envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>): void {
    if (!this.isEnabled()) return;
    this.rememberRuntimeEvent(domain, envelope);
  }

  recordApiRequest(input: {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly clientKind?: ControlPlaneEventStreamOptions['clientKind'] | undefined;
    readonly error?: string | undefined;
  }): void {
    if (!this.isEnabled()) return;
    this.requestCount += 1;
    this.lastRequestAt = Date.now();
    if (input.status >= 400 || input.error) {
      this.errorCount += 1;
    }
    this.rememberEvent('api-request', {
      method: input.method,
      path: input.path,
      status: input.status,
      clientKind: input.clientKind ?? 'web',
      ...(input.error ? { error: input.error } : {}),
    });
  }

  /**
   * `listening` is whether the host's listener is bound right now, which only
   * the host knows; omitted (a settings-only patch) leaves isRunning as it is.
   */
  setServerState(patch: Partial<ControlPlaneServerConfig>, listening?: boolean): void {
    if (!this.isEnabled()) {
      Object.assign(this.serverConfig, { ...patch, enabled: false });
      this.dispatch?.syncControlPlaneState({
        enabled: false,
        host: this.serverConfig.host,
        port: this.serverConfig.port,
        connectionState: 'disabled',
        isRunning: false,
      }, 'control-plane.gateway.state.disabled');
      return;
    }
    Object.assign(this.serverConfig, patch);
    const hasActiveClient = [...this.clients.values()].some((client) => client.connected);
    this.dispatch?.syncControlPlaneState({
      enabled: this.serverConfig.enabled,
      host: this.serverConfig.host,
      port: this.serverConfig.port,
      ...(listening !== undefined ? { isRunning: listening && this.serverConfig.enabled } : {}),
      connectionState: this.serverConfig.enabled ? (hasActiveClient ? 'connected' : 'disconnected') : 'disabled',
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      lastRequestAt: this.lastRequestAt,
    }, 'control-plane.gateway.state');
  }

  /**
   * Aborts when {@link closeClientsOf} revokes `principalId`. A request
   * context joins it to the request's own signal, so work started for a
   * credential stops when the credential is revoked.
   */
  principalSignal(principalId: string): AbortSignal {
    let revocation = this.principalRevocations.get(principalId);
    if (!revocation) { revocation = new AbortController(); this.principalRevocations.set(principalId, revocation); }
    return revocation.signal;
  }

  /**
   * The one revocation path: close every socket and event stream of
   * `principalId` and abort the requests it has in flight. Called by the owner
   * of the credential (pairing store, local auth) when it stops being valid.
   * Returns how many connections were closed.
   */
  closeClientsOf(principalId: string, reason = CREDENTIAL_REVOKED_FRAME.reason): number {
    const revocation = this.principalRevocations.get(principalId);
    this.principalRevocations.delete(principalId);
    revocation?.abort(new AppError(`The credential for ${principalId} was revoked.`, 'AUTH_REQUIRED', false, {
      category: 'authentication', source: 'runtime', statusCode: 401, guidance: CREDENTIAL_REVOKED_FRAME.next,
    }));
    let closed = 0;
    for (const client of [...this.liveClients.values()]) {
      if (client.principalId !== principalId || !client.close) continue;
      client.close(reason);
      closed++;
    }
    return closed;
  }

  openWebSocketClient(
    options: ControlPlaneEventStreamOptions,
    send: (event: string, payload: unknown, id?: string) => void,
    /** Ends the socket from the daemon side (revocation). */
    close?: (reason: string) => void,
    /** See {@link LiveControlPlaneClient.current}: the socket's credential checked (and its grant narrowed) before each frame is filtered. */
    current?: () => boolean,
  ): { clientId: string; domains: readonly RuntimeEventDomain[] } {
    this.requireEnabled('open websocket client');
    if (!this.runtimeBus) {
      throw new Error('Runtime event bus unavailable');
    }

    const grant = resolveEventGrant({ admin: options.admin, scopes: options.scopes });
    const selectedDomains = normalizeRuntimeDomains(options.domains).filter((domain) => grantAllowsDomain(grant, domain));
    const clientId = options.clientId ?? `cp-${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.clientKind ?? 'web'}:${clientId}`;
    const now = Date.now();
    const surfaceKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    const clientRecord: ControlPlaneClientRecord = {
      id: clientId,
      kind: surfaceKind,
      label,
      transport: 'websocket',
      connected: true,
      sessionId: options.sessionId,
      routeId: options.routeId,
      surfaceId: options.surfaceId,
      authenticatedAt: now,
      lastSeenAt: now,
      remoteAddress: options.remoteAddress,
      capabilities: [...(options.capabilities ?? [])],
      metadata: {
        domains: selectedDomains,
        ...(options.principalId ? { userId: options.principalId } : {}),
      },
    };
    const traceId = `control-plane:${clientId}`;
    // Live ref to the WS subscription set, shared with the liveClient (null = deliver-all).
    const wsDomains = new Set<RuntimeEventDomain>();
    const explicitDomains = (options.domains?.length ?? 0) > 0;
    this.clients.set(clientId, clientRecord);
    this.liveClients.set(clientId, {
      clientId,
      kind: options.clientKind ?? 'web',
      surfaceId: options.surfaceId,
      routeId: options.routeId,
      grant,
      domains: explicitDomains ? wsDomains : null,
      send,
      principalId: options.principalId,
      close,
      current,
    });
    this.websocketClients.set(clientId, {
      clientId,
      traceId,
      domains: wsDomains,
      unsubscribers: new Map(),
      streamBases: new Set(),
    });
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: 'connected',
      ...this.livenessCounters(),
    }, 'control-plane.gateway.ws-connect');
    this.dispatch?.syncControlPlaneClient(clientRecord, 'control-plane.gateway.ws-connect');

    const eventClientKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    emitControlPlaneClientConnected(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      clientKind: eventClientKind,
      transport: 'ws',
    });
    emitControlPlaneSubscriptionCreated(this.runtimeBus, {
      sessionId: options.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId,
    }, {
      clientId,
      subscriptionId: clientId,
      topics: selectedDomains,
    });
    if (options.principalId) {
      emitControlPlaneAuthGranted(this.runtimeBus, {
        sessionId: options.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId,
      }, {
        clientId,
        principalId: options.principalId,
        principalKind: options.principalKind ?? 'token',
        scopes: [...(options.scopes ?? ['read:events'])],
      });
    }

    this.subscribeWebSocketClient(clientId, selectedDomains);
    // Initial default subscriptions retain the historical broadcast-all mode.
    // Later explicit subscription changes narrow to the live subscription set.
    if (!explicitDomains) this.liveClients.get(clientId)!.domains = null;
    send('ready', {
      clientId,
      domains: selectedDomains,
      transport: 'websocket',
      ...(options.unrecognisedDomains?.length ? { unrecognisedDomains: [...options.unrecognisedDomains] } : {}),
    });
    replayRecentTraffic(this.recentEventsFor(grant, options.principalId), send, { ...options, clientId, domains: selectedDomains }, explicitDomains ? wsDomains : null);
    return { clientId, domains: selectedDomains };
  }

  touchWebSocketClient(clientId: string, metadata: Record<string, unknown> = {}): void {
    if (!this.isEnabled()) return;
    const existing = this.clients.get(clientId);
    if (!existing) return;
    const updated: ControlPlaneClientRecord = {
      ...existing,
      lastSeenAt: Date.now(),
      metadata: {
        ...existing.metadata,
        ...metadata,
      },
    };
    this.clients.set(clientId, updated);
  }

  authenticateClient(clientId: string, input: {
    readonly principalId: string;
    readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | undefined;
    readonly scopes?: readonly string[] | undefined;
    readonly admin?: boolean | undefined;
    readonly label?: string | undefined;
    readonly capabilities?: readonly string[] | undefined;
  }): void {
    if (!this.isEnabled()) return;
    const existing = this.clients.get(clientId);
    if (!existing || !this.runtimeBus) return;
    this.regrantClient(clientId, { admin: input.admin === true, scopes: input.scopes ?? [] });
    const liveClient = this.liveClients.get(clientId);
    if (liveClient) liveClient.principalId = input.principalId;
    const updated: ControlPlaneClientRecord = {
      ...existing,
      label: input.label ?? existing.label,
      authenticatedAt: Date.now(),
      lastSeenAt: Date.now(),
      capabilities: input.capabilities ? [...input.capabilities] : existing.capabilities,
      metadata: {
        ...existing.metadata,
        userId: input.principalId,
      },
    };
    this.clients.set(clientId, updated);
    this.dispatch?.syncControlPlaneClient(updated, 'control-plane.gateway.ws-auth');
    emitControlPlaneAuthGranted(this.runtimeBus, {
      sessionId: updated.sessionId ?? 'control-plane',
      source: 'control-plane.gateway',
      traceId: `control-plane:${clientId}:auth`,
    }, {
      clientId,
      principalId: input.principalId,
      principalKind: input.principalKind ?? 'token',
      scopes: [...(input.scopes ?? ['read:events'])],
    });
  }

  subscribeWebSocketClient(clientId: string, domains: readonly RuntimeEventDomain[]): void {
    if (!this.isEnabled()) return;
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient || !this.runtimeBus) return;
    const liveClient = this.liveClients.get(clientId);
    if (!liveClient) return;
    liveClient.domains = wsClient.domains;
    const nextDomains = [...new Set(domains)].filter((domain) => grantAllowsDomain(liveClient.grant, domain));
    for (const domain of nextDomains) {
      if (wsClient.unsubscribers.has(domain)) continue;
      const unsubscribe = this.runtimeBus.onDomain(domain, (envelope) => {
        // A credential narrowed since the subscription may no longer cover this domain (the narrowing unsubscribes it for later frames).
        if (liveClient.current && (!liveClient.current() || !grantAllowsDomain(liveClient.grant, domain))) return;
        if (grantNeedsOwnedSession(liveClient.grant, domain) && !this.ownsFrame(liveClient.principalId, envelope.sessionId)) return;
        this.touchWebSocketClient(clientId, { lastEventType: envelope.type });
        const record = this.rememberRuntimeEvent(domain, envelope);
        liveClient.send(domain, this.liveRuntimePayload(record, wsClient.streamBases), record.id);
      });
      wsClient.unsubscribers.set(domain, unsubscribe);
      wsClient.domains.add(domain);
    }
    this.touchWebSocketClient(clientId, { domains: [...wsClient.domains] });
  }

  unsubscribeWebSocketClient(clientId: string, domains?: readonly RuntimeEventDomain[]): void {
    if (!this.isEnabled()) return;
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    const liveClient = this.liveClients.get(clientId);
    if (liveClient) liveClient.domains = wsClient.domains;
    const targetDomains = domains?.length ? [...new Set(domains)] : [...wsClient.domains];
    for (const domain of targetDomains) {
      const unsubscribe = wsClient.unsubscribers.get(domain);
      unsubscribe?.();
      wsClient.unsubscribers.delete(domain);
      wsClient.domains.delete(domain);
    }
    this.touchWebSocketClient(clientId, { domains: [...wsClient.domains] });
  }

  /**
   * Pass the `send` the socket was opened with when the client id can be
   * reused: a socket that has since been replaced by a newer one on the same id
   * then closes without disconnecting its successor.
   */
  closeWebSocketClient(clientId: string, reason = 'socket-closed', send?: (event: string, payload: unknown, id?: string) => void): void {
    if (!this.isEnabled()) return;
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    if (send && this.liveClients.get(clientId)?.send !== send) return;
    if (this.runtimeBus) {
      emitControlPlaneSubscriptionDropped(this.runtimeBus, {
        sessionId: this.clients.get(clientId)?.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId: wsClient.traceId,
      }, {
        clientId,
        subscriptionId: clientId,
        reason,
      });
      emitControlPlaneClientDisconnected(this.runtimeBus, {
        sessionId: this.clients.get(clientId)?.sessionId ?? 'control-plane',
        source: 'control-plane.gateway',
        traceId: wsClient.traceId,
      }, {
        clientId,
        reason,
      });
    }
    this.unsubscribeWebSocketClient(clientId);
    this.websocketClients.delete(clientId);
    this.liveClients.delete(clientId);
    const previous = this.clients.get(clientId);
    if (!previous) return;
    const disconnected: ControlPlaneClientRecord = {
      ...previous,
      connected: false,
      lastSeenAt: Date.now(),
    };
    this.clients.set(clientId, disconnected);
    pruneDisconnectedClientRecords(this.clients);
    this.dispatch?.syncControlPlaneClient(disconnected, 'control-plane.gateway.ws-disconnect');
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: [...this.clients.values()].some((client) => client.connected) ? 'connected' : 'disconnected',
      ...this.livenessCounters(),
    }, 'control-plane.gateway.ws-disconnect');
  }

  createEventStream(request: Request, options: ControlPlaneEventStreamOptions = {}): Response {
    if (!this.isEnabled()) {
      return Response.json(buildGatewayDisabledResponseBody(), { status: 503 });
    }
    if (!this.runtimeBus) {
      return Response.json({ error: 'Runtime event bus unavailable' }, { status: 503 });
    }

    const asked = options.requestedDomains !== undefined
      ? readRequestedDomains(options.requestedDomains)
      : { domains: [...(options.domains ?? [])], unrecognised: [] as string[] };
    if (asked.unrecognised.length > 0 && asked.domains.length === 0) {
      // Nothing asked for exists; opening the default set instead would answer a different question.
      return Response.json({
        error: `No runtime event domain is named ${asked.unrecognised.join(', ')}.`,
        code: 'UNKNOWN_EVENT_DOMAIN',
        category: 'bad_request',
        status: 400,
        state: 'the event stream was not opened',
        next: [`Open the stream with domains from: ${RUNTIME_EVENT_DOMAINS.join(', ')}.`],
        unrecognisedDomains: asked.unrecognised,
      }, { status: 400 });
    }
    options = { ...options, domains: asked.domains };
    const grant = resolveEventGrant({ admin: options.admin, scopes: options.scopes });
    const requestedDomains = normalizeRuntimeDomains(options.domains);
    const selectedDomains = requestedDomains.filter((domain) => grantAllowsDomain(grant, domain));
    const withheld = requestedDomains.filter((domain) => !grantAllowsDomain(grant, domain));
    if (isEmptyEventGrant(grant) || ((options.domains?.length ?? 0) > 0 && selectedDomains.length === 0)) {
      return Response.json({
        error: isEmptyEventGrant(grant)
          ? 'This credential may not receive any control-plane events.'
          : `This credential may not receive the requested event domains: ${withheld.join(', ')}.`,
        code: 'EVENT_ACCESS_DENIED',
        category: 'authorization',
        status: 403,
        state: 'the event stream was not opened',
        next: ['Sign in as an admin, or open the stream with domains this credential may read.'],
        ...(withheld.length > 0 ? { withheldDomains: withheld } : {}),
      }, { status: 403 });
    }
    const lastEventId = request.headers.get('last-event-id')?.trim() || undefined;
    const clientId = options.clientId ?? `cp-${randomUUID().slice(0, 8)}`;
    const label = options.label ?? `${options.clientKind ?? 'web'}:${clientId}`;
    const now = Date.now();
    const transport = options.transport ?? 'sse';
    const surfaceKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    const clientRecord: ControlPlaneClientRecord = {
      id: clientId,
      kind: surfaceKind,
      label,
      transport: transport === 'ws' ? 'websocket' : transport === 'local' ? 'local' : 'sse',
      connected: true,
      sessionId: options.sessionId,
      routeId: options.routeId,
      surfaceId: options.surfaceId,
      authenticatedAt: now,
      lastSeenAt: now,
      remoteAddress: options.remoteAddress,
      capabilities: [...(options.capabilities ?? [])],
      metadata: {
        domains: selectedDomains,
        ...(options.principalId ? { userId: options.principalId } : {}),
      },
    };
    this.clients.set(clientId, clientRecord);
    this.dispatch?.syncControlPlaneState({
      enabled: true,
      isRunning: true,
      connectionState: 'connected',
      ...this.livenessCounters(),
    }, 'control-plane.gateway.connect');
    this.dispatch?.syncControlPlaneClient(clientRecord, 'control-plane.gateway.connect');

    const traceId = `control-plane:${clientId}`;
    const eventClientKind = options.clientKind === 'daemon' ? 'service' : (options.clientKind ?? 'web');
    // One shared event context for every control-plane lifecycle emit below.
    const evtCtx = { sessionId: options.sessionId ?? 'control-plane', source: 'control-plane.gateway', traceId };
    emitControlPlaneClientConnected(this.runtimeBus, evtCtx, {
      clientId,
      clientKind: eventClientKind,
      transport,
    });
    emitControlPlaneSubscriptionCreated(this.runtimeBus, evtCtx, {
      clientId,
      subscriptionId: clientId,
      topics: selectedDomains,
    });
    if (options.principalId) {
      emitControlPlaneAuthGranted(this.runtimeBus, evtCtx, {
        clientId,
        principalId: options.principalId,
        principalKind: options.principalKind ?? 'token',
        scopes: [...(options.scopes ?? ['read:events'])],
      });
    }

    // One predicate for live delivery AND replay, so they cannot drift apart.
    const scoped = createScopedSessionDelivery(options.sessionScopedDelivery === true ? options.sessionId : undefined);
    let teardown = (): void => {};
    // HWM 256 (default 1 drops handshake/replay chunks before the consumer pulls).
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // Events dropped while the consumer was behind. The next frame that
        // fits is preceded by a `gap` event naming the last id that was
        // delivered, so the client can reconnect with Last-Event-ID instead of
        // waiting on a stream that only looks healthy.
        let dropped = 0;
        let lastDeliveredId: string | undefined;
        // Turns whose full text this stream has received; emptied when a frame is dropped.
        const streamBases = new Set<string>();
        const write = (event: string, payload: unknown, id?: string): void => {
          controller.enqueue(sseFrame(event, payload, id));
        };
        // Set once the teardown below exists; ends the stream from the daemon side.
        let closeFromDaemon = (_reason: string): void => {};
        const rawSend = (event: string, payload: unknown, id?: string): void => {
          if (options.isAuthorized && !options.isAuthorized()) {
            closeFromDaemon(CREDENTIAL_REVOKED_FRAME.reason);
            return;
          }
          // Backpressure guard: drop when the consumer is falling behind (desiredSize<=0).
          if ((controller.desiredSize ?? 1) <= 0) {
            if (dropped === 0) logger.warn('Control-plane stream consumer is behind; dropping events', { clientId, event });
            dropped += 1;
            streamBases.clear();
            return;
          }
          if (dropped > 0) {
            write('gap', { dropped, ...(lastDeliveredId ? { afterId: lastDeliveredId } : {}) });
            dropped = 0;
          }
          write(event, payload, id);
          if (id) lastDeliveredId = id;
        };
        // Live broadcasts and replay both go through the stream's session rule.
        const send = scoped.wrapSend(rawSend);
        const unsubs = selectedDomains.map((domain) => this.runtimeBus!.onDomain(domain, (envelope) => {
          if (!scoped.mayDeliver(envelope.sessionId)) return;
          if (grantNeedsOwnedSession(grant, domain) && !this.ownsFrame(options.principalId, envelope.sessionId)) return;
          const updated: ControlPlaneClientRecord = {
            ...clientRecord,
            lastSeenAt: Date.now(),
            metadata: {
              ...clientRecord.metadata,
              lastEventType: envelope.type,
            },
          };
          this.clients.set(clientId, updated);
          const record = this.rememberRuntimeEvent(domain, envelope);
          send(domain, this.liveRuntimePayload(record, streamBases), record.id);
        }));
        // Opt-in narrowing (null=deliver-all, never the DEFAULT_DOMAINS fallback); reused below for replay.
        const sseLiveDomains = (options.domains?.length ?? 0) > 0 ? new Set(selectedDomains) : null;
        this.liveClients.set(clientId, {
          clientId,
          kind: options.clientKind ?? 'web',
          surfaceId: options.surfaceId,
          routeId: options.routeId,
          grant,
          domains: sseLiveDomains,
          send,
          principalId: options.principalId,
          close: (reason) => closeFromDaemon(reason),
        });
        emitStreamSubscriberConnected(this.runtimeBus!, evtCtx, {
          streamId: clientId,
          subscriberId: clientId,
          streamType: transport,
        });
        const emitHeartbeat = (): void => rawSend('heartbeat', { clientId, ts: Date.now() });
        const heartbeatIntervalMs = options.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
        const heartbeat = setInterval(emitHeartbeat, heartbeatIntervalMs);
        (heartbeat as unknown as { unref?: () => void }).unref?.();
        let torn = false;
        teardown = () => {
          if (torn) return; // idempotent: cancel + abort can both fire.
          torn = true;
          clearInterval(heartbeat);
          for (const unsub of unsubs) unsub();
          // A newer stream may have taken this client id (a reconnect or a second
          // tab on the same session). Only the stream that still owns the entry
          // removes it or reports the client as disconnected.
          if (this.liveClients.get(clientId)?.send !== send) return;
          this.liveClients.delete(clientId);
          const previous = this.clients.get(clientId);
          if (previous) {
            const disconnected: ControlPlaneClientRecord = {
              ...previous,
              connected: false,
              lastSeenAt: Date.now(),
            };
            this.clients.set(clientId, disconnected);
            pruneDisconnectedClientRecords(this.clients);
            this.dispatch?.syncControlPlaneClient(disconnected, 'control-plane.gateway.disconnect');
            this.dispatch?.syncControlPlaneState({
              enabled: true,
              isRunning: true,
              connectionState: [...this.clients.values()].some((client) => client.connected) ? 'connected' : 'disconnected',
              ...this.livenessCounters(),
            }, 'control-plane.gateway.disconnect');
            emitControlPlaneSubscriptionDropped(this.runtimeBus!, evtCtx, {
              clientId,
              subscriptionId: clientId,
              reason: 'stream-closed',
            });
            emitControlPlaneClientDisconnected(this.runtimeBus!, evtCtx, {
              clientId,
              reason: 'stream-closed',
            });
            emitStreamSubscriberDisconnected(this.runtimeBus!, evtCtx, {
              streamId: clientId,
              subscriberId: clientId,
              streamType: transport,
              reason: 'stream-closed',
            });
          }
        };
        const onAbort = (): void => {
          teardown();
          // cancel may have already closed the controller; closing twice throws.
          try { controller.close(); } catch { /* already closed by cancel */ }
        };
        closeFromDaemon = (reason) => {
          if (torn) return;
          // The last frame says why the stream ended and what to do, so the client does not just retry.
          try { write('closed', { ...CREDENTIAL_REVOKED_FRAME, reason }); } catch { /* consumer already gone */ }
          onAbort();
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        // An already-aborted request never fires the event, and the reader that
        // would call cancel never starts: release everything now.
        if (request.signal.aborted) {
          onAbort();
          return;
        }
        // A resuming client is told what its position turned into BEFORE any
        // replay lands, so "I asked to resume and received nothing" is a stated
        // outcome rather than something it has to infer from silence.
        const replayable = this.recentEventsFor(grant, options.principalId);
        rawSend('ready', {
          clientId,
          domains: selectedDomains,
          transport: 'sse',
          ...(withheld.length > 0 ? { withheldDomains: withheld } : {}),
          // Names the client asked for that are not domains: nothing will arrive for them.
          ...(asked.unrecognised.length > 0 ? { unrecognisedDomains: asked.unrecognised } : {}),
          resume: resolveReplayResume(replayable, lastEventId),
        });
        replayRecentTraffic(replayable, send, { ...options, clientId, domains: selectedDomains }, sseLiveDomains, lastEventId, scoped.mayDeliverPayload);
        // First keep-alive immediately on open (not one interval later), so the
        // window before the first interval can't strand a quiet stream.
        emitHeartbeat();
      },
      cancel: () => {
        teardown();
      },
    }, new CountQueuingStrategy({ highWaterMark: 256 }));

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  /**
   * Re-resolve what a live client may receive after its credential changed
   * (an in-band auth frame, or the same principal re-authenticated with
   * narrower rights), and drop the runtime domains it may no longer receive.
   */
  regrantClient(clientId: string, input: { readonly admin: boolean; readonly scopes: readonly string[] }): void {
    const liveClient = this.liveClients.get(clientId);
    if (!liveClient) return;
    liveClient.grant = resolveEventGrant({ admin: input.admin, scopes: input.scopes });
    const wsClient = this.websocketClients.get(clientId);
    if (!wsClient) return;
    const revoked = [...wsClient.domains].filter((domain) => !grantAllowsDomain(liveClient.grant, domain));
    if (revoked.length > 0) this.unsubscribeWebSocketClient(clientId, revoked);
  }

  /** The replay ring cut to what `grant` covers; an event addressed to one client keeps its own replay scope check. */
  private recentEventsFor(grant: EventGrant, principalId?: string): ScopedControlPlaneRecentEvent[] {
    const events = this.recentEvents;
    if (grant.all) return events;
    return events.filter((entry) => grantAllowsEvent(grant, entry.event, Boolean(entry.replayScope?.clientId || entry.replayScope?.clientIdPrefix))
      && (!grantNeedsOwnedSession(grant, entry.event) || this.ownsFrame(principalId, ownedFrameSessionId(entry.payload))));
  }

  renderWebUi(authTokenHint = ''): Response {
    if (!this.isEnabled()) {
      return Response.json(buildGatewayDisabledResponseBody(), { status: 503 });
    }
    return renderControlPlaneGatewayWebUi(authTokenHint);
  }

  private livenessCounters(): { requestCount: number; errorCount: number; lastRequestAt: number | undefined; lastEventAt: number } {
    return { requestCount: this.requestCount, errorCount: this.errorCount, lastRequestAt: this.lastRequestAt, lastEventAt: this._lastEventAt };
  }


  /** Retained replay/message entries (ring + surface messages), for MemoryGovernor visibility. */
  retainedEventCount(): number {
    return this._recentEventsCount + this.recentMessages.length;
  }

  /**
   * MemoryGovernor trim hook, a REAL reclaim. `floor` halves the retained
   * replay history (keeps the newest half of the ring); `flush` clears the
   * replay ring and the surface-message buffer entirely. Replay after a flush
   * degrades honestly: reconnecting clients simply get no replayed backlog.
   */
  trimRetainedEvents(level: 'floor' | 'flush'): void {
    if (level === 'flush') {
      this._recentEventsRing.fill(undefined);
      this._recentEventsHead = 0;
      this._recentEventsCount = 0;
      this.recentMessages.length = 0;
      return;
    }
    const keep = Math.floor(this._recentEventsCount / 2);
    const newest = this.recentEvents.slice(0, keep); // newest-first view
    this._recentEventsRing.fill(undefined);
    this._recentEventsHead = 0;
    this._recentEventsCount = 0;
    for (const entry of newest.reverse()) {
      this._recentEventsRing[this._recentEventsHead] = entry;
      this._recentEventsHead = (this._recentEventsHead + 1) % this._recentEventsCapacity;
      this._recentEventsCount += 1;
    }
    if (this.recentMessages.length > 50) this.recentMessages.length = 50;
  }

  private rememberRuntimeEvent(
    domain: RuntimeEventDomain,
    envelope: RuntimeEventEnvelope<AnyRuntimeEvent['type'], AnyRuntimeEvent>,
  ): ScopedControlPlaneRecentEvent {
    const previous = this.runtimeEventRecords.get(envelope);
    if (previous) return previous;
    const record = this.rememberEvent(domain, serializeEnvelope(envelope));
    this.runtimeEventRecords.set(envelope, record);
    if (domain === 'turn') this.decideStreamDeltaWire(record, envelope.payload);
    return record;
  }

  /**
   * Once per emission: whether a `STREAM_DELTA` may go out live as its
   * increment (`content` only). It may when its text extends the turn's
   * previous delta by exactly `content` and has not grown past the resync
   * point; otherwise it is a resync point and carries `accumulated`. The
   * replay ring always keeps the full payload, so a reconnecting reader is
   * whole from its first replayed delta.
   */
  private decideStreamDeltaWire(record: ScopedControlPlaneRecentEvent, payload: AnyRuntimeEvent): void {
    if (!('turnId' in payload) || typeof payload.turnId !== 'string') return;
    const turnId = payload.turnId;
    if (STREAM_TURN_END_EVENTS.has(payload.type)) {
      this.streamTurns.delete(turnId);
      this.streamDeltaWires.set(record, { turnId, ends: true });
      return;
    }
    if (payload.type !== 'STREAM_DELTA') return;
    const { content, accumulated } = payload;
    const previous = this.streamTurns.get(turnId);
    const appends = previous !== undefined
      && accumulated.length === previous.length + content.length
      && accumulated.endsWith(content)
      && accumulated.length < Math.max(previous.fullLength * 2, previous.fullLength + STREAM_RESYNC_MIN_GROWTH);
    if (!appends || previous === undefined) {
      trackBounded(this.streamTurns, turnId, { length: accumulated.length, fullLength: accumulated.length });
      this.streamDeltaWires.set(record, { turnId });
      return;
    }
    trackBounded(this.streamTurns, turnId, { length: accumulated.length, fullLength: previous.fullLength });
    const { accumulated: _full, ...increment } = payload;
    this.streamDeltaWires.set(record, {
      turnId,
      increment: { ...(record.payload as Record<string, unknown>), payload: increment },
    });
  }

  /**
   * What one connection is sent for a retained runtime event: a stream
   * delta's increment once the connection holds that turn's full text, the
   * full payload otherwise. `bases` is the connection's own set of turns whose
   * full text it has received.
   */
  private liveRuntimePayload(record: ScopedControlPlaneRecentEvent, bases: Set<string>): unknown {
    const wire = this.streamDeltaWires.get(record);
    if (!wire) return record.payload;
    if (wire.ends) {
      bases.delete(wire.turnId);
      return record.payload;
    }
    if (wire.increment && bases.has(wire.turnId)) return wire.increment;
    bases.add(wire.turnId);
    if (bases.size > STREAM_TURNS_TRACKED) {
      const oldest = bases.values().next().value;
      if (oldest !== undefined) bases.delete(oldest);
    }
    return record.payload;
  }

  private rememberEvent(
    event: string,
    payload: unknown,
    replayScope?: ControlPlaneEventReplayScope,
  ): ScopedControlPlaneRecentEvent {
    const record: ScopedControlPlaneRecentEvent = {
      id: `evt-${randomUUID().slice(0, 8)}`,
      event,
      createdAt: Date.now(),
      payload,
      ...(replayScope && hasReplayScope(replayScope) ? { replayScope } : {}),
    };
    this._recentEventsRing[this._recentEventsHead] = record;
    this._recentEventsHead = (this._recentEventsHead + 1) % this._recentEventsCapacity;
    if (this._recentEventsCount < this._recentEventsCapacity) this._recentEventsCount++;
    this._lastEventAt = record.createdAt;
    return record;
  }
}

// Exposes DEFAULT_DOMAINS invariants for direct verification.
export { DEFAULT_DOMAINS as DEFAULT_DOMAINS_TEST_EXPORT };

/** The session a delivered frame is about: its own `sessionId`, an approval's, or a hosted-session notice's record id. */
function ownedFrameSessionId(payload: unknown): string | undefined {
  const named = frameSessionId(payload);
  if (named !== undefined || !payload || typeof payload !== 'object') return named;
  const session = (payload as { session?: unknown }).session;
  const id = session && typeof session === 'object' ? (session as { id?: unknown }).id : undefined;
  return typeof id === 'string' ? id : undefined;
}
