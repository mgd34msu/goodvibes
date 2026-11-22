/**
 * What the provider calls of this process have shown about each provider: a
 * provider whose last call failed on its credentials, its rate limit or its
 * availability carries that status until a later call succeeds or its hold
 * ends, whichever comes first. Every hold ends: routed work never picks a
 * provider while it holds, so a success alone could never clear it, and a
 * provider fixed outside this process (a key renewed, a bill paid, a local
 * server started) is tried again. Every provider call goes through
 * `instrumentedLlmCall`, which writes call outcomes; the startup model-list
 * sweep writes the providers it could not reach. The route planner, the
 * optimizer and the health views read it through `ProviderRegistry.health()`.
 */
import { classifyFailure } from '@goodvibes/engine/errors';

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
  /** Epoch ms after which the status no longer holds and the provider is tried again. */
  readonly until?: number | undefined;
  /** Why, in a few words (the failure category or the startup reason). */
  readonly reason: string;
}

/** How long a network, server or timeout failure keeps a provider out of routes before it is tried again. */
const TRANSIENT_HOLD_MS = 60_000;
/**
 * How long a credential, billing or startup-unreachable failure keeps a
 * provider out of routes. Longer than a transient fault, since these are
 * usually fixed by a person, but bounded so the fix is noticed without a restart.
 */
const RECHECK_HOLD_MS = 10 * 60_000;

const entries = new Map<string, ProviderHealthEntry>();

/** Callers waiting for the next change of what is recorded (nextProviderHealthChange). */
const waiters = new Set<() => void>();

function changed(): void {
  if (waiters.size === 0) return;
  for (const wake of [...waiters]) wake();
}

/**
 * Resolves the next time what is recorded changes: a provider's status set,
 * replaced or cleared, or a hold reaching the end it was given when it was
 * set. Rejects with the signal's reason when `signal` aborts first.
 */
export function nextProviderHealthChange(signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const holdEnds = [...entries.values()].flatMap((entry) => (entry.until === undefined ? [] : [entry.until]));
    const firstEnd = holdEnds.length === 0 ? undefined : Math.min(...holdEnds);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      waiters.delete(wake);
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
    };
    const wake = (): void => { finish(); resolve(); };
    const aborted = (): void => { finish(); reject(signal!.reason); };
    waiters.add(wake);
    signal?.addEventListener('abort', aborted, { once: true });
    if (firstEnd !== undefined) {
      // The earliest hold ends at the time it was given: then the provider is tried again.
      timer = setTimeout(wake, Math.max(0, firstEnd - Date.now()));
      (timer as { unref?: () => void }).unref?.();
    }
  });
}

/**
 * Record the outcome of one provider call. A success clears the provider's
 * status; a failure sets it from the failure's category. A failure that says
 * nothing about the provider (a bad request, a cancellation) changes nothing.
 * An ordinary success with nothing recorded costs one map lookup.
 */
export function recordProviderCallOutcome(providerId: string, error?: unknown, now: number = Date.now()): void {
  if (error === undefined) {
    if (entries.size > 0 && entries.delete(providerId)) changed();
    return;
  }
  const failure = classifyFailure(error);
  if (!failure) return;
  switch (failure.category) {
    case 'authentication':
    case 'authorization':
      entries.set(providerId, { status: 'auth_error', since: now, until: now + RECHECK_HOLD_MS, reason: failure.category });
      break;
    case 'billing':
      entries.set(providerId, { status: 'unavailable', since: now, until: now + RECHECK_HOLD_MS, reason: 'billing' });
      break;
    case 'rate_limit':
      entries.set(providerId, { status: 'rate_limited', since: now, until: now + (failure.retryAfterMs ?? TRANSIENT_HOLD_MS), reason: 'rate_limit' });
      break;
    case 'network':
    case 'timeout':
    case 'service':
      entries.set(providerId, { status: 'unavailable', since: now, until: now + TRANSIENT_HOLD_MS, reason: failure.category });
      break;
    default:
      return;
  }
  changed();
}

/**
 * Record a provider whose model listing failed in the startup sweep. A status
 * a call already recorded is kept (it is newer evidence); a later successful
 * call clears this one like any other.
 */
export function recordProviderUnreachable(providerId: string, reason: string, now: number = Date.now()): void {
  if (entries.has(providerId)) return;
  entries.set(providerId, { status: 'unavailable', since: now, until: now + RECHECK_HOLD_MS, reason });
  changed();
}

/** Forget what was recorded for a provider: its registration (credentials, endpoint) was replaced. */
export function clearProviderHealth(providerId: string): void {
  if (entries.delete(providerId)) changed();
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
