/**
 * Who connected: the one place a listener turns the socket peer and, when it
 * trusts a proxy, the forwarding headers into the client address that security
 * events, the sign-in limiter and the failed-sign-in audit key on. Both the
 * control-plane listener and the webhook listener resolve it here, once per
 * request.
 */

import { extractForwardedClientIp } from '../runtime/network/index.js';
import { isLoopbackHost } from '../utils/reachable-base-url.js';

// ---------------------------------------------------------------------------
// Cloudflare IP ranges (maintained constant; do NOT fetch at runtime by default).
// Source: https://www.cloudflare.com/ips/
// Last reviewed: 2026-06-11
// ---------------------------------------------------------------------------

/** Cloudflare published IPv4 CIDR ranges (full list). */
const CLOUDFLARE_IPV4_CIDRS: ReadonlyArray<[string, number]> = [
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['108.162.192.0', 18],
  ['131.0.72.0', 22],
  ['141.101.64.0', 18],
  ['162.158.0.0', 15],
  ['172.64.0.0', 13],
  ['173.245.48.0', 20],
  ['188.114.96.0', 20],
  ['190.93.240.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
];

/** Cloudflare published IPv6 CIDR prefixes (prefix string, prefix-length pairs). */
const CLOUDFLARE_IPV6_PREFIXES: ReadonlyArray<[string, number]> = [
  ['2400:cb00::', 32],
  ['2606:4700::', 32],
  ['2803:f800::', 32],
  ['2405:b500::', 32],
  ['2405:8100::', 32],
  ['2a06:98c0::', 29],
  ['2c0f:f248::', 32],
];

function ipv4ToUint32(ip: string): number | undefined {
  const parts = ip.split('.');
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const part of parts) {
    const v = Number(part);
    if (!Number.isInteger(v) || v < 0 || v > 255) return undefined;
    n = (n << 8) | v;
  }
  // Shift result to unsigned 32-bit
  return n >>> 0;
}

function isIpInCidr4(ip: string, cidrNet: string, prefixLen: number): boolean {
  const ipInt = ipv4ToUint32(ip);
  const netInt = ipv4ToUint32(cidrNet);
  if (ipInt === undefined || netInt === undefined) return false;
  const mask = prefixLen === 0 ? 0 : (~0 << (32 - prefixLen)) >>> 0;
  return (ipInt & mask) === (netInt & mask);
}

