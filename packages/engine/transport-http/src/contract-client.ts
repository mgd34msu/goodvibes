import { ContractError, GoodVibesError } from '@goodvibes/engine/errors';
import type { ZodType } from 'zod/v4';
import type { HttpTransport } from './http.js';
import { openRawServerSentEventStream, type ServerSentEventHandlers } from './sse-stream.js';

/**
 * Said on a response-shape failure of a request that changes state. The
 * transport only gets here after a 2xx answer, so the server received the
 * request; but a success can mean done, accepted and queued (202), or found
 * already settled, so its effect is not verified.
 */
function receivedNotice(keyed: boolean): string {
  return 'The server answered with a success status, so it received this request, but its answer could not be read: whether the change finished, was queued to run later or was already settled is not known. '
    + (keyed
      ? 'Read the resulting state; to learn the outcome, repeat the request only with the same Idempotency-Key, which returns the first answer and acts no second time.'
      : 'Do not repeat the request: read the resulting state first.');
}

export interface ContractRouteDefinition {
  readonly method: string;
  readonly path: string;
}

export interface ContractRouteLike {
  readonly id: string;
  /**
   * When true, the server deduplicates repeats of this route by their
   * `Idempotency-Key`, so a call is retried on a retryable status or a
   * network failure whatever its verb, with one key for all its attempts.
   */
  readonly idempotent?: boolean | undefined;
}

export interface ContractInvokeOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: HeadersInit | undefined;
  /**
   * The `Idempotency-Key` for a mutating call, when the caller keeps its own
   * key across calls; an idempotent route otherwise gets one generated per call.
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * Optional Zod v4 schema to validate the parsed response body against.
   * When provided, a failed parse throws a {@link ContractError} with
   * field-level detail: operation, field path, expected type, and a
   * recovery hint.
   */
  readonly responseSchema?: ZodType | undefined;
}

export interface ContractStreamOptions extends ContractInvokeOptions {
  readonly handlers: ServerSentEventHandlers;
}

// One id index per route list. Shipped manifests are frozen, so the index is
// built once; a hand-built list that grows is re-indexed when its length moves.
const routeIndexes = new WeakMap<readonly ContractRouteLike[], { readonly length: number; readonly byId: ReadonlyMap<string, ContractRouteLike> }>();

function routeIndex(routes: readonly ContractRouteLike[]): ReadonlyMap<string, ContractRouteLike> {
  const known = routeIndexes.get(routes);
  if (known && known.length === routes.length) return known.byId;
  const byId = new Map<string, ContractRouteLike>();
  // First declaration wins, as a linear search would find it.
  for (const route of routes) if (!byId.has(route.id)) byId.set(route.id, route);
  routeIndexes.set(routes, { length: routes.length, byId });
  return byId;
}

export function requireContractRoute<TRoute extends ContractRouteLike>(
  routes: readonly TRoute[],
  routeId: string,
  kind: string,
): TRoute {
  const route = routeIndex(routes).get(routeId) as TRoute | undefined;
  if (!route) {
    throw new GoodVibesError(`Unknown ${kind} "${routeId}". Verify the method/route id is correct and that your contract manifest is up to date.`, { category: 'contract', source: 'contract', recoverable: false });
  }
  return route;
}

export async function invokeContractRoute<T = unknown>(
  transport: HttpTransport,
  route: ContractRouteDefinition & ContractRouteLike,
  input?: Record<string, unknown>,
  options: ContractInvokeOptions = {},
): Promise<T> {
  const resolved = transport.resolveContractRequest(route.method, route.path, input);
  const body = await transport.requestJson<T>(resolved.url, {
    method: resolved.method,
    body: resolved.body,
    headers: options.headers,
    signal: options.signal,
    methodId: route.id,
    idempotent: route.idempotent === true,
    idempotencyKey: options.idempotencyKey,
  });
  if (options.responseSchema) {
    const result = options.responseSchema.safeParse(body);
    if (!result.success) {
      const issue = result.error.issues[0]!;
      const fieldPath = issue ? issue.path.join('.') || '(root)' : '(unknown)';
      const expected = issue ? (issue as { readonly expected?: string }).expected ?? issue.code : 'unknown';
      const received = issue ? (issue as { readonly received?: string }).received ?? 'unknown' : 'unknown';
      const notice = !['GET', 'HEAD'].includes(route.method.toUpperCase()) ? receivedNotice(route.idempotent === true) : undefined;
      throw new ContractError(
        `Response validation failed for "${route.method} ${route.path}": field "${fieldPath}" expected ${expected} but received ${received}. Ensure the server is running the matching GoodVibes contract version.${notice ? ` ${notice}` : ''}`,
        { source: 'contract', ...(notice ? { phase: 'response-validation', hint: notice } : {}) },
      );
    }
    return result.data as T;
  }
  return body;
}

export async function openContractRouteStream(
  transport: HttpTransport,
  route: ContractRouteDefinition,
  input: Record<string, unknown> | undefined,
  options: ContractStreamOptions,
): Promise<() => void> {
  const resolved = transport.resolveContractRequest(route.method, route.path, input);
  // The transport's default headers, getHeaders and middleware apply to a stream as to a JSON call.
  return await openRawServerSentEventStream(
    transport.streamFetch,
    resolved.url,
    options.handlers,
    {
      authToken: transport.authToken,
      getAuthToken: transport.getAuthToken.bind(transport),
      headers: options.headers,
      signal: options.signal,
    },
  );
}
