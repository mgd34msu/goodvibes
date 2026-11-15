/**
 * relay-reachability-bridge.ts, the relay's live state and pairing payload, as
 * the adopted daemon reports them.
 *
 * The relay is a DAEMON capability: the reachability controller is composed
 * inside the platform's `DaemonServer` and is the process that registers with
 * the relay and can mint a pairing payload. This terminal is a client, so it
 * asks the daemon through the two operator verbs that serve that controller,
 * `relay.reachability.get` and `relay.pairing.mint` (one request per `/relay`).
 *
 * `'unavailable'` is kept for exactly one case: the daemon could not be asked
 * (disabled, unreachable, refused). It is deliberately NOT `'disabled'`, which is
 * the daemon's own answer meaning a relay gate is off; the reason the daemon
 * could not be asked travels with it so `/relay` can say it.
 */

import type { RelayRegistrationStatus } from '@goodvibes-jev/engine/daemon-api';
import { encodeRelayPairingString, type RelayPairingPayload } from '@goodvibes-jev/engine/transport-core/relay';
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';

/**
 * What `/relay` can be told: the daemon-side registration states, plus
 * `'disabled'` for a relay that is off, plus `'unavailable'` when the daemon
 * could not be asked.
 */
export type RelayReadableStatus = RelayRegistrationStatus | 'disabled' | 'unavailable';

/** The relay state with, when it could not be read, why. */
export interface RelayStatusReading {
  readonly status: RelayReadableStatus;
  /** Set only for `'unavailable'`: why the daemon could not be asked. */
  readonly reason?: string;
}

/** A minted pairing payload, in both the structured and the scannable form. */
export interface RelayPairingMint {
  readonly payload: RelayPairingPayload;
  readonly encoded: string;
}

/** The outcome of asking the daemon for a pairing payload. */
export type RelayPairingReading =
  | { readonly minted: RelayPairingMint }
  /** The daemon answered: there is no live registration to pair against yet. */
  | { readonly minted: null; readonly status: RelayReadableStatus }
  /** The daemon could not be asked. */
  | { readonly minted: null; readonly status: 'unavailable'; readonly reason: string };

export interface RelayReadAccessors {
  relayStatus(): Promise<RelayStatusReading>;
  mintRelayPairing(): Promise<RelayPairingReading>;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['disabled', 'idle', 'connecting', 'registered', 'reconnecting', 'stopped']);

function statusOf(value: unknown): RelayReadableStatus {
  return typeof value === 'string' && KNOWN_STATUSES.has(value) ? value as RelayReadableStatus : 'unavailable';
}

function isPairingPayload(value: unknown): value is RelayPairingPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.protocol === 'number' && typeof record.relayUrl === 'string'
    && typeof record.rid === 'string' && typeof record.daemonPublicKey === 'string';
}

/** The two relay accessors, spread into `externalServices` from bootstrap.ts. */
export function createRelayReadAccessors(verbs: DaemonVerbCaller): RelayReadAccessors {
  return {
    async relayStatus() {
      try {
        const answer = await verbs.invoke<{ status?: unknown }>('relay.reachability.get', {});
        return { status: statusOf(answer?.status) };
      } catch (error) {
        return { status: 'unavailable', reason: failureReason(error) };
      }
    },
    async mintRelayPairing() {
      try {
        const answer = await verbs.invoke<{ pairing?: unknown; status?: unknown }>('relay.pairing.mint', {});
        if (isPairingPayload(answer?.pairing)) {
          return { minted: { payload: answer.pairing, encoded: encodeRelayPairingString(answer.pairing) } };
        }
        return { minted: null, status: statusOf(answer?.status) };
      } catch (error) {
        return { minted: null, status: 'unavailable', reason: failureReason(error) };
      }
    },
  };
}
