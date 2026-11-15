/**
 * memory-spine-rest-transport.ts
 *
 * Thin adapter over the platform's own memory-spine REST transport
 * (`@goodvibes-jev/engine/platform/platform/runtime/memory-spine`), which implements
 * the full CORE + EXTENDED verb catalog directly on the platform's own
 * transport-http primitives. The hand-rolled `wireFetch`/per-verb JSON
 * parsing is retired in favor of that shared implementation (see the platform
 * module's own "Hoist provenance" doc comment: the TUI's version was adopted
 * as the superset, unchanged behavior-wise from the agent's for every verb
 * this agent calls).
 *
 * What stays agent-local, because the platform's transport takes a fixed
 * `{baseUrl, authToken}` at construction rather than a resolver:
 *  - Re-resolving the connection (and therefore the bearer token) on EVERY
 *    call, not just once at construction, a token that appears on disk
 *    after boot must be picked up without re-constructing this transport.
 *    Achieved by building a fresh platform transport instance per call rather than
 *    caching one.
 *  - The "no connected-host operator token found" honest-rejection message
 *    this surface's callers and tests depend on. The platform transport has no
 *    such pre-flight check (it would simply omit the Authorization header and
 *    let the daemon's own 401 propagate), so it is reproduced here as a guard
 *    that runs before every delegated call.
 *  - A bounded per-call timeout via an AbortController-wrapped `fetchImpl`,
 *    matching this surface's prior default (2s) for ordinary verbs and a longer
 *    one for the verbs whose cost grows with the store, the platform transport accepts
 *    an injectable `fetchImpl` for exactly this kind of consumer policy.
 */

import { createMemorySpineRestTransport as createPlatformMemorySpineRestTransport, captureMemoryOperation, assertMemoryOperationCurrent, awaitMemoryOperation, memoryVerbUnavailableError } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { MemoryTransport, MemoryOperationOptions } from '@goodvibes-jev/engine/platform/platform/runtime/memory-spine';
import type { SessionRegistrationConnection } from './session-spine-rest-transport.ts';

const DEFAULT_MEMORY_WIRE_TIMEOUT_MS = 2_000;
/** For verbs whose cost grows with the store: a whole bundle, a diagnostic sweep, a semantic search. */
const DEFAULT_LONG_MEMORY_WIRE_TIMEOUT_MS = 60_000;
const LONG_RUNNING_VERBS: ReadonlySet<string> = new Set([
  'exportBundle', 'importBundle', 'doctor', 'vectorStats', 'searchSemantic',
]);

export interface MemorySpineRestTransportOptions {
  readonly resolveConnection: () => SessionRegistrationConnection;
  /** Bound for ordinary verbs (add, get, list, link, ...). Default 2s. */
  readonly timeoutMs?: number;
  /** Bound for bundle, doctor, vector-stats and semantic-search verbs. Default 60s. */
  readonly longTimeoutMs?: number;
}

/**
 * Wraps global fetch with the verb's deadline. The abort reason is a
 * `TimeoutError` naming the verb and the bound, so the caller reports a
 * deadline, not a cancellation.
 */
function deadlineFetch(verb: string, timeoutMs: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new DOMException(
      `memory ${verb} did not answer within ${timeoutMs} ms`, 'TimeoutError')), timeoutMs);
    try {
      const parent = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const signal = parent ? AbortSignal.any([parent, deadline.signal]) : deadline.signal;
      return await awaitMemoryOperation(() => fetch(input, { ...init, signal }), { signal });
    } finally {
      clearTimeout(timer);
    }
  }) as typeof fetch;
}

function requireToken(connection: SessionRegistrationConnection): void {
  if (connection.token) return;
  throw new Error(connection.tokenPath
    ? `memory spine: no connected-host operator token found at ${connection.tokenPath}`
    : 'memory spine: no connected-host operator token found');
}

