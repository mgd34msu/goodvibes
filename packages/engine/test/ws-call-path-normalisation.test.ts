/** A WebSocket path call is scope-checked by the path the router will serve, not by the text the client typed. */
import { expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';

function setup() {
  const catalog = new GatewayMethodCatalog({ includeBuiltins: false });
  catalog.register({ id: 'test.admin-thing', title: 'test', description: 'test', category: 'test', source: 'builtin', access: 'authenticated', transport: ['http'],
    scopes: ['write:admin-thing'], http: { method: 'GET', path: '/api/admin-thing' } }, async () => ({ ok: true }));
  const served: string[] = [];
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, host: '127.0.0.1', port: 1,
    dispatchApiRoutes: async (req: Request) => { served.push(new URL(req.url).pathname); return Response.json({ ok: true }); } } as unknown as DaemonControlPlaneContext);
  const call = (path: string) => helper.invokeWebSocketControlPlaneCall({ authToken: 't', method: 'GET', path, context: { principalKind: 'user', scopes: ['read:other'] } });
  return { call, served };
}

test('a plain call to a scoped path is refused for a caller without the scope', async () => {
  const { call, served } = setup();
  expect((await call('/api/admin-thing')).status).toBe(403);
  expect(served).toEqual([]);
});

test('a path with dot segments is refused instead of reaching the router under another name', async () => {
  const { call, served } = setup();
  for (const path of ['/api/safe/../admin-thing', '/api/./admin-thing', '/api/%2e%2e/admin-thing', '/api\\..\\admin-thing']) {
    expect((await call(path)).status).toBe(400);
  }
  expect(served).toEqual([]);
});

test('a path carrying a query string is judged by its path part', async () => {
  const { call, served } = setup();
  expect((await call('/api/admin-thing?x=1')).status).toBe(403);
  expect(served).toEqual([]);
});
