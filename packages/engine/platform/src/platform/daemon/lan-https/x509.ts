/**
 * x509.ts, the two certificates the daemon's LAN https listener needs, built
 * with node:crypto alone: a certificate authority made on this machine, and
 * the server certificate it issues for this machine's own names and private
 * addresses.
 *
 * The authority carries a critical name-constraints extension: a client that
 * trusts it (a phone the owner installed it on) accepts what it signs only for
 * the names under `local`, `localhost`, `home.arpa`, `internal`, this
 * machine's own host name, and the private, loopback, link-local and tailnet
 * address ranges. Installing it cannot let anyone who later took its key
 * impersonate a public site to that phone. The issuer here refuses any other
 * name before signing as well.
 *
 * ECDSA P-256 with SHA-256, the key type iPhone and Android accept for a
 * user-installed authority. The server certificate lasts 397 days (under the
 * 398 browsers allow for a server certificate) and is made again at every
 * daemon start and listener bind, so a changed address is covered with no
 * timer; its private key is held in memory only. Pure apart from key
 * generation and signing: no I/O.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';
import { OID, bits, bool, dnsName, explicit, extension, integer, ipBytes, ipName, octets, oid, pem, seq, set, time, tlv, utf8 } from './der.js';

function name(commonName: string): Buffer {
  return seq(
    set(seq(oid(OID.organization), utf8('GoodVibes'))),
    set(seq(oid(OID.commonName), utf8(commonName))),
  );
}

function keyId(publicKey: KeyObject): Buffer {
  return createHash('sha1').update(publicKey.export({ type: 'spki', format: 'der' })).digest();
}

function serial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = bytes[0]! & 0x7f;
  return bytes;
}

function signCertificate(tbs: Buffer, issuerKey: KeyObject): Buffer {
  const signature = sign('sha256', tbs, { key: issuerKey, dsaEncoding: 'der' });
  return seq(tbs, seq(oid(OID.ecdsaSha256)), bits(signature));
}

// ── What may be named ──────────────────────────────────────────────────────

/** The DNS suffixes the authority may issue under (besides this machine's own host name). */
export const LAN_DNS_SUFFIXES: readonly string[] = ['local', 'localhost', 'home.arpa', 'internal'];

/** The address ranges the authority may issue for: private, loopback, link-local, carrier-grade NAT (tailnets), unique-local IPv6. */
const LAN_RANGES: readonly { readonly base: string; readonly bits: number }[] = [
  { base: '10.0.0.0', bits: 8 }, { base: '172.16.0.0', bits: 12 }, { base: '192.168.0.0', bits: 16 },
  { base: '127.0.0.0', bits: 8 }, { base: '169.254.0.0', bits: 16 }, { base: '100.64.0.0', bits: 10 },
  { base: 'fc00::', bits: 7 }, { base: 'fe80::', bits: 10 }, { base: '::1', bits: 128 },
];

function mask(bitCount: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < bitCount; i += 1) out[i >> 3] = out[i >> 3]! | (0x80 >> (i % 8));
  return out;
}

/** Whether `address` is in one of the ranges the authority may issue for. */
export function isLanAddress(address: string): boolean {
  if (isIP(address) === 0) return false;
  const bytes = ipBytes(address);
  return LAN_RANGES.some((range) => {
    const base = ipBytes(range.base);
    if (base.length !== bytes.length) return false;
    const m = mask(range.bits, bytes.length);
    return bytes.every((byte, i) => (byte & m[i]!) === (base[i]! & m[i]!));
  });
}

/** A host name that is a single label, or under one of the local suffixes; the names the authority may carry. */
export function isLanHostName(hostName: string): boolean {
  const lower = hostName.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/.test(lower)) return false;
  return !lower.includes('.') || LAN_DNS_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`));
}

/** Refused before anything is signed: a name the authority may not carry. */
export class LanCertificateRefusedError extends Error {
  constructor(readonly refusedName: string) {
    super(`The GoodVibes certificate authority issues only for this machine's own names and private network addresses, so "${refusedName}" was not signed.`);
    this.name = 'LanCertificateRefusedError';
  }
}

// ── The two certificates ───────────────────────────────────────────────────

export interface LanAuthority {
  readonly certPem: string;
  /** The authority's certificate in DER, the file a phone installs. */
  readonly certDer: Buffer;
  /** The authority's private key, PKCS#8 PEM; kept in the secret store, never logged or returned. */
  readonly keyPem: string;
}

export interface LanServerCertificate {
  readonly certPem: string;
  /** Held in memory by the listener only. */
  readonly keyPem: string;
  readonly dnsNames: readonly string[];
  readonly addresses: readonly string[];
  readonly notAfter: number;
}

const DAY_MS = 86_400_000;
/** How long the authority lasts: renewing it means installing it again on each phone. */
export const LAN_AUTHORITY_DAYS = 1095;
/** How long a server certificate lasts, under the 398 days browsers accept. */
export const LAN_SERVER_DAYS = 397;
/**
 * How long a server certificate lasts when a group's lead shares it with the group's machines: a machine that leaves or
 * is removed keeps its copy and key, and a phone that trusts the authority trusts it until it ends, so it ends sooner.
 * It is renewed by itself a month before (secure-address.ts).
 */
