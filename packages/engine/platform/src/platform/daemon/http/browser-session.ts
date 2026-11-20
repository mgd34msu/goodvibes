/**
 * `POST /api/browser-session`: the web UI's sign-in on its direct route. The
 * browser presents what it signs in with (a sign-in code or device token from
 * `goodvibes pair`, a pasted operator token, or a username and password) and the
 * daemon binds it to an HttpOnly, SameSite=Strict cookie (Secure over TLS) that
 * no page script can read. The credential never comes back in the body; the
 * page reads only the identity marker beside it (`goodvibes_identity`: a fresh
 * generation and who is signed in). `POST /logout` ends a sign-in session and
 * clears both cookies.
 *
 * Held to the page's origin: the request must name the daemon's own origin (or
 * one the owner allowed in `controlPlane.cors.allowedOrigins`), so a page on the
 * same host at another port cannot sign the browser in as someone else. A
 * password goes through the one sign-in handler (operator-login.ts), with its
 * per-address limit, lock and bounded password queue.
 *
 * Cost: one request per sign-in, nothing on an ordinary turn. A password sign-in
 * costs what `POST /login` costs (one session write); a code or token costs one
 * authentication, as any request presenting it does.
 */
import type { RequestPrincipal } from '@goodvibes/engine/daemon-api/http-policy';
import {
  buildExpiredRemoteNodeCookie, buildIdentityMarkerCookie, buildOperatorSessionCookie, buildRemoteNodeCookie, mintIdentityMarker,
  NON_EXPIRING_BROWSER_CREDENTIAL_MS, type CredentialRefusal,
} from '../../security/http-auth.js';
import type { DistributedPeerAuth } from '../../runtime/remote/index.js';
import { browserOriginAllowed, originNotAllowedResponse } from './browser-origin.js';
import { jsonErrorResponse } from './error-response.js';
import { parseDaemonJsonText } from './router-request-body.js';
import { readTextBodyWithinLimit } from '../../utils/request-body.js';

export interface BrowserSessionDeps {
  /** The principal a bearer credential authenticates as, through the daemon's one request authentication. */
  readonly authenticate: (req: Request) => { readonly principal: RequestPrincipal } | null;
  /**
   * The password sign-in (`POST /login`'s handler), answered for `signIn` (a request carrying
   * `{ username, password }`), counted against the address `original` came from.
   */
  readonly passwordSignIn: (signIn: Request, original: Request) => Promise<Response>;
  /** Why a credential the daemon knows is refused, or null. */
  readonly describeCredentialRefusal?: ((token: string) => CredentialRefusal | null) | undefined;
  /** A presented credential that did not authenticate (audited as a failed sign-in). */
  readonly recordRefused: (req: Request) => void;
  /** The browser origins the owner allowed besides the daemon's own. */
  readonly allowedBrowserOrigins: () => readonly string[];
  /** Whether a forwarded `https` marks the cookies Secure. */
  readonly trustProxy: boolean;
}

const MAX_BODY_BYTES = 16 * 1024;

export async function handleBrowserSession(req: Request, deps: BrowserSessionDeps): Promise<Response> {
  const origin = req.headers.get('origin');
  if (origin === null || !browserOriginAllowed(req, origin, deps.allowedBrowserOrigins())) {
    return originNotAllowedResponse(origin, 'sign this browser in');
  }
  if (req.headers.get('content-type')?.split(';', 1)[0]!.trim().toLowerCase() !== 'application/json') {
    return jsonErrorResponse({
      error: 'Unsupported media type', code: 'SIGN_IN_NOT_JSON', state: 'the sign-in body was not sent as application/json',
      next: ['Send { "token": "<code>" } or { "username": "…", "password": "…" } with Content-Type: application/json'],
    }, { status: 415 });
  }
  const text = await readTextBodyWithinLimit(req, MAX_BODY_BYTES);
  if (text instanceof Response) return text;
  const body = parseDaemonJsonText(text);
  if (body instanceof Response) return body;

  if (typeof body.username === 'string' || typeof body.password === 'string') {
    // The one sign-in handler, on the same address and headers; its refusals pass through as they are.
    const headers = new Headers(req.headers);
    headers.delete('content-length');
    const signedIn = await deps.passwordSignIn(new Request(req.url, {
      method: 'POST', headers, body: JSON.stringify({ username: body.username, password: body.password }),
    }), req);
    if (!signedIn.ok) return withoutCookies(signedIn);
    const session = await signedIn.json() as { readonly token?: unknown; readonly username?: unknown; readonly expiresAt?: unknown };
    if (typeof session.token !== 'string' || typeof session.username !== 'string' || typeof session.expiresAt !== 'number') {
      return jsonErrorResponse({ error: 'The sign-in did not produce a session', code: 'SIGN_IN_FAILED', state: 'the password was accepted but no session came back', next: ['Sign in again'] }, { status: 500 });
    }
    return bound(req, deps, session.token, session.username, 'user-session', session.expiresAt);
  }

  const token = typeof body.token === 'string' ? body.token.replace(/^Bearer\s+/i, '').trim() : '';
  if (!token) {
    return jsonErrorResponse({
      error: 'Nothing to sign in with', code: 'SIGN_IN_EMPTY', state: 'the body named neither a code nor a username and password',
      next: ['Send { "token": "<code>" } or { "username": "…", "password": "…" }'],
    }, { status: 400 });
  }
  const presented = new Request(req.url, { headers: { authorization: `Bearer ${token}` } });
  const principal = deps.authenticate(presented)?.principal;
  if (!principal) {
    deps.recordRefused(req);
    const known = deps.describeCredentialRefusal?.(token) ?? null;
    return jsonErrorResponse(known
      ? { error: known.reason, code: known.code, state: known.state, next: known.next }
      : { error: 'That code was not accepted', code: 'UNAUTHENTICATED', state: 'the daemon does not know this code, or it was revoked or has expired', next: ['Run goodvibes pair for a new code'] },
    { status: 401 });
  }
  // A sign-in session keeps its own end (renewed on each auth read); a token does not expire by itself.
  const sessionEnd = principal.credentialKind === 'user-session' ? principal.expiresAt ?? null : null;
  return bound(req, deps, token, principal.principalId, principal.credentialKind, sessionEnd);
}

