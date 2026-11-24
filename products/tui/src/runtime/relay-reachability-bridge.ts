/**
 * relay-reachability-bridge.ts, the relay's live state and pairing payload, as
 * the adopted daemon reports them.
 *
 * The relay is a DAEMON capability: the reachability controller is composed
 * inside the platform's `DaemonServer` and is the process that registers with
 * the relay and can mint a pairing payload. This terminal is a client, so it
 * asks the daemon through the operator verbs that serve that controller,
 * `relay.reachability.get` and `relay.pairing.mint`, and the per-device relay
 * codes, `relay.codes.list` and `relay.codes.revoke` (one request per /devices relay action).
 *
 * `'unavailable'` is kept for exactly one case: the daemon could not be asked
 * (disabled, unreachable, refused). It is deliberately NOT `'disabled'`, which is
 * the daemon's own answer meaning a relay gate is off; the reason the daemon
 * could not be asked travels with it so /devices can say it.
 */

import type { RelayRegistrationStatus } from '@goodvibes/engine/daemon-api';
import { encodeRelayPairingString, type RelayPairingPayload } from '@goodvibes/engine/transport-core/relay';
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import { mintRelayPairingInOneRun, type RelayTurnOnAnswer } from '@goodvibes/engine/terminal-shell/relay-pairing-ask';

/**
 * What /devices relay-status can be told: the daemon-side registration states, plus
 * `'disabled'` for a relay that is off, `'failed'` when the daemon's last start
 * of the registration failed (the refusal says why), and `'unavailable'` when
 * the daemon could not be asked.
 */
export type RelayReadableStatus = RelayRegistrationStatus | 'disabled' | 'failed' | 'unavailable';

/** Why the relay refused the daemon's registration, as the daemon reports it. */
export interface RelayRefusal {
  readonly code: string;
  readonly message: string;
  readonly state: string;
  readonly next: readonly string[];
  /** False when the daemon has stopped dialling (status `refused`) until the relay settings or identity change. */
  readonly retryable: boolean;
}

/** The relay state with, when it could not be read, why. */
export interface RelayStatusReading {
  readonly status: RelayReadableStatus;
  /** Set only for `'unavailable'`: why the daemon could not be asked. */
  readonly reason?: string;
  /** The id the daemon is registered under (derived from its identity key), while a registration runs. */
  readonly rendezvousId?: string;
  /** Set when the relay refused the registration: what is true and what to do. */
  readonly refusal?: RelayRefusal;
}

/** A minted pairing payload, in both the structured and the scannable form, with the relay code it carries. */
export interface RelayPairingMint {
  readonly payload: RelayPairingPayload;
  readonly encoded: string;
  /** The id and name of the device's relay code, for /devices relay-codes and /devices relay-revoke. */
  readonly codeId?: string;
  readonly codeName?: string;
}

/** One relay code as the daemon lists it (never the code itself). */
export interface RelayCodeView {
  readonly id: string;
  readonly name: string;
  readonly createdAt: number;
  readonly lastSeenAt?: number;
}

/** The daemon's relay codes, or why it could not be asked. */
export type RelayCodesReading =
  | { readonly codes: readonly RelayCodeView[] }
  | { readonly codes: null; readonly reason: string };

/** The outcome of revoking one relay code. */
export type RelayCodeRevokeReading =
  | { readonly revoked: true; readonly id: string }
  | { readonly revoked: false; readonly reason: string };

/** The outcome of asking the daemon for a pairing payload. */
export type RelayPairingReading =
  | { readonly minted: RelayPairingMint }
  /** The daemon answered: there is no live registration to pair against yet. */
  | { readonly minted: null; readonly status: RelayReadableStatus }
  /** The daemon could not be asked. */
  | { readonly minted: null; readonly status: 'unavailable'; readonly reason: string };

