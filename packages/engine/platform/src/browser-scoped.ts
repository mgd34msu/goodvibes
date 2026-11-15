import type { FetchLike } from '@goodvibes-jev/engine/transport-core';
import { buildUrl } from '@goodvibes-jev/engine/transport-http';
import { ConfigurationError, ContractError } from '@goodvibes-jev/engine/errors';
import type {
  OperatorMethodInput,
  OperatorMethodOutput,
  OperatorTypedMethodId,
} from '@goodvibes-jev/engine/contracts/generated/foundation-client-types';
import type {
  AuthTokenResolver,
  HttpRetryPolicy,
  ServerSentEventHandlers,
  StreamReconnectPolicy,
  TransportMiddleware,
} from './transport-http.js';
import {
  createHttpTransport,
  openRawServerSentEventStream,
} from './transport-http.js';
import {
  createTurnLifecycleGate,
  readEventEnvelope,
  readTurnLifecycleFrame,
} from './transport-realtime.js';
import type {
  GoodVibesAuthClient,
  GoodVibesTokenStore,
} from './auth.js';
import {
  createGoodVibesAuthClient,
} from './auth.js';
import type { PlatformObserver } from './observer/index.js';

export type BrowserScopedRouteDefinition = {
  readonly method: string;
  readonly path: string;
};

type JsonRecord = Record<string, unknown>;

export interface ScopedBrowserPlatformOptions {
  readonly baseUrl?: string | undefined;
  readonly authToken?: string | null | undefined;
  readonly getAuthToken?: AuthTokenResolver | undefined;
  readonly tokenStore?: GoodVibesTokenStore | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly WebSocketImpl?: typeof WebSocket | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly getHeaders?: (() => HeadersInit | undefined | Promise<HeadersInit | undefined>) | undefined;
  readonly retry?: HttpRetryPolicy | undefined;
  readonly middleware?: readonly TransportMiddleware[] | undefined;
  readonly realtime?: {
    readonly sseReconnect?: StreamReconnectPolicy | undefined;
    readonly onError?: ((error: unknown) => void) | undefined;
  } | undefined;
  readonly observer?: PlatformObserver | undefined;
}

export interface ScopedRealtimeSubscriptionOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface ScopedEventStreamOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly reconnect?: StreamReconnectPolicy | undefined;
}

export interface ScopedRawEventStream {
  open(
    pathOrUrl: string,
    handlers: ServerSentEventHandlers,
    options?: ScopedEventStreamOptions,
  ): Promise<() => void>;
}

type EventStreamOpenInput = {
  readonly pathOrUrl: string;
  readonly handlers: ServerSentEventHandlers;
  readonly options?: ScopedEventStreamOptions | undefined;
};

export interface ScopedInvokeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: HeadersInit | undefined;
}

type ScopedInput<TMethodId extends OperatorTypedMethodId> = OperatorMethodInput<TMethodId>;
type ScopedOutput<TMethodId extends OperatorTypedMethodId> = OperatorMethodOutput<TMethodId>;

export interface ScopedOperatorClient<TMethodId extends OperatorTypedMethodId> {
  invoke<TSelectedMethodId extends TMethodId>(
    methodId: TSelectedMethodId,
    input?: ScopedInput<TSelectedMethodId>,
    options?: ScopedInvokeOptions,
  ): Promise<ScopedOutput<TSelectedMethodId>>;
}

export interface ScopedRuntimeEventEnvelope<TPayload extends { readonly type: string } = { readonly type: string }> {
  readonly type: string;
  readonly ts: number;
  readonly traceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly source?: string | undefined;
  readonly payload: TPayload;
}

export interface ScopedRuntimeEventFeed<TPayload extends { readonly type: string } = { readonly type: string }> {
  on<TType extends string>(
    type: TType,
    listener: (payload: TPayload & { readonly type: TType }) => void,
  ): () => void;
  onEnvelope<TType extends string>(
    type: TType,
    listener: (envelope: ScopedRuntimeEventEnvelope<TPayload & { readonly type: TType }>) => void,
  ): () => void;
}

export type ScopedRuntimeEvents<TDomain extends string> = {
  readonly domains: readonly TDomain[];
  domain(domain: TDomain): ScopedRuntimeEventFeed;
} & { readonly [K in TDomain]: ScopedRuntimeEventFeed };

export interface ScopedBrowserPlatform<TMethodId extends OperatorTypedMethodId, TDomain extends string> {
  readonly operator: ScopedOperatorClient<TMethodId>;
  readonly auth: GoodVibesAuthClient;
  readonly realtime: {
    viaSse(options?: ScopedRealtimeSubscriptionOptions): ScopedRuntimeEvents<TDomain>;
  };
  readonly streams: ScopedRawEventStream;
  use(middleware: TransportMiddleware): void;
}

