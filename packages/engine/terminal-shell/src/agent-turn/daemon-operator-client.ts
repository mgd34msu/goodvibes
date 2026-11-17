/**
 * daemon-operator-client.ts, the result-value face of the connected-host client
 * for the Agent's daemon-backed stores (drafts, channel routing, the inbound
 * feed, schedule targets).
 *
 * Every failure is a VALUE, never a throw. The callers are stores that must
 * keep working when the daemon is not reachable, a laptop away from the LAN, a
 * daemon mid-restart, a token that has not been minted yet, and a store that
 * threw on an unreachable peer would take the whole feature down with it.
 *
 * The wire, the deadline and what a failure means belong to the one
 * connected-host client (connected-host-client.ts): a failure here carries the
 * same kind, the same `<what failed>: <cause>; <next step>` message and the same
 * refusal as every other connected-host call. The caller's currency check runs
 * once, before the request leaves; a response cannot be un-sent, so nothing is
 * checked after it. The answer is handed back as the host sent it; each store
 * reads the fields it needs and says when one is missing.
 *
 * The `fetch` implementation is injectable so tests drive the adopted path and
 * the unreachable path without a network, a port, or a live daemon.
 */

import type { OperatorMethodId, OperatorMethodInput } from '@goodvibes-jev/engine/platform/contracts';
import {
  createConnectedHost,
  isHostFailure,
  resolveConnectedHost,
  EXPLICIT_USER_REQUEST_HEADER,
  type ConnectedHostSource,
  type ConnectedHostUnavailable,
  type HostCallApplied,
  type HostFailure,
  type HostFailureKind,
  type HostRefusal,
} from './connected-host-client.js';
import { findOperatorHttpBinding, type JsonRecord } from './operator-contract-routes.js';

export { EXPLICIT_USER_REQUEST_HEADER };

export type DaemonInvokeFailureKind = HostFailureKind;

export interface DaemonInvokeSuccess {
  readonly ok: true;
  readonly methodId: string;
  /** "POST /api/channels/routing", the contract's route for the method. */
  readonly route: string;
  readonly body: unknown;
}

export interface DaemonInvokeFailure {
  readonly ok: false;
  readonly methodId: string;
  readonly route: string;
  readonly kind: DaemonInvokeFailureKind;
  /** `<what failed>: <cause>; <next step>`. */
  readonly error: string;
  /** State, reason and next steps, for a caller that renders them itself. */
  readonly refusal?: HostRefusal;
  /** Whether the host may have acted: `unknown` for a write that was sent and not answered. */
  readonly applied?: HostCallApplied;
}

export type DaemonInvokeResult = DaemonInvokeSuccess | DaemonInvokeFailure;

export interface DaemonInvokeOptions {
  readonly signal?: AbortSignal | undefined;
  /** The caller's currency check, run once before the request leaves. */
  readonly assertCurrent?: (() => void) | undefined;
  /**
   * Whether a person asked for this, right now.
   *
   * The daemon's confirmation gate wants two things: `confirm: true` in the
   * body, saying the CALL was reviewed, and this, saying a person asked. It
   * travels as the `x-goodvibes-explicit-user-request` header. Set it only
   * where that is true, a store syncing itself in the background is honestly
   * not a user request and should not claim to be one.
   */
  readonly explicitUserRequest?: boolean;
}

/** The one call shape every daemon-backed store in this product depends on. */
export type DaemonOperatorInvoke = (
  methodId: string,
  input?: JsonRecord,
  options?: DaemonInvokeOptions,
) => Promise<DaemonInvokeResult>;

export interface DaemonOperatorConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Where the credential was looked for, safe to show. */
  readonly tokenPath?: string;
  /** The owner's check that this connection is still the one selected, run once before the request leaves. */
  readonly assertCurrent?: (() => void) | undefined;
  readonly source?: ConnectedHostSource;
  /** Why there is no usable credential, when `token` is null. */
  readonly unavailable?: ConnectedHostUnavailable;
}

