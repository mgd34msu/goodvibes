/**
 * Delivery policy and delivery-attempt types.
 */

import type { AutomationRetryPolicy } from './failures.js';
import type { AutomationSurfaceKind } from './types.js';

export type AutomationDeliveryMode = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface AutomationDeliveryTarget {
  readonly kind: AutomationDeliveryMode;
  readonly surfaceKind?: AutomationSurfaceKind | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export interface AutomationDeliveryPolicy {
  readonly mode: AutomationDeliveryMode;
  readonly targets: readonly AutomationDeliveryTarget[];
  readonly fallbackTargets: readonly AutomationDeliveryTarget[];
  readonly includeSummary: boolean;
  readonly includeLinks: boolean;
  readonly replyToRouteId?: string | undefined;
}

export interface AutomationDeliveryAttempt {
  readonly id: string;
  readonly runId: string;
  readonly jobId: string;
  readonly target: AutomationDeliveryTarget;
  readonly status: 'pending' | 'sending' | 'sent' | 'failed' | 'dead_lettered';
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly error?: string | undefined;
  readonly responseId?: string | undefined;
}

/**
 * How often a message to one target is tried. It is separate from a job's
 * retry policy, which decides whether the job's work runs again: a job that
 * must not re-run an expensive task still gets its message delivered through a
 * brief outage.
 */
export const AUTOMATION_DELIVERY_RETRY_POLICY: AutomationRetryPolicy = Object.freeze({
  maxAttempts: 3,
  delayMs: 1_000,
  strategy: 'exponential',
  maxDelayMs: 10_000,
  jitterMs: 250,
});