export interface RelayReadAccessors {
  relayStatus(): Promise<RelayStatusReading>;
  /**
   * Mint a pairing for one device in one run; `name` labels its relay code. With `ask`, a relay that is
   * off is put to the person first (terminal-shell/relay-pairing-ask.ts); a yes turns it on (with the
   * address typed when none is set) and the same `relay.pairing.mint` call waits for the host to register.
   */
  mintRelayPairing(name?: string, options?: { readonly ask?: ((configuredUrl: string) => Promise<RelayTurnOnAnswer>) | undefined; readonly configuredUrl?: string | undefined }): Promise<RelayPairingReading>;
  listRelayCodes(): Promise<RelayCodesReading>;
  revokeRelayCode(id: string): Promise<RelayCodeRevokeReading>;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const KNOWN_STATUSES: ReadonlySet<string> = new Set(['disabled', 'failed', 'idle', 'connecting', 'registered', 'reconnecting', 'refused', 'stopped']);

function statusOf(value: unknown): RelayReadableStatus {
  return typeof value === 'string' && KNOWN_STATUSES.has(value) ? value as RelayReadableStatus : 'unavailable';
}

function refusalOf(value: unknown): RelayRefusal | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.code !== 'string' || typeof record.state !== 'string') return undefined;
  return {
    code: record.code,
    message: typeof record.message === 'string' ? record.message : '',
    state: record.state,
    next: Array.isArray(record.next) ? record.next.filter((step): step is string => typeof step === 'string') : [],
    retryable: record.retryable !== false,
  };
}

function isPairingPayload(value: unknown): value is RelayPairingPayload {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.protocol === 'number' && typeof record.relayUrl === 'string'
    && typeof record.rid === 'string' && typeof record.daemonPublicKey === 'string' && typeof record.code === 'string';
}

function relayCodeOf(value: unknown): RelayCodeView | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string' || typeof record.name !== 'string' || typeof record.createdAt !== 'number') return null;
  return { id: record.id, name: record.name, createdAt: record.createdAt, ...(typeof record.lastSeenAt === 'number' ? { lastSeenAt: record.lastSeenAt } : {}) };
}

/** The two relay accessors, spread into `externalServices` from bootstrap.ts. */
export function createRelayReadAccessors(verbs: DaemonVerbCaller): RelayReadAccessors {
  return {
    async relayStatus() {
      try {
        const answer = await verbs.invoke<{ status?: unknown; rendezvousId?: unknown; refusal?: unknown }>('relay.reachability.get', {});
        const refusal = refusalOf(answer?.refusal);
        const rendezvousId = typeof answer?.rendezvousId === 'string' && answer.rendezvousId ? answer.rendezvousId : undefined;
        return { status: statusOf(answer?.status), ...(rendezvousId ? { rendezvousId } : {}), ...(refusal ? { refusal } : {}) };
      } catch (error) {
        return { status: 'unavailable', reason: failureReason(error) };
      }
    },
    async mintRelayPairing(name, options = {}) {
      try {
        const answer = await mintRelayPairingInOneRun<{ pairing: unknown; status: string; codeId?: string; codeName?: string }>(
          <T>(method: string, input: Record<string, unknown>) => verbs.invoke<T>(method, input),
          { name, configuredUrl: options.configuredUrl, ask: options.ask },
        );
        if (isPairingPayload(answer?.pairing)) {
          return { minted: {
            payload: answer.pairing, encoded: encodeRelayPairingString(answer.pairing),
            ...(typeof answer.codeId === 'string' ? { codeId: answer.codeId } : {}),
            ...(typeof answer.codeName === 'string' ? { codeName: answer.codeName } : {}),
          } };
        }
        return { minted: null, status: statusOf(answer?.status) };
      } catch (error) {
        return { minted: null, status: 'unavailable', reason: failureReason(error) };
      }
    },
    async listRelayCodes() {
      try {
        const answer = await verbs.invoke<{ codes?: unknown }>('relay.codes.list', {});
        const codes = Array.isArray(answer?.codes) ? answer.codes.map(relayCodeOf).filter((code): code is RelayCodeView => code !== null) : [];
        return { codes };
      } catch (error) {
        return { codes: null, reason: failureReason(error) };
      }
    },
    async revokeRelayCode(id) {
      try {
        await verbs.invoke('relay.codes.revoke', { id });
        return { revoked: true, id };
      } catch (error) {
        return { revoked: false, reason: failureReason(error) };
      }
    },
  };
}
