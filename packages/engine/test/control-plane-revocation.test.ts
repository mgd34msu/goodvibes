import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext, type ControlPlaneWebSocketData } from '../sdk/src/platform/daemon/control-plane.js';
import { ControlPlaneGateway } from '../sdk/src/platform/control-plane/gateway.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerPairingGatewayMethods } from '../sdk/src/platform/control-plane/routes/pairing.js';
import { RuntimeEventBus } from '../sdk/src/platform/runtime/events/index.js';
import { PairingTokenManager } from '../sdk/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { HttpListener } from '../sdk/src/platform/daemon/http-listener.js';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function authFixture() {
  const root = mkdtempSync(join(tmpdir(), 'origin-auth-')); roots.push(root);
  const users = new UserAuthManager({ bootstrapFilePath: join(root, 'users.json'), bootstrapCredentialPath: join(root, 'bootstrap.txt'),
    users: [{ username: 'owner', roles: ['admin'], passwordHash: 'unused' }] });
  return { root, users };
}

test('secondary HTTP listener honors live legacy and paired-token revocation', async () => {
  const { root, users } = authFixture();
  const pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const config = new ConfigManager({ configDir: root });
  const listener = new HttpListener({ configManager: config, userAuth: users, pairingTokens: pairing });
  listener.enable({ httpListener: true }, 'synthetic-legacy');
  const handle = (token: string) => (listener as unknown as { handleRequest(req: Request): Promise<Response> }).handleRequest(
    new Request('http://localhost/health', { headers: { authorization: `Bearer ${token}` } }));
  try {
    expect((await handle('synthetic-legacy')).status).toBe(200);
    pairing.revokeLegacyShared();
    expect((await handle('synthetic-legacy')).status).toBe(401);
    const device = pairing.mint({ name: 'replacement' });
    expect((await handle(device.token)).status).toBe(200);
    pairing.revoke(device.id);
    expect((await handle(device.token)).status).toBe(401);
  } finally { await listener.stop(); config.stopWatchingConfigFiles(); }
});

test('WebSocket upgrades check browser origins while permitting authenticated native clients', () => {
  const { users } = authFixture();
  const session = users.createSession('owner');
  const helper = new DaemonControlPlaneHelper({ authToken: () => 'synthetic-operator', userAuth: users,
    gatewayMethods: new GatewayMethodCatalog(),
    trustProxyEnabled: () => false, allowedBrowserOrigins: () => ['https://trusted.example'] } as unknown as DaemonControlPlaneContext);
  let upgraded = 0;
  const server = { upgrade: () => { upgraded++; return true; } };
  for (const origin of ['https://sibling.example', 'null', undefined]) {
    const result = helper.tryUpgradeControlPlaneWebSocket(new Request('https://daemon.example/api/control-plane/ws', {
      headers: { cookie: `goodvibes_session=${session.token}`, ...(origin ? { origin } : {}) },
    }), server);
    expect(result instanceof Response && result.status).toBe(403);
  }
  for (const origin of ['https://daemon.example', 'https://trusted.example']) {
    expect(helper.tryUpgradeControlPlaneWebSocket(new Request('https://daemon.example/api/control-plane/ws', {
      headers: { cookie: `goodvibes_session=${session.token}`, origin },
    }), server)).toBe('upgraded');
  }
  expect(helper.tryUpgradeControlPlaneWebSocket(new Request('https://daemon.example/api/control-plane/ws', {
    headers: { authorization: 'Bearer synthetic-operator' },
  }), server)).toBe('upgraded');
  expect(upgraded).toBe(3);
});

test('an open WebSocket loses event and mint authority when its pairing is revoked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-revocation-'));
  const pairing = new PairingTokenManager(join(dir, 'pairing.json'));
  const device = pairing.mint({ name: 'connected device' });
  const catalog = new GatewayMethodCatalog();
  registerPairingGatewayMethods(catalog, pairing);
  const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, controlPlaneGateway: gateway, pairingTokens: pairing,
    authToken: () => 'synthetic-operator', trustProxyEnabled: () => false,
    userAuth: { validateSession: () => null },
  } as unknown as DaemonControlPlaneContext);
  const server = Bun.serve<ControlPlaneWebSocketData>({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      const result = helper.tryUpgradeControlPlaneWebSocket(req, server);
      return result === 'upgraded' ? undefined : result ?? new Response(null, { status: 404 });
    },
    websocket: {
      open: ws => helper.handleControlPlaneWebSocketOpen(ws),
      message: (ws, message) => helper.handleControlPlaneWebSocketMessage(ws, message),
      close: ws => helper.handleControlPlaneWebSocketClose(ws),
    },
  });
  // lib.dom's constructor omits Bun's supported header overload.
  const Socket = WebSocket as unknown as { new(url: string, options: Bun.WebSocketOptions): WebSocket };
  const ws = new Socket(`ws://127.0.0.1:${server.port}/api/control-plane/ws`, { headers: { Authorization: `Bearer ${device.token}` } });
  const events: string[] = [];
  const responses = new Map<string, (value: { status: number }) => void>();
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'event') events.push(frame.event);
    if (frame.type === 'response') responses.get(frame.id)?.(frame);
  });
  const call = (id: string, methodId: string, body?: unknown) => new Promise<{ status: number }>(resolve => {
    responses.set(id, resolve);
    ws.send(JSON.stringify({ type: 'call', id, methodId, body }));
  });
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    expect((await call('before', 'pairing.tokens.list')).status).toBe(200);
    pairing.revoke(device.id);
    events.length = 0;
    gateway.publishEvent('session-update', { secret: 'after revocation' });
    gateway.publishEvent('approval-update', { secret: 'after revocation' });
    expect((await call('after', 'pairing.tokens.create', { name: 'replacement' })).status).toBe(401);
    expect(pairing.list()).toHaveLength(0);
    expect(events).toEqual([]);
  } finally {
    ws.close();
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});


