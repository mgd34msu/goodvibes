/**
 * web-origin.ts, the web-app origin a pairing deep link points at.
 *
 * `web.publicBaseUrl` holds only what a person set, and nothing here writes
 * it: an empty value means the origin is derived live from the settings.
 * An explicit public URL is authoritative. The bundled WebUI shares the
 * control-plane listener: its fallback must use that binding, not the declared
 * web port, which has no separate bundle listener. `web.host`/`web.port` are
 * the development server's listener only and never an origin here: with the
 * bundle not served and no public URL, there is no web UI and no origin.
 * Every mode treats the exact shipped public
 * URL placeholder like an empty value: nothing listens on it, so a link built
 * from it would point a phone at its own loopback.
 */
import type { ConfigManager } from '../config/manager.js';
import { resolveHostBinding, resolveWebPort } from '../daemon/host-resolver.js';
import { describePairingReach, isLoopbackHost, type PairingReach } from './origin-posture.js';
import { isWildcardBindHost, probeStableHostInputs, stableUrlHostForBindHost, type ResolvedStableHost, type StableHostInputs } from './stable-host.js';

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

/** The `web.publicBaseUrl` placeholder older releases stored; never a user's choice of origin. */
const SHIPPED_PUBLIC_BASE_URL = 'http://127.0.0.1:3423';

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** Format a bind host and port as HTTP authority, retaining IPv6 brackets. */
export function formatHttpOrigin(host: string, port: number): string {
  return formatOrigin('http', host, port);
}

function formatOrigin(scheme: 'http' | 'https', host: string, port: number): string {
  const authorityHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${authorityHost}:${port}`;
}

/**
 * The scheme the control-plane listener speaks. Only direct mode hands TLS
 * material to the listener; proxy mode's external HTTPS endpoint is supplied
 * as an explicit public URL.
 */
export function controlPlaneScheme(config: Pick<ConfigManager, 'get'>): 'http' | 'https' {
  return config.get('controlPlane.tls.mode') === 'direct' ? 'https' : 'http';
}

function declaredControlPlaneBinding(config: Pick<ConfigManager, 'get'>) {
  return resolveHostBinding(
    String(config.get('controlPlane.hostMode') ?? 'local'),
    String(config.get('controlPlane.host') ?? '127.0.0.1'),
    Number(config.get('controlPlane.port')), 'controlPlane',
  );
}

export interface ControlPlaneOrigin {
  /** The origin a browser opens to reach the control plane, and the bundle it serves. */
  readonly origin: string;
  /** The same origin on the routable address, when `origin` uses a name. */
  readonly alternateOrigin?: string | undefined;
  readonly resolvedHost: ResolvedStableHost;
  /** False when `controlPlane.hostMode` is not a mode the daemon can bind. */
  readonly recognized: boolean;
}

/**
 * The origin the control plane answers on: its bind host through the
 * stable-name ladder, its port, and the scheme its listener really speaks.
 * `bound` is a settled listener observation; without one the binding is
 * resolved from settings the way the daemon binds.
 */
export function resolveControlPlaneOrigin(
  config: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
  bound?: BoundListener,
): ControlPlaneOrigin {
  const declared = bound === undefined ? declaredControlPlaneBinding(config) : undefined;
  const binding = bound ?? declared!;
  const recognized = declared?.recognized ?? true;
  const scheme = bound?.scheme ?? controlPlaneScheme(config);
  const resolvedHost = stableUrlHostForBindHost(binding.host, probe);
  return {
    origin: formatOrigin(scheme, resolvedHost.host, binding.port),
    ...(resolvedHost.alternateHost ? { alternateOrigin: formatOrigin(scheme, resolvedHost.alternateHost, binding.port) } : {}),
    resolvedHost,
    recognized,
  };
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

/**
 * The port of the daemon's LAN https listener (`controlPlane.lanHttps.*`,
 * daemon/lan-https), when it is switched on; undefined when it is off.
 */
export function lanHttpsPort(configManager: { get(key: string): unknown }): number | undefined {
  if (configManager.get('controlPlane.lanHttps.enabled') !== true) return undefined;
  const port = Number(configManager.get('controlPlane.lanHttps.port'));
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

/**
 * The LAN https origin beside a plain `http://<lan address>:<port>` origin:
 * the same host on the LAN https port. Undefined for a loopback host (this
 * machine is already a secure context) or an origin that is not plain http.
 */
export function lanHttpsOriginOf(origin: string, port: number): string | undefined {
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  if (url.protocol !== 'http:') return undefined;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host.startsWith('127.')) return undefined;
  return `https://${url.hostname}:${port}`;
}

