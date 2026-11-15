/**
 * Failure policy and failure record types.
 */
import { randomInt } from 'node:crypto';

export type AutomationFailureAction = 'retry' | 'cooldown' | 'disable' | 'dead_letter';
export type AutomationRetryStrategy = 'fixed' | 'linear' | 'exponential';

export interface AutomationRetryPolicy {
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly strategy: AutomationRetryStrategy;
  readonly maxDelayMs?: number | undefined;
  readonly jitterMs?: number | undefined;
}

/** Delay before try number `attempt + 1`, after `attempt` tries have failed (1-based). */
export function calculateRetryDelay(baseDelayMs: number, attempt: number, strategy: AutomationRetryStrategy, maxDelayMs?: number, jitterMs?: number): number {
  const multiplier = strategy === 'fixed' ? 1 : strategy === 'linear' ? attempt : Math.pow(2, attempt - 1);
  const base = baseDelayMs * multiplier;
  const jitter = jitterMs ? randomInt(0, Math.max(1, Math.floor(jitterMs) + 1)) : 0;
  return Math.min(base + jitter, maxDelayMs ?? Number.MAX_SAFE_INTEGER);
}

export interface AutomationFailurePolicy {
  readonly action: AutomationFailureAction;
  readonly maxConsecutiveFailures: number;
  readonly cooldownMs: number;
  readonly retryPolicy: AutomationRetryPolicy;
  readonly deadLetterRouteId?: string | undefined;
  readonly disableAfterFailures?: boolean | undefined;
  readonly notifyRouteId?: string | undefined;
}

export interface AutomationFailureRecord {
  readonly id: string;
  readonly jobId: string;
  readonly runId?: string | undefined;
  readonly occurredAt: number;
  readonly reason: string;
  readonly action: AutomationFailureAction;
  readonly consecutiveFailures: number;
  readonly autoDisabled: boolean;
  readonly deadLetterRouteId?: string | undefined;
  readonly metadata: Record<string, unknown>;
}
