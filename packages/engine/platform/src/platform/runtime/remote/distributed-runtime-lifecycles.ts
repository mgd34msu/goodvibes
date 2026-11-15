import { defineLifecycle, type LifecycleCheck } from '../../utils/lifecycle-machine.js';
import type { DistributedPeerStatus, DistributedWorkStatus } from './distributed-runtime-types.js';

/**
 * Remote work. A peer claims queued work and settles it. A lease that runs out
 * puts claimed work back in the queue, and the peer that held it may still
 * report it from there: a report that lands after its lease lapsed is a real
 * result, not a stale one, so queued work may settle directly. Work that
 * outlives its timeout, or keeps losing its lease, expires. The settled states
 * are final, so a second report cannot overwrite the first, and a report on
 * work an operator cancelled cannot revive it.
 */
export const distributedWorkLifecycle = defineLifecycle<DistributedWorkStatus>('remote work', {
  queued: ['claimed', 'completed', 'failed', 'cancelled', 'expired'],
  claimed: ['queued', 'completed', 'failed', 'cancelled', 'expired'],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
});

/**
 * Remote peer presence. Presence moves freely between the live states; only
 * revocation is sticky. A revoked peer has no usable token, so nothing it or
 * the lease clock does may present it as reachable again; it leaves `revoked`
 * only when a new token is issued to it.
 */
export const distributedPeerLifecycle = defineLifecycle<DistributedPeerStatus>('remote peer', {
  paired: ['connected', 'idle', 'disconnected', 'revoked'],
  connected: ['connected', 'idle', 'disconnected', 'revoked'],
  idle: ['connected', 'idle', 'disconnected', 'revoked'],
  disconnected: ['connected', 'idle', 'disconnected', 'revoked'],
  revoked: ['paired'],
});

/** The status a peer ends up in when a writer asks for `to`: `to` when legal, otherwise unchanged. */
/** The sentence a refusal carries; a legal move has none. */
export function refusalReason<S extends string>(check: LifecycleCheck<S>): string {
  return check.ok ? `${check.from} can become ${check.to}` : check.reason;
}

export function nextDistributedPeerStatus(current: DistributedPeerStatus, to: DistributedPeerStatus): DistributedPeerStatus {
  return current === to || distributedPeerLifecycle.can(current, to) ? to : current;
}

/**
 * A move the remote runtime refused because of the record's current state.
 * `status` is the HTTP status a route should answer with; the message names
 * the current state, why, and what the caller can do instead.
 */
export class DistributedRuntimeRefusalError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status = 409) {
    super(message);
    this.name = 'DistributedRuntimeRefusalError';
    this.code = code;
    this.status = status;
  }
}
