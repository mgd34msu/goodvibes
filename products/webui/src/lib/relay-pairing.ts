/**
 * relay-pairing.ts, store and read a relay pairing payload for this device.
 *
 * A relay pairing is different from the existing operator-token pairing
 * (see pairing.ts / usePairingHandoff.ts): it signs nobody in. It is
 * transport-level bootstrap, a relay URL, an unguessable rendezvous id, the
 * daemon's pinned public key and this device's own relay code
 * (@goodvibes/engine/transport-core/relay's `RelayPairingPayload`; the relay
 * client sends the code on every request, and the daemon owner can revoke it for
 * this device alone), that lets this browser reach the daemon through the
 * zero-knowledge relay when it cannot reach it directly (off the LAN). The daemon
 * mints this payload and shows it as a QR; scanning it with the device camera opens
 * a link back to this app carrying the encoded payload in the URL FRAGMENT, exactly
 * like the token pairing flow, and for the same reason: a `#`-fragment is never sent
 * to a server, so the payload never lands in an access log or a Referer header. The
 * relay docs call the payload itself "treat it like a credential", whoever holds a
 * valid one can reach the daemon through the relay, so it is held in this page's
 * memory only (a reload forgets it), never transmitted anywhere else, and cleared
 * with the sign-in.
 *
 * Once held, the platform client construction (lib/goodvibes.ts / lib/relay-connection.ts)
 * picks it up and uses it to build a relay-backed `fetch` for whenever the direct
 * connection is unreachable, see relay-connection.ts's routedFetch.
 *
 * Still auth-separate: a relay pairing gets you a TRANSPORT to the daemon, not a
 * signed-in session. The operator token pairing/paste flow still applies on top.
 */

import {
  decodeRelayPairingString,
  encodeRelayPairingString,
  type RelayPairingPayload,
} from '@goodvibes/engine/transport-core/relay';
import { noteRelayPairingChanged } from './client-lifetime';

export type { RelayPairingPayload };

/** The fragment key the relay pairing link uses: `#relay=<gvrelay1.…>`. */
export const RELAY_PAIRING_FRAGMENT_KEY = 'relay';

/**
 * Extract a relay pairing code from a URL hash string (`window.location.hash`), or
 * null when none is present. Mirrors parsePairingTokenFromHash's tolerances: a
 * leading `#`, an empty hash, and other fragment keys alongside `relay`.
 */
export function parseRelayPairingFromHash(hash: string): string | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const trimmed = new URLSearchParams(raw).get(RELAY_PAIRING_FRAGMENT_KEY)?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Remove the `relay` key from the current URL's fragment via history.replaceState,
 * preserving the pathname, query string, and any other fragment keys. No-op-safe.
 */
export function stripRelayPairingFragment(): void {
  if (typeof window === 'undefined') return;
  const rawHash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const params = new URLSearchParams(rawHash);
  if (!params.has(RELAY_PAIRING_FRAGMENT_KEY)) return;
  params.delete(RELAY_PAIRING_FRAGMENT_KEY);
  const remaining = params.toString();
  const url = `${window.location.pathname}${window.location.search}${remaining ? `#${remaining}` : ''}`;
  window.history.replaceState(window.history.state, '', url);
}

/**
 * Decode a scanned/pasted relay pairing string (the `gvrelay1.…` code) into a
 * payload. Throws the platform's own GoodVibesError on malformed input, callers
 * render that with formatError, same as any other honest rejection.
 */
export function decodeRelayPairingCode(code: string): RelayPairingPayload {
  return decodeRelayPairingString(code.trim());
}

/** Re-export for symmetry, callers that already have a payload object (not a string). */
export { encodeRelayPairingString };

// ---------------------------------------------------------------------------
// Held for the life of the page
// ---------------------------------------------------------------------------

/**
 * The pairing carries this device's relay code, a credential, so it is held in memory
 * only: never in localStorage, sessionStorage or IndexedDB. A reload forgets it, and the
 * relay route then asks for the relay code and a sign-in again.
 */
let heldPairing: RelayPairingPayload | null = null;

/** The relay pairing this page holds, or null. */
export function getStoredRelayPairing(): RelayPairingPayload | null {
  return heldPairing;
}

/** What an operator needs to see before a scanned relay pairing is stored. */
export interface RelayPairingConfirmation {
  /** The relay's host, as the operator would recognise it. */
  readonly relayHost: string;
  /** A short, comparable form of the daemon's pinned public key. */
  readonly fingerprint: string;
  /** True when storing would replace a different pairing already on this device. */
  readonly replacesExisting: boolean;
}

/**
 * Describe a decoded pairing for an explicit confirm step. A relay pairing routes this
 * browser's requests, bearer token included, to whichever daemon holds the pinned key, so
 * a scanned or linked payload must be shown and confirmed rather than stored on arrival.
 */
export function describeRelayPairingForConfirmation(
  payload: RelayPairingPayload,
  existing: RelayPairingPayload | null = getStoredRelayPairing(),
): RelayPairingConfirmation {
  let relayHost = payload.relayUrl;
  try {
    relayHost = new URL(payload.relayUrl).host || payload.relayUrl;
  } catch {
    // Not a parseable URL: show it verbatim so the operator can see what it is.
  }
  const key = payload.daemonPublicKey;
  const fingerprint = key.length > 20 ? `${key.slice(0, 10)}…${key.slice(-10)}` : key;
  const replacesExisting = existing !== null
    && (existing.relayUrl !== payload.relayUrl
      || existing.rid !== payload.rid
      || existing.daemonPublicKey !== payload.daemonPublicKey
      || existing.code !== payload.code);
  return { relayHost, fingerprint, replacesExisting };
}

/** Hold a relay pairing for this page. */
export function storeRelayPairing(payload: RelayPairingPayload): void {
  const held = heldPairing;
  if (held !== null && held.relayUrl === payload.relayUrl && held.rid === payload.rid
    && held.daemonPublicKey === payload.daemonPublicKey && held.code === payload.code) return;
  heldPairing = payload;
  noteRelayPairingChanged();
}

/** Forget the relay pairing: this page no longer has a relay route to any daemon. */
export function clearStoredRelayPairing(): void {
  if (heldPairing === null) return;
  heldPairing = null;
  noteRelayPairingChanged();
}