/**
 * Builds the wire `MemoryTransport` the agent injects into `MemorySpineClient`
 * once it has confirmed a daemon is adopted. Every method resolves the
 * connection fresh, asserts a token is present (the honest-failure contract),
 * and delegates to a freshly built platform transport, cheap, since the platform
 * transport is a plain object of closures over its construction options.
 */
export function createMemorySpineRestTransport(options: MemorySpineRestTransportOptions): MemoryTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_MEMORY_WIRE_TIMEOUT_MS;
  const longTimeoutMs = options.longTimeoutMs ?? DEFAULT_LONG_MEMORY_WIRE_TIMEOUT_MS;
  const resolveConnection = options.resolveConnection;
  const captureOperationScope = () => {
    const connection = resolveConnection();
    const baseUrl = connection.baseUrl, token = connection.token, tokenPath = connection.tokenPath;
    return () => {
      const current = resolveConnection();
      if (current.baseUrl !== baseUrl || current.token !== token || current.tokenPath !== tokenPath) {
        throw new Error('Memory spine connection changed');
      }
    };
  };

  const call = async <T>(verb: string, lifecycle: MemoryOperationOptions | undefined,
    invoke: (transport: MemoryTransport, operation: MemoryOperationOptions) => Promise<T> | undefined): Promise<T> => {
    const caller = captureMemoryOperation(lifecycle);
    assertMemoryOperationCurrent(caller);
    const scope = captureOperationScope();
    const operation = captureMemoryOperation({ signal: caller.signal, assertCurrent: () => {
      assertMemoryOperationCurrent(caller); scope();
    } });
    return awaitMemoryOperation(() => {
      assertMemoryOperationCurrent(operation);
      const connection = resolveConnection();
      requireToken(connection);
      const transport = createPlatformMemorySpineRestTransport({
        baseUrl: connection.baseUrl, authToken: connection.token,
        fetchImpl: deadlineFetch(verb, LONG_RUNNING_VERBS.has(verb) ? longTimeoutMs : timeoutMs),
      });
      const result = invoke(transport, operation);
      if (!result) throw memoryVerbUnavailableError(verb);
      return result;
    }, operation);
  };
  return {
    captureOperationScope,
    add: (opts, operation) => call('add', operation, (transport, owned) => transport.add(opts, owned)),
    honestSearch: (filter, searchOptions, operation) => call('honestSearch', operation, (transport, owned) => transport.honestSearch(filter, searchOptions, owned)),
    get: (id, operation) => call('get', operation, (transport, owned) => transport.get(id, owned)),
    updateReview: (id, patch, operation) => call('updateReview', operation, (transport, owned) => transport.updateReview(id, patch, owned)),
    delete: (id, operation) => call('delete', operation, (transport, owned) => transport.delete(id, owned)),
    list: (filter, operation) => call('list', operation, (transport, owned) => transport.list?.(filter, owned)),
    searchSemantic: (filter, operation) => call('searchSemantic', operation, (transport, owned) => transport.searchSemantic?.(filter, owned)),
    update: (id, patch, operation) => call('update', operation, (transport, owned) => transport.update?.(id, patch, owned)),
    link: (fromId, toId, relation, operation) => call('link', operation, (transport, owned) => transport.link?.(fromId, toId, relation, owned)),
    linksFor: (id, operation) => call('linksFor', operation, (transport, owned) => transport.linksFor?.(id, owned)),
    reviewQueue: (limit, scope, operation) => call('reviewQueue', operation, (transport, owned) => transport.reviewQueue?.(limit, scope, owned)),
    exportBundle: (filter, operation) => call('exportBundle', operation, (transport, owned) => transport.exportBundle?.(filter, owned)),
    importBundle: (bundle, operation) => call('importBundle', operation, (transport, owned) => transport.importBundle?.(bundle, owned)),
    vectorStats: (operation) => call('vectorStats', operation, (transport, owned) => transport.vectorStats?.(owned)),
    doctor: (operation) => call('doctor', operation, (transport, owned) => transport.doctor?.(owned)),
  };
}
