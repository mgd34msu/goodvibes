/**
 * DeliveryEvent, discriminated union covering outbound delivery attempts and outcomes.
 */

import type { RouteSurfaceKind } from './routes.js';

/**
 * What a delivery is: a `reply` to the conversation that asked (a job's
 * reply route, a channel reply), a `callback` to a webhook, or a
 * `notification` to any other surface.
 */
export const DELIVERY_KINDS = ['notification', 'reply', 'callback'] as const;

export type DeliveryKind = (typeof DELIVERY_KINDS)[number];

export type DeliveryEvent =
  | {
      type: 'DELIVERY_QUEUED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      /** The route id or label of the target; never its address, which can carry a secret (a webhook URL). */
      targetId: string;
      deliveryKind: DeliveryKind;
    }
  | {
      type: 'DELIVERY_STARTED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      startedAt: number;
    }
  | {
      type: 'DELIVERY_SUCCEEDED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      completedAt: number;
      durationMs: number;
    }
  | {
      type: 'DELIVERY_FAILED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      failedAt: number;
      error: string;
      retryable: boolean;
    }
  | {
      type: 'DELIVERY_DEAD_LETTERED';
      deliveryId: string;
      jobId: string;
      runId: string;
      surfaceKind: RouteSurfaceKind;
      targetId: string;
      reason: string;
      attempts: number;
    };

export type DeliveryEventType = DeliveryEvent['type'];
