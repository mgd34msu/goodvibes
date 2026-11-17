/**
 * useRelayPairingHandoff, turn a `#relay=<gvrelay1.…>` fragment into a stored relay
 * pairing for this device.
 *
 * Companion to usePairingHandoff (the `#pair=<token>` operator-token flow) but for a
 * DIFFERENT payload with a different job: a relay pairing carries no identity, just the
 * transport bootstrap (relay URL, rendezvous id, daemon public key, see
 * lib/relay-pairing.ts's header) that lets this device reach the daemon through the
 * relay when it cannot reach it directly. Storing it does not sign anyone in; the
 * existing token pairing/paste flow still handles authentication on top.
 *
 * Same capture-before-effect discipline as usePairingHandoff, and for the same reason:
 * useUrlState's own mount effect normalizes a bare URL and drops the fragment, so the
 * token/pairing MUST be read at module/render-init time, before any effect can run.
 *
 * A relay pairing routes this browser's requests (bearer token included) to whichever
 * daemon holds the pinned key, so a link must never store itself. Decoding is offline;
 * the decoded pairing is held as a pending offer (`status` 'pending', with `pairing`)
 * until the caller invokes `confirm()`, which is the only path that stores it.
 * `dismiss()` drops the offer. A link for the pairing this device already holds changes
 * nothing, so it reads as 'stored' at once and asks nothing. `status` is 'idle' until a
 * fragment is present, 'stored' once confirmed (or already held), or 'error' when the
 * fragment was malformed.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  decodeRelayPairingCode,
  getStoredRelayPairing,
  parseRelayPairingFromHash,
  storeRelayPairing,
  stripRelayPairingFragment,
  type RelayPairingPayload,
} from '../lib/relay-pairing';

export type RelayPairingHandoffStatus = 'idle' | 'pending' | 'stored' | 'error';

export interface RelayPairingHandoff {
  status: RelayPairingHandoffStatus;
  error: unknown;
  /** The offered pairing while 'pending', the stored one once 'stored'. */
  pairing: RelayPairingPayload | null;
  /** Store the pending offer. No-op unless 'pending'. */
  confirm: () => void;
  /** Drop the pending offer without storing anything. */
  dismiss: () => void;
}

type RelayOutcome =
  | { readonly status: 'pending'; readonly pairing: RelayPairingPayload }
  | { readonly status: 'stored'; readonly pairing: RelayPairingPayload }
  | { readonly status: 'dismissed' }
  | { readonly status: 'error'; readonly error: unknown };

// `outcome` is the remembered result of the hand-off; a remount reports it instead of
// reading as idle, and never decodes the code a second time.
const capture: { done: boolean; outcome: RelayOutcome | null; code: string | null } = { done: false, outcome: null, code: null };

function captureRelayPairingCode(): string | null {
  if (!capture.done) {
    capture.done = true;
    capture.code = typeof window !== 'undefined'
      ? parseRelayPairingFromHash(window.location.hash)
      : null;
    if (capture.code !== null) stripRelayPairingFragment();
  }
  return capture.code;
}

/** Test-only: reset the module-level capture between cases. */
export function resetRelayPairingCaptureForTest(): void {
  capture.done = false;
  capture.outcome = null;
  capture.code = null;
}

/** Decode the captured code into a pending offer, at most once per capture. Stores nothing. */
function offerRelayPairingCode(code: string): RelayOutcome {
  if (capture.outcome !== null) return capture.outcome;
  let outcome: RelayOutcome;
  try {
    const pairing = decodeRelayPairingCode(code);
    const held = getStoredRelayPairing();
    const alreadyHeld = held !== null && held.relayUrl === pairing.relayUrl
      && held.rid === pairing.rid && held.daemonPublicKey === pairing.daemonPublicKey;
    outcome = { status: alreadyHeld ? 'stored' : 'pending', pairing };
  } catch (error) {
    outcome = { status: 'error', error };
  }
  capture.outcome = outcome;
  return outcome;
}

function viewOf(outcome: RelayOutcome | null): { status: RelayPairingHandoffStatus; error: unknown; pairing: RelayPairingPayload | null } {
  if (outcome === null || outcome.status === 'dismissed') return { status: 'idle', error: null, pairing: null };
  if (outcome.status === 'error') return { status: 'error', error: outcome.error, pairing: null };
  return { status: outcome.status, error: null, pairing: outcome.pairing };
}

export function useRelayPairingHandoff(): RelayPairingHandoff {
  const [code] = useState(captureRelayPairingCode);
  const [view, setView] = useState(() => viewOf(capture.outcome));

  useEffect(() => {
    if (code === null) return;
    setView(viewOf(offerRelayPairingCode(code)));
    // Mount-once: the code was captured synchronously above; a later hash change is not
    // a new hand-off.
  }, [code]);

  const confirm = useCallback(() => {
    const outcome = capture.outcome;
    if (outcome?.status !== 'pending') return;
    storeRelayPairing(outcome.pairing);
    capture.outcome = { status: 'stored', pairing: outcome.pairing };
    setView(viewOf(capture.outcome));
  }, []);

  const dismiss = useCallback(() => {
    if (capture.outcome?.status !== 'pending') return;
    capture.outcome = { status: 'dismissed' };
    setView(viewOf(capture.outcome));
  }, []);

  return { ...view, confirm, dismiss };
}
