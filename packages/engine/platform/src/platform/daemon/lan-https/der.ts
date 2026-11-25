/**
 * der.ts, the few DER and PEM pieces the daemon's https certificates are built
 * from (the local authority and its server certificate in x509.ts, the
 * certificate request sent to Let's Encrypt in csr.ts). node:crypto alone: no
 * dependency. Pure: no I/O.
 */
import { isIP } from 'node:net';

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let value = n; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

export const seq = (...items: Buffer[]): Buffer => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]): Buffer => tlv(0x31, Buffer.concat(items));
export const octets = (body: Buffer): Buffer => tlv(0x04, body);
export const bits = (body: Buffer, unused = 0): Buffer => tlv(0x03, Buffer.concat([Buffer.from([unused]), body]));
export const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
export const utf8 = (text: string): Buffer => tlv(0x0c, Buffer.from(text, 'utf8'));
export const explicit = (n: number, body: Buffer): Buffer => tlv(0xa0 + n, body);

export function integer(value: Buffer | number): Buffer {
  let body = typeof value === 'number' ? Buffer.from([value]) : value;
  while (body.length > 1 && body[0] === 0 && (body[1]! & 0x80) === 0) body = body.subarray(1);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const bytes: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let value = part >> 7; value > 0; value >>= 7) chunk.unshift((value & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

export function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, 'ascii')) : tlv(0x18, Buffer.from(`${iso}Z`, 'ascii'));
}

export const OID = {
  ecdsaSha256: '1.2.840.10045.4.3.2',
  commonName: '2.5.4.3',
  organization: '2.5.4.10',
  basicConstraints: '2.5.29.19',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  serverAuth: '1.3.6.1.5.5.7.3.1',
  subjectAltName: '2.5.29.17',
  nameConstraints: '2.5.29.30',
  subjectKeyId: '2.5.29.14',
  authorityKeyId: '2.5.29.35',
  extensionRequest: '1.2.840.113549.1.9.14',
} as const;

export function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
}

/** The bytes of an IPv4 or IPv6 address, as a certificate's address name carries them. */
export function ipBytes(address: string): Buffer {
  if (isIP(address) === 4) return Buffer.from(address.split('.').map(Number));
  // IPv6: expand '::' and write the eight 16-bit groups.
  const [head, tail] = address.includes('::') ? address.split('::') as [string, string] : [address, undefined];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? headGroups : [...headGroups, ...Array(8 - headGroups.length - tailGroups.length).fill('0'), ...tailGroups];
  return Buffer.concat(groups.map((group) => { const b = Buffer.alloc(2); b.writeUInt16BE(parseInt(group || '0', 16)); return b; }));
}

export const dnsName = (value: string): Buffer => tlv(0x82, Buffer.from(value, 'ascii'));
export const ipName = (bytes: Buffer): Buffer => tlv(0x87, bytes);

export function pem(der: Buffer, label: string): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').replace(/\n$/, '');
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}
