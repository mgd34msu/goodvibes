/**
 * `POST /login`, the one sign-in handler. The control-plane listener and the
 * webhook listener both answer the route through it, so the protection is the
 * same on every port: a per-address limit before any password work, the
 * memory-hard password check off the event loop behind a bounded queue
 * (`UserAuthManager.authenticateSignIn`), and a lock that counts per username
 * and client address. An IPv6 address counts by its /64, the block one host
 * holds, so rotating through a host's own addresses does not reset either.
 */

import type { AddressRateLimiter } from '@goodvibes/engine/daemon-api';
import { logger } from '../utils/logger.js';
import { authFailureTotal, authSuccessTotal } from '../runtime/metrics.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitAuthFailed, emitAuthSucceeded } from '../runtime/emitters/security.js';
import {
  buildExpiredIdentityMarkerCookie, buildExpiredOperatorSessionCookie, buildIdentityMarkerCookie, buildOperatorSessionCookie,
  extractOperatorAuthToken, mintIdentityMarker,
} from '../security/http-auth.js';
import { refuseCookieWriteFromOtherOrigin } from './http/browser-origin.js';
import type { UserAuthManager } from '../security/user-auth.js';
import { parseDaemonJsonBody } from './http/router-request-body.js';
import { jsonErrorResponse } from './http/error-response.js';

/** The refusal code of a first sign-in with the generated password that did not set the owner's own. */
export const FIRST_SIGN_IN_SETS_PASSWORD = 'FIRST_SIGN_IN_SETS_PASSWORD';

/** Sign-in attempts one client address may make in a minute. */
export const SIGN_IN_ATTEMPTS_PER_MINUTE = 5;

export interface OperatorLoginDeps {
  readonly userAuth: UserAuthManager;
  /** The listener's per-address sign-in limit, checked before the body is read. */
  readonly limiter: AddressRateLimiter;
  readonly runtimeBus?: RuntimeEventBus | undefined;
  /** Which listener answered, on the security events. */
  readonly source: string;
  /** Whether a forwarded `https` marks the session cookie Secure. */
  readonly trustProxy: boolean;
}

/** The one sign-in source every loopback address of this machine counts as. */
export const LOOPBACK_SIGN_IN_SOURCE = 'loopback';

/**
 * The source a sign-in counts against: every loopback address (all of 127.0.0.0/8, ::1, an IPv4-mapped 127 address)
 * is ONE source, this machine, so a local process cannot use the 16 million loopback addresses as 16 million sources;
 * any other IPv4 address as it is (an IPv4-mapped IPv6 address as its IPv4 form), an IPv6 address by its /64.
 */