/**
 * A user-set public URL, or '' when the setting is empty or the placeholder
 * older releases shipped. The one reading of the setting every caller uses.
 */
export function explicitPublicBaseUrl(configManager: Pick<ConfigManager, 'get'>): string {
  const publicBaseUrl = trimTrailingSlash(String(configManager.get('web.publicBaseUrl') ?? '').trim());
  return publicBaseUrl === SHIPPED_PUBLIC_BASE_URL ? '' : publicBaseUrl;
}

/**
 * Whether another device can open the pairing address `origin`, from the
 * daemon's settings: the one decision every pairing surface uses. The daemon
 * answers it in `pairing.posture.get` and enforces it in
 * `pairing.handoff.create`; `goodvibes-daemon pair`, its start-up block and
 * the terminal app's in-process pairing screen read the same settings.
 */
export function pairingReachFromSettings(
  configManager: Pick<ConfigManager, 'get'>,
  origin: string,
): PairingReach {
  return describePairingReach(origin, {
    servesOtherMachines: configManager.get('controlPlane.enabled') === true,
    publicBaseUrl: explicitPublicBaseUrl(configManager),
  });
}

/** The web endpoint's bind host and port, for a web surface the control plane does not serve. */
function webBinding(configManager: Pick<ConfigManager, 'get'>): BoundListener {
  return { host: webBindHost(configManager), port: resolveWebPort(configManager.get('web.port')) };
}

/**
 * True when the control-plane origin (the listener serving the bundled web UI)
 * is resolved through the stable-host ladder, so a one-shot command that prints
 * it knows to await `refreshStableHostInputs` first.
 */
export function controlPlaneOriginUsesStableHost(configManager: Pick<ConfigManager, 'get'>): boolean {
  return isWildcardBindHost(declaredControlPlaneBinding(configManager).host);
}

/**
 * True when the pairing origin is resolved through the stable-host ladder (no
 * explicit public URL, wildcard bind), so a long-lived surface knows to warm
 * the host probes before it shows a link.
 */
export function pairingOriginUsesStableHost(configManager: Pick<ConfigManager, 'get'>): boolean {
  if (explicitPublicBaseUrl(configManager) || configManager.get('controlPlane.webui.serve') !== true) return false;
  return isWildcardBindHost(declaredControlPlaneBinding(configManager).host);
}

/**
 * The listener on this machine that serves the web UI, the one owner of that
 * address: the control-plane listener while the daemon serves the bundle
 * (`controlPlane.webui.serve`; `bound` is the listener as bound, when known).
 * Null otherwise. `web.host`/`web.port` are never this address: they are
 * where the web UI's development server listens (it reads them through
 * `goodvibes-daemon webui status --json`), and nothing else binds them.
 */
export function resolveWebUiListener(
  configManager: Pick<ConfigManager, 'get'>,
  boundControlPlane?: BoundListener,
): { readonly host: string; readonly port: number; readonly scheme: 'http' | 'https' } | null {
  if (configManager.get('controlPlane.webui.serve') !== true) return null;
  const binding = boundControlPlane ?? declaredControlPlaneBinding(configManager);
  return { host: binding.host, port: binding.port, scheme: boundControlPlane?.scheme ?? controlPlaneScheme(configManager) };
}

/**
 * The origin to open the web UI at: its listener ({@link resolveWebUiListener})
 * through the stable-name ladder, or, for a web UI this daemon does not serve,
 * a user-set `web.publicBaseUrl` naming where it runs. Null when no web UI is
 * served anywhere the settings name.
 */
