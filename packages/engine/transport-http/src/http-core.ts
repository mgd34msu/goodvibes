import { ConfigurationError, ContractError, GoodVibesError, HttpStatusError, createHttpStatusError } from '@goodvibes-jev/engine/errors';
import { sleepWithSignal } from './backoff.js';
import { mergeHeaderRecord, normalizeAuthToken, resolveHeaders, type AuthTokenResolver, type HeaderResolver } from './auth.js';
import {
  DEFAULT_IDEMPOTENT_MAX_ATTEMPTS,
  applyPerMethodPolicy,
  getHttpRetryDelay,
  isRetryableCall,
  isRetryableHttpStatus,
  isRetryableNetworkError,
  resolveHttpRetryPolicy,
  type HttpRetryPolicy,
  type PerMethodRetryPolicy,
} from './retry.js';
import { assertSameOriginAbsoluteUrl, buildUrl, createTransportPaths, type TransportPaths } from './paths.js';
import { exemptLoopbackFromProxy } from './loopback-proxy.js';
import {
  composeMiddleware,
  createUuidV4,
  injectTraceparentAsync,
  invokeTransportObserver,
  transportErrorFromUnknown,
  type FetchLike,
  type TransportContext,
  type TransportMiddleware,
  type TransportObserver,
} from '@goodvibes-jev/engine/transport-core';

export type { HttpRetryPolicy, PerMethodRetryPolicy } from './retry.js';
export type { TransportContext, TransportMiddleware } from '@goodvibes-jev/engine/transport-core';

// Re-export canonical JsonValue from contracts root index, single identity across all bundled packages.
// Using the root import ensures the same JsonValue identity as inline uses in foundation-client-types.
export type { JsonValue } from '@goodvibes-jev/engine/contracts';
import type { JsonValue } from '@goodvibes-jev/engine/contracts';
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * Generate a UUID v4 idempotency key.
 * Uses `crypto.randomUUID()` when available (Bun, browsers, Workers, Node 14.17+).
 * Falls back to a manual RFC 4122 v4 implementation otherwise.
 */
export function generateIdempotencyKey(): string {
  return createUuidV4();
}

/** Verbs that change state; only these carry an idempotency key. */
const IDEMPOTENCY_KEY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export interface HttpJsonTransportOptions {
  readonly baseUrl: string;
  readonly authToken?: string | null | undefined;
  readonly getAuthToken?: AuthTokenResolver | undefined;
  readonly fetch?: FetchLike | undefined;
  readonly fetchImpl?: FetchLike | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly getHeaders?: HeaderResolver | undefined;
  readonly retry?: HttpRetryPolicy | undefined;
  readonly observer?: TransportObserver | undefined;
  /** Middleware chain applied to every HTTP request/response cycle. */
  readonly middleware?: readonly TransportMiddleware[] | undefined;
  /**
   * Optional callback invoked when the retry loop decides to back off.
   * Fires immediately before the sleep delay. Use this to emit TRANSPORT_RETRY_SCHEDULED.
   */
  readonly onRetryScheduled?: ((info: { attempt: number; maxAttempts: number; backoffMs: number; reason: string }) => void) | undefined;
  /**
   * Optional callback invoked when the sleep delay completes and the next attempt is
   * about to start. Fires immediately after the sleep. Use to emit TRANSPORT_RETRY_EXECUTED.
   */
  readonly onRetryExecuted?: ((info: { attempt: number; maxAttempts: number }) => void) | undefined;
}

export interface HttpJsonRequestOptions {
  readonly method?: string | undefined;
  readonly body?: unknown | undefined;
  readonly headers?: HeadersInit | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly retry?: false | HttpRetryPolicy | undefined;
  /**
   * Contract method / endpoint ID used to look up `perMethodPolicy` attempt and
   * delay overrides. Populated automatically by `invokeContractRoute`.
   */
  readonly methodId?: string | undefined;
  /**
   * When `true`, the server deduplicates repeats of this call by its
   * `Idempotency-Key`, so the call is retried on a retryable status or a
   * network failure whatever its verb: up to `maxAttempts` when the transport
   * or the call sets one, else {@link DEFAULT_IDEMPOTENT_MAX_ATTEMPTS}. A
   * mutating call gets one key, generated once and sent on every attempt.
   * Populated automatically from the contract's `idempotent` mark.
   */
  readonly idempotent?: boolean | undefined;
  /**
   * The `Idempotency-Key` to send on a mutating call, for a caller that keeps
   * its own key across calls (a dispatcher retrying the same work). Without
   * it an idempotent call gets a generated key.
   */
  readonly idempotencyKey?: string | undefined;
}

