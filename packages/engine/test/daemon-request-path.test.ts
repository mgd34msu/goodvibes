// Proves: A request with no credential reaches an API route, or a caller below the right class reaches a method by its REST address, its operator method or a socket call that names a method and path.
// Red when: The daemon's request path stops authenticating before routing, or one of the three routes to a method stops asking the effect authority, so a viewer creates a user or an admin who is not the owner answers the owner's approval.
// Proves: A page from another origin acts through the daemon riding a browser cookie: it changes something, reads the event stream or signs the owner out with the sign-in cookie, or acts as the paired device node with its cookie.
// Red when: The request path stops refusing a write or a read authenticated by the sign-in cookie, the sign-out on that cookie, or a peer call on the device-node cookie, from a page whose origin is neither the daemon's own nor on the allowed list (or, for a change, from no origin).
/**
 * The real DaemonHttpRouter and DaemonControlPlaneHelper over a real user
 * store, method catalog, settings manager and distributed runtime (a peer
 * paired through it). Nothing is bound to a port; the routes beyond the gate
 * are not composed (a request that got past the gate would fail there or be
 * served, never be refused with 401 or 403 for its credential or its origin).
 * Sign-in, a webhook path and the owner's own calls are the controls.
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
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.ts';

const DAEMON = 'http://127.0.0.1:3421';
const OPERATOR_TOKEN = 'synthetic-operator-token';
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-request-path-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function daemon() {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  userAuth.addUser('viewer', 'viewer-password', ['viewer']);
  // An admin who is not the owner (the owner is the first user, `admin`).
  userAuth.addUser('deputy', 'deputy-password', ['admin']);
  const catalog = new GatewayMethodCatalog();
  const runtimeBus = new RuntimeEventBus();
  const configManager = new ConfigManager({ configDir: join(dir, 'config'), workingDir: dir, homeDir: join(dir, 'home'), surfaceRoot: 'goodvibes' });
  const distributedRuntime = new DistributedRuntimeManager(join(dir, 'remote', 'distributed-runtime.json'));
  let router: DaemonHttpRouter | undefined;
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: new PairingTokenManager(join(dir, 'pairing-tokens.json')),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus }), distributedRuntime,
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 3421,
    dispatchApiRoutes: (req: Request) => router!.dispatchApiRoutes(req),
  } as unknown as DaemonControlPlaneContext);
  router = new DaemonHttpRouter({
    configManager, userAuth, gatewayMethods: catalog, runtimeBus, runtimeStore: null, githubWebhookSecret: null, distributedRuntime,
    authToken: () => OPERATOR_TOKEN,
    authenticateRequest: (req: Request) => helper.authenticateRequest(req),
    extractAuthToken: (req: Request) => helper.extractAuthToken(req),
    requireRemotePeer: (req: Request, scope?: string) => helper.requireRemotePeer(req, scope),
  } as unknown as ConstructorParameters<typeof DaemonHttpRouter>[0]);
  return { userAuth, helper, router: router!, distributedRuntime };
}

/** A socket path call with the context the socket builds from its authenticated principal. */
function socketCall(helper: DaemonControlPlaneHelper, token: string, path: string, body: unknown) {
  const principal = helper.describeRequestPrincipal(token)!;
  return helper.invokeWebSocketControlPlaneCall({
    authToken: token, method: 'POST', path, body, principal,
    context: { principalKind: principal.principalKind, admin: principal.admin, scopes: principal.scopes, actor: principal.actor },
  });
}

const codeOf = (body: unknown): string | undefined => (body as { code?: string } | null)?.code;

