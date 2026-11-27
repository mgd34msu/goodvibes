// Proves: A credential with ordinary write access obtains the daemon's operator authority through a hosted Agent session, or the operator credential is sent to another host.
// Red when: The create handler lets a write-scoped or non-admin credential create an Agent-surface session, or the in-process host sends the operator credential to the address the Agent dials.
/**
 * A GoodVibes Agent session the daemon hosts acts on the daemon with full
 * operator authority, so only a caller that already holds it may create one:
 * a credential with ordinary write access cannot borrow the operator
 * credential through a session. Inside such a session the operator credential
 * travels only through the daemon's own in-process request path, never over
 * the network, even when the address the Agent dials names another host.
 *
 * The real control-plane router authenticates each call (a real pairing store,
 * a real user store) and applies the real grant and the real create handler;
 * the hosted-session engine behind it only counts what it was asked to
 * create. The in-process host and its connected-host client are the real
 * ones; "another host" is a loopback server that records what reached it.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerHostedSessionGatewayMethods, type HostedSessionVerbService } from '../platform/src/platform/control-plane/routes/hosted-sessions.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createAgentInProcessHost, inProcessVerbCaller } from '../terminal-shell/src/agent-turn/in-process-host.ts';
import { daemonCallerProjectCheck } from '../platform/src/platform/daemon/facade-composition.ts';
import { CallerProjectsStore } from '../platform/src/platform/workspace/caller-projects-store.ts';
import { resolveGoodVibesDaemonHome } from '../platform/src/platform/config/goodvibes-home.ts';
import { pairingPrincipalId } from '../platform/src/platform/pairing/principal-ids.ts';

const OPERATOR_TOKEN = 'fixture-operator-token';

let dir: string;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-hosted-credential-')); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function daemon() {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  const catalog = new GatewayMethodCatalog();
  const created: { originSurface?: string | undefined; principalId?: string | undefined }[] = [];
  const unused = (): never => { throw new Error('only create is called in this proof'); };
  const service = {
    create: async (input: { readonly originSurface?: string | undefined; readonly principalId?: string | undefined }) => {
      created.push({ originSurface: input.originSurface, principalId: input.principalId });
      return { id: `hosted-${created.length}` };
    },
    attach: unused, detach: unused, kill: unused,
  } as unknown as HostedSessionVerbService;
  registerHostedSessionGatewayMethods(catalog, service);
  const home = join(dir, 'home');
  const project = join(dir, 'project');
  mkdirSync(join(home, '.goodvibes', 'shared'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: pairing,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    // The daemon's one check of the project a caller names, as every daemon composes it (facade-composition.ts).
    callerProject: daemonCallerProjectCheck(home),
  } as unknown as DaemonControlPlaneContext);
  // The owner registered the project; a device the owner paired works in it once the owner gave it the project (Devices and network).
  writeFileSync(join(home, '.goodvibes', 'shared', 'workspace-registrations.json'), JSON.stringify({ workspaces: [{ root: project }] }));
  const give = (tokenId: string) => new CallerProjectsStore(resolveGoodVibesDaemonHome(home)).set(pairingPrincipalId(tokenId), [project]);
  const create = (token: string, body: Record<string, unknown>) =>
    helper.invokeGatewayMethodCall({ authToken: token, methodId: 'sessions.hosted.create', body: { workspaceRoot: project, ...body } });
  // The owner in person: their signed-in session (the account made at first start). The operator token alone is a script.
  const ownerName = userAuth.ownerUsername();
  if (ownerName === null) throw new Error('the user store made no owner account at first start');
  return { userAuth, pairing, created, create, give, owner: userAuth.createSession(ownerName).token };
}

test('a credential with ordinary write access cannot create an Agent session, and nothing is created', async () => {
  const d = daemon();
  const writerDevice = d.pairing.mint({ name: 'chat phone', scopes: ['read:sessions', 'write:sessions'] });
  d.give(writerDevice.id);
  const writer = writerDevice.token;
  d.userAuth.addUser('viewer', 'viewer-password', ['viewer']);
  const viewer = d.userAuth.createSession('viewer').token;
  const refused = await d.create(writer, { originSurface: 'agent' });
  expect(refused.status).toBe(403);
  expect((refused.body as { code?: string }).code).toBe('HOSTED_SURFACE_FORBIDDEN');
  // A sign-in without the admin role holds no write access to sessions at all.
  expect((await d.create(viewer, { originSurface: 'agent' })).status).toBe(403);
  expect(d.created).toEqual([]);
  // A plain hosted session needs no operator authority and is created for the same writer.
  expect((await d.create(writer, {})).status).toBe(200);
  // The owner in person may create an Agent session.
  expect((await d.create(d.owner, { originSurface: 'agent' })).status).toBe(200);
  expect(d.created.map((entry) => entry.originSurface)).toEqual([undefined, 'agent']);
});

test('inside a hosted Agent turn the operator credential goes only through the daemon\'s own request path, never to another host', async () => {
  const arrived: string[] = [];
  const elsewhere = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (req) => {
    arrived.push(req.headers.get('authorization') ?? '');
    return Response.json({ error: 'not this host' }, { status: 500 });
  } });
  cleanups.push(() => elsewhere.stop(true));
  const served: Request[] = [];
  mkdirSync(join(dir, 'home'), { recursive: true });
  const host = createAgentInProcessHost({
    // The address the Agent dials names another listening host.
    baseUrl: `http://127.0.0.1:${elsewhere.port}`,
    homeDirectory: join(dir, 'home'),
    requests: {
      serve: async (request) => { served.push(request); return Response.json({ ok: true, status: 'running' }); },
      operatorToken: () => OPERATOR_TOKEN,
    },
  });
  const caller = inProcessVerbCaller(host);
  expect(caller.probe()).toEqual({ available: true });
  await caller.invoke('control.status').catch(() => undefined);
  expect(served.length).toBeGreaterThan(0);
  expect(served.every((request) => request.headers.get('authorization') === `Bearer ${OPERATOR_TOKEN}`)).toBe(true);
  expect(arrived).toEqual([]);
});