export const GROUP_SERVER_DAYS = 90;

/**
 * A new certificate authority for this machine. `hostName` (when it is a local
 * name) is permitted beside the local suffixes; every other public name is
 * outside its constraints.
 */
export function createLanAuthority(hostName: string, now = Date.now()): LanAuthority {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = name(`GoodVibes on ${hostName || 'this computer'}`);
  const permittedNames = [...LAN_DNS_SUFFIXES, ...(hostName && isLanHostName(hostName) && !hostName.includes('.') ? [hostName.toLowerCase()] : [])];
  const permitted = [
    ...permittedNames.map((value) => seq(dnsName(value))),
    ...LAN_RANGES.map((range) => { const base = ipBytes(range.base); return seq(ipName(Buffer.concat([base, mask(range.bits, base.length)]))); }),
  ];
  const ski = keyId(publicKey);
  const extensions = seq(
    extension(OID.basicConstraints, true, seq(bool(true), integer(0))),
    extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
    extension(OID.nameConstraints, true, seq(tlv(0xa0, Buffer.concat(permitted)))),
    extension(OID.subjectKeyId, false, octets(ski)),
  );
  const tbs = seq(
    explicit(0, integer(2)), integer(serial()), seq(oid(OID.ecdsaSha256)), subject,
    seq(time(new Date(now - DAY_MS)), time(new Date(now + LAN_AUTHORITY_DAYS * DAY_MS))),
    subject, publicKey.export({ type: 'spki', format: 'der' }), explicit(3, extensions),
  );
  const certDer = signCertificate(tbs, privateKey);
  return { certPem: pem(certDer, 'CERTIFICATE'), certDer, keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

/**
 * The listener's certificate, signed by `authority`, for `dnsNames` and
 * `addresses`. Throws LanCertificateRefusedError, signing nothing, when any
 * name is not this machine's own (a public name or a public address).
 */
export function issueLanServerCertificate(
  authority: Pick<LanAuthority, 'certPem' | 'keyPem'>,
  names: { readonly dnsNames: readonly string[]; readonly addresses: readonly string[] },
  now = Date.now(),
  /** How long it lasts: LAN_SERVER_DAYS for a machine of its own, GROUP_SERVER_DAYS when a group's machines hold it too. */
  days = LAN_SERVER_DAYS,
): LanServerCertificate {
  for (const value of names.dnsNames) if (!isLanHostName(value)) throw new LanCertificateRefusedError(value);
  for (const value of names.addresses) if (!isLanAddress(value)) throw new LanCertificateRefusedError(value);
  if (names.dnsNames.length + names.addresses.length === 0) throw new LanCertificateRefusedError('(no name)');
  const issuerKey = createPrivateKey(authority.keyPem);
  const issuerPublic = createPublicKey(issuerKey);
  const issuer = new X509Certificate(authority.certPem);
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const notAfter = now + days * DAY_MS;
  const alt = seq(...names.dnsNames.map((value) => dnsName(value.toLowerCase())), ...names.addresses.map((value) => ipName(ipBytes(value))));
  const extensions = seq(
    extension(OID.basicConstraints, true, seq()),
    extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
    extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
    extension(OID.subjectAltName, false, alt),
    extension(OID.subjectKeyId, false, octets(keyId(publicKey))),
    extension(OID.authorityKeyId, false, seq(tlv(0x80, keyId(issuerPublic)))),
  );
  const tbs = seq(
    explicit(0, integer(2)), integer(serial()), seq(oid(OID.ecdsaSha256)), issuerName(issuer.raw),
    seq(time(new Date(now - DAY_MS)), time(new Date(notAfter))),
    name('GoodVibes daemon on this network'), publicKey.export({ type: 'spki', format: 'der' }), explicit(3, extensions),
  );
  return {
    certPem: pem(signCertificate(tbs, issuerKey), 'CERTIFICATE'),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    dnsNames: [...names.dnsNames], addresses: [...names.addresses], notAfter,
  };
}

/** The subject Name of a DER certificate, as the issuer of what it signs: read from its own bytes. */
function issuerName(certDer: Buffer): Buffer {
  // Certificate ::= SEQUENCE { tbs SEQUENCE { [0] version, serial, sigAlg, issuer, validity, subject, ... } ... }
  const children = (buffer: Buffer, offset: number): { readonly start: number; readonly end: number }[] => {
    const out: { start: number; end: number }[] = [];
    let at = offset;
    const read = (pos: number): { readonly header: number; readonly size: number } => {
      const first = buffer[pos + 1]!;
      if (first < 0x80) return { header: 2, size: first };
      const count = first & 0x7f;
      let size = 0;
      for (let i = 0; i < count; i += 1) size = (size << 8) | buffer[pos + 2 + i]!;
      return { header: 2 + count, size };
    };
    const outer = read(at);
    const end = at + outer.header + outer.size;
    at += outer.header;
    while (at < end) {
      const item = read(at);
      out.push({ start: at, end: at + item.header + item.size });
      at += item.header + item.size;
    }
    return out;
  };
  const tbs = children(certDer, 0)[0]!;
  const fields = children(certDer, tbs.start);
  // version [0], serial, sigAlg, issuer, validity, subject
  const subject = fields[5]!;
  return certDer.subarray(subject.start, subject.end);
}
