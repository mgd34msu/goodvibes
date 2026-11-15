/** The gateway answers "is this client connected" from the live connection, not from its recent-client list. */
import { describe, expect, test } from 'bun:test';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { RuntimeEventBus } from './_helpers/runtime-seam.ts';

describe('ControlPlaneGateway.isClientConnected', () => {
  test('a client that closed is still listed but is not connected', () => {
    const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
    const send = () => {};
    const { clientId } = gateway.openWebSocketClient({ clientId: 'c1', clientKind: 'web' }, send);
    expect(gateway.isClientConnected(clientId)).toBe(true);
    expect(gateway.isClientConnected('never-seen')).toBe(false);
    gateway.closeWebSocketClient(clientId, 'socket-closed', send);
    expect(gateway.listClients().some((client) => client.id === clientId)).toBe(true);
    expect(gateway.isClientConnected(clientId)).toBe(false);
  });
});
