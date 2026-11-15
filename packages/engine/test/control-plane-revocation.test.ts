import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext, type ControlPlaneWebSocketData } from '../platform/src/platform/daemon/control-plane.js';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.js';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.js';
import { registerPairingGatewayMethods } from '../platform/src/platform/control-plane/routes/pairing.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.js';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.js';
import { HttpListener } from '../platform/src/platform/daemon/http-listener.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';

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

test('an open WebSocket is told its pairing was revoked and is served nothing more', async () => {
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
  const closedFrames: unknown[] = [];
  const closedWaiters: Array<() => void> = [];
  const responses = new Map<string, (value: { status: number }) => void>();
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type === 'event') events.push(frame.event);
    if (frame.type === 'closed') { closedFrames.push(frame); closedWaiters.shift()?.(); }
    if (frame.type === 'response') responses.get(frame.id)?.(frame);
  });
  const nextClosedFrame = () => new Promise<void>(resolve => closedWaiters.push(resolve));
  const call = (id: string, methodId: string, body?: unknown) => new Promise<{ status: number }>(resolve => {
    responses.set(id, resolve);
    ws.send(JSON.stringify({ type: 'call', id, methodId, body }));
  });
  try {
    await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = reject; });
    expect((await call('before', 'pairing.tokens.list')).status).toBe(200);
    events.length = 0;
    pairing.revoke(device.id);
    const told = nextClosedFrame();
    gateway.publishEvent('session-update', { secret: 'after revocation' });
    gateway.publishEvent('approval-update', { secret: 'after revocation' });
    await told;
    expect(events).toEqual([]);
    expect(closedFrames).toEqual([{ type: 'closed', reason: 'credential-revoked', next: expect.any(String) }]);
    // A call on the revoked socket is answered with the same refusal, never run.
    const toldAgain = nextClosedFrame();
    ws.send(JSON.stringify({ type: 'call', id: 'after', methodId: 'pairing.tokens.create', body: { name: 'replacement' } }));
    await toldAgain;
    expect(closedFrames).toHaveLength(2);
    expect((await helper.invokeGatewayMethodCall({ methodId: 'pairing.tokens.create', authToken: device.token, body: { name: 'replacement' } })).status).toBe(401);
    expect(pairing.list()).toHaveLength(0);
  } finally {
    ws.close();
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a request is authenticated once; revoking its pairing closes that principal\'s streams and aborts its requests at once', async () => {
  const { root, users } = authFixture();
  const pairing = new PairingTokenManager(join(root, 'pairing.json'));
  const device = pairing.mint({ name: 'phone' });
  const other = pairing.mint({ name: 'laptop' });
  const gateway = new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: new GatewayMethodCatalog(), controlPlaneGateway: gateway,
    pairingTokens: pairing, userAuth: users, authToken: () => 'synthetic-operator', trustProxyEnabled: () => false,
  } as unknown as DaemonControlPlaneContext);
  helper.watchRevocations();
  const request = (token: string) => new Request('http://daemon.local/api/sessions/s1/events', { headers: { authorization: `Bearer ${token}` } });
  const req = request(device.token);
  const context = helper.authenticateRequest(req);
  if (!context) throw new Error('Expected the paired device to authenticate');
  expect(context.principal).toMatchObject({ principalId: `pairing:${device.id}`, credentialKind: 'device-token', admin: true });

  // Every later check on the same request reads the bound context, not the pairing store.
  let storeReads = 0;
  const authenticate = pairing.authenticate.bind(pairing);
  pairing.authenticate = (token: string) => { storeReads++; return authenticate(token); };
  for (let check = 0; check < 5; check++) expect(helper.authenticateRequest(req)).toBe(context);
  expect(helper.requireAdmin(req)).toBeNull();
  expect(helper.checkAuth(req)).toBe(true);
  expect(storeReads).toBe(0);

  const stream = gateway.createEventStream(req, { principalId: context.principal.principalId });
  const otherReq = request(other.token);
  const otherContext = helper.authenticateRequest(otherReq);
  if (!otherContext) throw new Error('Expected the second device to authenticate');
  const otherStream = gateway.createEventStream(otherReq, { principalId: otherContext.principal.principalId });
  const signal = context.signal;

  pairing.revoke(device.id);
  expect(signal.aborted).toBe(true);
  expect(otherContext.signal.aborted).toBe(false);
  expect(await new Response(stream.body).text()).toContain('event: closed');
  expect(helper.authenticateRequest(req)).toBeNull();
  expect(helper.authenticateRequest(otherReq)?.principal.principalId).toBe(`pairing:${other.id}`);
  await otherStream.body?.cancel();
  helper.dispose();
});

test('a revocation written by another process is taken in by the next request', () => {
  const { root, users } = authFixture();
  const file = join(root, 'pairing.json');
  const daemonStore = new PairingTokenManager(file);
  const device = daemonStore.mint({ name: 'tablet' });
  const helper = new DaemonControlPlaneHelper({ gatewayMethods: new GatewayMethodCatalog(), pairingTokens: daemonStore,
    userAuth: users, authToken: () => null, trustProxyEnabled: () => false } as unknown as DaemonControlPlaneContext);
  const request = () => new Request('http://daemon.local/api/status', { headers: { authorization: `Bearer ${device.token}` } });
  expect(helper.checkAuth(request())).toBe(true);
  new PairingTokenManager(file).revoke(device.id);
  expect(helper.checkAuth(request())).toBe(false);
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