test('a retained handler authority pins the original token after its request returns and the socket aborts', async () => {
  const { root, users } = authFixture(), pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const device = pairing.mint({ name: 'Original paired owner' }), catalog = new GatewayMethodCatalog();
  let authorized: ((scopes?: readonly string[]) => boolean) | undefined;
  const descriptor = { id: 'fixture.retained', title: 'Fixture retained work', description: 'Fixture', category: 'fixture', source: 'builtin' as const,
    transport: ['http' as const, 'ws' as const], access: 'admin' as const, scopes: ['write:fixture'] };
  catalog.register(descriptor, invocation => { authorized = invocation.isAuthorized; return { accepted: true }; });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, pairingTokens: pairing, userAuth: users,
    authToken: () => 'synthetic-shared' } as unknown as DaemonControlPlaneContext);
  const abort = new AbortController();
  const input = { methodId: descriptor.id, authToken: device.token, signal: abort.signal, body: { privateInput: 'original request data' } };
  expect((await helper.invokeGatewayMethodCall(input)).status).toBe(200);
  abort.abort(); input.authToken = 'unrelated replacement credential'; input.body.privateInput = 'replaced request data';
  expect(authorized?.(['write:fixture'])).toBe(true);
  expect(authorized?.(['write:ungranted'])).toBe(false);
  pairing.revoke(device.id); expect(authorized?.(['write:fixture'])).toBe(false);
});

test('mutating a returned request cannot rebind its authority to a newly rotated shared credential', async () => {
  const { users } = authFixture(), catalog = new GatewayMethodCatalog(); let shared = 'first-shared-credential';
  let authorized: ((scopes?: readonly string[]) => boolean) | undefined;
  const descriptor = { id: 'fixture.original-shared', title: 'Fixture', description: 'Fixture', category: 'fixture', source: 'builtin' as const,
    transport: ['ws' as const], access: 'admin' as const, scopes: ['write:fixture'] };
  catalog.register(descriptor, invocation => { authorized = invocation.isAuthorized; return {}; });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, userAuth: users, authToken: () => shared } as unknown as DaemonControlPlaneContext);
  const input = { methodId: descriptor.id, authToken: shared };
  await helper.invokeGatewayMethodCall(input); expect(authorized?.(['write:fixture'])).toBe(true);
  shared = 'second-shared-credential'; input.authToken = shared;
  expect(authorized?.(['write:fixture'])).toBe(false);
});

test('retiring and restoring a gateway descriptor does not revive a retained handler authorization', async () => {
  const { users } = authFixture(), catalog = new GatewayMethodCatalog(); let authorized: ((scopes?: readonly string[]) => boolean) | undefined;
  const descriptor = { id: 'fixture.catalog-owner', title: 'Fixture', description: 'Fixture', category: 'fixture', source: 'builtin' as const,
    transport: ['ws' as const], access: 'admin' as const, scopes: ['write:fixture'] };
  catalog.register(descriptor, invocation => { authorized = invocation.isAuthorized; return {}; });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: catalog, userAuth: users, authToken: () => 'synthetic-shared' } as unknown as DaemonControlPlaneContext);
  await helper.invokeGatewayMethodCall({ methodId: descriptor.id, authToken: 'synthetic-shared' });
  expect(authorized?.(['write:fixture'])).toBe(true);
  catalog.register({ ...descriptor, scopes: ['write:different'] }, () => ({}), { replace: true });
  expect(authorized?.(['write:fixture'])).toBe(false);
  catalog.register(descriptor, () => ({}), { replace: true }); expect(authorized?.(['write:fixture'])).toBe(false);
});

test('native execution authority cannot follow a replacement pairing store over the same persisted token', async () => {
  const { root, users } = authFixture(), file = join(root, 'pairing.json'), pairing = new PairingTokenManager(file);
  const device = pairing.mint({ name: 'Original native source' });
  const context = { gatewayMethods: new GatewayMethodCatalog(), pairingTokens: pairing, userAuth: users,
    authToken: () => 'synthetic-shared' } as unknown as DaemonControlPlaneContext;
  const helper = new DaemonControlPlaneHelper(context), authority = helper.createNativeExecutionAuthority(device.token);
  const original = authority?.current(); if (!authority || !original) throw new Error('Expected actual native pairing authority');
  Reflect.set(context, 'pairingTokens', new PairingTokenManager(file));
  expect(authority.current()).toBeNull();
  let effects = 0;
  await expect(authority.withCurrent(original, () => { effects++; })).rejects.toThrow();
  expect(effects).toBe(0);
});
