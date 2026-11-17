/**
 * Auto-refresh transport middleware.
 *
 * Integrates `AutoRefreshCoordinator` at the transport boundary so that ALL
 * typed operator/peer platform calls benefit from automatic token refresh, not only
 * `auth.current()`.
 *
 * Responsibilities:
 *   1. Pre-flight: the transport builds the Authorization header from
 *      `coordinator.currentToken()`, which reads the token store once and
 *      refreshes a token inside the leeway window first, so the header is
 *      already current when this middleware runs. When that refresh was
 *      rejected for good and the store cleared, an Authorization header from
 *      the transport's default headers is dropped rather than sent; one the
 *      caller set on the request itself is sent as given.
 *   2. Reactive 401: if `next()` throws a 401-shaped error, trigger a refresh
 *      via `coordinator.refreshAndRetryOnce()` and set `ctx.parsedBody` to the
 *      retry result so the transport can return it to the caller.
 *   3. Loop prevention: retry requests carry `__gv_ar_attempted: true` in their
 *      options. The middleware recognises this flag and passes through without
 *      additional refresh logic, preventing infinite recursion.
 *   4. Error passthrough: terminal auth errors from the coordinator are placed
 *      directly onto `ctx.error` rather than thrown, so the transport's
 *      middleware-error-wrapping instrumentation does not re-wrap them as
 *      `kind:'unknown'`.
 */

import type { TransportContext, TransportMiddleware } from '@goodvibes-jev/engine/transport-core';
import type { HttpJsonTransport } from '@goodvibes-jev/engine/transport-http/http-core';
import type { GoodVibesTokenStore } from './types.js';
import type { AutoRefreshCoordinator } from './auto-refresh.js';
import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { is401Error } from './auto-refresh.js';

/** Request-local flag key that never conflicts with public HttpJsonRequestOptions fields. */
const ATTEMPTED_FLAG = '__gv_ar_attempted';

/**
 * Create a transport middleware that integrates the `AutoRefreshCoordinator`
 * into every HTTP request.
 *
 * @param coordinator - The auto-refresh coordinator managing token lifecycle.
 * @param transport   - The HTTP JSON transport used to re-issue the request on
 *                      reactive 401 retry. Must be the same transport instance
 *                      whose middleware chain contains this middleware, so that
 *                      the retry benefits from other middleware (e.g. logging,
 *                      tracing) except for another auto-refresh cycle.
 * @param _tokenStore - Unused: the transport reads the token through
 *                      `coordinator.currentToken()`. Kept so existing callers
 *                      compile.
 *
 * The transport the middleware is installed on must resolve its auth token
 * with `coordinator.currentToken()` (as `createGoodVibesPlatform` does); the
 * middleware itself never reads the token store.
 *
 * @example
 * const mw = createAutoRefreshMiddleware(coordinator, transport, tokenStore);
 * transport.use(mw);
 */