function bound(req: Request, deps: BrowserSessionDeps, token: string, principalId: string, credential: string, sessionEnd: number | null): Response {
  const cookie = { req, expiresAt: sessionEnd ?? Date.now() + NON_EXPIRING_BROWSER_CREDENTIAL_MS, trustProxy: deps.trustProxy };
  const response = Response.json({ authenticated: true, principalId, credential, expiresAt: sessionEnd }, { headers: { 'Cache-Control': 'no-store' } });
  response.headers.append('Set-Cookie', buildOperatorSessionCookie(token, cookie));
  response.headers.append('Set-Cookie', buildIdentityMarkerCookie(mintIdentityMarker(principalId), cookie));
  return response;
}

/** A refused password sign-in, without anything it would have set. */
function withoutCookies(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete('Set-Cookie');
  headers.set('Cache-Control', 'no-store');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export interface BrowserNodeSessionDeps {
  /** The remote peer a request's credential authenticates as (the peer routes' own check), or its refusal. */
  readonly requireRemotePeer: (req: Request) => Promise<DistributedPeerAuth | Response>;
  readonly allowedBrowserOrigins: () => readonly string[];
  readonly trustProxy: boolean;
}

/**
 * `POST /api/browser-session/node`: the web UI acting as a device node (the phone page)
 * binds the peer token its pairing returned to its own HttpOnly, SameSite=Strict cookie,
 * `goodvibes_node`, scoped to `/api/remote`. It is kept apart from the sign-in cookie on
 * purpose: the node is a different principal (a remote peer with its own scopes, its own
 * revocation and rotation), and the peer routes read only this cookie or a bearer, while
 * operator routes never read it, so neither credential can act with the other's rights.
 * `POST /api/browser-session/node/end` clears it. Both are held to the page's origin.
 */
export async function handleBrowserNodeSession(req: Request, deps: BrowserNodeSessionDeps): Promise<Response> {
  const origin = req.headers.get('origin');
  if (origin === null || !browserOriginAllowed(req, origin, deps.allowedBrowserOrigins())) {
    return originNotAllowedResponse(origin, 'bind a device node to this browser');
  }
  if (new URL(req.url).pathname.endsWith('/end')) {
    const response = Response.json({ cleared: true }, { headers: { 'Cache-Control': 'no-store' } });
    response.headers.append('Set-Cookie', buildExpiredRemoteNodeCookie(req, deps.trustProxy));
    return response;
  }
  const text = await readTextBodyWithinLimit(req, MAX_BODY_BYTES);
  if (text instanceof Response) return text;
  const body = parseDaemonJsonText(text);
  if (body instanceof Response) return body;
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) {
    return jsonErrorResponse({ error: 'No peer token', code: 'SIGN_IN_EMPTY', state: 'the body named no peer token', next: ['Send { "token": "<peer token from pair/verify>" }'] }, { status: 400 });
  }
  const auth = await deps.requireRemotePeer(new Request(req.url, { method: 'POST', headers: { authorization: `Bearer ${token}` } }));
  if (auth instanceof Response) return auth;
  const response = Response.json({ bound: true, nodeId: auth.peer.id }, { headers: { 'Cache-Control': 'no-store' } });
  response.headers.append('Set-Cookie', buildRemoteNodeCookie(token, { req, expiresAt: Date.now() + NON_EXPIRING_BROWSER_CREDENTIAL_MS, trustProxy: deps.trustProxy }));
  return response;
}
