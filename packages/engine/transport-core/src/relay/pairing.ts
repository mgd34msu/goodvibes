// relay/pairing.ts
//
// The pairing payload is the out-of-band bootstrap for a relay connection: it
// carries everything a surface needs to reach a daemon and authenticate it,
// the relay URL, the unguessable rendezvous id, and the daemon's pinned static
// public key. It is deliberately compact and QR-encodable (base64url of a small
// JSON object, prefixed with a self-describing scheme tag) because the intended
// delivery is a QR code scanned from the daemon's screen, the same trust model
// as pairing a phone by scanning a code.
//
// Delivering this payload over a trusted channel (QR on the same LAN, a copied
// string) is what bootstraps trust. Each payload carries its own relay code, a
// per-device secret the daemon issued with it: every request tunneled through
// the relay presents it (RELAY_CODE_HEADER), and the daemon refuses one whose
// code it did not issue or has revoked. Whoever holds a valid pairing payload
// can reach the daemon through the relay until its code is revoked; treat it
// like a credential.

import { fromBase64Url, toBase64Url, decodeUtf8, encodeUtf8 } from './crypto.js';
import { RELAY_PROTOCOL_VERSION, type RendezvousId } from './protocol.js';
import { GoodVibesError } from '@goodvibes/engine/errors';

/** Self-describing prefix so a scanner can recognize a relay pairing string. */
export const PAIRING_SCHEME = 'gvrelay1';

/**
 * The header a relayed request carries its device's relay code in. The client
 * transport sets it from the pairing on every tunneled request; the daemon
 * checks it against the codes it issued and has not revoked.
 */
export const RELAY_CODE_HEADER = 'x-goodvibes-relay-code';

/** The decoded contents of a pairing payload. */
export interface RelayPairingPayload {
  /** Pairing format / protocol version. */
  readonly protocol: number;
  /** Public relay URL the surface should dial (wss://…). */
  readonly relayUrl: string;
  /** Unguessable rendezvous id the daemon registered under. */
  readonly rid: RendezvousId;
  /** Daemon static public key (raw uncompressed P-256), base64url. */
  readonly daemonPublicKey: string;
  /** This device's relay code: listed and revocable on the daemon (`relay.codes.*`), sent on every relayed request. */
  readonly code: string;
  /** Optional human-facing label for the daemon (shown in the surface UI). */
  readonly label?: string;
}

interface WirePairing {
  readonly p: number;
  readonly u: string;
  readonly r: string;
  readonly k: string;
  readonly c: string;
  readonly l?: string;
}

/** Mint a pairing payload object from its parts. */
export function createRelayPairingPayload(input: {
  readonly relayUrl: string;
  readonly rid: RendezvousId;
  readonly daemonPublicKey: string;
  readonly code: string;
  readonly label?: string;
}): RelayPairingPayload {
  return {
    protocol: RELAY_PROTOCOL_VERSION,
    relayUrl: input.relayUrl,
    rid: input.rid,
    daemonPublicKey: input.daemonPublicKey,
    code: input.code,
    ...(input.label !== undefined ? { label: input.label } : {}),
  };
}

/** Encode a pairing payload to a compact, QR-friendly string. */
export function encodeRelayPairingString(payload: RelayPairingPayload): string {
  const wire: WirePairing = {
    p: payload.protocol,
    u: payload.relayUrl,
    r: payload.rid,
    k: payload.daemonPublicKey,
    c: payload.code,
    ...(payload.label !== undefined ? { l: payload.label } : {}),
  };
  return `${PAIRING_SCHEME}.${toBase64Url(encodeUtf8(JSON.stringify(wire)))}`;
}

/** Decode a pairing string back into a payload. Throws on malformed input. */
export function decodeRelayPairingString(text: string): RelayPairingPayload {
  const trimmed = text.trim();
  const dot = trimmed.indexOf('.');
  if (dot < 0 || trimmed.slice(0, dot) !== PAIRING_SCHEME) {
    throw new GoodVibesError('Not a recognizable relay pairing string.', {
      category: 'bad_request',
      source: 'transport',
      recoverable: false,
      hint: `Expected a "${PAIRING_SCHEME}." prefixed pairing code.`,
    });
  }
  let wire: unknown;
  try {
    wire = JSON.parse(decodeUtf8(fromBase64Url(trimmed.slice(dot + 1))));
  } catch {
    throw new GoodVibesError('Corrupt relay pairing string.', { category: 'bad_request', source: 'transport', recoverable: false });
  }
  if (
    typeof wire !== 'object' ||
    wire === null ||
    typeof (wire as WirePairing).p !== 'number' ||
    typeof (wire as WirePairing).u !== 'string' ||
    typeof (wire as WirePairing).r !== 'string' ||
    typeof (wire as WirePairing).k !== 'string' ||
    typeof (wire as WirePairing).c !== 'string'
  ) {
    throw new GoodVibesError('Relay pairing string is missing required fields.', {
      category: 'bad_request', source: 'transport', recoverable: false,
      next: ['Pair again from /relay pair (or goodvibes-agent relay pair): every pairing now carries its own relay code.'],
    });
  }
  const w = wire as WirePairing;
  return assertPairingUsable({
    protocol: w.p,
    relayUrl: w.u,
    rid: w.r,
    daemonPublicKey: w.k,
    code: w.c,
    ...(typeof w.l === 'string' ? { label: w.l } : {}),
  });
}

/**
 * A pairing as a client receives it, either the encoded string or the decoded
 * object, checked once: a code minted by a daemon of another protocol is
 * refused here, before any connection, with the reason and the next step.
 */
export function resolveRelayPairing(pairing: RelayPairingPayload | string): RelayPairingPayload {
  return typeof pairing === 'string' ? decodeRelayPairingString(pairing) : assertPairingUsable(pairing);
}

// The checks every pairing passes, decoded from a string or given as an object:
// its protocol, and a relay code to send (an empty one is refused per request).
function assertPairingUsable(pairing: RelayPairingPayload): RelayPairingPayload {
  assertPairingProtocol(pairing.protocol);
  if (typeof pairing.code !== 'string' || pairing.code.length === 0) {
    throw new GoodVibesError('This relay pairing carries no relay code.', {
      category: 'bad_request', source: 'transport', recoverable: false, state: 'not connected',
      next: ['Pair again from /relay pair (or goodvibes-agent relay pair): every pairing now carries its own relay code.'],
    });
  }
  return pairing;
}

// The relay would only report this as an offline daemon, so it is told here.
function assertPairingProtocol(protocol: number): void {
  if (protocol === RELAY_PROTOCOL_VERSION) return;
  throw new GoodVibesError(`This pairing code is for relay protocol ${String(protocol)}; this build speaks protocol ${RELAY_PROTOCOL_VERSION}.`, {
    category: 'bad_request',
    source: 'transport',
    recoverable: false,
    state: 'not connected',
    next: ['Pair again from /relay pair on a daemon of the same release line, or update this program.'],
  });
}
