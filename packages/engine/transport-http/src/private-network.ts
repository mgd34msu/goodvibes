/**
 * Which hosts are private networks, where plain http is a supported posture.
 *
 * The one rule shared by the transport (which refuses plain http to any other
 * host), the daemon's origin posture, the addresses the daemon prints and
 * puts in a pairing QR, and the web UI's start-up guard. It imports nothing so
 * the web UI can run it before anything else loads.
 *
 * Private: loopback and `.localhost`; the wildcard bind addresses (as a dial
 * target they reach this machine); mDNS `.local`; RFC 1918 (10/8, 172.16/12,
 * 192.168/16); IPv4 link-local 169.254/16; the Tailscale range 100.64/10 and
 * MagicDNS `*.ts.net` names (a plain-http `ts.net` origin is reachable only
 * inside the tailnet, where WireGuard encrypts it; Funnel serves https only);
 * IPv6 unique-local fc00::/7 and link-local fe80::/10.
 *
 * Accepts the hostname as URL.hostname yields it (IPv6 still in brackets).
 */

function bareHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function ipv4Octets(host: string): readonly [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return null;
  const octets = [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] as const;
  return octets.every((octet) => octet <= 255) ? octets : null;
}

/** An IPv4-mapped IPv6 address (`::ffff:c0a8:101`, as URL.hostname writes it) as dotted IPv4. */
function mappedIpv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (dotted) return dotted[1] ?? null;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (!hex) return null;
  const high = Number.parseInt(hex[1] ?? '', 16);
  const low = Number.parseInt(hex[2] ?? '', 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateIpv4(host: string): boolean {
  const octets = ipv4Octets(host);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 127 || a === 10) return true; // loopback, 10/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // Tailscale (CGNAT 100.64/10)
  return false;
}

function isPrivateIpv6(host: string): boolean {
  if (!host.includes(':')) return false;
  const withoutZone = host.replace(/%.*$/, '');
  if (withoutZone === '::1' || withoutZone === '::' || withoutZone === '0:0:0:0:0:0:0:0') return true;
  const mapped = mappedIpv4(withoutZone);
  if (mapped) return isPrivateIpv4(mapped);
  const first = withoutZone.split(':')[0] ?? '';
  if (!/^[0-9a-f]{1,4}$/.test(first)) return false;
  const word = Number.parseInt(first, 16);
  if ((word & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((word & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  return false;
}

/** A Tailscale MagicDNS name or a Tailscale address (100.64/10). */
export function isTailnetHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host.endsWith('.ts.net')) return true;
  const octets = ipv4Octets(host);
  return octets !== null && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

/** Whether a URL hostname addresses a private network (see the file header for the list). */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  if (host.endsWith('.ts.net')) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}
