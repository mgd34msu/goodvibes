/**
 * Delivery domain state, outbound delivery attempts and their outcomes.
 */

import type { AutomationDeliveryAttempt } from '../../../automation/delivery.js';

export interface DeliveryDomainState {
  readonly revision: number;
  readonly lastUpdatedAt: number;
  readonly source: string;
  readonly deliveryAttempts: Map<string, AutomationDeliveryAttempt>;
  readonly attemptIds: string[];
  readonly pendingAttemptIds: string[];
  readonly failedAttemptIds: string[];
  readonly deadLetterIds: string[];
  readonly totalQueued: number;
  readonly totalStarted: number;
  readonly totalSucceeded: number;
  readonly totalFailed: number;
  readonly totalDeadLettered: number;
  /** What finished attempts dropped from `deliveryAttempts` (the registry is bounded) contributed to the totals above, so the totals keep counting them. */
  readonly retiredAttempts?: RetiredAttemptCounts | undefined;
}

export interface RetiredAttemptCounts {
  readonly queued: number;
  readonly started: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly deadLettered: number;
}

export function createInitialDeliveryState(): DeliveryDomainState {
  return {
    revision: 0,
    lastUpdatedAt: 0,
    source: 'init',
    deliveryAttempts: new Map(),
    attemptIds: [],
    pendingAttemptIds: [],
    failedAttemptIds: [],
    deadLetterIds: [],
    totalQueued: 0,
    totalStarted: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    totalDeadLettered: 0,
  };
}