test('no credential is refused before any route; a viewer is refused an admin method and an admin who is not the owner the owner\'s act, by REST, operator method and socket call', async () => {
  const { userAuth, helper, router } = daemon();
  const viewer = userAuth.createSession('viewer').token;
  const newUser = { username: 'mallory', password: 'mallory-password', roles: ['admin'] };
  const rest = (headers: Record<string, string>) => router.handleRequest(new Request(`${DAEMON}/api/local-auth/users`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(newUser),
  }));
  expect((await router.handleRequest(new Request(`${DAEMON}/api/local-auth`))).status).toBe(401);
  expect((await rest({})).status).toBe(401);
  expect((await rest({ authorization: `Bearer ${viewer}` })).status).toBe(403);
  expect((await socketCall(helper, viewer, '/api/local-auth/users', newUser)).status).toBe(403);
  expect(userAuth.getUser('mallory')).toBeNull();

  // Answering an approval is the owner's own act: the same effect by each of its three routes asks the same authority.
  const answer = async (token: string) => {
    const body = { remember: false };
    const viaRest = await router.handleRequest(new Request(`${DAEMON}/api/approvals/approval-1/approve`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    }));
    const viaMethod = await helper.invokeGatewayMethodCall({ authToken: token, methodId: 'approvals.approve', body: { approvalId: 'approval-1', ...body } });
    const viaSocket = await socketCall(helper, token, '/api/approvals/approval-1/approve', body);
    const refused = (status: number, code: string | undefined) => status === 403 && code === 'OWNER_ONLY' ? 'refused OWNER_ONLY' : 'not refused';
    return {
      rest: refused(viaRest.status, codeOf(await viaRest.json().catch(() => null))),
      method: refused(viaMethod.status, codeOf(viaMethod.body)),
      socket: refused(viaSocket.status, codeOf(viaSocket.body)),
    };
  };
  const deputy = userAuth.createSession('deputy').token;
  expect(await answer(deputy)).toEqual({ rest: 'refused OWNER_ONLY', method: 'refused OWNER_ONLY', socket: 'refused OWNER_ONLY' });
  // The control: the owner's credential is not refused the same act on any route (the approvals beyond are not composed).
  expect(await answer(OPERATOR_TOKEN)).toEqual({ rest: 'not refused', method: 'not refused', socket: 'not refused' });

  // The control: sign-in answers without a credential, and so does a channel webhook path.
  const signIn = await router.handleRequest(new Request(`${DAEMON}/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'viewer', password: 'viewer-password' }),
  }));
  expect(signIn.status).toBe(200);
  const webhook = await router.handleRequest(new Request(`${DAEMON}/webhook/github`, { method: 'POST', body: '{}' }));
  expect(webhook.status).not.toBe(401);
});

test('a browser cookie acts for no page of another origin: no change, no event stream, no sign-out with the sign-in cookie, no peer call with the device-node cookie; the daemon\'s own page is let through', async () => {
  const { userAuth, router, distributedRuntime } = daemon();
  const session = userAuth.createSession('admin').token;
  const cookie = `goodvibes_session=${encodeURIComponent(session)}`;
  const asked = await distributedRuntime.requestPairing({ peerKind: 'node', label: 'phone page' });
  await distributedRuntime.approvePairRequest(asked.request.id);
  const peerToken = (await distributedRuntime.verifyPairRequest(asked.request.id, asked.challenge))!.token.value;
  const nodeCookie = `goodvibes_node=${encodeURIComponent(peerToken)}`;

  const send = async (method: string, path: string, cookieHeader: string, origin: string | null, body?: unknown) => {
    const response = await router.handleRequest(new Request(`${DAEMON}${path}`, {
      method, headers: { cookie: cookieHeader, ...(origin === null ? {} : { origin }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    const code = codeOf(await response.json().catch(() => null));
    return code === 'ORIGIN_NOT_ALLOWED' ? 'refused for its origin' : response.status === 401 ? 'unauthenticated' : 'let through';
  };
  const create = (origin: string | null) => send('POST', '/api/local-auth/users', cookie, origin, { username: 'mallory', password: 'mallory-password', roles: ['admin'] });
  const rows: ReadonlyArray<readonly [string, () => Promise<string>, string]> = [
    ['a change from another origin', () => create('https://elsewhere.example'), 'refused for its origin'],
    ['a change from another port on this host', () => create('http://127.0.0.1:8080'), 'refused for its origin'],
    ['a change with no origin', () => create(null), 'refused for its origin'],
    ['the event stream from another origin', () => send('GET', '/api/control-plane/events', cookie, 'https://elsewhere.example'), 'refused for its origin'],
    ['a sign-out from another origin', () => send('POST', '/logout', cookie, 'https://elsewhere.example'), 'refused for its origin'],
    ['a peer call on the device-node cookie from another origin', () => send('POST', '/api/remote/heartbeat', nodeCookie, 'https://elsewhere.example', {}), 'refused for its origin'],
    // The controls: the daemon's own page, and a same-origin read that names no origin, pass the origin check.
    ['a change from the daemon\'s own origin', () => create(DAEMON), 'let through'],
    ['a read with no origin', () => send('GET', '/api/local-auth', cookie, null), 'let through'],
    ['a peer call on the device-node cookie from the daemon\'s own origin', () => send('POST', '/api/remote/heartbeat', nodeCookie, DAEMON, {}), 'let through'],
  ];
  for (const [name, run, expected] of rows) expect(`${name}: ${await run()}`).toBe(`${name}: ${expected}`);
  expect(userAuth.getUser('mallory')).toBeNull();
  // The sign-out refused for its origin left the session signed in; the daemon's own page ends it.
  expect(userAuth.validateSession(session)).not.toBeNull();
  expect(await send('POST', '/logout', cookie, DAEMON)).toBe('let through');
  expect(userAuth.validateSession(session)).toBeNull();
});
