/**
 * web-origin.ts, the web-app origin a pairing deep link points at, and the
 * one-time write of `web.publicBaseUrl` from the stable-name resolution.
 *
 * An explicit public URL is authoritative. The bundled WebUI shares the
 * control-plane listener: its fallback must use that binding, not the declared
 * web port, which has no separate bundle listener. Other web surfaces retain
 * their declared endpoint fallback. Every mode treats the exact shipped public
 * URL placeholder like an empty value: nothing listens on it, so a link built
 * from it would point a phone at its own loopback.
 */
import type { ConfigManager } from '../config/manager.js';
import { resolveHostBinding, resolveWebPort } from '../daemon/host-resolver.js';
import { isLoopbackHost } from './origin-posture.js';
import { isWildcardBindHost, stableUrlHostForBindHost, type ResolvedStableHost, type StableHostInputs } from './stable-host.js';

export interface PairingWebOrigin {
  readonly origin: string;
  readonly resolvedHost: ResolvedStableHost;
  /** True when the origin is http:// on a non-loopback host, the honest LAN-posture case. */
  readonly httpOnLan: boolean;
  /** True when the origin came verbatim from a user-set web.publicBaseUrl. */
  readonly fromPublicBaseUrl: boolean;
  /**
   * The same origin on the routable address, present when `origin` uses a
   * name (Tailscale or `.local`): the fallback for a device that cannot
   * resolve or reach that name.
   */
  readonly alternateOrigin?: string | undefined;
}

/** The shipped `web.publicBaseUrl` default; a placeholder, never a user's choice of origin. */
const SHIPPED_PUBLIC_BASE_URL = 'http://127.0.0.1:3423';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Format a bind host and port as HTTP authority, retaining IPv6 brackets. */
export function formatHttpOrigin(host: string, port: number): string {
  const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${authorityHost}:${port}`;
}

/** http:// on anything other than loopback is served in the clear on the LAN. */
export function isHttpOnLan(origin: string): boolean {
  if (!origin.startsWith('http://')) return false;
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  // `URL.hostname` keeps the brackets on an IPv6 host (`[::1]`), so the old
  // `!== '::1'` never matched; the shared rule strips them.
  return !isLoopbackHost(host);
}

/**
 * The bind host the web endpoint is configured for, from `web.hostMode` and
 * `web.host`. A wildcard bind ('network') is what sends the caller through the
 * stable-name ladder; every other mode names its own host, and an unrecognized
 * mode falls back to loopback rather than guessing something routable.
 */
function webBindHost(config: Pick<ConfigManager, 'get'>): string {
  const hostMode = String(config.get('web.hostMode') ?? 'local');
  const configuredHost = String(config.get('web.host') ?? '127.0.0.1');
  if (hostMode === 'network') return '0.0.0.0';
  if (hostMode === 'custom') return configuredHost || '127.0.0.1';
  return '127.0.0.1';
}

type BoundListener = { readonly host: string; readonly port: number; readonly scheme?: 'http' | 'https' };

/** A user-set public URL, or '' when the setting is empty or the shipped placeholder. */
function explicitPublicBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  const publicBaseUrl = trimTrailingSlash(String(configManager.get('web.publicBaseUrl') ?? '').trim());
  return publicBaseUrl === SHIPPED_PUBLIC_BASE_URL ? '' : publicBaseUrl;
}

/** The listener the pairing origin points at: the control plane when it serves the bundle, else the web endpoint. */
function pairingBinding(configManager: Pick<ConfigManager, 'get'>, boundControlPlane?: BoundListener): BoundListener {
  if (configManager.get('controlPlane.webui.serve') !== true) {
    return { host: webBindHost(configManager), port: resolveWebPort(configManager.get('web.port')) };
  }
  return boundControlPlane ?? resolveHostBinding(
    String(configManager.get('controlPlane.hostMode') ?? 'local'),
    String(configManager.get('controlPlane.host') ?? '127.0.0.1'),
    Number(configManager.get('controlPlane.port')), 'controlPlane',
  );
}

/**
 * True when the pairing origin is resolved through the stable-host ladder (no
 * explicit public URL, wildcard bind), so a long-lived surface knows to warm
 * the host probes before it shows a link.
 */
export function pairingOriginUsesStableHost(configManager: Pick<ConfigManager, 'get'>): boolean {
  return !explicitPublicBaseUrl(configManager) && isWildcardBindHost(pairingBinding(configManager).host);
}

export function resolvePairingWebOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
  /** Settled listener observation, only used for bundled serving fallback. */
  boundControlPlane?: BoundListener,
): PairingWebOrigin {
  const publicBaseUrl = explicitPublicBaseUrl(configManager);
  if (publicBaseUrl) {
    return {
      origin: publicBaseUrl,
      resolvedHost: { host: hostnameOf(publicBaseUrl), kind: 'public-url', stable: true },
      httpOnLan: isHttpOnLan(publicBaseUrl),
      fromPublicBaseUrl: true,
    };
  }
  const bundled = configManager.get('controlPlane.webui.serve') === true;
  const binding = pairingBinding(configManager, boundControlPlane);
  const resolvedHost = stableUrlHostForBindHost(binding.host, probe);
  // Only direct mode passes TLS material to the bound listener. Proxy mode's
  // external HTTPS endpoint must be supplied as an explicit public URL.
  const scheme = boundControlPlane?.scheme ?? (configManager.get('controlPlane.tls.mode') === 'direct' ? 'https' : 'http');
  const originFor = (host: string): string => {
    const httpOrigin = formatHttpOrigin(host, binding.port);
    return bundled && scheme === 'https' ? httpOrigin.replace('http://', 'https://') : httpOrigin;
  };
  const origin = originFor(resolvedHost.host);
  return {
    origin,
    resolvedHost,
    httpOnLan: isHttpOnLan(origin),
    fromPublicBaseUrl: false,
    ...(resolvedHost.alternateHost ? { alternateOrigin: originFor(resolvedHost.alternateHost) } : {}),
  };
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}

/**
 * Persist web.publicBaseUrl once, from the stable-name resolution, and only when
 * it is empty AND the resolution produced a stable name (a DHCP-bound address is
 * not worth freezing into config). Returns the resolved origin either way. Never
 * overwrites a stored value, the shipped placeholder included: other surfaces
 * (notifications, channels) read that setting as a public URL, and pairing does
 * not decide that a LAN name should become one.
 */
export function ensurePublicBaseUrl(
  configManager: Pick<ConfigManager, 'get' | 'setDynamic'>,
  probe?: () => StableHostInputs,
  boundControlPlane?: BoundListener,
): PairingWebOrigin {
  const resolved = resolvePairingWebOrigin(configManager, probe, boundControlPlane);
  if (!String(configManager.get('web.publicBaseUrl') ?? '').trim() && !resolved.fromPublicBaseUrl && resolved.resolvedHost.stable) {
    configManager.setDynamic('web.publicBaseUrl', resolved.origin);
    return { ...resolved, fromPublicBaseUrl: true };
  }
  return resolved;
}
