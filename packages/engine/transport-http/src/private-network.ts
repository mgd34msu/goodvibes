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
 * 192.168/16); IPv4 link-local 169.254/16; Tailscale MagicDNS `*.ts.net` names
 * (a plain-http `ts.net` origin is reachable only inside the tailnet, where
 * WireGuard encrypts it; Funnel serves https only); IPv6 unique-local fc00::/7
 * and link-local fe80::/10.
 *
 * A 100.64/10 address is private only when it is stated to be a Tailscale
 * address. That range is RFC 6598 shared address space: Tailscale uses it, and
 * so does carrier-grade NAT, where a plain-http origin crosses the ISP's
 * network unencrypted. It is stated by Tailscale itself (a process that can run
 * programs asks a running `tailscale status` for this machine's and its peers'
 * addresses, only when such an address comes up and at most once a minute), by
 * the owner in `GOODVIBES_TAILNET_ADDRESSES` (comma-separated addresses, or
 * `100.64.0.0/10` for the whole range when no carrier-grade NAT is in the
 * path), or by a caller with {@link stateTailnetAddresses}. A browser has no
 * way to ask, so it reaches a Tailscale machine by its `*.ts.net` name.
 *
 * Imports nothing: the Tailscale question goes through the runtime's own
 * `process.getBuiltinModule`, which a browser does not have.
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
  return false;
}

/** 100.64/10, the shared address space Tailscale and carrier-grade NAT both use. */
function isSharedAddressSpace(host: string): boolean {
  const octets = ipv4Octets(host);
  return octets !== null && octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

const WHOLE_SHARED_RANGE = '100.64.0.0/10';
/** 100.64/10 addresses stated to be Tailscale addresses by this process. */
const statedTailnetAddresses = new Set<string>();
let settingText: string | undefined;
let settingAddresses: ReadonlySet<string> = new Set();

/** The owner's `GOODVIBES_TAILNET_ADDRESSES`, parsed again only when its text changes. */
function settingTailnetAddresses(): ReadonlySet<string> {
  const runtimeProcess = (globalThis as { readonly process?: { readonly env?: Record<string, string | undefined> } }).process;
  const text = runtimeProcess?.env?.GOODVIBES_TAILNET_ADDRESSES ?? '';
  if (text !== settingText) {
    settingText = text;
    settingAddresses = new Set(text.split(/[\s,]+/).map((entry) => bareHost(entry)).filter((entry) => entry.length > 0));
  }
  return settingAddresses;
}

/**
 * Record addresses the caller knows are Tailscale addresses. Only 100.64/10
 * literals are kept; anything else is already decided by the rules above.
 */
export function stateTailnetAddresses(addresses: Iterable<string>): void {
  for (const address of addresses) {
    const host = bareHost(address);
    if (isSharedAddressSpace(host)) statedTailnetAddresses.add(host);
  }
}

/** How long one `tailscale status` answer is trusted; Tailscale can stop, and then the range is the ISP's again. */
const TAILSCALE_ANSWER_TTL_MS = 60_000;
const TAILSCALE_PROBE_TIMEOUT_MS = 1_500;
let tailscaleAnswer: { readonly at: number; readonly addresses: ReadonlySet<string> } | undefined;

type ExecFileSync = (file: string, args: readonly string[], options: {
  readonly encoding: 'utf8';
  readonly timeout: number;
  readonly stdio: readonly ['ignore', 'pipe', 'ignore'];
  readonly windowsHide: boolean;
}) => string;

/** The `TailscaleIPs` of this machine and its peers from a running Tailscale's `status --json`. */
function runningTailscaleAddresses(json: string): Set<string> {
  const out = new Set<string>();
  const add = (node: unknown): void => {
    const ips = node !== null && typeof node === 'object' ? (node as { readonly TailscaleIPs?: unknown }).TailscaleIPs : undefined;
    if (!Array.isArray(ips)) return;
    for (const ip of ips) if (typeof ip === 'string' && isSharedAddressSpace(bareHost(ip))) out.add(bareHost(ip));
  };
  try {
    const parsed = JSON.parse(json) as { readonly BackendState?: unknown; readonly Self?: unknown; readonly Peer?: unknown };
    if (parsed.BackendState !== 'Running') return out;
    add(parsed.Self);
    if (parsed.Peer !== null && typeof parsed.Peer === 'object') for (const peer of Object.values(parsed.Peer as Record<string, unknown>)) add(peer);
  } catch {
    // Not Tailscale's JSON: nothing is stated.
  }
  return out;
}

/**
 * Whether a running Tailscale on this machine lists the address as its own or a
 * peer's. Asked only for a 100.64/10 address nothing else stated, in a process
 * that can run programs (never in a browser), and at most once a minute: the
 * answer (about 10 ms) is reused until it is a minute old.
 */
function tailscaleReports(ipv4: string): boolean {
  const now = Date.now();
  if (!tailscaleAnswer || now - tailscaleAnswer.at >= TAILSCALE_ANSWER_TTL_MS) {
    let addresses: ReadonlySet<string> = new Set();
    try {
      const runtimeProcess = (globalThis as { readonly process?: { readonly getBuiltinModule?: (id: string) => unknown } }).process;
      const childProcess = runtimeProcess?.getBuiltinModule?.('node:child_process') as { readonly execFileSync?: ExecFileSync } | undefined;
      if (childProcess?.execFileSync) {
        addresses = runningTailscaleAddresses(childProcess.execFileSync('tailscale', ['status', '--json'], {
          encoding: 'utf8', timeout: TAILSCALE_PROBE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
        }));
      }
    } catch {
      // No Tailscale here, or it did not answer: it states nothing.
    }
    tailscaleAnswer = { at: now, addresses };
  }
  return tailscaleAnswer.addresses.has(ipv4);
}

function isStatedTailnetAddress(host: string): boolean {
  const ipv4 = mappedIpv4(host.replace(/%.*$/, '')) ?? host;
  if (!isSharedAddressSpace(ipv4)) return false;
  if (statedTailnetAddresses.has(ipv4)) return true;
  const setting = settingTailnetAddresses();
  if (setting.has(ipv4) || setting.has(WHOLE_SHARED_RANGE)) return true;
  return tailscaleReports(ipv4);
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

/** A Tailscale MagicDNS name, or a 100.64/10 address stated to be a Tailscale address. */
export function isTailnetHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host.endsWith('.ts.net')) return true;
  return isStatedTailnetAddress(host);
}

/** Whether a URL hostname addresses a private network (see the file header for the list). */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = bareHost(hostname);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '0.0.0.0') return true;
  if (host.endsWith('.local')) return true;
  if (host.endsWith('.ts.net')) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host) || isStatedTailnetAddress(host);
}
