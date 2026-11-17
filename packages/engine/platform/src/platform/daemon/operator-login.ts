/**
 * `POST /login`, the one sign-in handler. The control-plane listener and the
 * webhook listener both answer the route through it, so the protection is the
 * same on every port: a per-address limit before any password work, the
 * memory-hard password check off the event loop behind a bounded queue
 * (`UserAuthManager.authenticateSignIn`), and a lock that counts per username
 * and client address.
 */

import type { AddressRateLimiter } from '@goodvibes-jev/engine/daemon-api';
import { logger } from '../utils/logger.js';
import { authFailureTotal, authSuccessTotal } from '../runtime/metrics.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitAuthFailed, emitAuthSucceeded } from '../runtime/emitters/security.js';
import { buildOperatorSessionCookie } from '../security/http-auth.js';
import type { UserAuthManager } from '../security/user-auth.js';
import { parseDaemonJsonBody } from './http/router-request-body.js';
import { jsonErrorResponse } from './http/error-response.js';

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

  if (!deps.limiter.allow(clientAddress)) {
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
  const authResult = await deps.userAuth.authenticateSignIn(username, password, clientAddress);

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
        error: 'Too many requests', code: 'SIGN_IN_LOCKED', state: 'repeated failed sign-ins from this address locked this account here',
        next: [`Wait ${retryAfterSeconds} seconds, then sign in again`],
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
    return Response.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const { user } = authResult;
  const session = deps.userAuth.createSession(user.username);
  authSuccessTotal.add(1);
  logger.info('AUTH_SUCCEEDED', { type: 'AUTH_SUCCEEDED', requestId, username: user.username, clientIp: clientAddress, method: 'password', source: deps.source });
  if (deps.runtimeBus) {
    emitAuthSucceeded(deps.runtimeBus, { sessionId: 'system', traceId: `auth:${requestId}`, source: deps.source },
      { username: user.username, sessionId: session.id, clientIp: clientAddress, method: 'password' });
  }

  // The bootstrap credential is retired only after the first sign-in with a
  // real password: retiring it on a bootstrap sign-in would lock the owner out
  // if that session is lost before an account password is set.
  if (!authResult.usedBootstrapCredential && deps.userAuth.inspect().bootstrapCredentialPresent) {
    if (deps.userAuth.clearBootstrapCredentialFile()) {
      logger.info('Bootstrap credential file retired after first non-bootstrap login', { username: user.username });
    }
  }

  return Response.json({
    authenticated: true,
    token: session.token,
    username: session.username,
    expiresAt: session.expiresAt,
  }, {
    headers: {
      'Set-Cookie': buildOperatorSessionCookie(session.token, { req, expiresAt: session.expiresAt, trustProxy: deps.trustProxy }),
    },
  });
}

function isJsonMediaType(contentType: string | null): boolean {
  return contentType?.split(';', 1)[0]!.trim().toLowerCase() === 'application/json';
}

function retryAfter(response: Response, seconds: number): Response {
  response.headers.set('Retry-After', String(seconds));
  return response;
}
