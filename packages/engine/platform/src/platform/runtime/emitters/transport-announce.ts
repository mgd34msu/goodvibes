/**
 * One way to announce a transport lifecycle step: the runtime event for the
 * bus (telemetry, the store, subscribers) and the `Lifecycle:transport:<step>`
 * hook. Both owners of a transport (the daemon listener and an ACP
 * connection) announce through this, so the two stay in step. The hook fires
 * whether or not a bus is attached: a host with hooks and no bus still hears
 * its transports.
 */
import type { RuntimeEventBus } from '../events/index.js';
import type { HookDispatcher } from '../../hooks/index.js';
import type { EmitterContext } from './index.js';
import {
  emitTransportAuthenticating,
  emitTransportConnected,
  emitTransportDisconnected,
  emitTransportInitializing,
  emitTransportSyncing,
  emitTransportTerminalFailure,
} from './transport.js';

export type TransportAnnouncement =
  | { readonly step: 'initializing'; readonly payload: { readonly transportId: string; readonly protocol: string } }
  | { readonly step: 'authenticating'; readonly payload: { readonly transportId: string } }
  | { readonly step: 'connected'; readonly payload: { readonly transportId: string; readonly endpoint: string } }
  | { readonly step: 'syncing'; readonly payload: { readonly transportId: string } }
  | { readonly step: 'disconnected'; readonly payload: { readonly transportId: string; readonly reason?: string; readonly willRetry: boolean } }
  | { readonly step: 'failed'; readonly payload: { readonly transportId: string; readonly error: string } };

/**
 * Publish one step. A hook that throws or rejects is reported to `onHookError`
 * and never reaches the transport that announced.
 */
export function announceTransport(
  bus: RuntimeEventBus | null | undefined,
  hooks: Pick<HookDispatcher, 'fire'> | null | undefined,
  ctx: EmitterContext,
  announcement: TransportAnnouncement,
  onHookError: (step: TransportAnnouncement['step'], error: unknown) => void,
): void {
  if (bus) {
    switch (announcement.step) {
      case 'initializing': emitTransportInitializing(bus, ctx, { ...announcement.payload }); break;
      case 'authenticating': emitTransportAuthenticating(bus, ctx, { ...announcement.payload }); break;
      case 'connected': emitTransportConnected(bus, ctx, { ...announcement.payload }); break;
      case 'syncing': emitTransportSyncing(bus, ctx, { ...announcement.payload }); break;
      case 'disconnected': emitTransportDisconnected(bus, ctx, { ...announcement.payload }); break;
      case 'failed': emitTransportTerminalFailure(bus, ctx, { ...announcement.payload }); break;
    }
  }
  if (!hooks) return;
  const { step, payload } = announcement;
  try {
    void Promise.resolve(hooks.fire({
      path: `Lifecycle:transport:${step}`,
      phase: 'Lifecycle',
      category: 'transport',
      specific: step,
      sessionId: ctx.sessionId,
      timestamp: Date.now(),
      payload: { ...payload },
    })).catch((error: unknown) => onHookError(step, error));
  } catch (error) {
    onHookError(step, error);
  }
}
