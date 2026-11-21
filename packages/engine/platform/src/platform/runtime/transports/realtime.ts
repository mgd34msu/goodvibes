import { createDaemonHttpTransport } from './daemon-http-client.js';
import { createClientTransport } from './client-transport.js';
import type { DaemonHttpTransportOptions, HttpTransportPeerClient, HttpTransportOperatorClient, HttpTransportSnapshot } from './http-types.js';
import { createWebSocketConnector } from './shared.js';
import { createRemoteUiRuntimeEvents } from './ui-runtime-events.js';
import { authenticatedSocketFactory } from '../client/daemon-target.js';

export interface RealtimeTransportOptions extends DaemonHttpTransportOptions {
  readonly webSocketImpl?: typeof WebSocket | undefined;
}

export interface RealtimeTransportSnapshot extends Omit<HttpTransportSnapshot, 'kind'> {
  readonly kind: 'realtime';
}

export interface RealtimeTransport {
  readonly kind: 'realtime';
  readonly operator: HttpTransportOperatorClient;
  readonly peer: HttpTransportPeerClient;
  getOperatorClient(): HttpTransportOperatorClient;
  getPeerClient(): HttpTransportPeerClient;
  snapshot(): Promise<RealtimeTransportSnapshot>;
}

export function createRealtimeTransport(options: RealtimeTransportOptions): RealtimeTransport {
  const baseTransport = createDaemonHttpTransport({
    baseUrl: options.baseUrl,
    authToken: options.authToken,
    fetchImpl: options.fetchImpl,
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.onRetryScheduled ? { onRetryScheduled: options.onRetryScheduled } : {}),
    ...(options.onRetryExecuted ? { onRetryExecuted: options.onRetryExecuted } : {}),
  });
  const WebSocketImpl = options.webSocketImpl ?? WebSocket;
  // The daemon refuses a WebSocket upgrade without a credential, so the token
  // resolved for each connect goes on the upgrade request itself.
  const events = createRemoteUiRuntimeEvents(
    createWebSocketConnector(options.baseUrl, options.authToken, WebSocketImpl, {
      createSocket: authenticatedSocketFactory(options.baseUrl, WebSocketImpl),
    }),
  );
  const operator = {
    ...baseTransport.operator,
    events,
  };
  const transport = createClientTransport('realtime', operator, baseTransport.peer);

  return Object.freeze({
    ...transport,
    async snapshot(): Promise<RealtimeTransportSnapshot> {
      const snapshot = await baseTransport.snapshot();
      return {
        ...snapshot,
        kind: 'realtime',
      };
    },
  });
}
