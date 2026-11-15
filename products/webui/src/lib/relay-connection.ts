/**
 * relay-connection.ts, the transport ROUTE the platform client dispatches requests over.
 *
 * Two transports can answer a request:
 *   - direct: an ordinary `fetch` against GOODVIBES_BASE_URL (the LAN/co-located path,
 *     unchanged from before this file existed).
 *   - relay: `createRelayClient` (@goodvibes-jev/engine/transport-realtime) tunnels unary
 *     request/response calls, end-to-end encrypted, through a relay server, for when
 *     this device cannot reach the daemon directly. It requires a stored pairing (see
 *     relay-pairing.ts).
 *
 * STREAMING OVER RELAY: the relay tunnel now carries live event streams. A request whose
 * `Accept` is `text/event-stream` (the SSE opener's header, see
 * @goodvibes-jev/engine/transport-http's sse-stream.js) is opened by the relay client as a
 * tunnelled stream: the returned `Response` carries a `ReadableStream` body fed by the
 * tunnel's `stream-data` frames, and a dropped-chunk overflow surfaces as a visible
 * `relay-overflow` SSE event (never a silent gap). So `routedFetch` no longer rejects SSE
 * over relay, it hands the request straight to the relay client like any other, and the
 * webui's stream consumers render the `relay-overflow` notice honestly (see
 * relay-stream-overflow.ts).
 *
 * STEP-UP ON STATE-CHANGING RELAY CALLS: the daemon gates state-changing relay calls behind
 * a WebAuthn step-up assertion, deciding from the called method's catalog scopes (not the HTTP
 * verb, so the browser does not guess). A gated call with no usable assertion is answered
 * `401` with `www-authenticate: WebAuthn` and body `{ code: 'step-up-required', reason,
 * action, error, next }`. `routedFetch` intercepts that response for any verb, asks the
 * registered UI prompter to run the passkey ceremony (stepup-prompter.ts), and retries the
 * original call ONCE with the assertion header attached. When the daemon's `action` is
 * `register-locally` (no passkey it could accept is registered), no ceremony can help, so no
 * dialog opens and the 401 surfaces with its reason and next step. If no prompter is
 * registered or the operator cancels, the original 401 surfaces honestly too, never a silent
 * skip of verification.
 *
 * `routedFetch` is the one `fetch` implementation the platform client is built with
 * (lib/goodvibes.ts). It always exists and behaves exactly like the plain global fetch
 * when no relay pairing is stored, this file changes nothing for the common LAN/
 * co-located case.
 */

import { createRelayClient, type RelayClient } from '@goodvibes-jev/engine/transport-realtime';
import { clearStoredRelayPairing, getStoredRelayPairing, type RelayPairingPayload } from './relay-pairing';
import { STEP_UP_ASSERTION_HEADER } from './stepup';
import { resolveStepUp } from './stepup-prompter';

export type ConnectionRoute = 'direct' | 'relay';

// ---------------------------------------------------------------------------
// Route store, a tiny module-level pub/sub. Plain (non-React) code, like
// routedFetch below, reads the snapshot directly; React reads it reactively via
// useSyncExternalStore in useDaemonHealth.
//
// A route is transport, not identity: flipping it re-opens the live streams (their
// hooks depend on the route) and lets in-flight requests finish or fail on their own.
// It never bumps the client lifetime, so drafts, attachments and the query cache
// survive a device moving between its home network and the relay. The last route that
// answered is remembered for this tab session beside the pairing, so a reload away
// from home starts on the relay instead of waiting for the direct probe to fail.
// ---------------------------------------------------------------------------

const ROUTE_SESSION_KEY = 'goodvibes.webui.relayRoute';

function readRememberedRoute(): ConnectionRoute {
  try {
    return globalThis.sessionStorage?.getItem(ROUTE_SESSION_KEY) === 'relay' && getStoredRelayPairing() ? 'relay' : 'direct';
  } catch {
    return 'direct';
  }
}

function rememberRoute(route: ConnectionRoute): void {
  try {
    if (route === 'relay') globalThis.sessionStorage?.setItem(ROUTE_SESSION_KEY, route);
    else globalThis.sessionStorage?.removeItem(ROUTE_SESSION_KEY);
  } catch {
    // Unusable session storage only costs the head start on the next load.
  }
}

let activeRoute: ConnectionRoute = readRememberedRoute();
const listeners = new Set<() => void>();

/** Current active route: the remembered one for this tab session, else 'direct'. */
export function getActiveRoute(): ConnectionRoute {
  return activeRoute;
}

/** Switch the active route. A no-op notify-wise if unchanged (avoids extra renders). */
export function setActiveRoute(route: ConnectionRoute): void {
  if (activeRoute === route) return;
  activeRoute = route;
  rememberRoute(route);
  for (const listener of listeners) listener();
}