function isIpv6InPrefix(ip: string, prefix: string, prefixLen: number): boolean {
  try {
    // Normalize by expanding both to full 128-bit arrays
    const ipBytes = ipv6ToBytes(ip);
    const prefixBytes = ipv6ToBytes(prefix);
    if (!ipBytes || !prefixBytes) return false;
    const fullBytes = Math.floor(prefixLen / 8);
    const remainBits = prefixLen % 8;
    for (let i = 0; i < fullBytes; i++) {
      if (ipBytes[i] !== prefixBytes[i]) return false;
    }
    if (remainBits > 0 && fullBytes < 16) {
      const mask = (0xff << (8 - remainBits)) & 0xff;
      if ((ipBytes[fullBytes]! & mask) !== (prefixBytes[fullBytes]! & mask)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function ipv6ToBytes(ip: string): Uint8Array | undefined {
  try {
    // Strip brackets if present (e.g. [::1])
    const clean = ip.replace(/^\[|\]$/g, '');
    // Reject zone IDs (e.g. fe80::1%eth0), '%' is not valid in a routable address.
    if (clean.includes('%')) return undefined;
    const halves = clean.split('::');
    if (halves.length > 2) return undefined;
    const leftGroups = halves[0] ? halves[0].split(':') : [];
    const rightGroups = halves[1] ? halves[1].split(':') : [];
    const totalGroups = 8;
    const zeroGroups = totalGroups - leftGroups.length - rightGroups.length;
    if (zeroGroups < 0) return undefined;
    const groups = [
      ...leftGroups,
      ...Array(zeroGroups).fill('0'),
      ...rightGroups,
    ];
    if (groups.length !== 8) return undefined;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 8; i++) {
      const g = groups[i]!;
      // Each group must be 1-4 hex characters, no leading garbage, no zone index fragments.
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return undefined;
      const v = parseInt(g, 16);
      // parseInt with a valid hex pattern never exceeds 0xffff, but guard defensively.
      if (v < 0 || v > 0xffff) return undefined;
      bytes[i * 2] = (v >> 8) & 0xff;
      bytes[i * 2 + 1] = v & 0xff;
    }
    return bytes;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when the given IP address belongs to a Cloudflare-owned range.
 * Used to validate CF-Connecting-IP header trust: only trust it when the
 * connecting peer is actually a Cloudflare edge node.
 */
export function isCloudflareIp(ip: string): boolean {
  if (!ip) return false;
  // Strip IPv6-mapped IPv4 prefix (::ffff:a.b.c.d)
  const v4mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  const candidate = v4mapped ? v4mapped[1]! : ip;
  // Try IPv4 ranges first
  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    return CLOUDFLARE_IPV4_CIDRS.some(([net, len]) => isIpInCidr4(candidate, net, len));
  }
  // Try IPv6 prefixes
  return CLOUDFLARE_IPV6_PREFIXES.some(([prefix, len]) => isIpv6InPrefix(candidate, prefix, len));
}

export interface ClientAddressTrust {
  /** Forwarding headers name the client (only behind a trusted reverse proxy). */
  readonly trustProxy: boolean;
  /** CF-Connecting-IP names the client, and only when the peer is a Cloudflare edge address. Needs trustProxy. */
  readonly trustCloudflare?: boolean | undefined;
}

/** The client address for one request; `unknown` only when neither the socket nor a trusted header names one. */
export function resolveClientAddress(req: Request, peerAddress: string | undefined, trust: ClientAddressTrust): string {
  const peer = peerAddress?.trim() || undefined;
  if (trust.trustCloudflare && trust.trustProxy) {
    // Only the actual socket peer can establish Cloudflare provenance; without it forwarded headers establish nothing.
    const cfConnectingIp = req.headers.get('cf-connecting-ip')?.trim();
    return (cfConnectingIp && peer && isCloudflareIp(peer) ? cfConnectingIp : peer) ?? 'unknown';
  }
  return extractForwardedClientIp(req, trust.trustProxy) ?? peer ?? 'unknown';
}

const boundAddresses = new WeakMap<Request, string>();

/** Record the address the listener resolved for this request, so every later reader gets the same one. */
export function bindClientAddress(req: Request, address: string): void {
  boundAddresses.set(req, address);
}

/** The address the listener bound to this request, or undefined for a request that did not come through one. */
export function clientAddressOf(req: Request): string | undefined {
  return boundAddresses.get(req);
}

/**
 * Headers a reverse proxy or tunnel adds to say whom it forwards for. A
 * same-machine proxy (cloudflared, tailscale serve, Caddy, nginx) connects from
 * loopback, so the socket peer alone cannot tell its callers from the
 * daemon's own machine; an app talking to the daemon directly sends none.
 */
const FORWARDING_HEADERS = [
  'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip', 'cf-connecting-ip', 'true-client-ip', 'via',
] as const;

/** The host name the request was addressed to: its Host header, else its URL. */
function requestHostName(req: Request): string | undefined {
  const host = req.headers.get('host')?.trim();
  if (!host) {
    try { return new URL(req.url).hostname; } catch { return undefined; }
  }
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end) : undefined;
  }
  const colon = host.indexOf(':');
  return colon >= 0 && host.indexOf(':', colon + 1) < 0 ? host.slice(0, colon) : host;
}

/**
 * Whether a request reached the listener straight from this machine: the
 * socket peer is loopback, no proxy or tunnel forwarding header is present, and
 * it was addressed to a loopback name. A header read per name and no I/O.
 * The listener still has to rule out a configured public address (a proxy
 * that rewrites Host and adds no header looks the same) before it calls
 * {@link bindLocalOrigin}.
 */
export function isDirectLoopbackRequest(req: Request, peerAddress: string | undefined): boolean {
  if (!isLoopbackHost(peerAddress)) return false;
  for (const name of FORWARDING_HEADERS) if (req.headers.has(name)) return false;
  return isLoopbackHost(requestHostName(req));
}

const localOrigins = new WeakSet<Request>();

/**
 * Record that the listener established this request as coming from the
 * daemon's own machine: the one fact that makes the operator token the
 * `local` credential. Only a listener (or the daemon calling itself in
 * process) sets it; a request it was not set on is never local.
 */
export function bindLocalOrigin(req: Request): void {
  localOrigins.add(req);
}

/** True only when the listener bound this request as coming from the daemon's own machine. */
export function isLocalOrigin(req: Request): boolean {
  return localOrigins.has(req);
}
