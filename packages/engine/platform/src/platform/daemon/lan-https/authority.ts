/**
 * authority.ts, the certificate authority of the daemon's LAN https listener,
 * kept in the secret store, and the names this machine answers to on its
 * network.
 *
 * Made once, the first time the listener is switched on; kept while it is off,
 * so switching it on again needs no new install on the phone; removed only by
 * `goodvibes-daemon webui https off --forget-certificate`. Its private key is
 * the secret: it is read from the store to sign the listener's certificate and
 * never logged, returned or written anywhere else. Its certificate is public:
 * the daemon serves it at /lan-https/goodvibes-ca.crt for a phone to install.
 */
import { hostname, networkInterfaces } from 'node:os';
import { X509Certificate } from 'node:crypto';
import type { Secret } from '../../security/secret.js';
import { createLanAuthority, isLanAddress, isLanHostName, type LanAuthority } from './x509.js';

/** The secret-store key the authority is kept under (classified in config/credential-scope-registry.ts). */
export const LAN_AUTHORITY_SECRET_KEY = 'controlPlane.lanHttps.authority';

export interface LanAuthoritySecrets {
  get(key: string): Promise<Secret | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface StoredAuthority {
  readonly version: 1;
  readonly certPem: string;
  readonly keyPem: string;
}

function readStored(raw: string): StoredAuthority | null {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuthority>;
    if (parsed.version !== 1 || typeof parsed.certPem !== 'string' || typeof parsed.keyPem !== 'string') return null;
    return parsed as StoredAuthority;
  } catch { return null; }
}

/** This machine's host name, lower case, without a domain. */
export function lanHostName(): string {
  return hostname().toLowerCase().split('.')[0] ?? '';
}

/**
 * The authority on record, or a new one saved first when there is none (or the
 * stored one has expired). The key never leaves this function's result.
 */
export async function loadOrCreateLanAuthority(secrets: LanAuthoritySecrets, now = Date.now()): Promise<Pick<LanAuthority, 'certPem' | 'keyPem'>> {
  const stored = await secrets.get(LAN_AUTHORITY_SECRET_KEY);
  const existing = stored ? readStored(stored.reveal('dispatch')) : null;
  if (existing && Date.parse(new X509Certificate(existing.certPem).validTo) > now) return existing;
  const made = createLanAuthority(lanHostName(), now);
  await secrets.set(LAN_AUTHORITY_SECRET_KEY, JSON.stringify({ version: 1, certPem: made.certPem, keyPem: made.keyPem } satisfies StoredAuthority));
  return { certPem: made.certPem, keyPem: made.keyPem };
}

/** The authority's certificate only (public), or null when none was made. */
export async function lanAuthorityCertificate(secrets: Pick<LanAuthoritySecrets, 'get'>): Promise<string | null> {
  const stored = await secrets.get(LAN_AUTHORITY_SECRET_KEY);
  return stored ? readStored(stored.reveal('dispatch'))?.certPem ?? null : null;
}

/** Remove the authority: every phone that installed it must remove it too (the page says how). */
export async function forgetLanAuthority(secrets: Pick<LanAuthoritySecrets, 'delete'>): Promise<void> {
  await secrets.delete(LAN_AUTHORITY_SECRET_KEY);
}

/**
 * The names and addresses the listener's certificate carries, read now (the
 * daemon reads them at each start and listener bind): this machine's host name
 * and `<host>.local`, `localhost`, and every private, loopback, link-local and
 * tailnet address of its interfaces. Public addresses are left out.
 */
export function lanServerNames(): { readonly dnsNames: string[]; readonly addresses: string[] } {
  const host = lanHostName();
  const dnsNames = ['localhost', ...(host && isLanHostName(host) ? [host, `${host}.local`] : [])];
  const addresses = new Set<string>(['127.0.0.1']);
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      const address = entry.address.split('%')[0]!;
      if (isLanAddress(address)) addresses.add(address);
    }
  }
  return { dnsNames, addresses: [...addresses] };
}
