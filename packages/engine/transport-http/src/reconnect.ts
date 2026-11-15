import { computeBackoffDelay, normalizeBackoffPolicy, type BackoffPolicy, type ResolvedBackoffPolicy } from './backoff.js';

export interface StreamReconnectPolicy extends BackoffPolicy {
  readonly enabled?: boolean | undefined;
}

export interface ResolvedStreamReconnectPolicy extends ResolvedBackoffPolicy {
  readonly enabled: boolean;
}

/**
 * Reconnect attempts when reconnect is on and the caller sets no limit: none.
 * The daemon is a long-lived local service that comes back after a restart or
 * a sleep, the delay between attempts is capped, and a failure no retry can
 * clear (a refused credential) ends the stream at once; closing the stream is
 * how a caller gives up.
 */
export const DEFAULT_STREAM_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;

/**
 * Off for a raw stream opened directly; the runtime-event connectors turn it
 * on unless their caller turns it off.
 */
export const DEFAULT_STREAM_RECONNECT_POLICY: ResolvedStreamReconnectPolicy = {
  enabled: false,
  maxAttempts: DEFAULT_STREAM_MAX_ATTEMPTS,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  backoffFactor: 2,
};

export function normalizeStreamReconnectPolicy(
  policy?: StreamReconnectPolicy,
): ResolvedStreamReconnectPolicy {
  const normalized = normalizeBackoffPolicy(policy, DEFAULT_STREAM_RECONNECT_POLICY);
  return {
    ...normalized,
    enabled: policy?.enabled ?? DEFAULT_STREAM_RECONNECT_POLICY.enabled,
  };
}

export function getStreamReconnectDelay(
  attempt: number,
  policy: ResolvedStreamReconnectPolicy,
): number {
  // Attempts are unlimited by default; past this the delay is maxDelayMs anyway,
  // and a larger exponent would overflow to Infinity (0 * Infinity is NaN).
  return computeBackoffDelay(Math.min(attempt, 64), policy);
}