const SHARED_BROWSER_ROUTES = {
  'accounts.snapshot': { method: 'GET', path: '/api/accounts' },
  'control.auth.current': { method: 'GET', path: '/api/control-plane/auth' },
  'control.auth.login': { method: 'POST', path: '/login' },
  'control.snapshot': { method: 'GET', path: '/api/control-plane' },
  'control.status': { method: 'GET', path: '/status' },
  'providers.get': { method: 'GET', path: '/api/providers/{providerId}' },
  'providers.list': { method: 'GET', path: '/api/providers' },
  'providers.usage.get': { method: 'GET', path: '/api/providers/{providerId}/usage' },
  'sessions.create': { method: 'POST', path: '/api/sessions' },
  'sessions.followUp': { method: 'POST', path: '/api/sessions/{sessionId}/follow-up' },
  'sessions.get': { method: 'GET', path: '/api/sessions/{sessionId}' },
  'sessions.inputs.cancel': { method: 'POST', path: '/api/sessions/{sessionId}/inputs/{inputId}/cancel' },
  'sessions.inputs.list': { method: 'GET', path: '/api/sessions/{sessionId}/inputs' },
  'sessions.list': { method: 'GET', path: '/api/sessions' },
  'sessions.messages.create': { method: 'POST', path: '/api/sessions/{sessionId}/messages' },
  'sessions.messages.list': { method: 'GET', path: '/api/sessions/{sessionId}/messages' },
  'sessions.steer': { method: 'POST', path: '/api/sessions/{sessionId}/steer' },
} as const satisfies Partial<Record<OperatorTypedMethodId, BrowserScopedRouteDefinition>>;

export type SharedBrowserMethodId = Extract<keyof typeof SHARED_BROWSER_ROUTES, OperatorTypedMethodId>;

export function resolveBrowserBaseUrl(baseUrl?: string): string {
  const explicit = baseUrl?.trim();
  if (explicit) return explicit;
  if (typeof globalThis.location?.origin === 'string' && globalThis.location.origin.trim()) {
    return globalThis.location.origin.trim();
  }
  throw new ConfigurationError(
    'Browser baseUrl is required when location.origin is unavailable.',
  );
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  const resolved = fetchImpl ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError(
      'Fetch implementation is required. Pass options.fetch or use a browser/runtime that provides global fetch.',
    );
  }
  return resolved;
}

function buildRouteError(methodId: string): ContractError {
  return new ContractError(
    `Operator method "${methodId}" is not available from this scoped browser platform entrypoint. Import the matching scoped entrypoint instead of the full browser client.`,
  );
}

function createScopedOperatorClient<TMethodId extends OperatorTypedMethodId>(
  routes: Record<TMethodId, BrowserScopedRouteDefinition>,
  options: ScopedBrowserPlatformOptions,
): {
  readonly operator: ScopedOperatorClient<TMethodId>;
  readonly requestJson: <T>(pathOrUrl: string, requestOptions?: Parameters<ReturnType<typeof createHttpTransport>['requestJson']>[1]) => Promise<T>;
  readonly openEventStream: (input: EventStreamOpenInput) => Promise<() => void>;
  readonly getAuthToken: () => Promise<string | null>;
  readonly use: (middleware: TransportMiddleware) => void;
} {
  const baseUrl = resolveBrowserBaseUrl(options.baseUrl);
  const fetchImpl = resolveFetch(options.fetch);
  const transport = createHttpTransport({
    baseUrl,
    authToken: options.authToken ?? null,
    getAuthToken: options.tokenStore
      ? () => options.tokenStore!.getToken()
      : options.getAuthToken,
    fetch: fetchImpl,
    headers: options.headers,
    getHeaders: options.getHeaders,
    retry: options.retry,
    middleware: options.middleware,
    observer: options.observer,
  });

  const operator: ScopedOperatorClient<TMethodId> = {
    invoke<TSelectedMethodId extends TMethodId>(
      methodId: TSelectedMethodId,
      input?: ScopedInput<TSelectedMethodId>,
      invokeOptions: ScopedInvokeOptions = {},
    ): Promise<ScopedOutput<TSelectedMethodId>> {
      // Returning the typed transport promise avoids expanding Awaited over the
      // full operator method map. Keep the former async rejection semantics.
      try {
        const route = routes[methodId];
        if (!route) throw buildRouteError(methodId);
        const resolved = transport.resolveContractRequest(
          route.method,
          route.path,
          input && typeof input === 'object' && !Array.isArray(input)
            ? input as JsonRecord
            : {},
        );
        return transport.requestJson<ScopedOutput<TSelectedMethodId>>(resolved.url, {
          method: resolved.method,
          body: resolved.body,
          headers: invokeOptions.headers,
          signal: invokeOptions.signal,
          methodId,
          idempotent: false,
        });
      } catch (error) { return Promise.reject(error); }
    },
  };

  return {
    operator,
    requestJson: (pathOrUrl, requestOptions) => transport.requestJson(pathOrUrl, requestOptions),
    openEventStream: async ({ pathOrUrl, handlers, options: streamOptions = {} }) => {
      const url = pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')
        ? pathOrUrl
        : buildUrl(baseUrl, pathOrUrl);
      return await openRawServerSentEventStream(fetchImpl, url, handlers, {
        signal: streamOptions.signal,
        headers: streamOptions.headers,
        reconnect: streamOptions.reconnect,
        getAuthToken: () => transport.getAuthToken(),
      });
    },
    getAuthToken: () => transport.getAuthToken(),
    use: (middleware) => transport.use(middleware),
  };
}

