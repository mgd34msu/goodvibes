/**
 * insecure-origin.ts, the entry guard for the plain-http-on-a-genuinely-PUBLIC-origin
 * white screen.
 *
 * The platform transport refuses an insecure PUBLIC baseUrl by THROWING at module
 * evaluation (`ENGINE_TRANSPORT_INSECURE_BASE_URL`). That throw fires the instant
 * `src/lib/goodvibes.ts` is imported, before React mounts, so without this guard an
 * operator who opens the daemon over a plain `http://` public hostname gets a silent
 * blank `#root`. bootstrap.ts checks `isInsecureTransportOrigin()` FIRST and, when true,
 * renders the honest HTTPS message instead of importing the app at all.
 *
 * Plain http on a private network (loopback, a private LAN or link-local address, a
 * `.local` name, a Tailscale `*.ts.net` name) is a supported posture and never trips
 * this wall; its browser-gated capabilities render as labelled degradation from
 * `pairing.posture.get` instead. The public/private boundary is the transport's own
 * `isPrivateNetworkHost`, imported from the transport's paths module (which loads
 * no app code and does not throw on import), so the guard and the transport cannot
 * disagree. A 100.64/10 address is shared with carrier-grade NAT, so a browser (which
 * has no Tailscale probe and no environment) is pointed at the Tailscale name instead.
 */
import { isLoopbackHost, isPrivateNetworkHost, isTailnetHost } from '@goodvibes/engine/transport-http/paths';

export const INSECURE_ORIGIN_TITLE = 'This page needs HTTPS';

export const INSECURE_ORIGIN_BODY =
  'GoodVibes needs a secure (HTTPS) connection over the public internet; open it over '
  + 'HTTPS instead of plain http. The daemon refuses to talk to an insecure public '
  + 'origin, so the app cannot start here. Plain http is supported on your own network '
  + '(localhost, a private network address, a .local name, or a Tailscale name), this '
  + 'page would work there. A 100.64-127.x address is also used by carrier-grade NAT, so '
  + 'open a Tailscale machine by its Tailscale name (<machine>.<tailnet>.ts.net) instead.';

/**
 * The baseUrl the platform transport would be handed, identical source to
 * `GOODVIBES_BASE_URL` in lib/goodvibes.ts, re-derived here so we never import that
 * (throwing) module. `VITE_GOODVIBES_BASE_URL` wins if non-empty; otherwise the page origin.
 */
function effectiveBaseUrl(): string {
  const configured = import.meta.env?.VITE_GOODVIBES_BASE_URL as string | undefined;
  if (configured) return configured;
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

/**
 * Mirror of the transport guard's insecure predicate: an http/ws baseUrl on a genuinely
 * PUBLIC host (never a private-network one), unless GOODVIBES_ALLOW_INSECURE_TRANSPORT=true
 * opts out. Returns true exactly when the platform would throw ENGINE_TRANSPORT_INSECURE_BASE_URL,
 * so the honest message shows in precisely the cases the app would otherwise blank-screen,
 * and never otherwise. A private-network http origin (LAN IP, .local, localhost) is a
 * supported posture and never trips this wall, see the file header.
 */
export function isInsecureTransportOrigin(): boolean {
  // Honor the same explicit override the platform guard honors, so an intentional insecure
  // deployment does not get the message.
  const runtimeProcess = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  // Same switch grammar as transport-http paths.ts and the platform envFlag: 1/true on, anything else off.
  const insecureSwitch = runtimeProcess?.env?.GOODVIBES_ALLOW_INSECURE_TRANSPORT?.trim().toLowerCase();
  if (insecureSwitch === '1' || insecureSwitch === 'true') return false;

  const base = effectiveBaseUrl();
  if (!base) return false;
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  const protocol = url.protocol;
  if (protocol !== 'http:' && protocol !== 'ws:') return false;
  return !isPrivateNetworkHost(url.hostname);
}

/**
 * How this page reaches the daemon, read the way the daemon reads it for card
 * entry (runtime/network/request-transport.ts): https or wss is TLS; plain
 * http to this machine is loopback; plain http to a Tailscale address is the
 * tailnet; plain http to anything else (a LAN address, a .local name) is a
 * plain network, where the daemon refuses a card number, so the form is not
 * offered there either.
 */
export function cardEntryTransport(): 'loopback' | 'tls' | 'tailnet' | 'plain-network' {
  const base = effectiveBaseUrl();
  let url: URL;
  try {
    url = new URL(base || window.location.href);
  } catch {
    return 'plain-network';
  }
  if (url.protocol === 'https:' || url.protocol === 'wss:') return 'tls';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host)) return 'loopback';
  if (isTailnetHost(host)) return 'tailnet';
  return 'plain-network';
}