export interface ResolvedContractRequest {
  readonly url: string;
  readonly method: string;
  readonly body?: Record<string, unknown> | undefined;
}

export interface TransportJsonError {
  readonly status: number;
  readonly body: unknown;
  readonly url: string;
  readonly method: string;
  readonly retryAfterMs?: number | undefined;
  readonly cause?: unknown | undefined;
}

export interface HttpJsonTransport {
  readonly baseUrl: string;
  readonly authToken?: string | null | undefined;
  readonly fetchImpl: FetchLike;
  readonly paths: TransportPaths;
  buildUrl(path: string): string;
  getAuthToken(): Promise<string | null>;
  requestJson<T>(pathOrUrl: string, options?: HttpJsonRequestOptions): Promise<T>;
  resolveContractRequest(method: string, path: string, input?: Record<string, unknown>): ResolvedContractRequest;
  /**
   * The fetch a stream opens with: the transport's default headers and
   * `getHeaders` under the call's own, and the middleware chain around it, as
   * every JSON call gets them. The response body is left unread for the stream.
   */
  readonly streamFetch: FetchLike;
  /** Append a middleware to the transport's middleware chain. */
  use(middleware: TransportMiddleware): void;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function inferTransportHint(
  status: number,
  url: string,
  retryAfterMs?: number,
): string | undefined {
  if (status === 0) return `Transport could not reach ${url}. Verify the baseUrl is reachable.`;
  if (status === 401) return 'Check your authentication token or credentials.';
  if (status === 403) return 'Valid credentials but insufficient permissions for this operation.';
  if (status === 404) return 'The requested resource was not found.';
  if (status === 408) return 'The request timed out. Consider retrying.';
  if (status === 429) {
    return retryAfterMs !== undefined
      ? `Rate limit exceeded. Retry after ${retryAfterMs}ms.`
      : 'Rate limit exceeded. Back off and retry.';
  }
  if (status >= 500) return 'Remote server error. The service may be temporarily unavailable.';
  return undefined;
}

export function createTransportError(
  status: number,
  url: string,
  method: string,
  body: unknown,
  retryAfterMs?: number,
): HttpStatusError & { readonly transport: TransportJsonError } {
  const inferred = inferTransportHint(status, url, retryAfterMs);
  const baseError = createHttpStatusError(status, url, method, body, inferred);
  const transportPayload: TransportJsonError = {
    status,
    body,
    url,
    method,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  return Object.assign(baseError, {
    transport: transportPayload,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  });
}

export function createNetworkTransportError(
  error: unknown,
  url: string,
  method: string,
): HttpStatusError & { readonly transport: TransportJsonError } {
  const message = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : `Transport request failed before receiving a response for ${url}`;
  const hint = `Transport could not reach ${url}. Verify the baseUrl is reachable.`;
  // Any failure thrown by fetch before a response is a connection failure worth
  // retrying (Node reports codes such as ECONNREFUSED, undici UND_ERR_*, Bun a
  // plain Error with code 'ConnectionRefused'), except a deliberate abort,
  // which the caller asked for.
  const isNetworkError = !(error instanceof Error && error.name === 'AbortError');
  const networkError = new HttpStatusError(message, {
    category: 'network',
    source: 'transport',
    recoverable: isNetworkError,
    url,
    method,
    body: { error: message },
    hint,
    cause: error,
  });
  const transportPayload: TransportJsonError = {
    status: 0,
    body: { error: message },
    url,
    method,
    cause: error,
  };
  return Object.assign(networkError, { transport: transportPayload });
}

function toStringValue(value: unknown, key: string): string {
  if (value === undefined || value === null) {
    throw new ContractError(`Missing required path parameter "${key}". Ensure the input object includes a non-null value for this field before invoking the route.`);
  }
  return String(value);
}

function addQueryValue(url: URL, key: string, value: unknown): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) {
      addQueryValue(url, key, item);
    }
    return;
  }
  if (typeof value === 'object') {
    // object query values cannot be reliably round-tripped through URL
    // query strings (no daemon route parses JSON-stringified query params).
    // Throw a ContractError instead of implicitly serialising; callers must
    // decompose objects into primitive fields before passing as query parameters.
    throw new ContractError(
      `Contract query parameter "${key}" is an object, which cannot be safely serialised as a URL query value. Decompose it into primitive fields.`,
    );
  }
  url.searchParams.append(key, String(value));
}