function createAuthOperatorShim<TMethodId extends OperatorTypedMethodId>(
  operator: ScopedOperatorClient<TMethodId>,
): {
  readonly control: {
    readonly auth: {
      current(): Promise<unknown>;
      login(input: unknown): Promise<unknown>;
    };
  };
} {
  return {
    control: {
      auth: {
        current: () => operator.invoke('control.auth.current' as TMethodId, {} as ScopedInput<TMethodId>),
        login: (input) => operator.invoke('control.auth.login' as TMethodId, input as ScopedInput<TMethodId>),
      },
    },
  };
}

type Listener<T> = (value: T) => void;

function createFeed(
  subscribe: (type: string, listener: (envelope: ScopedRuntimeEventEnvelope) => void) => () => void,
): ScopedRuntimeEventFeed {
  return {
    on(type, listener) {
      return subscribe(type, (envelope) => {
        listener(envelope.payload as { readonly type: typeof type });
      });
    },
    onEnvelope(type, listener) {
      return subscribe(type, listener as Listener<ScopedRuntimeEventEnvelope>);
    },
  };
}

/**
 * The shared envelope reader, plus what this feed dispatches on: the payload's
 * own `type`. It always stamps a time on what it hands out.
 */
function readScopedEnvelope(value: unknown): ScopedRuntimeEventEnvelope | null {
  const envelope = readEventEnvelope(value);
  if (!envelope || typeof (envelope.payload as { readonly type?: unknown } | null)?.type !== 'string') return null;
  return { ...envelope, ts: envelope.ts ?? Date.now() };
}

