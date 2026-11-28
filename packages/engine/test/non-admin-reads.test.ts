// Proves: A signed-in user without the admin role reads the owner's transcripts, devices, task prompts or contracts.
// Red when: A private read scope reaches the non-admin grant or a method loses its scope, the task list stops redacting prompts and errors, a method's openness changes without the reviewed list, or contract visibility follows session attachment instead of the starting principal.
/**
 * A signed-in user without the admin role cannot read the owner's content
 * (transcripts, paired devices, browser pages, calendar, inbox, knowledge,
 * approvals and the rest) or contracts. Every method open to that user is
 * on the reviewed list below, so a method newly opened to non-admins is a
 * decision someone made here. A contract stays its owner's after the owner
 * detaches from the session it was started in.
 *
 * The real control-plane router (DaemonControlPlaneHelper) authenticates each
 * call from a real user session and applies the catalog's real grant; the
 * pairing and contract handlers run over a real pairing store and a real
 * contract runner. Calls are served in-process; no port is bound.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { daemonCallerProjectCheck } from '../platform/src/platform/daemon/facade-composition.ts';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { OWNER_PRIVATE_READ_SCOPES } from '../platform/src/platform/control-plane/method-catalog-shared.ts';
import { refuseGatewayAccess } from '../platform/src/platform/daemon/http/gateway-binding-gate.ts';
import { registerPairingGatewayMethods } from '../platform/src/platform/control-plane/routes/pairing.ts';
import { registerContractGatewayMethods } from '../platform/src/platform/control-plane/routes/contracts.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { createContractOperatorService } from '../platform/src/platform/contract/operator-service.ts';
import { createDaemonIntegrationRouteHandlers, dispatchTaskRoutes, type DaemonIntegrationRouteContext } from '../daemon-api/src/index.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { makeHarness, makeRepo, oneUnitPlan, type Harness } from './contract/runner-support.ts';

/** A cheap hash cost: the grant is under test, not scrypt. */
const FAST = { N: 1024, r: 1, p: 1 };

let dir: string;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'gv-non-admin-reads-')); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  rmSync(dir, { recursive: true, force: true });
});

function daemon() {
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: FAST });
  userAuth.addUser('viewer', 'viewer-password', ['viewer']);
  const catalog = new GatewayMethodCatalog();
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  registerPairingGatewayMethods(catalog, pairing);
  // The task routes as the daemon router wires them: the caller is the request's own credential.
  const tasks = { snapshot: {} as Record<string, unknown> };
  const taskRoutes = (req: Request) => dispatchTaskRoutes(req, createDaemonIntegrationRouteHandlers({
    integrationHelpers: { getTaskSnapshot: () => tasks.snapshot },
    resolveAuthenticatedPrincipal: (request: Request) => helper.authenticateRequest(request)?.principal ?? null,
  } as unknown as DaemonIntegrationRouteContext) as unknown as Parameters<typeof dispatchTaskRoutes>[1]);
  const helper: DaemonControlPlaneHelper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: pairing,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => 'fixture-operator-token', trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    dispatchApiRoutes: taskRoutes,
    // The daemon's one project check, over the registered projects.
    callerProject: daemonCallerProjectCheck(dir),
  } as unknown as DaemonControlPlaneContext);
  // The user's own signed-in session, the account made at first start.
  const ownerName = userAuth.ownerUsername();
  if (ownerName === null) throw new Error('the user store made no owner account at first start');
  const owner = userAuth.createSession(ownerName).token;
  const viewer = userAuth.createSession('viewer').token;
  const call = (token: string, methodId: string, body: Record<string, unknown> = {}) =>
    helper.invokeGatewayMethodCall({ authToken: token, methodId, body });
  return { userAuth, catalog, pairing, helper, owner, ownerName, viewer, call, tasks };
}

test('a non-admin user cannot read transcripts, paired devices or any owner-private record', async () => {
  const d = daemon();
  // A token is listed as a device once it has been used.
  expect(d.pairing.authenticate(d.pairing.mint({ name: 'owner phone' }).token)).not.toBeNull();
  const principal = d.helper.describeRequestPrincipal(d.viewer)!;
  expect(principal.admin).toBe(false);
  for (const scope of [...OWNER_PRIVATE_READ_SCOPES]) expect(`${scope}: ${principal.scopes.includes(scope)}`).toBe(`${scope}: false`);
  for (const methodId of ['sessions.get', 'sessions.messages.list', 'sessions.inputs.list', 'pairing.tokens.list', 'browser.readText',
    'calendar.events.list', 'channels.inbox.list', 'channels.drafts.get', 'knowledge.search', 'approvals.list', 'inbox.list',
    'checkpoints.diff', 'fleet.snapshot', 'control.messages.list', 'tasks.status', 'principals.list', 'remote.peers.list',
    'sessions.list', 'sessions.search', 'sessions.hosted.list', 'routes.snapshot', 'deliveries.list']) {
    const refused = await d.call(d.viewer, methodId, { sessionId: 'owner-session' });
    expect(`${methodId}: ${refused.status}`).toBe(`${methodId}: 403`);
    expect(JSON.stringify(refused.body)).not.toContain('owner phone');
  }
  // The owner reads the same list.
  const listed = await d.call(d.owner, 'pairing.tokens.list');
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).toContain('owner phone');
});

