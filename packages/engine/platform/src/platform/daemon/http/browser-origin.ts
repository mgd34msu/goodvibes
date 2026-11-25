/**
 * Which browser page may use the owner's sign-in cookie. A browser attaches the
 * cookie to a request whatever page made it, so the page's origin decides, and the
 * only origins that count are the ones the owner has stated the web UI is served at
 * ({@link ownBrowserOrigins}). The request's own Host and forwarded headers never
 * count: behind a proxy they name the proxy's upstream, and anyone can send them.
 * `SameSite=Strict` stops other sites, but not a page on the same host at another
 * port, which is why the origin is checked. The control-plane socket, the event
 * stream, every state-changing REST request, the browser-session endpoints and
 * sign-out read this one rule.
 */
import { networkInterfaces } from 'node:os';
import { readControlPlaneBinding } from '../../config/control-plane-base-url.js';
import { activeTailscaleServeOrigin } from '../../remote-access/tailscale.js';
import { jsonErrorResponse } from './error-response.js';
import { lanHttpsPort } from '../../pairing/web-origin.js';
import { lanServerNames } from '../lan-https/authority.js';
import { servedHttps } from '../lan-https/served-https.js';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Where the control-plane listener is bound, when the daemon knows (else its settings say). */
export type ListenerBindingReader = () => { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' } | undefined;

function originOf(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch { return null; }
}

function hostOrigin(scheme: string, host: string, port: number): string | null {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return originOf(`${scheme}://${bracketed}:${port}`);
}

const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '::1'];
const WILDCARD = new Set(['0.0.0.0', '::', '[::]', '*', '']);

/**
 * Every origin the owner has stated the web UI is served at, and nothing else:
 * - the origin the control-plane listener is bound to (a loopback bind answers as
 *   127.0.0.1, localhost and [::1]; a bind to every interface answers at each of this
 *   machine's addresses);
 * - `web.publicBaseUrl` (and `controlPlane.publicBaseUrl`), the address a tunnel or
 *   proxy such as `tailscale serve` reaches it at;
 * - the tailnet address `tailscale.serve.run` set up, while that serve is on record;
 * - each origin in `controlPlane.cors.allowedOrigins`.
 * Cost: a few string parses; a bind to every interface also lists the interfaces.
 */
export function ownBrowserOrigins(config: { get(key: string): unknown }, listener?: ListenerBindingReader): readonly string[] {
  const origins = new Set<string>();
  const add = (origin: string | null) => { if (origin) origins.add(origin); };
  const bound = listener?.();
  const binding = readControlPlaneBinding((key) => config.get(key));
  const scheme = bound?.scheme ?? (binding.tlsMode !== 'off' ? 'https' : 'http');
  const port = bound?.port ?? binding.port;
  const host = (bound?.host ?? (binding.hostMode === 'local' ? '127.0.0.1' : binding.host)).trim().replace(/^\[|\]$/g, '');
  if (WILDCARD.has(host)) {
    for (const name of LOOPBACK_NAMES) add(hostOrigin(scheme, name, port));
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) add(hostOrigin(scheme, entry.address.split('%')[0]!, port));
    }
  } else if (LOOPBACK_NAMES.includes(host) || host.startsWith('127.')) {
    for (const name of LOOPBACK_NAMES) add(hostOrigin(scheme, name, port));
    add(hostOrigin(scheme, host, port));
  } else {
    add(hostOrigin(scheme, host, port));
  }
  // The https listener beside a network bind (the Secure address): the names and addresses its certificate carries,
  // as served now (a wildcard stands for this machine's own name under it); from the settings in a process that serves none.
  const serving = servedHttps();
  const lanPort = serving?.port ?? lanHttpsPort(config);
  if (lanPort !== undefined && !(LOOPBACK_NAMES.includes(host) || host.startsWith('127.'))) {
    const names = lanServerNames();
    const served = serving ? serving.names.filter((name) => !name.startsWith('*.')) : [...names.dnsNames, ...names.addresses];
    if (serving?.hostName) served.push(serving.hostName);
    for (const name of served) add(hostOrigin('https', name, lanPort));
  }
  add(originOf(config.get('web.publicBaseUrl')));
  add(originOf(binding.publicBaseUrl));
  add(activeTailscaleServeOrigin());
  for (const origin of String(config.get('controlPlane.cors.allowedOrigins') ?? '').split(',')) add(originOf(origin));
  return [...origins];
}

/** True when `origin` (the request's Origin header) is one of the daemon's own browser origins. */
export function browserOriginAllowed(origin: string, own: readonly string[]): boolean {
  return origin !== 'null' && own.includes(origin);
}

/** The refusal for a page whose origin may not use the owner's credential. */
export function originNotAllowedResponse(origin: string | null, action: string): Response {
  return jsonErrorResponse({
    error: `This browser origin is not allowed to ${action}`,
    code: 'ORIGIN_NOT_ALLOWED',
    state: `the origin ${origin ?? '(none)'} is not an address the web UI is served at`,
    next: [origin && origin !== 'null'
      ? `If this daemon is reached at ${origin} (a tunnel or proxy such as tailscale serve), set web.publicBaseUrl to ${origin}`
      : 'Open the web UI at the daemon address, or set web.publicBaseUrl to the address it is reached at'],
  }, { status: 403 });
}

/**
 * A request that authenticated with the sign-in cookie (no bearer credential,
 * which a browser never adds by itself) is served only for a page whose origin
 * may use it. A state-changing one must name its origin: a request without an
 * Origin header is not taken on the cookie, as the socket does not take one.
 * A read (an event stream included) is refused when it names another origin;
 * a browser sends none on a same-origin read. Null: let it through.
 */
export function refuseCookieWriteFromOtherOrigin(req: Request, allowed: () => readonly string[]): Response | null {
  if (/^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '')) return null;
  const origin = req.headers.get('origin');
  if (READ_METHODS.has(req.method.toUpperCase())) {
    if (origin === null || browserOriginAllowed(origin, allowed())) return null;
    return originNotAllowedResponse(origin, 'read with the sign-in cookie');
  }
  if (origin !== null && browserOriginAllowed(origin, allowed())) return null;
  return originNotAllowedResponse(origin, 'change anything with the sign-in cookie');
}
