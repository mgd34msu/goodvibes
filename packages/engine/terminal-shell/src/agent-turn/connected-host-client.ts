/**
 * connected-host-client.ts, the one client this Agent uses to call an operator
 * method on its connected host.
 *
 * Three facts live here and nowhere else:
 *
 * - Which host and which credential. `resolveConnectedHost` reads the dial
 *   setting, the host address and the credential with one precedence
 *   (environment, then this host's pairing, then the operator token file) and
 *   says which source it used. The credential files are re-read only when an
 *   `lstat` shows they changed, so a call costs one or two `lstat`s, not a parse.
 * - How long to wait. Every call has a deadline (15 s for a read, 60 s for a
 *   write) joined to the caller's signal, so a host that accepts the connection
 *   and never answers ends the call with a refusal instead of a hang.
 * - What a failure means. A failure is classified from the HTTP status, the
 *   errno code and the error's own structured fields, never from its wording and
 *   never by a model. It is thrown as a `HostFailure` whose message reads
 *   `<what failed>: <cause>; <next step>` and whose `refusal` carries the state,
 *   reason and next steps for a person or an agent to act on.
 *
 * The route each method is served on comes from the operator contract the Agent
 * was built with, through `@goodvibes/engine/operator-client`; a method the
 * contract publishes for the WebSocket only goes to the host's invoke-by-id
 * endpoint.
 */

import { lstatSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { categoryForCode, categoryForStatus, GoodVibesError, httpStatusOf } from '@goodvibes/engine/errors';
import { createOperatorApiClient, type OperatorApiClient } from '@goodvibes/engine/operator-client';
import type { OperatorMethodId, OperatorMethodInput, OperatorMethodOutput } from '@goodvibes/engine/platform/contracts';
import { resolveConnectedHostDialEnabled } from '@goodvibes/engine/platform/platform/config';
import { resolveConnectedHostAddress, type ConnectedHostAddressKey } from './connected-host-dial.js';
import {
  connectedHostOperatorTokenPath,
  readConnectedHostOperatorToken,
  type ConnectedHostCredentialSource,
  type ConnectedHostOperatorToken,
} from './connected-host-auth.js';
import { agentHostPairingStorePath } from './connected-host-pairing-store.js';
import { assertSafeOperatorPathValue, findOperatorContractMethod, findOperatorHttpBinding, READ_ONLY_HTTP_METHODS } from './operator-contract-routes.js';
import type { AgentInProcessHost } from './in-process-host.js';

/** Where the credential came from; `in-process` is the operator credential of the daemon hosting this Agent turn, presented in process (in-process-host.ts). */
export type ConnectedHostSource = ConnectedHostCredentialSource | 'in-process';

/** How long a read may wait for the host before the call ends as a timeout. */
export const CONNECTED_HOST_READ_DEADLINE_MS = 15_000;
/** How long a write may wait; longer, because some writes start work on the host. */
export const CONNECTED_HOST_WRITE_DEADLINE_MS = 60_000;
/** The `/status` probe that tells an older host from no host after a 404. */
const STATUS_PROBE_DEADLINE_MS = 3_000;

/** A request's signal: the caller's, also ended by a deadline; `deadline` says which ended it. */
export interface RequestDeadline {
  readonly signal: AbortSignal;
  readonly deadline: AbortSignal;
  readonly deadlineMs: number;
}

/**
 * The one way a tool bounds a request it sends: a host or server that accepts
 * the connection and never answers ends the call at the deadline, with a
 * timeout the caller can name, instead of holding the turn until the owner
 * cancels. One timer per request.
 */
export function requestDeadline(deadlineMs: number, signal?: AbortSignal): RequestDeadline {
  const deadline = AbortSignal.timeout(deadlineMs);
  return { signal: signal ? AbortSignal.any([signal, deadline]) : deadline, deadline, deadlineMs };
}

/** The deadline for one connected-host request: a read waits less than a write, which may start work on the host. */
export function connectedHostRequestDeadline(isRead: boolean, signal?: AbortSignal): RequestDeadline {
  return requestDeadline(isRead ? CONNECTED_HOST_READ_DEADLINE_MS : CONNECTED_HOST_WRITE_DEADLINE_MS, signal);
}

/** The header the daemon reads the explicit-user-request claim from. */
export const EXPLICIT_USER_REQUEST_HEADER = 'x-goodvibes-explicit-user-request';

/**
 * A refusal in the shape every surface prints: the state, the reason and the
 * next steps. Field for field the engine's `Refusal`, so a caller can hand it on
 * unchanged.
 */
export interface HostRefusal {
  readonly code: string;
  readonly state: string;
  readonly reason: string;
  readonly next: readonly string[];
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
}

/** Why a credential is not usable, carried on a connection whose token is null. */
export interface ConnectedHostUnavailable {
  /**
   * `host_too_old`: the attached daemon's build is below what this Agent build needs (its build verdict).
   * `address_unstated`: the host is another machine and no origin with its scheme was stated (connected-host-dial.ts).
   */
  readonly code: 'dial_disabled' | 'address_unstated' | 'no_credential' | 'credential_unreadable' | 'source_not_accepted' | 'host_too_old';
  readonly reason: string;
  readonly next: readonly string[];
}

/** The host to call and the credential to present, resolved once per call. */
export interface ConnectedHostConnection {
  readonly baseUrl: string;
  readonly token: string | null;
  /** Which source the credential came from; absent when a caller supplied the connection itself. */
  readonly source?: ConnectedHostSource;
  /** Where the credential was looked for, safe to show: a file path, a store name or an environment variable. */
  readonly credential: string;
  /** Present when `token` is null. */
  readonly unavailable?: ConnectedHostUnavailable;
  /** A pairing binds its token to a principal the host should report back. */
  readonly expectedPrincipalId?: string;
  /**
   * How a request reaches the host. Absent: the network. For the daemon
   * hosting this turn itself, its own request path (in-process-host.ts).
   */
  readonly fetch?: typeof fetch | undefined;
}

export interface ConnectedHostConfigReader {
  get(key: string): unknown;
}

export interface ConnectedHostSelection {
  readonly configManager: ConnectedHostConfigReader;
  readonly homeDirectory: string | (() => string);
  /**
   * The credential sources this caller may use. A feature that must act as a
   * paired principal (the work import) passes `['pairing']`; the default is all.
   */
  readonly accept?: readonly ConnectedHostSource[];
  /**
   * The daemon hosting this Agent turn: when present it is the connected host,
   * reached in process, and no dial setting or credential file is read.
   */
  readonly inProcess?: AgentInProcessHost | undefined;
  /**
   * Why this host may not be called right now (the attached daemon is older
   * than this build needs), or undefined. Read once per resolution, a field
   * read; the process-wide refusal ({@link useConnectedHostRefusal}) applies
   * when this is absent.
   */
  readonly hostRefusal?: (() => string | undefined) | undefined;
}

/** The refusal every connected-host call of this process answers with; set by the app that owns the daemon build verdict. */
let processHostRefusal: (() => string | undefined) | undefined;

/**
 * Make every connected-host call of this process (schedules, operator tools,
 * slash-command routes, owner questions, Activity, occasions) answer with
 * `refusal()` while it says the attached daemon may not be used, instead of
 * calling it and returning its own 404s. A call to the daemon hosting this turn
 * in process is never refused. Returns the function that removes it.
 */
export function useConnectedHostRefusal(refusal: () => string | undefined): () => void {
  processHostRefusal = refusal;
  return () => { if (processHostRefusal === refusal) processHostRefusal = undefined; };
}

export type HostFailureKind =
  | 'auth_required'
  | 'connected_host_unavailable'
  | 'connected_host_incompatible'
  | 'connected_host_route_unavailable'
  | 'connected_host_error'
  | 'cancelled';

/**
 * Whether the host may have acted on a failed call: `no` (refused or never
 * sent), `unknown` (a write sent and not answered), `answered` (a write the
 * host answered with a success status in a shape this Agent could not read:
 * the host received it, but a success can mean done, queued to run later or
 * already settled, so its effect is not verified).
 */
export type HostCallApplied = 'no' | 'unknown' | 'answered';

/** A failed connected-host call. The message is `<what failed>: <cause>; <next step>`. */
export class HostFailure extends Error {
  override readonly name = 'HostFailure';
  readonly kind: HostFailureKind;
  readonly refusal: HostRefusal;
  readonly applied: HostCallApplied;
  readonly methodId: string;
  /** The route from the operator contract, `POST /api/...`, or the method id when it has none. */
  readonly route: string;
  readonly baseUrl: string;
  readonly source?: ConnectedHostSource;

  constructor(init: {
    readonly kind: HostFailureKind;
    readonly refusal: HostRefusal;
    readonly applied: HostCallApplied;
    readonly methodId: string;
    readonly route: string;
    readonly baseUrl: string;
    readonly source?: ConnectedHostSource | undefined;
    readonly cause?: unknown;
  }) {
    const next = init.refusal.next[0];
    super(`${init.methodId} on the connected host failed: ${init.refusal.reason}${next ? `; ${next}` : ''}`,
      init.cause === undefined ? undefined : { cause: init.cause });
    this.kind = init.kind;
    this.refusal = init.refusal;
    this.applied = init.applied;
    this.methodId = init.methodId;
    this.route = init.route;
    this.baseUrl = init.baseUrl;
    if (init.source !== undefined) this.source = init.source;
  }
}

export function isHostFailure(error: unknown): error is HostFailure {
  return error instanceof HostFailure;
}

/** Multi-line rendering for a terminal: what failed, then the state, the reason and each next step. */
export function formatHostFailure(failure: HostFailure): string {
  return [
    `Connected-host call failed: ${failure.methodId} (${failure.kind})`,
    `  route ${failure.route}`,
    `  connected host ${failure.baseUrl}${failure.source ? ` (credential from ${failure.source})` : ''}`,
    `  state: ${failure.refusal.state}`,
    `  reason: ${failure.refusal.reason}`,
    ...failure.refusal.next.map(step => `  next: ${step}`),
  ].join('\n');
}

export interface ConnectedHostInvokeOptions {
  readonly signal?: AbortSignal | undefined;
  /** Overrides the default deadline for this one call. */
  readonly deadlineMs?: number | undefined;
  /**
   * Whether a person asked for this call right now. Sent as the
   * explicit-user-request header the daemon's confirmation gate reads; leave it
   * unset for background work.
   */
  readonly explicitUserRequest?: boolean | undefined;
}

export interface ConnectedHost {
  /** Call one operator method. Resolves with its typed output or throws a `HostFailure`. */
  invoke<M extends OperatorMethodId>(
    methodId: M,
    input: OperatorMethodInput<M>,
    options?: ConnectedHostInvokeOptions,
  ): Promise<OperatorMethodOutput<M>>;
  /** The connection the next call would use. Never throws; a missing credential is `token: null` with `unavailable`. */
  connection(): ConnectedHostConnection;
}

export interface ConnectedHostClientOptions {
  /** Defaults to the global `fetch`, read at call time. */
  readonly fetchImpl?: typeof fetch | undefined;
  readonly readDeadlineMs?: number | undefined;
  readonly writeDeadlineMs?: number | undefined;
  /**
   * Check each answer against the method's output schema (the default). A
   * result-value face whose callers read the answer field by field themselves
   * (the daemon-backed stores, operator actions) turns this off: the check then
   * costs a schema walk per answer and turns a host that adds or drops one
   * field into a failed call although the host acted.
   */
  readonly validateResponses?: boolean | undefined;
}

// ── Resolution ────────────────────────────────────────────────────────────

const NO_CREDENTIAL_NEXT = [
  'provision the connected-host token with agent_harness mode:"provision_connected_host_token" setupItemId:"connected-host-auth" (it asks for confirmation), or pair this Agent with the host, then retry',
] as const;

interface CachedCredential {
  readonly pairingStamp: string;
  readonly operatorStamp: string;
  readonly value: ConnectedHostOperatorToken;
}

const CREDENTIAL_CACHE_LIMIT = 8;
const credentialCache = new Map<string, CachedCredential>();

/** File identity and change time; `absent` when there is no file; null when it cannot be read (never cached). */
function fileStamp(path: string): string | null {
  try {
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    return stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : 'absent';
  } catch {
    return null;
  }
}

function environmentToken(): boolean {
  return Boolean(process.env.GOODVIBES_CONNECTED_HOST_TOKEN?.trim() || process.env.GOODVIBES_DAEMON_TOKEN?.trim());
}

/**
 * The credential for one host, re-read only when a file it depends on changed.
 * A pairing outranks the token file, so while the pairing is the source only the
 * pairing file is checked.
 */
function readCredential(homeDirectory: string, baseUrl: string): ConnectedHostOperatorToken {
  if (environmentToken()) return readConnectedHostOperatorToken(homeDirectory, baseUrl);
  const key = `${resolvePath(homeDirectory)}\n${baseUrl}`;
  const pairingStamp = fileStamp(agentHostPairingStorePath(homeDirectory));
  const cached = credentialCache.get(key);
  if (cached && pairingStamp !== null && cached.pairingStamp === pairingStamp
    && (cached.value.source === 'pairing' || cached.operatorStamp === fileStamp(connectedHostOperatorTokenPath(homeDirectory)))) {
    return cached.value;
  }
  const operatorStamp = fileStamp(connectedHostOperatorTokenPath(homeDirectory));
  const value = readConnectedHostOperatorToken(homeDirectory, baseUrl);
  credentialCache.delete(key);
  // An unreadable store can be fixed without touching the file (a directory's mode), so it is never cached.
  if (pairingStamp !== null && operatorStamp !== null && value.error === undefined) {
    credentialCache.set(key, { pairingStamp, operatorStamp, value });
    if (credentialCache.size > CREDENTIAL_CACHE_LIMIT) {
      const oldest = credentialCache.keys().next().value;
      if (oldest !== undefined) credentialCache.delete(oldest);
    }
  }
  return value;
}

function dialSettingValue(value: unknown): boolean | string | number | undefined {
  return typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

/**
 * Which host this Agent dials and which credential it presents, with one
 * precedence for every feature. Never throws: an unusable credential comes back
 * as `token: null` with the reason and the next step in `unavailable`.
 */
export function resolveConnectedHost(selection: ConnectedHostSelection): ConnectedHostConnection {
  if (selection.inProcess) return selection.inProcess.connection();
  const { configManager } = selection;
  const address = resolveConnectedHostAddress({ get: (key: ConnectedHostAddressKey) => configManager.get(key) });
  const { baseUrl } = address;
  if (!resolveConnectedHostDialEnabled({ get: key => dialSettingValue(configManager.get(key)) })) {
    return {
      baseUrl, token: null, credential: 'daemon.connectedHost.enabled',
      unavailable: {
        code: 'dial_disabled',
        reason: 'this Agent is set not to dial a connected host (daemon.connectedHost.enabled is false)',
        next: ['set daemon.connectedHost.enabled to true in settings, then retry'],
      },
    };
  }
  if (address.refusal) {
    return {
      baseUrl, token: null, credential: 'daemon.connectedHost.url',
      unavailable: {
        code: 'address_unstated',
        reason: address.refusal,
        next: ['set daemon.connectedHost.url to the host\'s https:// or http:// origin in settings, then retry'],
      },
    };
  }
  const tooOld = (selection.hostRefusal ?? processHostRefusal)?.();
  if (tooOld) {
    return {
      baseUrl, token: null, credential: 'the daemon build check',
      unavailable: { code: 'host_too_old', reason: tooOld, next: ['update GoodVibes on the host (goodvibes-daemon) to this Agent\'s version, then retry'] },
    };
  }
  const homeDirectory = typeof selection.homeDirectory === 'function' ? selection.homeDirectory() : selection.homeDirectory;
  const credential = readCredential(homeDirectory, baseUrl);
  const base = {
    baseUrl, source: credential.source, credential: credential.path,
    ...(credential.expectedPrincipalId === undefined ? {} : { expectedPrincipalId: credential.expectedPrincipalId }),
  };
  if (credential.token && selection.accept && !selection.accept.includes(credential.source)) {
    return {
      ...base, token: null,
      unavailable: {
        code: 'source_not_accepted',
        reason: `this operation accepts only a credential from ${selection.accept.join(' or ')}, and the one in effect comes from ${credential.source} (${credential.path})`,
        next: credential.source === 'environment'
          ? ['unset GOODVIBES_CONNECTED_HOST_TOKEN and GOODVIBES_DAEMON_TOKEN for this Agent, pair it with the host, then retry']
          : ['pair this Agent with the host, then retry'],
      },
    };
  }
  if (credential.token) return { ...base, token: credential.token };
  return {
    ...base, token: null,
    unavailable: credential.error
      ? { code: 'credential_unreadable', reason: credential.error, next: NO_CREDENTIAL_NEXT }
      : { code: 'no_credential', reason: `no connected-host credential was found (looked in ${credential.path})`, next: NO_CREDENTIAL_NEXT },
  };
}

// ── Transport ─────────────────────────────────────────────────────────────

type FetchLike = typeof fetch;

/** Clients by fetch implementation, then by host and credential: the contract's schema table is built once per client. */
const clientCache = new WeakMap<FetchLike, Map<string, OperatorApiClient>>();
const CLIENT_CACHE_LIMIT = 4;

function clientFor(baseUrl: string, token: string, fetchImpl: FetchLike, validateResponses: boolean): OperatorApiClient {
  let clients = clientCache.get(fetchImpl);
  if (!clients) {
    clients = new Map();
    clientCache.set(fetchImpl, clients);
  }
  const key = `${baseUrl}\n${token}\n${validateResponses ? 'validated' : 'raw'}`;
  let client = clients.get(key);
  if (!client) {
    // A redirect would carry the credential to wherever the host points; refuse it.
    // Every call names the Agent, so what the owner does in it is attributed to it (an inbox answer says agent).
    const noRedirect = (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      headers.set('x-goodvibes-client', 'agent');
      return fetchImpl(input, { ...init, headers, redirect: 'error' });
    };
    client = createOperatorApiClient({ baseUrl, authToken: token, fetchImpl: noRedirect, retry: { maxAttempts: 1 }, validateResponses });
    clients.set(key, client);
    if (clients.size > CLIENT_CACHE_LIMIT) {
      const oldest = clients.keys().next().value;
      if (oldest !== undefined) clients.delete(oldest);
    }
  }
  return client;
}

function seconds(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/** The system's code for a connection fault: the cause's first, since the transport wraps it in an error of its own. */
function errnoCode(error: unknown): string | undefined {
  const own = error instanceof GoodVibesError ? undefined : error;
  for (const value of [(error as { cause?: unknown } | null)?.cause, own]) {
    const code = (value as { code?: unknown } | null)?.code;
    if (typeof code === 'string' && code) return code;
  }
  return undefined;
}

/** Bun names a refused connection `ConnectionRefused`; Node uses the errno. Either means nothing was sent. */
function connectionRefused(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ECONNREFUSED' || code === 'ConnectionRefused';
}

/** The host's own words for a refusal, bounded and on one line. */
function hostMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // eslint-disable-next-line no-control-regex
  const text = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}...` : text || 'no message';
}

/**
 * One bounded `GET /status`: does a GoodVibes host answer at this address at
 * all. The one probe every connected-host caller uses to tell a host older
 * than this Agent (it answers) from nothing listening (it does not).
 */
export async function fetchConnectedHostStatus(
  connection: { readonly baseUrl: string; readonly token: string | null; readonly fetch?: typeof fetch | undefined },
  options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined } = {},
): Promise<{ readonly ok: boolean; readonly status: number; readonly body: unknown }> {
  options.assertCurrent?.();
  const deadline = AbortSignal.timeout(STATUS_PROBE_DEADLINE_MS);
  try {
    const response = await (connection.fetch ?? globalThis.fetch)(`${connection.baseUrl}/status`, {
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, deadline]) : deadline,
      headers: connection.token ? { authorization: `Bearer ${connection.token}` } : undefined,
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, body: hostMessage(error) };
  }
}

interface CallFacts {
  readonly methodId: string;
  readonly route: string;
  readonly isRead: boolean;
  readonly connection: ConnectedHostConnection & { readonly token: string };
  readonly fetchImpl: FetchLike;
  readonly callerSignal: AbortSignal | undefined;
  readonly deadline: AbortSignal;
  readonly deadlineMs: number;
}

/** The state and next steps a host states in its own error body; they outrank what this client can infer. */
function hostStatedRefusal(error: unknown): { readonly state?: string; readonly next: readonly string[] } {
  const body = (error as { body?: unknown } | null)?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { next: [] };
  const record = body as Record<string, unknown>;
  const state = typeof record.state === 'string' && record.state.trim() ? record.state.trim() : undefined;
  const next = Array.isArray(record.next)
    ? (record.next as unknown[]).filter((step): step is string => typeof step === 'string' && step.trim().length > 0).slice(0, 8)
    : [];
  return state === undefined ? { next } : { state, next };
}

/** Status, errno and structured fields decide; the wording is only ever reported. */
async function classifyFailure(error: unknown, facts: CallFacts): Promise<HostFailure> {
  const { methodId, route, isRead, connection } = facts;
  const stated = hostStatedRefusal(error);
  const failure = (kind: HostFailureKind, applied: HostCallApplied, inferred: HostRefusal) => new HostFailure({
    kind, applied, methodId, route, baseUrl: connection.baseUrl, source: connection.source, cause: error,
    refusal: {
      ...inferred,
      ...(stated.state === undefined ? {} : { state: stated.state }),
      next: [...stated.next, ...inferred.next.filter(step => !stated.next.includes(step))],
    },
  });
  const sentWrite: HostCallApplied = isRead ? 'no' : 'unknown';
  const checkFirst = 'check whether the change happened before repeating it; the host may have applied it';

  if (facts.callerSignal?.aborted) {
    return failure('cancelled', sentWrite, {
      code: 'cancelled', state: 'the call was cancelled', retryable: false,
      reason: 'the caller stopped waiting before the connected host answered',
      next: [isRead ? 'call again when the answer is still wanted' : checkFirst],
    });
  }
  if (facts.deadline.aborted) {
    return failure('connected_host_unavailable', sentWrite, {
      code: 'host_timeout', retryable: isRead,
      state: `the connected host at ${connection.baseUrl} accepted the request but did not answer`,
      reason: `connected host did not answer within ${seconds(facts.deadlineMs)}`,
      next: [isRead ? 'check the daemon with agent_harness mode:"connected_host_status", then retry' : checkFirst],
    });
  }

  const status = httpStatusOf(error);
  if (status !== undefined) {
    const reason = `${hostMessage(error)} (HTTP ${status})`;
    const retryAfterMs = (error as { retryAfterMs?: unknown }).retryAfterMs;
    switch (categoryForStatus(status)) {
      case 'authentication':
        return failure('auth_required', 'no', {
          code: 'auth_rejected', status, reason, retryable: false,
          state: `the connected host rejected the credential from ${connection.credential}`,
          next: ['pair this Agent with the host again or provision a fresh connected-host token (agent_harness mode:"connected_host_status" shows which), then retry'],
        });
      case 'authorization':
        return failure('auth_required', 'no', {
          code: 'forbidden', status, reason, retryable: false,
          state: `the credential from ${connection.credential} is valid but may not call ${methodId}`,
          next: ['use a credential the host grants this scope to, then retry'],
        });
      case 'not_found': {
        // The host names a missing record with its own code (SESSION_NOT_FOUND and the like);
        // only an unknown route or method (METHOD_NOT_FOUND, or a bare 404) says anything about the host's version.
        const bodyCode = error instanceof GoodVibesError ? error.code : undefined;
        if (bodyCode !== undefined && bodyCode !== 'METHOD_NOT_FOUND' && bodyCode !== 'NOT_FOUND') {
          return failure('connected_host_error', 'no', {
            code: 'not_found', status, reason, retryable: false,
            state: `the connected host has no such record (${bodyCode})`,
            next: [error instanceof GoodVibesError && error.next?.[0] ? error.next[0] : 'check the id with the matching list, then retry'],
          });
        }
        // A 404 alone cannot tell a host older than this Agent from no GoodVibes host at all.
        const answers = (await fetchConnectedHostStatus({ baseUrl: connection.baseUrl, token: connection.token, fetch: facts.fetchImpl },
          { signal: facts.callerSignal })).ok;
        return answers
          ? failure('connected_host_incompatible', 'no', {
            code: 'incompatible', status, reason, retryable: false,
            state: `the GoodVibes host at ${connection.baseUrl} is running but did not serve ${route}`,
            next: ['if the request names the right record, update GoodVibes on the host to the version this Agent was built with'],
          })
          : failure('connected_host_route_unavailable', 'no', {
            code: 'route_unavailable', status, reason, retryable: false,
            state: `nothing at ${connection.baseUrl} served ${route} or /status`,
            next: ['check that daemon.connectedHost.url (or, for the daemon on this machine, controlPlane.host and controlPlane.port) points at the GoodVibes daemon, then retry'],
          });
      }
      case 'timeout':
        return failure('connected_host_unavailable', sentWrite, {
          code: 'host_timeout', status, reason, retryable: isRead,
          state: `the connected host at ${connection.baseUrl} timed out`,
          next: [isRead ? 'retry; if it keeps timing out, check the daemon with agent_harness mode:"connected_host_status"' : checkFirst],
        });
      case 'rate_limit':
        return failure('connected_host_error', 'no', {
          code: 'rate_limited', status, reason, retryable: true,
          ...(typeof retryAfterMs === 'number' ? { retryAfterMs } : {}),
          state: 'the connected host is limiting requests',
          next: [typeof retryAfterMs === 'number' ? `retry after ${seconds(retryAfterMs)}` : 'wait, then retry'],
        });
      case 'service':
        return failure('connected_host_error', sentWrite, {
          code: 'host_failed', status, reason, retryable: isRead,
          state: `the connected host failed while handling ${route}`,
          next: [isRead ? 'retry; if it keeps failing, read the daemon log on the host' : checkFirst],
        });
      default:
        return failure('connected_host_error', 'no', {
          code: 'host_refused', status, reason, retryable: false,
          state: `the connected host refused ${methodId}`,
          next: ['correct the request as the host says, then retry'],
        });
    }
  }

  if (error instanceof GoodVibesError) {
    if (error.phase === 'response-validation' || error.category === 'protocol') {
      const applied: HostCallApplied = isRead ? 'no' : error.phase === 'response-validation' ? 'answered' : 'unknown';
      return failure('connected_host_error', applied, {
        code: 'response_invalid', reason: hostMessage(error), retryable: false,
        state: 'the host answered, but not in the shape this Agent expects',
        next: [applied === 'answered'
          ? 'do not repeat the request: the host received it, but whether it finished or is still queued is not verified; check the resulting state'
          : 'run the same GoodVibes version on the host and in this Agent, then retry'],
      });
    }
    if (error.category === 'contract') {
      return failure('connected_host_error', 'no', {
        code: 'bad_input', reason: hostMessage(error), retryable: false,
        state: `the request for ${methodId} could not be built`,
        next: ['correct the input the message names, then retry'],
      });
    }
  }
  const code = errnoCode(error);
  const network = categoryForCode(code) !== undefined || (error instanceof GoodVibesError && error.category === 'network');
  if (network) {
    const refused = connectionRefused(error);
    return failure('connected_host_unavailable', refused ? 'no' : sentWrite, {
      code: 'host_unreachable', retryable: refused || isRead,
      state: `the connected host at ${connection.baseUrl} could not be reached`,
      reason: hostMessage(error) + (code && !hostMessage(error).includes(code) ? ` (${code})` : ''),
      next: [refused || isRead
        ? 'start the GoodVibes daemon (goodvibes-daemon), or check daemon.connectedHost.url (for the daemon on this machine, controlPlane.host and controlPlane.port), then retry'
        : checkFirst],
    });
  }
  return failure('connected_host_error', sentWrite, {
    code: 'unknown', reason: hostMessage(error), retryable: false,
    state: `the call to ${methodId} failed for a reason the Agent cannot classify`,
    next: [isRead ? 'retry; if it fails again, report the message' : checkFirst],
  });
}

async function failWith(error: unknown, facts: CallFacts): Promise<never> {
  throw await classifyFailure(error, facts);
}

// ── The client ────────────────────────────────────────────────────────────

/**
 * Build the connected-host client. Pass a selection to use the Agent's one
 * resolution, or a function when the caller already holds the connection.
 */
export function createConnectedHost(
  from: ConnectedHostSelection | (() => ConnectedHostConnection),
  options: ConnectedHostClientOptions = {},
): ConnectedHost {
  const connection = typeof from === 'function' ? from : () => resolveConnectedHost(from);
  const readDeadlineMs = options.readDeadlineMs ?? CONNECTED_HOST_READ_DEADLINE_MS;
  const writeDeadlineMs = options.writeDeadlineMs ?? CONNECTED_HOST_WRITE_DEADLINE_MS;

  function invoke<M extends OperatorMethodId>(
    methodId: M,
    input: OperatorMethodInput<M>,
    callOptions: ConnectedHostInvokeOptions = {},
  ): Promise<OperatorMethodOutput<M>> {
    const binding = findOperatorHttpBinding(methodId);
    // A method published for the WebSocket only has no REST route; the host
    // serves it through its invoke-by-id endpoint, behind the same access gate.
    const listed = binding ? null : findOperatorContractMethod(methodId);
    const invokePath = `/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`;
    const route = binding ? `${binding.httpMethod} ${binding.pathTemplate}` : listed ? `POST ${invokePath}` : methodId;
    const scopes = listed?.scopes ?? [];
    const isRead = binding
      ? READ_ONLY_HTTP_METHODS.has(binding.httpMethod)
      : scopes.length > 0 && scopes.every((scope) => scope.startsWith('read:'));
    let resolved: ConnectedHostConnection;
    try {
      resolved = connection();
    } catch (error) {
      return Promise.reject(error);
    }
    const refuse = (kind: HostFailureKind, refusal: HostRefusal, cause?: unknown): Promise<never> => Promise.reject(new HostFailure({
      kind, refusal, applied: 'no', methodId, route, baseUrl: resolved.baseUrl, source: resolved.source, cause,
    }));

    if (callOptions.signal?.aborted) {
      return refuse('cancelled', {
        code: 'cancelled', state: 'the call was cancelled', retryable: false,
        reason: 'the caller stopped waiting before the request was sent', next: ['call again when it is still wanted'],
      });
    }
    if (!binding && !listed) {
      return refuse('connected_host_error', {
        code: 'method_unknown', retryable: false,
        state: `${methodId} is not in the operator contract this Agent was built with`,
        reason: 'no route is known for this method', next: ['update the Agent, or call a method the contract lists'],
      });
    }
    try {
      for (const match of (binding?.pathTemplate ?? '').matchAll(/\{([^}]+)\}/g)) {
        const name = match[1]!.trim();
        const value = (input as Record<string, unknown> | undefined)?.[name];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') assertSafeOperatorPathValue(String(value), name);
      }
    } catch (error) {
      return refuse('connected_host_error', {
        code: 'bad_input', retryable: false, state: `the request for ${methodId} could not be built`,
        reason: hostMessage(error), next: ['pass a real identifier, then retry'],
      }, error);
    }
    if (resolved.token === null && resolved.unavailable?.code === 'host_too_old') {
      return refuse('connected_host_incompatible', {
        code: 'host_too_old', reason: resolved.unavailable.reason, next: resolved.unavailable.next, retryable: false,
        state: `the GoodVibes host at ${resolved.baseUrl} is older than this Agent build needs`,
      });
    }
    if (resolved.token === null && resolved.unavailable?.code === 'address_unstated') {
      return refuse('connected_host_unavailable', {
        code: 'address_unstated', reason: resolved.unavailable.reason, next: resolved.unavailable.next, retryable: false,
        state: 'nothing was sent',
      });
    }
    if (resolved.token === null) {
      const unavailable = resolved.unavailable ?? {
        code: 'no_credential', next: NO_CREDENTIAL_NEXT,
        reason: `no connected-host credential was found${resolved.credential ? ` (looked in ${resolved.credential})` : ''}`,
      };
      return refuse('auth_required', {
        code: unavailable.code, reason: unavailable.reason, next: unavailable.next, retryable: false,
        state: `no usable credential for the connected host at ${resolved.baseUrl}`,
      });
    }

    const fetchImpl = resolved.fetch ?? options.fetchImpl ?? globalThis.fetch;
    const { signal, deadline, deadlineMs } = requestDeadline(callOptions.deadlineMs ?? (isRead ? readDeadlineMs : writeDeadlineMs), callOptions.signal);
    const facts: CallFacts = {
      methodId, route, isRead, connection: { ...resolved, token: resolved.token }, fetchImpl,
      callerSignal: callOptions.signal, deadline, deadlineMs,
    };
    let client: OperatorApiClient;
    try {
      client = clientFor(resolved.baseUrl, resolved.token, fetchImpl, options.validateResponses !== false);
    } catch (error) {
      return failWith(error, facts);
    }
    // The client's typed overload takes a conditional argument tuple that cannot
    // be resolved against a still-generic `M`; both ends stay bound to `M`.
    const call = client.invoke as unknown as (
      methodId: M,
      input: OperatorMethodInput<M>,
      options: { readonly signal: AbortSignal; readonly headers?: Record<string, string> },
    ) => Promise<OperatorMethodOutput<M>>;
    const headers = callOptions.explicitUserRequest === undefined
      ? undefined
      : { [EXPLICIT_USER_REQUEST_HEADER]: String(callOptions.explicitUserRequest) };
    let pending: Promise<OperatorMethodOutput<M>>;
    try {
      pending = binding
        ? call(methodId, input, headers ? { signal, headers } : { signal })
        : client.transport.requestJson<OperatorMethodOutput<M>>(invokePath, {
          method: 'POST', body: { body: input ?? {} }, methodId, signal, ...(headers ? { headers } : {}),
        });
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.catch((error: unknown) => failWith(error, facts));
  }

  return { invoke, connection };
}