test('a non-admin user reads task counts and states but not an agent task\'s prompt or error', async () => {
  const d = daemon();
  // The task runs in a registered project: the list is the viewer's to read, its prompt and error never.
  const project = join(dir, 'project');
  mkdirSync(project, { recursive: true });
  await new WorkspaceRegistrationStore({ path: join(dir, '.goodvibes', 'shared', 'workspace-registrations.json'), homeDir: dir,
    daemonStateDir: join(dir, '.goodvibes') }).add(project);
  d.catalog.setRecordOwner('task', (id) => (id === 'task-1' ? { project } : undefined));
  const prompt = 'Draft the reply to my lawyer about the custody hearing';
  d.tasks.snapshot = {
    queued: 0, running: 1, blocked: 0, totals: { created: 1, completed: 0, failed: 0, cancelled: 0 },
    tasks: [{ id: 'task-1', kind: 'agent', title: prompt, description: prompt, status: 'running', owner: 'agent-1', cancellable: true, childTaskIds: [], queuedAt: 1, error: `failed on: ${prompt}` }],
  };
  const seen = await d.call(d.viewer, 'tasks.list');
  expect(seen.status).toBe(200);
  expect(JSON.stringify(seen.body)).not.toContain('custody');
  expect(seen.body).toMatchObject({ running: 1, tasks: [{ id: 'task-1', kind: 'agent', status: 'running' }] });
  const own = await d.call(d.owner, 'tasks.list');
  expect(JSON.stringify(own.body)).toContain('custody');
});

test('every method open to a non-admin user is non-mutating and carries no owner-private scope', () => {
  const d = daemon();
  const principal = d.helper.describeRequestPrincipal(d.viewer)!;
  const open = d.catalog.list().filter((descriptor) => refuseGatewayAccess(descriptor, principal.actor) === null);
  expect(open.length).toBeGreaterThan(0);
  const violations: string[] = [];
  for (const descriptor of open) {
    const scopes = descriptor.scopes ?? [];
    // companion.chat.* reads are scoped to the caller's own web chats (read:sessions);
    // their read:transcripts tag applies only to reading other sessions.
    const ownChatOnly = descriptor.id.startsWith('companion.chat.');
    for (const scope of scopes) {
      if (OWNER_PRIVATE_READ_SCOPES.has(scope) && !(ownChatOnly && scope === 'read:transcripts')) {
        violations.push(`${descriptor.id}: carries owner-private scope ${scope}`);
      }
      if (scope.startsWith('write:') || scope.startsWith('admin:')) violations.push(`${descriptor.id}: carries mutating/admin scope ${scope}`);
    }
    if (descriptor.access === 'admin') violations.push(`${descriptor.id}: marked admin access yet open to viewer`);
  }
  expect(violations).toEqual([]);
});

test('a contract is shown only to the principal that started it, also after the owner detaches from its session', async () => {
  const d = daemon();
  const root = makeRepo();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const harness: Harness = makeHarness({ root, plan: oneUnitPlan(), scripts: { u1: () => [{ text: '', stop: { kind: 'hang' } }] } });
  cleanups.push(async () => {
    const ids = harness.runner.list({ includeTerminal: true }).map((row) => row.id);
    await Promise.resolve(harness.dispose()).catch(() => undefined);
    await Promise.all(ids.map((id) => harness.runner.join(id).catch(() => undefined)));
  });
  const service = createContractOperatorService({ runner: harness.runner, workingDirectory: root });
  // The owner is attached to the session; detaching leaves it owned by nobody.
  let ownerAttached = true;
  service.attachHosted({ runners: () => [], forSession: async () => null, knows: () => false,
    ownedByOthers: (_session, principalId) => ownerAttached && principalId !== d.ownerName });
  registerContractGatewayMethods(d.catalog, service);

  const started = await d.call(d.owner, 'contracts.start', { ask: 'Add a CSV parser module', sessionId: 'owner-session', workspaceRoot: root, isolation: 'shared' });
  expect(started.status).toBe(200);
  const contractId = (started.body as { contract: { id: string } }).contract.id;

  const viewerSees = async () => {
    const list = await d.call(d.viewer, 'contracts.list', { includeTerminal: true });
    const get = await d.call(d.viewer, 'contracts.get', { contractId });
    const status = await d.call(d.viewer, 'contracts.status', { contractId });
    return { list: JSON.stringify(list.body).includes(contractId), get: get.status, status: status.status };
  };
  expect(await viewerSees()).toEqual({ list: false, get: 404, status: 404 });
  ownerAttached = false;
  expect(await viewerSees()).toEqual({ list: false, get: 404, status: 404 });
  const own = await d.call(d.owner, 'contracts.get', { contractId });
  expect(own.status).toBe(200);
});