export function signInAddressKey(address: string): string {
  const bare = address.replace(/^\[|\]$/g, '').split('%')[0]!.toLowerCase();
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare) || /^(?:0{0,4}:){1,7}:?0{0,3}1$/.test(bare) || bare === '::1') return LOOPBACK_SIGN_IN_SOURCE;
  if (!bare.includes(':')) return bare;
  const mapped = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(bare);
  if (mapped) return mapped[1]!.startsWith('127.') ? LOOPBACK_SIGN_IN_SOURCE : mapped[1]!;
  const halves = bare.split('::');
  if (halves.length > 2) return bare;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const tailGroups = tail.length + (tail.at(-1)?.includes('.') ? 1 : 0);
  const groups = halves.length === 2 ? [...head, ...Array<string>(Math.max(0, 8 - head.length - tailGroups)).fill('0'), ...tail] : head;
  const prefix = groups.slice(0, 4);
  if (prefix.length < 4 || prefix.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return bare;
  return `${prefix.map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

export async function handleOperatorLogin(req: Request, clientAddress: string, deps: OperatorLoginDeps): Promise<Response> {
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const failed = (reason: 'invalid_credentials' | 'rate_limited'): void => {
    // Never the attempted username or any credential: an address is not tied to an account in the log.
    logger.warn('AUTH_FAILED', { type: 'AUTH_FAILED', requestId, clientIp: clientAddress, reason, source: deps.source });
    authFailureTotal.add(1);
    if (deps.runtimeBus) {
      emitAuthFailed(deps.runtimeBus, { sessionId: 'system', traceId: `auth:${requestId}`, source: deps.source },
        { usernameAttempted: '', clientIp: clientAddress, reason });
    }
  };

  // A cross-site form or text/plain POST needs no browser preflight; requiring
  // the JSON media type, before the per-address limit, keeps a page the owner
  // visits from spending the owner's sign-in attempts or lock budget on its
  // behalf. A 415 does no password work, so it takes no attempt. Every client
  // sends the JSON type.
  if (!isJsonMediaType(req.headers.get('content-type'))) {
    return jsonErrorResponse({
      error: 'Unsupported media type', code: 'SIGN_IN_NOT_JSON', state: 'the sign-in body was not sent as application/json',
      next: ['Send the username and password as a JSON object with Content-Type: application/json'],
    }, { status: 415 });
  }

  const addressKey = signInAddressKey(clientAddress);
  if (!deps.limiter.allow(addressKey)) {
    failed('rate_limited');
    return retryAfter(jsonErrorResponse({
      error: 'Too many requests', code: 'RATE_LIMITED', state: 'this address used its sign-in attempts for the minute',
      next: ['Wait a minute, then sign in again'],
    }, { status: 429 }), 60);
  }

  const body = await parseDaemonJsonBody(req);
  if (body instanceof Response) return body;
  const username = typeof body.username === 'string' ? body.username : '';
  const password = typeof body.password === 'string' ? body.password : '';
  const authResult = await deps.userAuth.authenticateSignIn(username, password, addressKey);

  if (!authResult.ok) {
    if (authResult.busy) {
      return retryAfter(jsonErrorResponse({
        error: 'The daemon is checking other sign-ins', code: 'SIGN_IN_BUSY', state: 'too many sign-ins are waiting for a password check',
        next: ['Sign in again in a few seconds'],
      }, { status: 503 }), 2);
    }
    const lockedUntilMs = authResult.lockedUntilMs;
    failed(lockedUntilMs ? 'rate_limited' : 'invalid_credentials');
    if (lockedUntilMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((lockedUntilMs - Date.now()) / 1_000));
      return retryAfter(jsonErrorResponse({
        error: 'Too many requests', code: 'SIGN_IN_LOCKED',
        state: addressKey === LOOPBACK_SIGN_IN_SOURCE
          ? 'repeated failed sign-ins from this computer held its sign-ins for a short time; sign-ins from other addresses are not held by them'
          : 'repeated failed sign-ins from this address held its sign-ins for a short time; sign-ins from other addresses are not held by them',
        next: [
          `Wait ${retryAfterSeconds} seconds, then sign in again`,
          'Or, on the computer the daemon runs on, open the terminal app or the Agent, go to Permissions and safety, Sign-in, and change your password there (p): a new password ends every hold at once',
        ],
      }, { status: 429 }), retryAfterSeconds);
    }
    if (authResult.staleBootstrapCredential) {
      // Only someone who read the private bootstrap file can send its exact pair, so saying why it failed tells a stranger nothing.
      return jsonErrorResponse({
        error: 'Invalid credentials', code: 'BOOTSTRAP_CREDENTIAL_STALE',
        state: 'the bootstrap credential file no longer matches the stored password, so its password does not sign in',
        next: [`Set a new password with goodvibes auth rotate-password ${username}`, 'Or delete both the user store and the bootstrap file and restart the daemon to generate a new admin'],
      }, { status: 401 });
    }
    if (authResult.withdrawnBootstrapCredential) {
      // Only someone who knew the generated password can send it, so saying it was withdrawn tells a stranger nothing.
      return jsonErrorResponse({
        error: 'Invalid credentials', code: 'BOOTSTRAP_CREDENTIAL_WITHDRAWN',
        state: 'this generated password signed in only while the bootstrap credential file held it, and that file was deleted or cleared',
        next: [`Set a password with goodvibes auth rotate-password ${username}`],
      }, { status: 401 });
    }
    if (authResult.passwordChangedDuringSignIn) {
      // Only someone who knew the previous password can reach this, so saying why tells a stranger nothing.
      return jsonErrorResponse({
        error: 'Invalid credentials', code: 'PASSWORD_CHANGED_DURING_SIGN_IN',
        state: 'this password was changed (or the account deleted) while the sign-in was being checked, so the previous password no longer signs in',
        next: ['Sign in with the new password'],
      }, { status: 401 });
    }
    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const { user } = authResult;
  // The first-run file's generated password is for the first sign-in only: that sign-in sets the owner's own password
  // (`newPassword`), which removes the file and retires the generated one (UserAuthManager.rotatePassword). The
  // generated pair alone never makes a session: a process that read the file is not the owner signing in.
  if (authResult.usedBootstrapCredential) {
    const chosen = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!chosen) {
      return jsonErrorResponse({
        error: 'Set your own password to finish the first sign-in', code: FIRST_SIGN_IN_SETS_PASSWORD,
        state: 'this is the generated first-run password: it signs in only once, by setting a password of your own; no session was made',
        next: ['Sign in again with the same username and password and a new password of your own (newPassword, at least 8 characters)'],
      }, { status: 409 });
    }
    if (chosen === password) {
      return jsonErrorResponse({
        error: 'Choose a password of your own', code: FIRST_SIGN_IN_SETS_PASSWORD,
        state: 'the new password is the generated one; no session was made', next: ['Choose a different password (at least 8 characters)'],
      }, { status: 400 });
    }
    try {
      deps.userAuth.rotatePassword(user.username, chosen);
    } catch (error) {
      return jsonErrorResponse({
        error: error instanceof Error ? error.message : String(error), code: FIRST_SIGN_IN_SETS_PASSWORD,
        state: 'your password was not set; no session was made', next: ['Choose a password of at least 8 characters, then sign in again'],
      }, { status: 400 });
    }
    logger.info('First sign-in: the owner set their own password; the first-run file was removed and its password retired', { username: user.username });
  }
  const session = deps.userAuth.createSession(user.username);
  authSuccessTotal.add(1);
  logger.info('AUTH_SUCCEEDED', { type: 'AUTH_SUCCEEDED', requestId, username: user.username, clientIp: clientAddress, method: 'password', source: deps.source });
  if (deps.runtimeBus) {
    emitAuthSucceeded(deps.runtimeBus, { sessionId: 'system', traceId: `auth:${requestId}`, source: deps.source },
      { username: user.username, sessionId: session.id, clientIp: clientAddress, method: 'password' });
  }

  // A bootstrap file is retired at a sign-in with a real password only once
  // nothing signs in with it: while the user it names still has the generated
  // password, the file is that password (deleting it withdraws it), so another
  // user's sign-in never takes it away.
  if (deps.userAuth.retireStaleBootstrapCredential()) {
    logger.info('Bootstrap credential file retired: the user it names has a password of its own', { username: user.username });
  }

  const response = Response.json({
    authenticated: true,
    token: session.token,
    username: session.username,
    expiresAt: session.expiresAt,
  }, { headers: { 'Cache-Control': 'no-store' } });
  const cookie = { req, expiresAt: session.expiresAt, trustProxy: deps.trustProxy };
  response.headers.append('Set-Cookie', buildOperatorSessionCookie(session.token, cookie));
  response.headers.append('Set-Cookie', buildIdentityMarkerCookie(mintIdentityMarker(session.username), cookie));
  return response;
}

export interface OperatorLogoutDeps {
  readonly userAuth: Pick<UserAuthManager, 'validateSession' | 'revokeSession'>;
  /** Which listener answered, on the log line. */
  readonly source: string;
  /** Whether a forwarded `https` marks the expired cookie Secure. */
  readonly trustProxy: boolean;
  /** The browser origins the owner allowed besides the daemon's own (`controlPlane.cors.allowedOrigins`). Absent: only the daemon's own. */
  readonly allowedBrowserOrigins?: (() => readonly string[]) | undefined;
}

/**
 * `POST /logout`: ends the sign-in session the request presents (its bearer,
 * or the session cookie) and expires the credential cookie and the identity
 * marker beside it. It needs no role: a session may always end itself, and the
 * credential travels in the header or cookie, never in the path, so no access
 * log or proxy records it. Another site's page never carries the cookie
 * (SameSite=Strict) and cannot set the Authorization header; a page on the
 * same host at another port does carry it, so a request on the cookie is
 * served only for the daemon's own origin or one the owner allowed.
 */
export function handleOperatorLogout(req: Request, deps: OperatorLogoutDeps): Response {
  const token = extractOperatorAuthToken(req);
  const viaCookie = token !== '' && !/^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '');
  const refusedOrigin = viaCookie ? refuseCookieWriteFromOtherOrigin(req, deps.allowedBrowserOrigins ?? (() => [])) : null;
  if (refusedOrigin) return refusedOrigin;
  const session = token ? deps.userAuth.validateSession(token) : null;
  const expire = (response: Response): Response => {
    response.headers.append('Set-Cookie', buildExpiredOperatorSessionCookie(req, deps.trustProxy));
    response.headers.append('Set-Cookie', buildExpiredIdentityMarkerCookie(req, deps.trustProxy));
    response.headers.set('Cache-Control', 'no-store');
    return response;
  };
  if (!session) {
    return expire(jsonErrorResponse({
      error: 'No sign-in session', code: 'SESSION_UNKNOWN',
      state: token ? 'the presented credential is not a live sign-in session (it expired, was revoked, or is a token rather than a sign-in)' : 'no credential was presented',
      next: ['Nothing to sign out of; sign in again with POST /login when needed'],
    }, { status: 401 }));
  }
  deps.userAuth.revokeSession(token);
  logger.info('AUTH_SIGNED_OUT', { type: 'AUTH_SIGNED_OUT', username: session.username, sessionId: session.id, source: deps.source });
  return expire(Response.json({ revoked: true }));
}

function isJsonMediaType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

function retryAfter(response: Response, seconds: number): Response {
  response.headers.set('Retry-After', String(seconds));
  return response;
}