/** A header's value under any spelling of its name. */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized && value.trim().length > 0) return value;
  }
  return undefined;
}

/** Sets a header, replacing any spelling of it already present: two spellings reach the server as one comma-joined value. */
function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const normalized = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === normalized) delete headers[key];
  }
  headers[name] = value;
}

function splitContractInput(path: string, input: Record<string, unknown> = {}): {
  readonly interpolatedPath: string;
  readonly remaining: Record<string, unknown>;
} {
  const remaining = { ...input };
  // forbid '.' in path-param names to prevent ambiguous flat-key lookup.
  // Contract generators must not emit dotted param names like {foo.bar}.
  const interpolatedPath = path.replace(/\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, key: string) => {
    const value = toStringValue(remaining[key], key);
    delete remaining[key];
    // encodeURIComponent leaves RFC 3986 sub-delimiters (!'()*~) unencoded.
    // If the server uses regex routing, an unencoded `!`, `(`, `)`, `*`, `~`, or
    // `'` in a path segment could match against a route pattern unexpectedly.
    // Encode those characters explicitly after the standard percent-encoding pass.
    return encodeURIComponent(value).replace(/[!'()*~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  });
  if (/[{}]/.test(interpolatedPath)) {
    throw new ContractError(`Malformed contract path "${path}". Path parameters must use "{name}" with identifier-like names.`);
  }
  return { interpolatedPath, remaining };
}

export function createJsonRequestInit(
  token: string | null | undefined,
  body?: unknown,
  method = 'GET',
  headers: HeadersInit = {},
  signal?: AbortSignal,
  defaultHeaders: HeadersInit = {},
): RequestInit {
  return {
    method,
    credentials: 'include',
    ...(signal !== undefined ? { signal } : {}),
    headers: mergeHeaderRecord(
      defaultHeaders,
      token ? { Authorization: `Bearer ${token}` } : undefined,
      body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      headers,
    ),
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
}

export const createJsonInit = createJsonRequestInit;

export function createFetch(fetchImpl?: FetchLike, fallbackFetch?: FetchLike): FetchLike {
  const resolved = fetchImpl ?? fallbackFetch ?? globalThis.fetch;
  if (typeof resolved !== 'function') {
    throw new ConfigurationError('Fetch implementation is required. Pass a fetch option (e.g. options.fetch) or ensure globalThis.fetch is available in your runtime.');
  }
  const bound = resolved.bind(globalThis);
  // Requests to this machine never go through a proxy (loopback-proxy.ts).
  exemptLoopbackFromProxy();
  return (input, init) => {
    exemptLoopbackFromProxy(requestHostname(input));
    return bound(input, init);
  };
}

function requestHostname(input: string | URL | Request): string | undefined {
  if (input instanceof URL) return input.hostname;
  try {
    return new URL(typeof input === 'string' ? input : input.url).hostname;
  } catch {
    return undefined;
  }
}

const MAX_RETRY_AFTER_MS = 10 * 60 * 1000; // 10 minutes

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return undefined;
  // Numeric seconds, cap to prevent hostile/buggy huge values.
  const seconds = Number(retryAfter);
  if (!Number.isNaN(seconds) && seconds > 0) {
    return Math.min(Math.ceil(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  // HTTP-date
  const date = new Date(retryAfter);
  if (!Number.isNaN(date.getTime())) {
    const ms = date.getTime() - Date.now();
    return ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : 0;
  }
  return undefined;
}

export async function readJsonBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Reads the body of a 2xx response. An empty body is `null`; anything else must
 * be JSON. A proxy, captive portal or truncated reply that answers 200 with HTML
 * is a protocol failure here, not a string typed as the caller's `T`.
 */
async function readSuccessBody(response: Response, url: string, method: string): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    const preview = text.trim().slice(0, 80);
    throw new GoodVibesError(`Expected a JSON response from ${url} but received a ${response.status} body that is not JSON: ${preview}`, {
      category: 'protocol',
      source: 'transport',
      recoverable: false,
      url,
      method,
      cause,
      hint: 'A proxy or captive portal may be answering instead of the daemon. Check the baseUrl.',
    });
  }
}

/**
 * Low-level one-shot JSON request helper.
 *
 * This deliberately bypasses transport auth, middleware, retry policy,
 * idempotency keys, and observers. Prefer
 * `createHttpTransport(...).requestJson()` for normal application code.
 */
export async function requestJsonRaw<T>(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw createNetworkTransportError(error, url, init.method ?? 'GET');
  }
  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(response.headers);
    throw createTransportError(response.status, url, init.method ?? 'GET', await readJsonBody(response), retryAfterMs);
  }
  return await readSuccessBody(response, url, init.method ?? 'GET') as T;
}

/**
 * Gives `ctx.response` a Response built from the parsed body on first read, so
 * a request whose middleware never reads it never serialises its body again.
 * Assigning `ctx.response` replaces it as before.
 */
function defineLazyResponse(ctx: TransportContext, response: Response, body: unknown): void {
  let built: Response | undefined;
  Object.defineProperty(ctx, 'response', {
    configurable: true,
    enumerable: true,
    get: () => built ??= new Response(response.status === 204 || response.status === 205 ? null : JSON.stringify(body), {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    }),
    set: (value: Response | undefined) => {
      Object.defineProperty(ctx, 'response', { configurable: true, enumerable: true, writable: true, value });
    },
  });
}

export function createHttpJsonTransport(options: HttpJsonTransportOptions): HttpJsonTransport {
  const baseUrl = options.baseUrl.trim();
  const fetchImpl = createFetch(options.fetchImpl, options.fetch);
  const authToken = options.authToken ?? null;
  // Normalize at the boundary: downstream always works with a single resolver.
  const getAuthToken = options.getAuthToken ?? normalizeAuthToken(options.authToken ?? undefined);
  const defaultHeaders = options.headers;
  const retryPolicy = options.retry;
  const paths = createTransportPaths(baseUrl);
  const observer = options.observer;
  const onRetryScheduled = options.onRetryScheduled;
  const onRetryExecuted = options.onRetryExecuted;
  // Persistent middleware chain, mutated via use().
  const middlewareChain: TransportMiddleware[] = [...(options.middleware ?? [])];

  const requestJsonForTransport = async <T>(pathOrUrl: string, requestOptions: HttpJsonRequestOptions = {}): Promise<T> => {
    const url = /^https?:\/\//i.test(pathOrUrl)
      ? assertSameOriginAbsoluteUrl(pathOrUrl, baseUrl)
      : buildUrl(baseUrl, pathOrUrl);
    const method = requestOptions.method ?? (requestOptions.body === undefined ? 'GET' : 'POST');
    const methodId = requestOptions.methodId;
    const baseRetry = resolveHttpRetryPolicy(retryPolicy, requestOptions.retry);
    // A caller that gives a method more than one attempt in `perMethodPolicy` states
    // that the server deduplicates it: the call is treated as idempotent (retried, and
    // a mutating one carries one generated Idempotency-Key on every attempt).
    const perMethodAttempts = methodId === undefined ? undefined : baseRetry.perMethodPolicy[methodId]?.maxAttempts;
    const idempotent = requestOptions.idempotent === true || (perMethodAttempts !== undefined && perMethodAttempts > 1);
    const methodRetry = methodId ? applyPerMethodPolicy(baseRetry, methodId) : baseRetry;
    // One rule decides whether a call may be repeated (isRetryableCall: a safe
    // verb, or an idempotent mark); an idempotent call nobody gave an attempt
    // count to gets a small default so a lost response does not fail it.
    const attemptsUnset = retryPolicy?.maxAttempts === undefined
      && requestOptions.retry === undefined
      && perMethodAttempts === undefined;
    const resolvedRetry = idempotent && attemptsUnset
      ? { ...methodRetry, maxAttempts: DEFAULT_IDEMPOTENT_MAX_ATTEMPTS }
      : methodRetry;
    const mayRetry = isRetryableCall(method, resolvedRetry, idempotent);
    // pin traceparent once before the retry loop so all retries share one trace span.
    const pinnedTraceHeaders: Record<string, string> = {};
    await injectTraceparentAsync(pinnedTraceHeaders);
    // A key goes only on a mutating call the server deduplicates (or one whose
    // caller brought its own key): sending keys on every mutation could make a
    // proxy's own retry of a non-idempotent request look like a replay.
    // The key is pinned once, before the first attempt, and every attempt sends
    // exactly it, whatever a header resolver or a middleware supplies later: a
    // resolver that minted a new key per attempt would make a retry after a lost
    // answer look like a new request to the daemon's dedupe. Precedence: the
    // caller's `idempotencyKey`, then an `Idempotency-Key` among the call's own
    // headers, then one the default headers or the resolver give the first
    // attempt, then a generated key for a call the server deduplicates.
    const keyedMethod = IDEMPOTENCY_KEY_METHODS.has(method.toUpperCase());
    let idempotencyKey: string | undefined = keyedMethod
      ? requestOptions.idempotencyKey ?? headerValue(mergeHeaderRecord(requestOptions.headers ?? {}), 'Idempotency-Key')
      : undefined;

    let attempt = 0;

    while (true) {
      attempt += 1;
      const token = (await getAuthToken()) ?? null;
      const resolvedHeaders = await resolveHeaders(defaultHeaders, options.getHeaders);
      // Build merged headers record: default + per-request, then inject cross-cutting headers.
      const mergedHeaders = mergeHeaderRecord(
        resolvedHeaders ?? {},
        requestOptions.headers ?? {},
      );
      if (token) {
        setHeader(mergedHeaders, 'Authorization', `Bearer ${token}`);
      }
      if (requestOptions.body !== undefined) {
        setHeader(mergedHeaders, 'Content-Type', 'application/json');
      }

      // merge pre-pinned traceparent headers (captured once before the retry loop)
      // so all retry attempts share a single logical trace span.
      for (const [k, v] of Object.entries(pinnedTraceHeaders)) {
        mergedHeaders[k] = v;
      }

      // The same key on every attempt of this call (pinned above, or on the first attempt here).
      if (keyedMethod && attempt === 1 && idempotencyKey === undefined) {
        idempotencyKey = headerValue(mergedHeaders, 'Idempotency-Key') ?? (idempotent ? generateIdempotencyKey() : undefined);
      }
      if (idempotencyKey !== undefined) setHeader(mergedHeaders, 'Idempotency-Key', idempotencyKey);

      // Notify observer before dispatching the request.
      invokeTransportObserver(() => observer?.onTransportActivity?.({ direction: 'send', url, kind: 'http' }), observer?.onObserverError);
      const sendAt = Date.now();
      // The status of this attempt's response, once one arrives (error statuses included).
      const received: { status?: number } = {};
      const reportReceived = (status: number | undefined, durationMs: number | undefined): void => {
        invokeTransportObserver(() => observer?.onTransportActivity?.({
          direction: 'recv',
          url,
          kind: 'http',
          ...(status !== undefined ? { status } : {}),
          durationMs: durationMs ?? Date.now() - sendAt,
        }), observer?.onObserverError);
      };

      // Build the middleware context for this attempt.
      const ctx: TransportContext = {
        method,
        url,
        headers: mergedHeaders,
        body: requestOptions.body,
        options: requestOptions as { readonly signal?: AbortSignal; readonly retry?: unknown; [key: string]: unknown },
        signal: requestOptions.signal,
      };

      // The fetch that middleware wraps, also called directly without middleware.
      // The parsed body on `ctx.parsedBody` is the one carrier of the result;
      // `ctx.response` is built from it only if a middleware reads it.
      const innerFetch = async (c: TransportContext): Promise<void> => {
        // A middleware may rewrite headers; the pinned key is what goes out.
        if (idempotencyKey !== undefined) setHeader(c.headers, 'Idempotency-Key', idempotencyKey);
        const init: RequestInit = {
          method: c.method,
          credentials: 'include',
          ...(c.signal !== undefined ? { signal: c.signal } : {}),
          headers: c.headers,
          ...(c.body !== undefined ? { body: JSON.stringify(c.body) } : {}),
        };
        let response: Response;
        try {
          response = await fetchImpl(c.url, init);
        } catch (error) {
          throw createNetworkTransportError(error, c.url, c.method);
        }
        received.status = response.status;
        if (!response.ok) {
          const retryAfterMs = parseRetryAfterMs(response.headers);
          throw createTransportError(response.status, c.url, c.method, await readJsonBody(response), retryAfterMs);
        }
        const body = await readSuccessBody(response, c.url, c.method);
        ctx.parsedBody = body;
        if (middlewareChain.length > 0) defineLazyResponse(ctx, response, body);
      };

      try {
        if (middlewareChain.length > 0) {
          // Middleware path, compose chain around innerFetch.
          const composed = composeMiddleware(middlewareChain, innerFetch);
          await composed(ctx);
          if (ctx.error) throw ctx.error;
          // The parsed body when the real fetch (or a middleware) set one; a
          // middleware that answered with its own Response is read from it.
          let result: T;
          if (ctx.parsedBody !== undefined) {
            result = ctx.parsedBody as T;
          } else if (ctx.response) {
            result = await ctx.response.json() as T;
          } else {
            throw new GoodVibesError('HTTP middleware chain completed without producing a response.', {
              category: 'protocol',
              source: 'transport',
              recoverable: false,
              url,
              method,
            });
          }
          reportReceived(received.status ?? ctx.response?.status, ctx.durationMs);
          return result;
        }

        // No middleware: the parsed body is the result, nothing else is built.
        await innerFetch(ctx);
        const result = ctx.parsedBody as T;
        reportReceived(received.status, undefined);
        return result;
      } catch (error) {
        // Wrap middleware errors as GoodVibesError{kind:'unknown'} with middleware identity in cause.
        // ALL errors originating from the middleware chain are wrapped, including HttpStatusError.
        const wrappedError = (() => {
          if (ctx.middlewareError) {
            // Error came from within the middleware chain, wrap regardless of error type.
            const msg = transportErrorFromUnknown(error, 'transport middleware error').message;
            const middlewareName = ctx.activeMiddlewareName ?? 'unknown';
            const wrapped = new GoodVibesError(`Transport middleware error: ${msg}`, {
              category: 'unknown',
              source: 'transport',
              recoverable: false,
              cause: { middleware: middlewareName, originalError: error },
            });
            return wrapped;
          }
          if (error instanceof GoodVibesError) return error;
          return error;
        })();
        // A response that arrived with an error status is still a receive.
        if (received.status !== undefined) reportReceived(received.status, ctx.durationMs);
        // Notify observer of the transport error before deciding to retry or rethrow.
        invokeTransportObserver(() => observer?.onError?.(transportErrorFromUnknown(wrappedError, 'HTTP transport error')), observer?.onObserverError);
        const status = typeof wrappedError === 'object' && wrappedError !== null && 'transport' in wrappedError
          ? (wrappedError as { readonly transport?: { readonly status?: unknown } }).transport?.status
          : undefined;
        // Never retry a request the caller deliberately aborted.
        if (requestOptions.signal?.aborted) {
          throw wrappedError;
        }
        // Honor the computed `recoverable` flag for network (status 0) failures so that
        // non-recoverable errors (e.g. AbortError, programmer TypeErrors) are not retried.
        const recoverable = typeof wrappedError === 'object' && wrappedError !== null && 'recoverable' in wrappedError
          ? (wrappedError as { readonly recoverable?: unknown }).recoverable
          : undefined;
        // A reply whose own body says it is final (`recoverable: false`, or a billing
        // limit) is not retried however transient its status looks: a 429 for an
        // exhausted budget will not clear by asking again. Only the body counts here,
        // the error's `recoverable` default would also veto statuses a caller opted into.
        const replyBody = typeof wrappedError === 'object' && wrappedError !== null && 'transport' in wrappedError
          ? (wrappedError as { readonly transport?: { readonly body?: unknown } }).transport?.body
          : undefined;
        const declaredFinal = typeof replyBody === 'object' && replyBody !== null
          && ((replyBody as { readonly recoverable?: unknown }).recoverable === false
            || (replyBody as { readonly category?: unknown }).category === 'billing');
        const shouldRetry = mayRetry && !declaredFinal && attempt < resolvedRetry.maxAttempts && (
          (typeof status === 'number' && status > 0 && isRetryableHttpStatus(method, status, resolvedRetry, idempotent))
          || (typeof status === 'number' && status === 0 && recoverable !== false && isRetryableNetworkError(method, resolvedRetry, idempotent))
        );
        if (!shouldRetry) {
          throw wrappedError;
        }
        // Respect a server-supplied Retry-After (parsed onto transport.retryAfterMs) as a
        // floor over the computed exponential backoff so we don't hammer a rate-limited server.
        const retryAfterMs = typeof wrappedError === 'object' && wrappedError !== null && 'transport' in wrappedError
          ? (wrappedError as { readonly transport?: { readonly retryAfterMs?: number } }).transport?.retryAfterMs
          : undefined;
        const backoffMs = Math.min(
          MAX_RETRY_AFTER_MS,
          Math.max(getHttpRetryDelay(attempt, resolvedRetry), retryAfterMs ?? 0),
        );
        const retryReason = typeof status === 'number' && status > 0 ? `http-${status}` : 'network-error';
        // Notify callers before the retry sleep starts.
        onRetryScheduled?.({ attempt, maxAttempts: resolvedRetry.maxAttempts, backoffMs, reason: retryReason });
        await sleepWithSignal(backoffMs, requestOptions.signal);
        // Notify callers after the retry sleep completes.
        onRetryExecuted?.({ attempt, maxAttempts: resolvedRetry.maxAttempts });
      }
    }
  };

  const resolveContractRequest = (method: string, path: string, input: Record<string, unknown> = {}): ResolvedContractRequest => {
    const { interpolatedPath, remaining } = splitContractInput(path, input);
    const upperMethod = method.toUpperCase();
    const url = new URL(buildUrl(baseUrl, interpolatedPath));
    if (upperMethod === 'GET' || upperMethod === 'HEAD') {
      for (const [key, value] of Object.entries(remaining)) {
        addQueryValue(url, key, value);
      }
      return {
        url: url.toString(),
        method: upperMethod,
      };
    }
    const body = isPlainObject(remaining) && Object.keys(remaining).length > 0 ? remaining : undefined;
    return {
      url: url.toString(),
      method: upperMethod,
      ...(body ? { body } : {}),
    };
  };

  // A stream (server-sent events) goes through the same headers and middleware as a JSON call.
  const streamFetch: FetchLike = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = mergeHeaderRecord(
      (await resolveHeaders(defaultHeaders, options.getHeaders)) ?? {},
      (init.headers ?? {}) as HeadersInit,
    );
    const method = (init.method ?? 'GET').toUpperCase();
    const signal = init.signal ?? undefined;
    const ctx: TransportContext = { method, url, headers, body: undefined, options: { ...(signal ? { signal } : {}) }, signal };
    const innerFetch = async (c: TransportContext): Promise<void> => {
      c.response = await fetchImpl(c.url, { ...init, method: c.method, headers: c.headers, ...(c.signal ? { signal: c.signal } : {}) });
    };
    if (middlewareChain.length === 0) {
      await innerFetch(ctx);
    } else {
      await composeMiddleware(middlewareChain, innerFetch)(ctx);
      if (ctx.error) throw ctx.error;
    }
    if (!ctx.response) {
      throw new GoodVibesError('HTTP middleware chain completed without producing a stream response.', {
        category: 'protocol', source: 'transport', recoverable: false, url, method,
      });
    }
    return ctx.response;
  };

  return {
    baseUrl: paths.baseUrl,
    authToken,
    fetchImpl,
    streamFetch,
    paths,
    buildUrl(path: string): string {
      return buildUrl(baseUrl, path);
    },
    async getAuthToken(): Promise<string | null> {
      return (await getAuthToken()) ?? null;
    },
    requestJson: requestJsonForTransport,
    resolveContractRequest,
    use(middleware: TransportMiddleware): void {
      middlewareChain.push(middleware);
    },
  };
}
