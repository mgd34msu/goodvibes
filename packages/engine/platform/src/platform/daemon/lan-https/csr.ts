/**
 * csr.ts, the certificate request (PKCS #10) the daemon sends Let's Encrypt
 * when it finalizes an order: the names to cover and the public half of a new
 * key made here. The private half never leaves this machine except, sealed, to
 * the members of its group (group-share.ts). Pure apart from key generation
 * and signing: no I/O.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { OID, bits, dnsName, explicit, extension, integer, oid, seq, set, utf8 } from './der.js';

export interface CertificateRequest {
  /** DER bytes of the request, as ACME's finalize takes them (base64url). */
  readonly der: Buffer;
  /** The new key, PKCS #8 PEM: kept in the secret store with the certificate, never logged or returned. */
  readonly keyPem: string;
}

/** A request for `names` (the first is the subject's common name), with a new ECDSA P-256 key. */
export function createCertificateRequest(names: readonly string[]): CertificateRequest {
  if (names.length === 0) throw new Error('a certificate request needs at least one name');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const subject = seq(set(seq(oid(OID.commonName), utf8(names[0]!))));
  const alt = extension(OID.subjectAltName, false, seq(...names.map((value) => dnsName(value.toLowerCase()))));
  const attributes = explicit(0, seq(oid(OID.extensionRequest), set(seq(alt))));
  const info = seq(integer(0), subject, publicKey.export({ type: 'spki', format: 'der' }), attributes);
  const signature = sign('sha256', info, { key: privateKey, dsaEncoding: 'der' });
  return {
    der: seq(info, seq(oid(OID.ecdsaSha256)), bits(signature)),
    keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}