export function resolveWebUiOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
  boundControlPlane?: BoundListener,
): PairingWebOrigin | null {
  if (configManager.get('controlPlane.webui.serve') === true) return derivedPairingWebOrigin(configManager, probe, boundControlPlane);
  const publicBaseUrl = explicitPublicBaseUrl(configManager);
  return publicBaseUrl ? publicOrigin(publicBaseUrl) : null;
}

/**
 * The web-app origin a link read on another device opens (a pairing deep
 * link, a notification): a user-set `web.publicBaseUrl` (a tunnel, a proxy, a
 * Tailscale serve), otherwise where the web UI is served
 * ({@link resolveWebUiOrigin}). Null when there is no web UI to open.
 */
export function resolvePairingWebOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
  /** Settled listener observation, only used for bundled serving fallback. */
  boundControlPlane?: BoundListener,
): PairingWebOrigin | null {
  const publicBaseUrl = explicitPublicBaseUrl(configManager);
  if (publicBaseUrl) return publicOrigin(publicBaseUrl);
  return resolveWebUiOrigin(configManager, probe, boundControlPlane);
}

function publicOrigin(publicBaseUrl: string): PairingWebOrigin {
  return {
    origin: publicBaseUrl,
    resolvedHost: { host: hostnameOf(publicBaseUrl), kind: 'public-url', stable: true },
    httpOnLan: isHttpOnLan(publicBaseUrl),
    fromPublicBaseUrl: true,
  };
}

/** The web origin this daemon derives for itself, whatever `web.publicBaseUrl` holds. */
function derivedPairingWebOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  probe?: () => StableHostInputs,
  boundControlPlane?: BoundListener,
): PairingWebOrigin {
  if (configManager.get('controlPlane.webui.serve') === true) {
    const served = resolveControlPlaneOrigin(configManager, probe, boundControlPlane);
    // With the daemon's own LAN certificate on (webui https), another device opens the https listener beside the plain one.
    const lan = lanHttpsPort(configManager);
    const secure = (origin: string): string => (lan !== undefined ? lanHttpsOriginOf(origin, lan) ?? origin : origin);
    const origin = secure(served.origin);
    return {
      origin,
      resolvedHost: served.resolvedHost,
      httpOnLan: isHttpOnLan(origin),
      fromPublicBaseUrl: false,
      ...(served.alternateOrigin ? { alternateOrigin: secure(served.alternateOrigin) } : {}),
    };
  }
  const binding = webBinding(configManager);
  const resolvedHost = stableUrlHostForBindHost(binding.host, probe);
  const origin = formatHttpOrigin(resolvedHost.host, binding.port);
  return {
    origin,
    resolvedHost,
    httpOnLan: isHttpOnLan(origin),
    fromPublicBaseUrl: false,
    ...(resolvedHost.alternateHost ? { alternateOrigin: formatHttpOrigin(resolvedHost.alternateHost, binding.port) } : {}),
  };
}

/**
 * Whether `web.publicBaseUrl` holds nothing but this daemon's own derived web
 * origin (the value older releases stored there, or the address beside it),
 * or is empty or the old placeholder: then no tunnel or reverse proxy
 * publishes the daemon through it. Any other value (a tunnel, a proxy, a
 * Tailscale serve URL) is not. `settled` is false while the answer could still
 * change once this process has its slow host facts (the Tailscale name, the
 * `.local` lookup). Reads cached host facts and the network interfaces; no
 * lookup is made.
 */
export function publicBaseUrlIsOwnOrigin(
  configManager: Pick<ConfigManager, 'get'>,
  boundControlPlane?: BoundListener,
  probe: () => StableHostInputs = probeStableHostInputs,
): { readonly own: boolean; readonly settled: boolean } {
  const stored = explicitPublicBaseUrl(configManager);
  if (!stored) return { own: true, settled: true };
  const inputs = probe();
  const derived = derivedPairingWebOrigin(configManager, () => inputs, boundControlPlane);
  const own = stored === derived.origin || stored === derived.alternateOrigin;
  return { own, settled: own || inputs.mdnsResolvesToThisHost !== undefined };
}

function hostnameOf(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return origin;
  }
}
