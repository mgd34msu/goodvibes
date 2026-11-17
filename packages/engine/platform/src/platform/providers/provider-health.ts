/**
 * What the provider calls of this process have shown about each provider: a
 * provider whose last call failed on its credentials, its rate limit or its
 * availability carries that status until a later call succeeds (or, for a
 * transient fault, until a short window passes). Every provider call goes
 * through `instrumentedLlmCall`, which is the one writer; the route planner,
 * the optimizer and the health views read it through `ProviderRegistry.health()`.
 */
import { classifyFailure } from '@goodvibes-jev/engine/errors';

/** Health status for a single provider. */
export type ProviderStatus =
  | 'unknown'
  | 'healthy'
  | 'degraded'
  | 'rate_limited'
  | 'auth_error'
  | 'unavailable';

/** Aggregate health summary across all providers. */
export type CompositeHealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';

export interface ProviderHealthEntry {
  readonly status: ProviderStatus;
  /** Epoch ms the status was set. */
  readonly since: number;
  /** Epoch ms after which the status no longer holds; absent while it holds until a call succeeds. */
  readonly until?: number | undefined;
  /** Why, in a few words (the failure category or the startup reason). */
  readonly reason: string;
}

/** How long a network, server or timeout failure keeps a provider out of routes before it is tried again. */
const TRANSIENT_HOLD_MS = 60_000;

const entries = new Map<string, ProviderHealthEntry>();

/**
 * Record the outcome of one provider call. A success clears the provider's
 * status; a failure sets it from the failure's category. A failure that says
 * nothing about the provider (a bad request, a cancellation) changes nothing.
 * An ordinary success with nothing recorded costs one map lookup.
 */
export function recordProviderCallOutcome(providerId: string, error?: unknown, now: number = Date.now()): void {
  if (error === undefined) {
    if (entries.size > 0) entries.delete(providerId);
    return;
  }
  const failure = classifyFailure(error);
  if (!failure) return;
  switch (failure.category) {
    case 'authentication':
    case 'authorization':
      entries.set(providerId, { status: 'auth_error', since: now, reason: failure.category });
      return;
    case 'billing':
      entries.set(providerId, { status: 'unavailable', since: now, reason: 'billing' });
      return;
    case 'rate_limit':
      entries.set(providerId, { status: 'rate_limited', since: now, until: now + (failure.retryAfterMs ?? TRANSIENT_HOLD_MS), reason: 'rate_limit' });
      return;
    case 'network':
    case 'timeout':
    case 'service':
      entries.set(providerId, { status: 'unavailable', since: now, until: now + TRANSIENT_HOLD_MS, reason: failure.category });
      return;
    default:
      return;
  }
}

/** Forget what was recorded for a provider: its registration (credentials, endpoint) was replaced. */
export function clearProviderHealth(providerId: string): void {
  entries.delete(providerId);
}

/** The statuses that still hold, keyed by provider id. Expired entries are dropped as they are read. */
export function readProviderHealth(now: number = Date.now()): Map<string, ProviderHealthEntry> {
  const current = new Map<string, ProviderHealthEntry>();
  for (const [providerId, entry] of entries) {
    if (entry.until !== undefined && entry.until <= now) {
      entries.delete(providerId);
      continue;
    }
    current.set(providerId, entry);
  }
  return current;
}
