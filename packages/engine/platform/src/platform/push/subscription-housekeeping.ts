/**
 * push/subscription-housekeeping.ts, which stored push subscriptions are dead.
 *
 * The owner's ruling of 2026-07-26: "as long as it is transparent to the user
 * and the user never has to resubscribe or anything like that and everything
 * keeps working, it's fine. otherwise it needs to remain unbounded. i want zero
 * friction."
 *
 * So a subscription is removed ONLY on evidence that it is already dead:
 *
 *  - `gone`             , the push service answered 404 or 410 for it.
 *  - `failure-threshold`, the push service itself rejected the endpoint (a 4xx
 *                          other than 404, 408, 410, 413 and 429) for at least
 *                          `failureThreshold` consecutive deliveries. A network
 *                          error, a timeout, a rate limit or a 5xx says nothing
 *                          about the endpoint and never counts.
 *  - `unusable`         , its own endpoint/key material fails the content
 *                          validation registration applies, so no delivery to
 *                          it could ever succeed (records stored before that
 *                          validation existed).
 *  - `malformed`        , the record is torn or missing required fields; it
 *                          cannot be addressed at all.
 *
 * There is NO age TTL and no cap: a quiet device that still works keeps
 * working, forever, without the operator resubscribing. The per-principal
 * count is a WARNING line only.
 *
 * Every read leaves dead records out of its result, and the store drops them
 * from the file in whichever write happens next (a registration, a delete, the
 * outcome stamp of a delivery), keeping the latest removal per principal so
 * `push.subscriptions.list` can say why a device stopped receiving.
 */

import { describeSubscriptionProblem } from './subscription-validation.js';
import type { StoredPushSubscription } from './types.js';

/** Why a subscription left the store. Every value is evidence-backed. */
export type PushSubscriptionRemovalReason = 'gone' | 'failure-threshold' | 'unusable' | 'malformed';

/** One removal, with the evidence that the subscription was dead. */
export interface PushSubscriptionRemoval {
  readonly subscriptionId: string;
  readonly principalId: string;
  /** Origin only, the full endpoint is a capability URL and stays off the wire. */
  readonly endpointOrigin: string;
  readonly reason: PushSubscriptionRemovalReason;
  /** Plain-language proof this record could not have received a push. */
  readonly evidence: string;
  readonly removedAt: number;
}

/** The knobs the store reads; the composition root fills them from config. */
export interface PushSubscriptionPolicy {
  /** Per-principal count above which a registration logs a warning. Never a cap. */
  readonly warnAbovePerPrincipal: number;
  /** Consecutive push-service rejections after which the endpoint is dead. */
  readonly failureThreshold: number;
}

/** Stock policy: 50 devices before a warning, 5 consecutive rejections. */
export const DEFAULT_PUSH_SUBSCRIPTION_POLICY: PushSubscriptionPolicy = {
  warnAbovePerPrincipal: 50,
  failureThreshold: 5,
};

/** The result of judging a loaded record set: what survives and what is proven dead. */
export interface PushRecordsDecision {
  readonly kept: StoredPushSubscription[];
  readonly removed: PushSubscriptionRemoval[];
}

export function endpointOriginOf(endpoint: unknown): string {
  if (typeof endpoint !== 'string') return 'unknown';
  try {
    return new URL(endpoint).origin;
  } catch {
    return 'invalid';
  }
}

function isRecordShaped(value: unknown): value is StoredPushSubscription {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Partial<StoredPushSubscription>;
  return typeof record.id === 'string'
    && record.id.length > 0
    && typeof record.principalId === 'string'
    && record.principalId.length > 0
    && typeof record.endpoint === 'string'
    && record.keys !== null
    && typeof record.keys === 'object';
}

/** A removal record for a subscription that is being dropped. */
export function removalOf(
  record: Pick<StoredPushSubscription, 'id' | 'principalId' | 'endpoint'>,
  reason: PushSubscriptionRemovalReason,
  evidence: string,
  now: number,
): PushSubscriptionRemoval {
  return {
    subscriptionId: record.id,
    principalId: record.principalId,
    endpointOrigin: endpointOriginOf(record.endpoint),
    reason,
    evidence,
    removedAt: now,
  };
}

/**
 * Decide, from content alone, which loaded records are provably dead. Pure and
 * deterministic: running it over its own `kept` removes nothing.
 */
export function findDeadPushRecords(
  loaded: readonly unknown[],
  policy: PushSubscriptionPolicy,
  now: number,
): PushRecordsDecision {
  const kept: StoredPushSubscription[] = [];
  const removed: PushSubscriptionRemoval[] = [];

  for (const entry of loaded) {
    if (!isRecordShaped(entry)) {
      const partial = (entry ?? {}) as Partial<StoredPushSubscription>;
      removed.push({
        subscriptionId: typeof partial.id === 'string' ? partial.id : '(no id)',
        principalId: typeof partial.principalId === 'string' ? partial.principalId : '(unknown)',
        endpointOrigin: endpointOriginOf(partial.endpoint),
        reason: 'malformed',
        evidence: 'record is missing the id / principal / endpoint / keys it needs to be addressed at all',
        removedAt: now,
      });
      continue;
    }
    const problem = describeSubscriptionProblem({ endpoint: entry.endpoint, keys: entry.keys });
    if (problem) {
      removed.push(removalOf(entry, 'unusable', `${problem.field}: ${problem.reason}, no delivery to this record could ever succeed`, now));
      continue;
    }
    const failures = entry.consecutiveFailures ?? 0;
    if (failures >= policy.failureThreshold) {
      removed.push(removalOf(entry, 'failure-threshold', `the push service rejected ${failures} consecutive deliveries (bound ${policy.failureThreshold})`, now));
      continue;
    }
    kept.push(entry);
  }

  return { kept, removed };
}
