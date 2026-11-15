// relay/protocol.ts
//
// The relay-hop wire protocol. This is the ONLY part of the traffic the relay
// operator can read: connection-control frames (who is a daemon, who is a
// client, which rendezvous id, which multiplexed pipe) plus opaque binary
// payloads it forwards verbatim. The relay never sees the end-to-end keys or
// plaintext, every binary payload is ciphertext produced by secure-channel.ts.
//
// Two message shapes travel over each relay WebSocket:
//   1. Control frames , JSON text messages (this module encodes/decodes them).
//   2. Data frames    , binary messages: on the daemon<->relay leg they carry a
//      16-byte pipe-id prefix (relay-hop routing metadata) followed by opaque
//      ciphertext; on the client<->relay leg they are bare opaque ciphertext
//      (a client owns exactly one pipe).
//
// Keeping the framing tiny and explicit is deliberate: a public relay instance
// must be auditable at a glance for exactly what it can observe.
//
// Ownership of a rendezvous id is self-certifying: the id is derived from the
// daemon's identity public key, and a registration is accepted only with a
// signature over a relay-chosen nonce under that key. The relay therefore keeps
// no record of who owns which id, and someone who learned the id from a pairing
// code cannot register it.

import { GoodVibesError } from '@goodvibes-jev/engine/errors';
import { concatBytes, encodeUtf8, fromBase64Url, randomBytes, RELAY_CURVE, RELAY_PUBLIC_KEY_BYTES, sha256, toBase64Url, type RelayKeyPair } from './crypto.js';

/** Wire protocol version. Bumped only on incompatible control-frame changes. */
export const RELAY_PROTOCOL_VERSION = 1;

/** Length in bytes of a multiplexed pipe identifier. */
export const RELAY_PIPE_ID_BYTES = 16;

/** Rendezvous id: unguessable string a daemon registers under and a client dials. */
export type RendezvousId = string;

/** Opaque multiplexed pipe id (one client<->daemon tunnel through the relay). */
export type PipeId = string;

/** Endpoint role on a relay connection. */
export type RelayRole = 'daemon' | 'client';

/** Machine-readable relay failure codes (surfaced to callers as honest errors). */
export type RelayErrorCode =
  | 'daemon-offline' // client dialed a rendezvous id with no registered daemon
  | 'rid-taken' // another live connection holds the rendezvous id and this registration did not prove ownership
  | 'capacity' // the relay instance hit a configured cap (daemons/pipes/rate)
  | 'protocol-version' // incompatible RELAY_PROTOCOL_VERSION
  | 'malformed' // unparseable or invalid control frame
  | 'rate-limited' // per-connection or per-ip rate limit tripped
  | 'unauthorized' // the registration's proof did not verify for the rendezvous id
  | 'internal';

// ─── Control frames (JSON over WebSocket text) ────────────────────────────────

/** Daemon → relay: claim a rendezvous id and accept client pipes for it. */
export interface RelayRegisterFrame {
  readonly t: 'register';
  readonly role: 'daemon';
  readonly protocol: number;
  readonly rid: RendezvousId;
}

/**
 * Relay → daemon: prove ownership of the rendezvous id named in `register` by
 * answering with a {@link RelayProveFrame} signed over this nonce.
 */
export interface RelayChallengeFrame {
  readonly t: 'challenge';
  /** Random base64url nonce, fresh per connection. */
  readonly nonce: string;
}

/** Daemon → relay: the answer to a {@link RelayChallengeFrame}. */
export interface RelayProveFrame {
  readonly t: 'prove';
  /** Daemon identity public key (raw uncompressed P-256), base64url; the rendezvous id is derived from it. */
  readonly key: string;
  /** ECDSA P-256 / SHA-256 signature (IEEE P1363) over the registration message, base64url. */
  readonly sig: string;
}

