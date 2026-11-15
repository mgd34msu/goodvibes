/**
 * Real WebAuthn material for step-up tests: a P-256 keypair, its COSE public
 * key as an authenticator's none-attestation registration yields it, and
 * assertions signed over `authenticatorData || SHA-256(clientDataJSON)`. No
 * mock crypto.
 */
import { toBase64Url } from '@goodvibes-jev/engine/transport-core/relay';
import type { StepUpAssertionEnvelope } from '../../platform/src/platform/relay/step-up-webauthn.ts';

export const RP_ID = 'daemon.example';
export const ORIGIN = 'https://daemon.example';

export function u8(...bytes: number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes) as Uint8Array<ArrayBuffer>;
}

/** Encode a byte string as a CBOR byte-string of length 32 (0x58 0x20 <bytes>). */
function cborByteString32(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(2 + 32);
  out[0] = 0x58;
  out[1] = 0x20;
  out.set(bytes, 2);
  return out as Uint8Array<ArrayBuffer>;
}

/** Build a COSE_Key (EC2 / P-256 / ES256) from the raw 65-byte public point. */
function coseFromRawPoint(rawPoint: Uint8Array): Uint8Array<ArrayBuffer> {
  const x = rawPoint.subarray(1, 33);
  const y = rawPoint.subarray(33, 65);
  const parts: number[] = [
    0xa5, // map(5)
    0x01, 0x02, // 1 (kty) : 2 (EC2)
    0x03, 0x26, // 3 (alg) : -7 (ES256)
    0x20, 0x01, // -1 (crv): 1 (P-256)
    0x21, // -2 (x):
  ];
  const head = new Uint8Array(parts);
  const xTag = cborByteString32(x);
  const yHead = new Uint8Array([0x22]); // -3 (y):
  const yTag = cborByteString32(y);
  const total = new Uint8Array(head.length + xTag.length + yHead.length + yTag.length);
  let o = 0;
  total.set(head, o); o += head.length;
  total.set(xTag, o); o += xTag.length;
  total.set(yHead, o); o += yHead.length;
  total.set(yTag, o);
  return total as Uint8Array<ArrayBuffer>;
}

/** Convert a raw 64-byte r||s ECDSA signature into ASN.1 DER. */
function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const encodeInt = (bytes: Uint8Array): number[] => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0x00) start += 1;
    let slice = Array.from(bytes.subarray(start));
    if ((slice[0]! & 0x80) !== 0) slice = [0x00, ...slice];
    return [0x02, slice.length, ...slice];
  };
  const r = encodeInt(raw.subarray(0, 32));
  const s = encodeInt(raw.subarray(32, 64));
  const body = [...r, ...s];
  return new Uint8Array([0x30, body.length, ...body]) as Uint8Array<ArrayBuffer>;
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data)) as Uint8Array<ArrayBuffer>;
}

export interface SyntheticCredential {
  readonly privateKey: CryptoKey;
  readonly credentialId: string;
  readonly publicKeyCose: string;
}

export async function makeCredential(): Promise<SyntheticCredential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rawPoint = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    privateKey: pair.privateKey,
    credentialId: toBase64Url(u8(1, 2, 3, 4, 5, 6, 7, 8)),
    publicKeyCose: toBase64Url(coseFromRawPoint(rawPoint)),
  };
}

export interface SignOptions {
  readonly credential: SyntheticCredential;
  readonly challenge: string;
  readonly origin?: string;
  readonly rpId?: string;
  readonly signCount?: number;
  readonly flags?: number;
}

export async function signAssertion(opts: SignOptions): Promise<StepUpAssertionEnvelope> {
  const clientData = JSON.stringify({
    type: 'webauthn.get',
    challenge: opts.challenge,
    origin: opts.origin ?? ORIGIN,
  });
  const clientDataBytes = new TextEncoder().encode(clientData);
  const rpIdHash = await sha256(new TextEncoder().encode(opts.rpId ?? RP_ID));
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = opts.flags ?? 0x05; // UP (0x01) | UV (0x04)
  new DataView(authData.buffer).setUint32(33, opts.signCount ?? 1, false);
  const clientDataHash = await sha256(clientDataBytes);
  const signatureBase = new Uint8Array(authData.length + clientDataHash.length);
  signatureBase.set(authData, 0);
  signatureBase.set(clientDataHash, authData.length);
  const rawSig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, opts.credential.privateKey, signatureBase));
  return {
    credentialId: opts.credential.credentialId,
    authenticatorData: toBase64Url(authData as Uint8Array<ArrayBuffer>),
    clientDataJSON: toBase64Url(clientDataBytes as Uint8Array<ArrayBuffer>),
    signature: toBase64Url(rawToDer(rawSig)),
  };
}