export function subscribeActiveRoute(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---------------------------------------------------------------------------
// Relay client, lazy singleton over the stored pairing. Rebuilt if the stored
// pairing changes (e.g. a fresh scan replacing an old one).
// ---------------------------------------------------------------------------

let client: RelayClient | null = null;
let clientForPairingKey: string | null = null;

function pairingKey(pairing: RelayPairingPayload): string {
  return `${pairing.relayUrl}|${pairing.rid}|${pairing.daemonPublicKey}`;
}

/** Get (creating if needed) the relay client for the currently-stored pairing, or null if none is stored. */
export function getRelayClient(): RelayClient | null {
  const pairing = getStoredRelayPairing();
  if (!pairing) {
    // The pairing is gone: close the client rather than orphaning its socket.
    if (client) client.close();
    client = null;
    clientForPairingKey = null;
    return null;
  }
  const key = pairingKey(pairing);
  if (client && clientForPairingKey === key) return client;
  if (client) client.close();
  client = createRelayClient({ pairing });
  clientForPairingKey = key;
  return client;
}

/**
 * Tear down the relay client (e.g. after clearing the stored pairing). The pairing
 * write itself retires the client lifetime (relay-pairing.ts); closing a socket does not.
 */
export function closeRelayClient(): void {
  if (client) client.close();
  client = null;
  clientForPairingKey = null;
}

/**
 * Unpair this device from its relay daemon: forget the pairing, close the relay socket and
 * return to the direct route. Doing only some of these leaves `activeRoute === 'relay'` with
 * no pairing (requests fall back to a direct fetch until the next health pass) or a live
 * socket to a daemon the operator meant to leave.
 */
export function unpairRelay(): void {
  clearStoredRelayPairing();
  closeRelayClient();
  setActiveRoute('direct');
}

/**
 * Attempt to reach the daemon over the relay: connect the client (idempotent) and
 * confirm the end-to-end channel is ready. Returns false, never throws, on any
 * failure (no pairing stored, handshake failure, relay unreachable, timeout).
 */
export async function probeRelayReachability(): Promise<boolean> {
  const relayClient = getRelayClient();
  if (!relayClient) return false;
  try {
    await relayClient.connect();
    return relayClient.ready;
  } catch {
    return false;
  }
}

/** What one connection probe found: the route that answered, if any, and the direct latency. */
export interface ConnectionProbeResult {
  readonly route: ConnectionRoute | null;
  readonly latencyMs: number | null;
}

export type DirectProbe = () => Promise<{ ok: boolean; latencyMs: number | null }>;

let lastAnsweredRoute: ConnectionRoute | null = null;

/**
 * Find a route to the daemon. With no relay pairing this is the direct probe alone.
 * With one, the direct probe runs alone only while direct is the route that answered
 * last; otherwise (first probe, on the relay, or after a miss) the direct probe and the
 * relay connect start together, and the relay is adopted the moment it answers, before a
 * slow or hanging direct probe settles (`onRelayReady` lets the caller show it at once).
 * Direct is preferred whenever it answers, so a device back on its home network leaves
 * the relay on the next probe.
 */
export async function probeConnection(probeDirect: DirectProbe, onRelayReady?: () => void): Promise<ConnectionProbeResult> {
  if (!getStoredRelayPairing()) {
    const direct = await probeDirect();
    return { route: direct.ok ? 'direct' : null, latencyMs: direct.latencyMs };
  }
  if (activeRoute === 'direct' && lastAnsweredRoute === 'direct') {
    const direct = await probeDirect();
    if (direct.ok) return { route: 'direct', latencyMs: direct.latencyMs };
    lastAnsweredRoute = (await probeRelayReachability()) ? 'relay' : null;
    return { route: lastAnsweredRoute, latencyMs: null };
  }
  let directSettled = false;
  const relay = probeRelayReachability().then((ok) => {
    if (ok && !directSettled) {
      setActiveRoute('relay');
      onRelayReady?.();
    }
    return ok;
  });
  const direct = await probeDirect();
  directSettled = true;
  if (direct.ok) {
    lastAnsweredRoute = 'direct';
    return { route: 'direct', latencyMs: direct.latencyMs };
  }
  lastAnsweredRoute = (await relay) ? 'relay' : null;
  return { route: lastAnsweredRoute, latencyMs: null };
}

// ---------------------------------------------------------------------------
// routedFetch, the fetch the platform client is built with.
// ---------------------------------------------------------------------------

/** The HTTP method a fetch call carries, uppercased; the challenge is minted for it. */
function requestMethod(input: RequestInfo | URL, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return method.toUpperCase();
}

/** RequestInit owns an explicit signal override, including null; otherwise inherit the Request. */
function requestSignal(input: RequestInfo | URL, init: RequestInit | undefined): AbortSignal | undefined {
  if (init?.signal !== undefined) return init.signal ?? undefined;
  return input instanceof Request ? input.signal : undefined;
}

/** The request path (no host) a fetch call targets, what the step-up ceremony binds against. */
function requestPath(input: RequestInfo | URL): string {
  try {
    const href = input instanceof Request ? input.url : String(input);
    return new URL(href, globalThis.location?.origin ?? 'http://127.0.0.1').pathname;
  } catch {
    return '';
  }
}

/**
 * True when a fetch response is the daemon's "this call needs a fresh step-up assertion"
 * and a passkey ceremony could satisfy it. `register-locally` means no passkey the daemon
 * could accept is registered, so the ceremony is skipped and the refusal surfaces. Peeks a
 * clone so the caller's response body stays intact when we decide not to retry.
 */
async function isStepUpSatisfiable(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  if (!/WebAuthn/i.test(response.headers.get('www-authenticate') ?? '')) return false;
  try {
    const body = (await response.clone().json()) as { code?: string; action?: string };
    return body?.code === 'step-up-required' && body.action !== 'register-locally';
  } catch {
    return false;
  }
}

/** Re-issue a relay fetch with the step-up assertion header attached, preserving body/method. */
function withAssertion(
  relayClient: RelayClient,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  retryRequest: Request | null,
  assertion: string,
  signal: AbortSignal | undefined,
): Promise<Response> {
  signal?.throwIfAborted();
  if (retryRequest) {
    const headers = new Headers(retryRequest.headers);
    headers.set(STEP_UP_ASSERTION_HEADER, assertion);
    return relayClient.fetch(new Request(retryRequest, { headers, signal: signal ?? null }));
  }
  const headers = new Headers(init?.headers ?? undefined);
  headers.set(STEP_UP_ASSERTION_HEADER, assertion);
  return relayClient.fetch(input, { ...init, headers, signal: signal ?? null });
}

/**
 * Dispatch one relay fetch, transparently satisfying a step-up challenge. The daemon decides
 * which calls are gated, so any verb may come back `401 step-up-required`; then the UI
 * ceremony runs and the call is retried ONCE with the assertion header. Every other response
 * (including a refusal no ceremony can fix, or a cancelled ceremony) is returned unchanged so
 * the caller sees the honest outcome.
 */
async function relayFetchWithStepUp(relayClient: RelayClient, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Apply RequestInit once, before either dispatch consumes a native Request body.
  const effectiveRequest = input instanceof Request
    ? new Request(input, init?.signal === null ? { ...init, signal: new AbortController().signal } : init)
    : null;
  const requestInput = effectiveRequest ?? input;
  const requestInit = effectiveRequest ? undefined : init;
  const signal = requestSignal(requestInput, requestInit);
  signal?.throwIfAborted();
  // The retry preserves the effective method/body/headers/signal, adding only its assertion.
  const retryRequest = effectiveRequest ? effectiveRequest.clone() : null;

  const first = await relayClient.fetch(requestInput, requestInit);
  signal?.throwIfAborted();
  const satisfiable = await isStepUpSatisfiable(first);
  signal?.throwIfAborted();
  if (!satisfiable) return first;

  const assertion = await resolveStepUp({ method: requestMethod(requestInput, requestInit), path: requestPath(requestInput),
    ...(signal === undefined ? {} : { signal }) });
  signal?.throwIfAborted();
  if (!assertion) return first; // no prompter / cancelled / unsupported, surface the 401 honestly
  return withAssertion(relayClient, requestInput, requestInit, retryRequest, assertion, signal);
}

/**
 * The fetch implementation the platform client dispatches every call through. Routes to
 * the relay's tunneled fetch when the active route is 'relay'; otherwise behaves
 * exactly like the platform's native fetch (the pre-relay default).
 */
function routedFetchImpl(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (activeRoute !== 'relay') return globalThis.fetch(input, init);

  const relayClient = getRelayClient();
  if (!relayClient) return globalThis.fetch(input, init);
  return relayFetchWithStepUp(relayClient, input, init);
}

// The runtime's `fetch` carries a `preconnect` static (a Bun extension the platform's
// `typeof fetch` option type inherits from this project's global types) that a plain
// function value structurally lacks. Delegate it straight to the real fetch's own
// implementation so routedFetch is a genuine drop-in, not just a same-shaped cast.
export const routedFetch: typeof fetch = Object.assign(routedFetchImpl, {
  preconnect: (...args: Parameters<typeof fetch.preconnect>) => globalThis.fetch.preconnect(...args),
});