/** Relay → daemon: the rendezvous id is claimed; the daemon is now reachable. */
export interface RelayRegisteredFrame {
  readonly t: 'registered';
  readonly rid: RendezvousId;
}

/** Client → relay: dial a rendezvous id. */
export interface RelayConnectFrame {
  readonly t: 'connect';
  readonly role: 'client';
  readonly protocol: number;
  readonly rid: RendezvousId;
}

/** Relay → client: a pipe to the daemon is open; begin the E2E handshake. */
export interface RelayConnectedFrame {
  readonly t: 'connected';
  readonly pipe: PipeId;
}

/** Relay → daemon: a new client pipe opened for this daemon's rendezvous id. */
export interface RelayPipeOpenFrame {
  readonly t: 'pipe-open';
  readonly pipe: PipeId;
}

/** Relay → daemon/client: a pipe closed (peer gone or torn down). */
export interface RelayPipeCloseFrame {
  readonly t: 'pipe-close';
  readonly pipe: PipeId;
  readonly reason?: string;
}

/** Relay → endpoint: an error occurred. `code` is machine-readable. */
export interface RelayErrorFrame {
  readonly t: 'error';
  readonly code: RelayErrorCode;
  readonly message: string;
  readonly pipe?: PipeId;
}

/** Any endpoint ↔ relay control frame. */
export type RelayControlFrame =
  | RelayRegisterFrame
  | RelayChallengeFrame
  | RelayProveFrame
  | RelayRegisteredFrame
  | RelayConnectFrame
  | RelayConnectedFrame
  | RelayPipeOpenFrame
  | RelayPipeCloseFrame
  | RelayErrorFrame;

/** Serialize a control frame to a WebSocket text payload. */
export function encodeControlFrame(frame: RelayControlFrame): string {
  return JSON.stringify(frame);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse a WebSocket text payload into a control frame, or return null if it is
 * not a recognizable, well-typed relay control frame. Callers treat null as a
 * `malformed` protocol violation.
 */
export function decodeControlFrame(text: string): RelayControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed['t'] !== 'string') return null;
  const t = parsed['t'];
  switch (t) {
    case 'register':
      return isRid(parsed) && parsed['role'] === 'daemon' && typeof parsed['protocol'] === 'number'
        ? { t, role: 'daemon', protocol: parsed['protocol'], rid: parsed['rid'] as string }
        : null;
    case 'connect':
      return isRid(parsed) && parsed['role'] === 'client' && typeof parsed['protocol'] === 'number'
        ? { t, role: 'client', protocol: parsed['protocol'], rid: parsed['rid'] as string }
        : null;
    case 'challenge':
      return isNonEmptyString(parsed['nonce']) ? { t, nonce: parsed['nonce'] } : null;
    case 'prove':
      return isNonEmptyString(parsed['key']) && isNonEmptyString(parsed['sig'])
        ? { t, key: parsed['key'], sig: parsed['sig'] }
        : null;
    case 'registered':
      return isRid(parsed) ? { t, rid: parsed['rid'] as string } : null;
    case 'connected':
      return isPipe(parsed) ? { t, pipe: parsed['pipe'] as string } : null;
    case 'pipe-open':
      return isPipe(parsed) ? { t, pipe: parsed['pipe'] as string } : null;
    case 'pipe-close':
      return isPipe(parsed)
        ? { t, pipe: parsed['pipe'] as string, ...(typeof parsed['reason'] === 'string' ? { reason: parsed['reason'] } : {}) }
        : null;
    case 'error':
      return typeof parsed['code'] === 'string' && typeof parsed['message'] === 'string'
        ? {
            t,
            code: parsed['code'] as RelayErrorCode,
            message: parsed['message'] as string,
            ...(typeof parsed['pipe'] === 'string' ? { pipe: parsed['pipe'] as string } : {}),
          }
        : null;
    default:
      return null;
  }
}

function isRid(v: Record<string, unknown>): boolean {
  return typeof v['rid'] === 'string' && v['rid'].length > 0;
}

