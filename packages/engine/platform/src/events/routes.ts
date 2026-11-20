/**
 * RouteEvent, discriminated union covering external route binding lifecycle events.
 */

export const ROUTE_SURFACE_KINDS = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'homeassistant',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'telephony',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
] as const;
export const ROUTE_TARGET_KINDS = ['session', 'run', 'job', 'task', 'message'] as const;

export type RouteSurfaceKind = (typeof ROUTE_SURFACE_KINDS)[number];

export type RouteTargetKind = (typeof ROUTE_TARGET_KINDS)[number];

export type RouteEvent =
  /**
   * A route binding was made: messages from a chat surface's conversation
   * (`surfaceKind`, `externalId` its id there) now go to a GoodVibes target
   * (`targetKind` session, run, job, task or message, and `targetId`).
   */
  | {
      type: 'ROUTE_BINDING_CREATED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      targetKind: RouteTargetKind;
      targetId: string;
    }
  /** A route binding changed; `changedFields` names what differs. */
  | {
      type: 'ROUTE_BINDING_UPDATED';
      bindingId: string;
      changedFields: string[];
    }
  /** A route binding was removed; messages from that conversation are no longer routed by it. */
  | {
      type: 'ROUTE_BINDING_REMOVED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
    }
  /** An incoming message was matched to an existing route binding and sent to its target. */
  | {
      type: 'ROUTE_BINDING_RESOLVED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      targetKind: RouteTargetKind;
      targetId: string;
    }
  /** A binding recorded where replies go in its conversation: `replyTargetId` and the thread `threadId`. */
  | {
      type: 'ROUTE_REPLY_TARGET_CAPTURED';
      bindingId: string;
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      replyTargetId: string;
      threadId: string;
    }
  /** Routing a message from a chat conversation failed; `error` says why. */
  | {
      type: 'ROUTE_BINDING_FAILED';
      surfaceKind: RouteSurfaceKind;
      externalId: string;
      error: string;
    };

export type RouteEventType = RouteEvent['type'];
