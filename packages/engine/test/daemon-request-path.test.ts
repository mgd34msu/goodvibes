// Proves: A request with no credential reaches an API route, or a non-admin reaches an admin method by its REST address or by a socket call that names a method and path.
// Red when: The daemon's request path stops authenticating before routing, or the access rule of the method a REST address or a socket method-and-path call names is not applied, so a viewer creates a user.
/**
 * The method-dispatch path is proved in non-admin-reads; these are the two
 * other ways to the same handler. The real DaemonHttpRouter and
 * DaemonControlPlaneHelper over a real user store, method catalog and settings
 * manager, built as non-admin-reads builds its helper. Nothing is bound to a
 * port; the routes beyond the gate are not composed (a request that got past
 * the gate would fail there or be served, never be refused with 401 or 403).
 * Sign-in and a webhook path answering without a credential are the control.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { DaemonHttpRouter } from '../platform/src/platform/daemon/http/router.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';

const DAEMON = 'http://127.0.0.1:3421';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-request-path-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('no credential is refused before any route; a viewer is refused an admin method by its REST address and by a socket path call', async () => {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  userAuth.addUser('viewer', 'viewer-password', ['viewer']);
  const catalog = new GatewayMethodCatalog();
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ configDir: join(dir, 'config'), workingDir: dir, homeDir: join(dir, 'home'), surfaceRoot: 'goodvibes' });
  let router: DaemonHttpRouter | undefined;
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: new PairingTokenManager(join(dir, 'pairing-tokens.json')),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus }),
    authToken: () => 'synthetic-operator-token', trustProxyEnabled: () => false, host: '127.0.0.1', port: 3421,
    dispatchApiRoutes: (req: Request) => router!.dispatchApiRoutes(req),
  } as unknown as DaemonControlPlaneContext);
  router = new DaemonHttpRouter({
    configManager, userAuth, gatewayMethods: catalog, runtimeBus, runtimeStore: null, githubWebhookSecret: null,
    authToken: () => 'synthetic-operator-token',
    authenticateRequest: (req: Request) => helper.authenticateRequest(req),
    extractAuthToken: (req: Request) => helper.extractAuthToken(req),
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);

  const viewer = userAuth.createSession('viewer').token;
  const newUser = { username: 'mallory', password: 'mallory-password', roles: ['admin'] };
  const rest = (headers: Record<string, string>) => router!.handleRequest(new Request(`${DAEMON}/api/local-auth/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(newUser),
  }));
  expect((await router.handleRequest(new Request(`${DAEMON}/api/local-auth`))).status).toBe(401);
  expect((await rest({})).status).toBe(401);
  expect((await rest({ authorization: `Bearer ${viewer}` })).status).toBe(403);
  const socketCall = await helper.invokeWebSocketControlPlaneCall({
    authToken: viewer, method: 'POST', path: '/api/local-auth/users', body: newUser,
    context: { principalKind: 'user', admin: false, scopes: helper.describeRequestPrincipal(viewer)!.scopes },
  });
  expect(socketCall.status).toBe(403);
  expect(userAuth.getUser('mallory')).toBeNull();

  // The control: sign-in answers without a credential, and so does a channel webhook path.
  const signIn = await router.handleRequest(new Request(`${DAEMON}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'viewer-password' }),
  }));
  expect(signIn.status).toBe(200);
  const webhook = await router.handleRequest(new Request(`${DAEMON}/webhook/github`, { method: 'POST', body: '{}' }));
  expect(webhook.status).not.toBe(401);
});
