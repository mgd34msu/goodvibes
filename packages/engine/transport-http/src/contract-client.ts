import { ContractError, GoodVibesError } from '@goodvibes-jev/engine/errors';
import type { ZodType } from 'zod/v4';
import type { HttpTransport } from './http.js';
import { openRawServerSentEventStream, type ServerSentEventHandlers } from './sse-stream.js';

/**
 * Said on a response-shape failure of a request that changes state: the
 * transport only gets here after a 2xx answer, so the daemon already acted.
 */
const REQUEST_APPLIED_NOTICE = 'The daemon answered successfully, so this request was applied; only its response did not match the expected shape. Do not repeat the request: check the resulting state instead.';

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

export function requireContractRoute<TRoute extends ContractRouteLike>(
  routes: readonly TRoute[],
  routeId: string,
  kind: string,
): TRoute {
  const route = routes.find((candidate) => candidate.id === routeId);
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
      const applied = !['GET', 'HEAD'].includes(route.method.toUpperCase());
      throw new ContractError(
        `Response validation failed for "${route.method} ${route.path}": field "${fieldPath}" expected ${expected} but received ${received}. Ensure the server is running the matching GoodVibes contract version.${applied ? ` ${REQUEST_APPLIED_NOTICE}` : ''}`,
        { source: 'contract', ...(applied ? { phase: 'response-validation', hint: REQUEST_APPLIED_NOTICE } : {}) },
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
  return await openRawServerSentEventStream(
    transport.fetchImpl,
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
