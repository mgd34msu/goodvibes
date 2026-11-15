/**
 * The principal on the request.
 *
 * A daemon request is authenticated once, where it enters (the router's auth
 * gate or the WebSocket upgrade), into a RequestContext bound to that Request
 * object. Every later check on the same request reads the bound context: while
 * the daemon's authentication revision is the one the context was read under,
 * and a login session has not reached its end, the answer is one integer
 * compare and no credential store is read. When the revision moved, the request
 * is authenticated once more and the new context replaces the old one.
 *
 * A long-lived connection (a WebSocket, an event stream) keeps the revision it
 * authenticated under and makes the same compare before each event.
 */
import type { RequestContext, RequestPrincipal } from './http-policy.js';

const bound = new WeakMap<Request, RequestContext>();

/** The context the request was authenticated into, if it was. */
export function requestContextOf(req: Request): RequestContext | undefined {
  return bound.get(req);
}

/** Attach a context to a request; a request derived from another one carries its context on. */
export function bindRequestContext(req: Request, context: RequestContext): void {
  bound.set(req, context);
}

/**
 * A context whose signal aborts when the request ends or when the principal's
 * credential is revoked. The two are joined only when a handler reads
 * `signal`, so a request that never reads it allocates nothing for it.
 */
export function createRequestContext(
  principal: RequestPrincipal,
  requestSignal: AbortSignal,
  revocation: (() => AbortSignal | undefined) | undefined,
): RequestContext {
  let signal: AbortSignal | undefined;
  return Object.freeze({
    principal,
    get signal(): AbortSignal {
      if (signal) return signal;
      const revoked = revocation?.();
      signal = revoked ? AbortSignal.any([requestSignal, revoked]) : requestSignal;
      return signal;
    },
  });
}

/** Still the principal it was: the authentication revision has not moved and the session has not ended. */
export function isPrincipalCurrent(
  principal: Pick<RequestPrincipal, 'authRevision' | 'expiresAt'>,
  revision: number,
  now: number = Date.now(),
): boolean {
  return principal.authRevision === revision && (principal.expiresAt === undefined || now < principal.expiresAt);
}
