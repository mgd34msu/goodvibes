/**
 * Where the Agent dials its connected host, decided in one place.
 *
 * The address is an origin, never a host and port glued to `http://`:
 *
 * - `daemon.connectedHost.url`, when set, is the stated origin and its scheme
 *   is used as written. `--runtime-url` and its environment variables set it
 *   for one run.
 * - Otherwise the daemon on this machine, at the address derived from its bind
 *   (`controlPlane.hostMode`, `host`, `port` and `tls.mode`) by the same rule
 *   the daemon and the terminal app use.
 * - A bind host that names another machine with no stated origin is refused:
 *   inferring that machine's scheme from this machine's TLS setting could send
 *   pairing and operator credentials across the network unencrypted.
 *
 * Client-dial-side only. An address handed to ANOTHER machine (a pairing QR
 * code, a phone-facing link) resolves a wildcard to a LAN address through the
 * engine's `stableUrlHostForBindHost`, never here.
 */
import {
  deriveControlPlaneBaseUrl,
  parseDaemonOrigin,
  readConnectedDaemonOrigin,
  readControlPlaneBinding,
} from '@goodvibes/engine/platform/platform/config/control-plane-base-url';
import { isThisMachineHost } from '@goodvibes/engine/platform/platform/runtime/client/daemon-target-resolver';

/** The interface a wildcard-bound listener answers on locally. */
export const LOOPBACK_DIAL_HOST = '127.0.0.1';

/** Bind addresses that name every interface rather than a reachable one. */
const WILDCARD_BIND_HOSTS: ReadonlySet<string> = new Set(['0.0.0.0', '::', '[::]']);

/**
 * The host this process connects to for a configured bind host, for a TCP
 * probe of a listener on this machine. Wildcards and blank values resolve to
 * loopback, the interface a wildcard answers on.
 */
export function dialHostForConfiguredHost(host: unknown): string {
  const trimmed = typeof host === 'string' ? host.trim() : '';
  if (trimmed.length === 0) return LOOPBACK_DIAL_HOST;
  if (WILDCARD_BIND_HOSTS.has(trimmed)) return LOOPBACK_DIAL_HOST;
  return trimmed;
}

/** The settings the connected-host address is read from. */
export type ConnectedHostAddressKey =
  | 'daemon.connectedHost.url'
  | 'controlPlane.hostMode'
  | 'controlPlane.host'
  | 'controlPlane.port'
  | 'controlPlane.tls.mode'
  | 'controlPlane.publicBaseUrl';

export interface ConnectedHostAddressReader {
  get(key: ConnectedHostAddressKey): unknown;
}

export interface ConnectedHostAddress {
  /** The origin (`scheme://host:port`, no trailing slash). Also the key credentials and pairings are stored under. */
  readonly baseUrl: string;
  /** Set when the Agent must not dial `baseUrl`: why, and what to set instead. Nothing is sent while it is set. */
  readonly refusal: string | null;
}

/**
 * The Agent's connected-host address: the stated `daemon.connectedHost.url`,
 * else this machine's daemon at its derived address. A bind host that is
 * another machine, with no stated origin, comes back with a refusal.
 */
export function resolveConnectedHostAddress(config: ConnectedHostAddressReader): ConnectedHostAddress {
  const stated = readConnectedDaemonOrigin((key) => config.get(key));
  if (stated) return { baseUrl: stated.baseUrl, refusal: null };
  const baseUrl = deriveControlPlaneBaseUrl(
    readControlPlaneBinding((key) => config.get(key as ConnectedHostAddressKey)),
    'loopback',
  );
  const origin = parseDaemonOrigin(baseUrl);
  if (origin && isThisMachineHost(origin.host)) return { baseUrl: origin.baseUrl, refusal: null };
  const host = origin?.host ?? baseUrl;
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const port = origin?.port ?? '';
  return {
    baseUrl: origin?.baseUrl ?? baseUrl,
    refusal: `controlPlane.host names ${host}, which is another machine, and how to reach it was not stated. `
      + `Set daemon.connectedHost.url to https://${bracketed}${port === '' ? '' : `:${port}`} (encrypted), or to http://${bracketed}${port === '' ? '' : `:${port}`} to send this Agent's credentials unencrypted over the network; controlPlane.host and controlPlane.port say only how a daemon on this machine listens.`,
  };
}