function isPipe(v: Record<string, unknown>): boolean {
  return typeof v['pipe'] === 'string' && v['pipe'].length > 0;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

// ─── Rendezvous id ownership ──────────────────────────────────────────────────

/** Random bytes in a registration challenge nonce. */
export const RELAY_CHALLENGE_BYTES = 32;

const RID_PREFIX = 'rid_';
const RID_DOMAIN = 'goodvibes-relay-rid-v1\n';
const REGISTER_DOMAIN = 'goodvibes-relay-register-v1\n';

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c || typeof c.subtle === 'undefined') {
    throw new GoodVibesError('Web Crypto (crypto.subtle) is unavailable in this runtime.', { category: 'config', source: 'transport', recoverable: false });
  }
  return c.subtle;
}

function registrationMessage(rid: RendezvousId, nonce: string): Uint8Array<ArrayBuffer> {
  return encodeUtf8(`${REGISTER_DOMAIN}${rid}\n${nonce}`);
}

/**
 * The rendezvous id a daemon registers under, derived from its identity public
 * key (raw uncompressed P-256). It is as unguessable as the key is unknown, and
 * anyone can check it against the key without asking the daemon.
 */
export async function deriveRendezvousId(publicKeyRaw: Uint8Array<ArrayBuffer>): Promise<RendezvousId> {
  const digest = await sha256(concatBytes(encodeUtf8(RID_DOMAIN), publicKeyRaw));
  return `${RID_PREFIX}${toBase64Url(digest)}`;
}

/** Relay side: a fresh challenge for one registering connection. */
export function createRelayChallenge(): RelayChallengeFrame {
  return { t: 'challenge', nonce: toBase64Url(randomBytes(RELAY_CHALLENGE_BYTES)) };
}

/**
 * Daemon side: answer a challenge by signing it with the identity key. The
 * identity is an ECDH key pair; its private scalar is reused for ECDSA under a
 * domain-separated message, so pairing codes keep pinning one key. The
 * identity's private key must be extractable (it is, so it can be persisted).
 */
export async function proveRelayRegistration(identity: RelayKeyPair, rid: RendezvousId, nonce: string): Promise<RelayProveFrame> {
  const jwk = await subtle().exportKey('jwk', identity.privateKey);
  const signingJwk: JsonWebKey = { ...jwk, key_ops: ['sign'] };
  delete signingJwk.use;
  delete signingJwk.alg;
  const signingKey = await subtle().importKey('jwk', signingJwk, { name: 'ECDSA', namedCurve: RELAY_CURVE }, false, ['sign']);
  const signature = await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, registrationMessage(rid, nonce));
  const publicKeyRaw = new Uint8Array(await subtle().exportKey('raw', identity.publicKey));
  return { t: 'prove', key: toBase64Url(publicKeyRaw), sig: toBase64Url(new Uint8Array(signature)) };
}

/**
 * Relay side: true when `proof` shows that the registering daemon holds the key
 * `rid` was derived from and signed this connection's `nonce`. Costs one hash
 * and one signature check per registration; nothing per frame, nothing stored.
 */
export async function verifyRelayRegistration(rid: RendezvousId, nonce: string, proof: RelayProveFrame): Promise<boolean> {
  let keyRaw: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    keyRaw = fromBase64Url(proof.key);
    sig = fromBase64Url(proof.sig);
  } catch {
    return false;
  }
  if (keyRaw.length !== RELAY_PUBLIC_KEY_BYTES || keyRaw[0] !== 0x04) return false;
  if (await deriveRendezvousId(keyRaw) !== rid) return false;
  try {
    const verifyKey = await subtle().importKey('raw', keyRaw, { name: 'ECDSA', namedCurve: RELAY_CURVE }, false, ['verify']);
    return await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, verifyKey, sig, registrationMessage(rid, nonce));
  } catch {
    return false;
  }
}