export function createAutoRefreshMiddleware(
  coordinator: AutoRefreshCoordinator,
  transport: Pick<HttpJsonTransport, 'requestJson'>,
  _tokenStore?: GoodVibesTokenStore,
): TransportMiddleware {
  return async function autoRefreshMiddleware(
    ctx: TransportContext,
    next: () => Promise<void>,
  ): Promise<void> {
    // ── Loop-prevention guard ────────────────────────────────────────────────
    // Retry requests issued by this middleware carry the flag. When we see it,
    // simply forward the request without any refresh logic.
    // We catch and re-place errors onto ctx.error so they are NOT tagged as
    // "middleware errors" by the transport's instrumented-chain wrapper, which
    // would re-wrap them as GoodVibesError{kind:'unknown'} and hide the
    // original 401 status that refreshAndRetryOnce needs to detect.
    if (ctx.options[ATTEMPTED_FLAG] === true) {
      try {
        await next();
      } catch (passthroughErr) {
        ctx.error = passthroughErr;
      }
      return;
    }

    // ── Pre-flight ───────────────────────────────────────────────────────────
    // The header already carries the token `coordinator.currentToken()` read
    // (refreshed first when it was inside the leeway window). When that read
    // found the store empty because a refresh was rejected for good, an
    // Authorization header left over from the transport's default headers
    // would only be refused, so drop it. One the caller set on THIS request
    // (`options.headers`, a bootstrap or pairing token) is the caller's own
    // credential: it is sent as given, and its 401 is reported as is. (A store
    // that simply has no token is left alone.)
    const usedToken = bearerTokenOf(ctx.headers);
    const callerAuthorization = setsAuthorization(ctx.options['headers']);
    const sessionCleared = coordinator.sessionCleared && !callerAuthorization;
    if (sessionCleared) {
      for (const key of Object.keys(ctx.headers)) {
        if (key.toLowerCase() === 'authorization') delete ctx.headers[key];
      }
    }

    // ── Dispatch request ─────────────────────────────────────────────────────
    // We catch ALL errors from next() rather than re-throwing them directly.
    // Re-throwing from within a middleware causes the transport's instrumented-
    // chain wrapper to tag the error as "from this middleware" and re-wrap it
    // as GoodVibesError{kind:'unknown'}, even when the error originated
    // from the real fetch (innerFetch). By placing non-401 errors onto
    // ctx.error instead, they bypass the middleware-wrapping path and propagate
    // with their original type and kind intact.
    let caughtErr: unknown;
    let nextSucceeded = false;
    try {
      await next();
      nextSucceeded = true;
    } catch (err) {
      caughtErr = err;
    }

    if (nextSucceeded) {
      return; // success, nothing more to do
    }

    if (!is401Error(caughtErr)) {
      // Non-401 error (e.g. 5xx, network), place on ctx.error so it exits
      // the middleware chain without triggering middleware-error wrapping.
      ctx.error = caughtErr;
      return;
    }

    if (callerAuthorization && coordinator.sessionCleared) {
      // The caller's own credential was refused; no stored token can stand in.
      ctx.error = caughtErr;
      return;
    }

    if (sessionCleared) {
      // The request went out without a token because the session was rejected
      // at refresh time, so a second refresh cannot help. Say what happened.
      ctx.error = new GoodVibesError(
        'Authentication failed · The session was rejected when its token was refreshed and the stored token was cleared · Re-login to obtain a fresh token.',
        { category: 'authentication', source: 'transport', status: 401, recoverable: false },
      );
      return;
    }

    // ── Reactive 401 retry ─────────────────────────────────────────────────
    // Release the original 401 error before we await the refresh + retry. The
    // transport's end-of-chain catch (composeMiddleware) sets `ctx.error` to
    // the SAME error object innerFetch threw before rethrowing it to us, and
    // ctx stays strongly reachable for the whole call, so clearing only the
    // local `caughtErr` would be a no-op (verified by WeakRef probe): the
    // error, which can transitively retain the failed request and its
    // operator-token Authorization header, would stay pinned via ctx.error for
    // the entire refresh+retry await window. Under a 401 storm that is one
    // pinned error-plus-request context per in-flight call. We have already
    // extracted everything we need (the 401 classification), so release BOTH
    // references now. Post-retry semantics are preserved: every exit path from
    // this block explicitly sets ctx.error (terminal errors) or leaves it
    // cleared (successful retry), so no later reader observes a stale 401.
    caughtErr = undefined;
    ctx.error = undefined;
    // Build retry options that preserve the original request attributes and
    // carry the loop-prevention flag so the next pass through this middleware
    // just calls next() without re-entering the refresh logic.
    // The caller's own options (headers, methodId, idempotent, retry, ...) are
    // carried over so the retried request behaves like the original; only the
    // fields the middleware chain may have changed are taken from ctx. The
    // original Idempotency-Key is reused so the daemon can recognise the retry.
    const idempotencyHeader = Object.entries(ctx.headers).find(([k]) => k.toLowerCase() === 'idempotency-key');
    const callerHeaders = (ctx.options['headers'] ?? {}) as Record<string, string>;
    const retryOptions: Record<string, unknown> = {
      ...ctx.options,
      ...(idempotencyHeader ? { headers: { ...callerHeaders, [idempotencyHeader[0]]: idempotencyHeader[1] } } : {}),
      method: ctx.method,
      body: ctx.body,
      signal: ctx.signal,
      [ATTEMPTED_FLAG]: true,
    };

    // Delegate to coordinator.refreshAndRetryOnce, this refreshes the token
    // exactly once and executes the retry fn once. If the retry also returns
    // 401, it throws GoodVibesError{kind:'auth'} with the standard three-part message.
    //
    // IMPORTANT: we place terminal errors onto ctx.error instead of re-throwing
    // them. This bypasses the transport's middleware-error-wrapping path
    // (which would re-label them as kind:'unknown') and lets the transport's
    // outer `if (ctx.error) throw ctx.error` propagate them cleanly.
    let retryResult: unknown;
    try {
      retryResult = await coordinator.refreshAndRetryOnce(async () => {
        // transport.requestJson goes through the full middleware chain; the
        // ATTEMPTED_FLAG ensures this middleware is a passthrough on that call.
        return transport.requestJson<unknown>(ctx.url, retryOptions as never);
      }, sessionCleared ? null : usedToken);
    } catch (retryErr) {
      // Place onto ctx.error, transport's post-chain check will rethrow it
      // without the middleware-wrapping treatment.
      ctx.error = retryErr;
      return;
    }

    // The retry result is the call's result: the transport returns
    // `ctx.parsedBody`, so nothing is serialised and parsed again. An empty
    // result stays the transport's empty result (null). Clear ctx.error, which
    // innerFetch set to the original 401 before rethrowing it.
    ctx.error = undefined;
    ctx.parsedBody = retryResult === undefined ? null : retryResult;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// is401Error is shared, import from auto-refresh.ts to avoid divergence.

/** The bearer token a request's headers carry, or null. */
/** Whether per-request headers (a record, a `Headers`, or name/value pairs) set Authorization. */
function setsAuthorization(headers: unknown): boolean {
  if (headers === undefined || headers === null) return false;
  if (typeof Headers !== 'undefined' && headers instanceof Headers) return headers.has('authorization');
  if (Array.isArray(headers)) {
    return headers.some((entry) => Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].toLowerCase() === 'authorization');
  }
  if (typeof headers !== 'object') return false;
  return Object.entries(headers).some(([key, value]) => key.toLowerCase() === 'authorization' && typeof value === 'string' && value.length > 0);
}

function bearerTokenOf(headers: Readonly<Record<string, string>>): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== 'authorization') continue;
    const match = /^Bearer\s+(.+)$/i.exec(value);
    return match ? match[1]!.trim() : null;
  }
  return null;
}
