import { expect, test } from 'bun:test';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext, type ControlPlaneWebSocketData } from '../platform/src/platform/daemon/control-plane.js';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';

function connect() {
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: new GatewayMethodCatalog(),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => 'synthetic-operator',
    trustProxyEnabled: () => false,
    userAuth: { validateSession: () => null },
  } as unknown as DaemonControlPlaneContext);
  const sent: Array<Record<string, unknown>> = [];
  const closed: Array<{ code?: number; reason?: string }> = [];
  const ws = {
    data: { authToken: 'wrong' } as ControlPlaneWebSocketData,
    send: (message: string) => { sent.push(JSON.parse(message)); },
    close: (code?: number, reason?: string) => { closed.push({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) }); },
  };
  helper.handleControlPlaneWebSocketOpen(ws as unknown as Parameters<typeof helper.handleControlPlaneWebSocketOpen>[0]);
  return { helper, ws, sent, closed };
}

test('a refused credential on an unauthenticated socket is answered and the socket is closed with the reason', async () => {
  const { helper, ws, sent, closed } = connect();
  await helper.handleControlPlaneWebSocketMessage(ws, JSON.stringify({ type: 'auth', token: 'not-the-token' }));
  expect(sent).toContainEqual({ type: 'auth', ok: false, error: 'Unauthorized' });
  expect(closed).toEqual([{ code: 1008, reason: 'Unauthorized' }]);
});

test('a valid credential is acknowledged and the socket stays open', async () => {
  const { helper, ws, sent, closed } = connect();
  await helper.handleControlPlaneWebSocketMessage(ws, JSON.stringify({ type: 'auth', token: 'synthetic-operator' }));
  expect(sent.some((frame) => frame.type === 'auth' && frame.ok === true)).toBe(true);
  expect(closed).toEqual([]);
});