// ─── What a relay error means for the caller ──────────────────────────────────

/** What is true after a relay error, and what gets past it. */
export interface RelayErrorAdvice {
  readonly state: string;
  readonly next: readonly string[];
  readonly retryable: boolean;
}

/**
 * The one table of relay error meanings, read by the daemon's registration
 * status and by the client's connect failure so both say the same thing.
 */
export const RELAY_ERROR_ADVICE: Readonly<Record<RelayErrorCode, RelayErrorAdvice>> = Object.freeze({
  'daemon-offline': {
    state: 'no daemon is registered on the relay for this pairing',
    next: ['Start the daemon, and check its remote access with /relay status on that machine', 'If the daemon was re-paired, scan its new code from /relay pair'],
    retryable: true,
  },
  'rid-taken': {
    state: 'another connection holds this daemon\'s relay id',
    next: ['Update the relay and the daemon to the same release so the daemon can prove the id is its own', 'Check remote access with /relay status'],
    retryable: true,
  },
  capacity: {
    state: 'the relay is at capacity',
    next: ['Try again shortly, or set relay.url to a relay with room'],
    retryable: true,
  },
  'protocol-version': {
    state: 'the relay speaks a different protocol version',
    next: ['Update this program or the relay so both run the same release line'],
    retryable: false,
  },
  malformed: {
    state: 'the relay could not read a control frame',
    next: ['Update this program or the relay so both run the same release line'],
    retryable: false,
  },
  'rate-limited': {
    state: 'the relay is limiting connections from this address',
    next: ['Wait a minute and try again'],
    retryable: true,
  },
  unauthorized: {
    state: 'the relay did not accept this daemon\'s proof of its relay id',
    next: ['Check remote access with /relay status; the relay id must be the one derived from the daemon\'s identity key'],
    retryable: false,
  },
  internal: {
    state: 'the relay failed internally',
    next: ['Try again shortly'],
    retryable: true,
  },
});

/** Advice for a code read off the wire; an unknown code is treated as `internal`. */
export function relayErrorAdvice(code: string): RelayErrorAdvice {
  return Object.hasOwn(RELAY_ERROR_ADVICE, code) ? RELAY_ERROR_ADVICE[code as RelayErrorCode] : RELAY_ERROR_ADVICE.internal;
}

// ─── Data frames (binary, daemon<->relay leg carries a pipe-id prefix) ─────────

/**
 * Prefix an opaque ciphertext payload with its 16-byte pipe id, for the
 * daemon<->relay leg where a single socket multiplexes many client pipes.
 * `pipeIdBytes` is the raw 16-byte random pipe id; its base64url encoding is the
 * `PipeId` string carried in control frames (the daemon correlates the two by
 * base64url-encoding this prefix). The relay reads this prefix as routing
 * metadata and never inspects the payload that follows.
 */
export function framePipePayload(pipeIdBytes: Uint8Array<ArrayBuffer>, payload: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  if (pipeIdBytes.length !== RELAY_PIPE_ID_BYTES) {
    throw new Error(`pipe id must be ${RELAY_PIPE_ID_BYTES} bytes`);
  }
  const out = new Uint8Array(RELAY_PIPE_ID_BYTES + payload.length);
  out.set(pipeIdBytes, 0);
  out.set(payload, RELAY_PIPE_ID_BYTES);
  return out;
}

/** Split a daemon<->relay binary frame into its pipe-id prefix and opaque payload. */
export function unframePipePayload(frame: Uint8Array<ArrayBuffer>): { readonly pipeId: Uint8Array<ArrayBuffer>; readonly payload: Uint8Array<ArrayBuffer> } | null {
  if (frame.length < RELAY_PIPE_ID_BYTES) return null;
  return {
    pipeId: frame.subarray(0, RELAY_PIPE_ID_BYTES),
    payload: frame.subarray(RELAY_PIPE_ID_BYTES),
  };
}
