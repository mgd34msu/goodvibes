/**
 * serve-to-network.ts, what a pairing surface's "Serve it to your network?"
 * yes does inside the daemon: the settings `goodvibes-daemon webui enable
 * --lan` writes, then the daemon's own report that its listener is bound
 * again, so the pairing code is made for the address phones can open.
 *
 * No sleep and no poll: a change of `controlPlane.hostMode` rebinds the
 * listener (daemon/facade.ts), which ends with TRANSPORT_CONNECTED (bound) or
 * TRANSPORT_TERMINAL_FAILURE (it could not bind; the caller's reach check then
 * says so). When the listener already binds the network, only
 * `controlPlane.enabled` changes, which is read per request: nothing rebinds
 * and nothing is waited for.
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import type { RuntimeEventBus } from './index.js';
import type { TransportEvent } from '@goodvibes/engine/platform/events';

export async function serveDaemonToNetwork(configManager: Pick<ConfigManager, 'get' | 'setDaemonValues'>, runtimeBus: RuntimeEventBus): Promise<void> {
  const rebinds = configManager.get('controlPlane.hostMode') !== 'network';
  const bound = rebinds ? new Promise<void>((resolve) => {
    const stops: (() => void)[] = [];
    const done = (): void => { for (const stop of stops) stop(); resolve(); };
    const daemonListener = (transportId: unknown): void => { if (String(transportId ?? '').startsWith('daemon:http')) done(); };
    stops.push(
      runtimeBus.on<Extract<TransportEvent, { type: 'TRANSPORT_CONNECTED' }>>('TRANSPORT_CONNECTED', (envelope) => daemonListener(envelope.payload?.transportId)),
      runtimeBus.on<Extract<TransportEvent, { type: 'TRANSPORT_TERMINAL_FAILURE' }>>('TRANSPORT_TERMINAL_FAILURE', (envelope) => daemonListener(envelope.payload?.transportId)),
    );
  }) : Promise.resolve();
  configManager.setDaemonValues({ 'controlPlane.hostMode': 'network', 'web.hostMode': 'network', 'controlPlane.enabled': true });
  await bound;
}
