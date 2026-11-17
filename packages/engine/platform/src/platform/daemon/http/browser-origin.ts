/**
 * Which browser page may use the owner's sign-in cookie. A browser attaches the
 * cookie to a request whatever page made it, so the page's origin decides: the
 * daemon's own origin, or one the owner listed in
 * `controlPlane.cors.allowedOrigins`. `SameSite=Lax` stops other sites, but not
 * a page on the same host at another port, which is why the origin is checked.
 * The control-plane socket and every state-changing REST request read this one rule.
 */
import { jsonErrorResponse } from './error-response.js';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The browser origins the owner allowed besides the daemon's own. */
export function configuredBrowserOrigins(config: { get(key: string): unknown }): readonly string[] {
  return String(config.get('controlPlane.cors.allowedOrigins') ?? '').split(',').map((origin) => origin.trim()).filter(Boolean);
}

/** True when `origin` (the request's Origin header) is the daemon's own or one the owner allowed. */
export function browserOriginAllowed(req: Request, origin: string, allowed: readonly string[]): boolean {
  return origin === new URL(req.url).origin || (origin !== 'null' && allowed.includes(origin));
}

/** The refusal for a page whose origin may not use the owner's credential. */
export function originNotAllowedResponse(origin: string | null, action: string): Response {
  return jsonErrorResponse({
    error: `This browser origin is not allowed to ${action}`,
    code: 'ORIGIN_NOT_ALLOWED',
    state: `the origin ${origin ?? '(none)'} is not on the allowed list`,
    next: ['Open the web UI from the daemon address, or add this origin to controlPlane.cors.allowedOrigins'],
  }, { status: 403 });
}

/**
 * A state-changing request that authenticated with the sign-in cookie (no
 * bearer credential, which a browser never adds by itself) is served only for
 * a page whose origin may use it; a request without an Origin header is not
 * taken on the cookie, as the socket does not take one. Null: let it through.
 */
export function refuseCookieWriteFromOtherOrigin(req: Request, allowed: () => readonly string[]): Response | null {
  if (READ_METHODS.has(req.method.toUpperCase())) return null;
  if (/^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '')) return null;
  const origin = req.headers.get('origin');
  if (origin !== null && browserOriginAllowed(req, origin, allowed())) return null;
  return originNotAllowedResponse(origin, 'change anything with the sign-in cookie');
}