function buildEventUrl(baseUrl: string, domain: string): string {
  const url = new URL(buildUrl(baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', domain);
  return url.toString();
}

function createScopedRealtime<TDomain extends string>(
  domains: readonly TDomain[],
  options: ScopedBrowserPlatformOptions,
  getAuthToken: () => Promise<string | null>,
): { viaSse(options?: ScopedRealtimeSubscriptionOptions): ScopedRuntimeEvents<TDomain> } {
  return {
    viaSse(subscriptionOptions?: ScopedRealtimeSubscriptionOptions): ScopedRuntimeEvents<TDomain> {
      const callerSignal = subscriptionOptions?.signal;
      const baseUrl = resolveBrowserBaseUrl(options.baseUrl);
      const fetchImpl = resolveFetch(options.fetch);
      const feeds = new Map<TDomain, ScopedRuntimeEventFeed>();
      const activeByDomain = new Map<TDomain, {
        listenersByType: Map<string, Set<Listener<ScopedRuntimeEventEnvelope>>>;
        closed: boolean;
        disconnect?: (() => void) | undefined;
        close: () => void;
      }>();
      // A domain's stream is torn down when its last listener goes and opened
      // again when a listener returns, so the position must outlive the stream:
      // without it the new stream claims to have seen nothing and is replayed
      // the tail of the last turn, terminal frames included.
      const resumePositions = new Map<TDomain, string>();
      // One gate for this realtime client: a terminal frame addressed to a turn
      // this client is not rendering never reaches a listener.
      const turnGate = createTurnLifecycleGate();

      const ensureDomain = (domain: TDomain) => {
        const existing = activeByDomain.get(domain);
        if (existing) return existing;
        const controller = new AbortController();
        const active: {
          listenersByType: Map<string, Set<Listener<ScopedRuntimeEventEnvelope>>>;
          closed: boolean;
          disconnect?: (() => void) | undefined;
          close: () => void;
        } = {
          listenersByType: new Map(),
          closed: false,
          close: () => {
            if (active.closed) return;
            active.closed = true;
            callerSignal?.removeEventListener('abort', active.close);
            active.listenersByType.clear();
            if (activeByDomain.get(domain) === active) activeByDomain.delete(domain);
            // The native closer is available only after response readiness.
            // This controller also owns the initial request and reconnect wait.
            controller.abort();
            active.disconnect?.();
          },
        };
        activeByDomain.set(domain, active);
        const isCurrent = () => !active.closed
          && !controller.signal.aborted
          && activeByDomain.get(domain) === active;
        if (callerSignal?.aborted) {
          active.close();
          return active;
        }
        callerSignal?.addEventListener('abort', active.close, { once: true });
        void openRawServerSentEventStream(
          fetchImpl,
          buildEventUrl(baseUrl, domain),
          {
            onEventId: (id) => {
              if (isCurrent()) resumePositions.set(domain, id);
            },
            onEvent: (eventName, payload) => {
              if (!isCurrent() || eventName !== domain) return;
              const envelope = readScopedEnvelope(payload);
              if (!envelope) return;
              const frame = readTurnLifecycleFrame(envelope.sessionId, envelope.payload);
              if (frame && !turnGate.accepts(frame)) return;
              for (const listener of [...(active.listenersByType.get(envelope.payload.type) ?? [])]) {
                if (!isCurrent()) break;
                // A throwing listener must not reach the stream reader: it would be
                // taken for a connection error, tear the stream down and leave the
                // other listeners without this event.
                try {
                  listener(envelope);
                } catch (error) {
                  try {
                    options.realtime?.onError?.(error);
                  } catch {
                    // An error reporter that throws is not allowed to end the stream either.
                  }
                }
              }
            },
            onError: (error) => {
              if (isCurrent()) options.realtime?.onError?.(error);
            },
          },
          {
            signal: controller.signal,
            reconnect: options.realtime?.sseReconnect,
            getAuthToken,
            lastEventId: resumePositions.get(domain) ?? null,
          },
        ).then((disconnect) => {
          if (!isCurrent()) {
            disconnect();
            return;
          }
          active.disconnect = disconnect;
        }).catch((error) => {
          if (isCurrent()) options.realtime?.onError?.(error);
        });
        return active;
      };

      const getFeed = (domain: TDomain) => {
        let feed = feeds.get(domain);
        if (feed) return feed;
        feed = createFeed((type, listener) => {
          const active = ensureDomain(domain);
          const listeners = active.listenersByType.get(type) ?? new Set<Listener<ScopedRuntimeEventEnvelope>>();
          listeners.add(listener);
          active.listenersByType.set(type, listeners);
          return () => {
            listeners.delete(listener);
            if (listeners.size === 0) active.listenersByType.delete(type);
            if (active.listenersByType.size === 0) {
              active.close();
            }
          };
        });
        feeds.set(domain, feed);
        return feed;
      };

      return Object.freeze({
        domains,
        domain: getFeed,
        ...Object.fromEntries(domains.map((domain) => [domain, getFeed(domain)])),
      }) as ScopedRuntimeEvents<TDomain>;
    },
  };
}

export function forScopedBrowserSession<TDomain extends string>(
  events: ScopedRuntimeEvents<TDomain>,
  sessionId: string,
): ScopedRuntimeEvents<TDomain> {
  const feeds = new Map<TDomain, ScopedRuntimeEventFeed>();
  const getFeed = (domain: TDomain) => {
    let feed = feeds.get(domain);
    if (feed) return feed;
    const baseFeed = events.domain(domain);
    feed = {
      on(type, listener) {
        return baseFeed.onEnvelope(type, (envelope) => {
          if (envelope.sessionId !== sessionId) return;
          listener(envelope.payload as { readonly type: typeof type });
        });
      },
      onEnvelope(type, listener) {
        return baseFeed.onEnvelope(type, (envelope) => {
          if (envelope.sessionId !== sessionId) return;
          listener(envelope as ScopedRuntimeEventEnvelope<{ readonly type: typeof type }>);
        });
      },
    };
    feeds.set(domain, feed);
    return feed;
  };
  return Object.freeze({
    domains: events.domains,
    domain: getFeed,
    ...Object.fromEntries(events.domains.map((domain) => [domain, getFeed(domain)])),
  }) as ScopedRuntimeEvents<TDomain>;
}

export function createScopedBrowserPlatform<TMethodId extends OperatorTypedMethodId, TDomain extends string>(
  routes: Record<TMethodId, BrowserScopedRouteDefinition>,
  domains: readonly TDomain[],
  options: ScopedBrowserPlatformOptions = {},
): ScopedBrowserPlatform<TMethodId, TDomain> {
  const scoped = createScopedOperatorClient(routes, options);
  const auth = createGoodVibesAuthClient(
    createAuthOperatorShim(scoped.operator) as never,
    options.tokenStore ?? null,
    options.getAuthToken,
    options.observer,
    undefined,
    null,
  );
  return {
    operator: scoped.operator,
    auth,
    realtime: createScopedRealtime(domains, options, scoped.getAuthToken),
    streams: {
      open: (pathOrUrl, handlers, streamOptions) => scoped.openEventStream({ pathOrUrl, handlers, options: streamOptions }),
    },
    use: scoped.use,
  };
}

export { SHARED_BROWSER_ROUTES };
