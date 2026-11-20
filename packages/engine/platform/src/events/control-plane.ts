/**
 * ControlPlaneEvent, discriminated union covering gateway/control-plane client lifecycle events.
 */

export const CONTROL_PLANE_CLIENT_KINDS = [
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'daemon',
  'webhook',
  'homeassistant',
  'service',
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
] as const;
export const CONTROL_PLANE_TRANSPORT_KINDS = ['local', 'http', 'sse', 'ws', 'websocket', 'webhook'] as const;
export const CONTROL_PLANE_PRINCIPAL_KINDS = ['user', 'bot', 'service', 'token'] as const;

export type ControlPlaneClientKind = (typeof CONTROL_PLANE_CLIENT_KINDS)[number];

export type ControlPlaneTransportKind = (typeof CONTROL_PLANE_TRANSPORT_KINDS)[number];

export type ControlPlanePrincipalKind = (typeof CONTROL_PLANE_PRINCIPAL_KINDS)[number];

export type ControlPlaneEvent =
  /** A client opened a live connection to the daemon (a web UI, a terminal app, a service): `clientKind` is what it is and `transport` how it is connected. */
  | {
      type: 'CONTROL_PLANE_CLIENT_CONNECTED';
      clientId: string;
      clientKind: ControlPlaneClientKind;
      transport: ControlPlaneTransportKind;
    }
  /** A connected client went away; `reason` says why (it closed, it timed out, it was dropped). */
  | {
      type: 'CONTROL_PLANE_CLIENT_DISCONNECTED';
      clientId: string;
      reason: string;
    }
  /** A connected client subscribed to runtime events; `topics` are the event domains it receives. */
  | {
      type: 'CONTROL_PLANE_SUBSCRIPTION_CREATED';
      clientId: string;
      subscriptionId: string;
      topics: string[];
    }
  /** A client's event subscription ended; `reason` says why. */
  | {
      type: 'CONTROL_PLANE_SUBSCRIPTION_DROPPED';
      clientId: string;
      subscriptionId: string;
      reason: string;
    }
  /** A connected client was authenticated: `principalId` and `principalKind` say who it acts as and `scopes` what it may do. */
  | {
      type: 'CONTROL_PLANE_AUTH_GRANTED';
      clientId: string;
      principalId: string;
      principalKind: ControlPlanePrincipalKind;
      scopes: string[];
    };

export type ControlPlaneEventType = ControlPlaneEvent['type'];