export interface DaemonOperatorConfigReader {
  get(key: string): unknown;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Where the daemon is and what proves this process may talk to it: the Agent's one resolution. */
export function resolveDaemonOperatorConnection(
  configManager: DaemonOperatorConfigReader,
  homeDirectory: string,
): DaemonOperatorConnection {
  const resolved = resolveConnectedHost({ configManager, homeDirectory });
  return {
    baseUrl: resolved.baseUrl,
    token: resolved.token,
    tokenPath: resolved.credential,
    ...(resolved.source === undefined ? {} : { source: resolved.source }),
    ...(resolved.unavailable === undefined ? {} : { unavailable: resolved.unavailable }),
  };
}

/** The most of the host's own words passed on to a caller. */
const HOST_REASON_LIMIT = 200;

/**
 * The host's reason with addresses removed and bounded: a refused draft's
 * webhook address is a bearer secret, and the host may echo it.
 */
function scrubReason(reason: string): string {
  const cleaned = reason
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[address]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > HOST_REASON_LIMIT ? `${cleaned.slice(0, HOST_REASON_LIMIT)}...` : cleaned;
}

/** The host's own words from its error body (`error` or `message`), with the status; otherwise the client's reading. */
function hostReason(failure: HostFailure): string {
  const body = (failure.cause as { body?: unknown } | undefined)?.body;
  const record = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  const stated = typeof record?.error === 'string' ? record.error
    : typeof record?.message === 'string' ? record.message
    : typeof body === 'string' ? body
    : '';
  const status = failure.refusal.status;
  return stated.trim() && status !== undefined ? scrubReason(`${stated} (HTTP ${status})`) : scrubReason(failure.refusal.reason);
}

function routeOf(methodId: string): string {
  const binding = findOperatorHttpBinding(methodId);
  return binding ? `${binding.httpMethod} ${binding.pathTemplate}` : methodId;
}

/**
 * Build the invoke function for a connection.
 *
 * `resolveConnection` is called per invoke rather than once: the token file can
 * appear after this process started (a daemon minted it), and a client that
 * cached "no token" at construction would stay locked out until restart.
 */
export function createDaemonOperatorInvoke(
  resolveConnection: () => DaemonOperatorConnection,
  fetchImpl?: FetchLike,
): DaemonOperatorInvoke {
  return async (methodId, input = {}, options = {}) => {
    const route = routeOf(methodId);
    let connection: DaemonOperatorConnection;
    try {
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      connection = resolveConnection();
      connection.assertCurrent?.();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false, methodId, route, kind: 'cancelled', applied: 'no',
        error: `${methodId} was not sent: ${reason}`,
        refusal: { code: 'not_current', state: 'the request was not sent', reason, next: ['repeat the request if it is still wanted'], retryable: false },
      };
    }
    // A test stub supplies only the call signature; the client reads nothing else from it.
    const host = createConnectedHost(() => ({
      baseUrl: connection.baseUrl,
      token: connection.token,
      credential: connection.tokenPath ?? 'the connected-host credential',
      ...(connection.source === undefined ? {} : { source: connection.source }),
      ...(connection.unavailable === undefined ? {} : { unavailable: connection.unavailable }),
    }), { validateResponses: false, ...(fetchImpl ? { fetchImpl: fetchImpl as typeof fetch } : {}) });
    try {
      const body: unknown = await host.invoke(
        methodId as OperatorMethodId,
        input as OperatorMethodInput<OperatorMethodId>,
        { signal: options.signal, ...(options.explicitUserRequest === undefined ? {} : { explicitUserRequest: options.explicitUserRequest }) },
      );
      return { ok: true, methodId, route, body };
    } catch (error) {
      if (isHostFailure(error)) {
        const refusal = { ...error.refusal, reason: hostReason(error) };
        const next = refusal.next[0];
        return {
          ok: false, methodId, route: error.route, kind: error.kind, refusal, applied: error.applied,
          error: `${methodId} on the connected host failed: ${refusal.reason}${next ? `; ${next}` : ''}`,
        };
      }
      return { ok: false, methodId, route, kind: 'connected_host_error', applied: 'unknown', error: `${methodId} on the connected host failed: ${scrubReason(error instanceof Error ? error.message : String(error))}` };
    }
  };
}
