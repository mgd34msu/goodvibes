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
import { mkdtempSync, rmSync } from 'node:fs';
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
  userAuth.addUser('owner', 'owner-password', ['admin']);
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
  } as unknown as DaemonControlPlaneContext);
  const owner = userAuth.createSession('owner').token;
  const viewer = userAuth.createSession('viewer').token;
  const call = (token: string, methodId: string, body: Record<string, unknown> = {}) =>
    helper.invokeGatewayMethodCall({ authToken: token, methodId, body });
  return { userAuth, catalog, pairing, helper, owner, viewer, call, tasks };
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
    'sessions.list', 'sessions.search', 'sessions.hosted.list', 'companion.chat.sessions.list', 'routes.snapshot', 'deliveries.list']) {
    const refused = await d.call(d.viewer, methodId, { sessionId: 'owner-session' });
    expect(`${methodId}: ${refused.status}`).toBe(`${methodId}: 403`);
    expect(JSON.stringify(refused.body)).not.toContain('owner phone');
  }
  // The owner reads the same list.
  const listed = await d.call(d.owner, 'pairing.tokens.list');
  expect(listed.status).toBe(200);
  expect(JSON.stringify(listed.body)).toContain('owner phone');
});

/**
 * Every method a signed-in user without the admin role may call, reviewed,
 * each with why it is open: it returns only the caller's own records or status
 * that is not the owner's content (counts, states, names, configuration). The
 * owner's content (mail, profile, purchases, dates, memory, transcripts and the
 * session listings drawn from them, paired devices and peers, calendar,
 * approvals, named people, workspace file contents, and the records of his
 * browser, knowledge, channels, automations, fleet and skills) is absent because
 * its scopes are outside that grant.
 */
const OPEN_TO_NON_ADMIN: ReadonlyMap<string, string> = new Map([
  ['accounts.snapshot', 'provider routes, readiness and freshness; no account identity'],
  ['acp.agents.list', 'which coding agents are installed on PATH'],
  ['automation.heartbeat.list', 'job names and why each is queued; no prompt or output'],
  ['automation.integration.snapshot', 'job names, schedules and run states; no prompt or output'],
  ['batch.runtime.get', 'the batch queue mode'],
  ['browser.sessions.list', 'open browser sessions and page counts; no URL or page text'],
  ['browser.status', 'whether a browser is available and which sessions are open'],
  ['channels.actions.list', 'actions channel plugins register'],
  ['channels.actions.surface.list', 'actions of one surface'],
  ['channels.agent_tools.list', 'tools channel plugins expose'],
  ['channels.agent_tools.surface.list', 'tools of one surface'],
  ['channels.capabilities.list', 'what each surface supports'],
  ['channels.capabilities.surface.list', 'what one surface supports'],
  ['channels.doctor.get', 'setup checks of one surface'],
  ['channels.lifecycle.get', 'version posture of one surface'],
  ['channels.policies.list', 'ingress policy configuration'],
  ['channels.profiles.get', 'the session defaults one channel applies'],
  ['channels.profiles.list', 'the session defaults each channel applies'],
  ['channels.repairs.list', 'repair actions a surface offers'],
  ['channels.routing.list', 'the channel-to-profile routing table'],
  ['channels.setup.get', 'the setup schema of one surface'],
  ['channels.status', 'channel plugin status'],
  ['channels.tools.list', 'operator tools channel plugins register'],
  ['channels.tools.surface.list', 'operator tools of one surface'],
  ['checkin.config.get', 'check-in settings and whether the schedule is installed'],
  ['ci.status', 'job conclusions of a repository ref'],
  ['ci.watches.list', 'standing CI watches and their states'],
  ['continuity.snapshot', 'session recovery state'],
  ['contracts.get', 'only a contract the caller started (see the contract test below)'],
  ['contracts.list', 'only contracts the caller started'],
  ['contracts.status', 'only a contract the caller started'],
  ['contracts.summaries', 'only contracts the caller started'],
  ['control.auth.current', 'the caller\'s own principal and grant'],
  ['control.auth.login', 'signing in'],
  ['control.auth.logout', 'ending the caller\'s own sign-in'],
  ['control.clients.list', 'connected clients and when they were seen'],
  ['control.contract', 'the published operator contract'],
  ['control.events.catalog', 'the event catalog'],
  ['control.events.stream', 'the event stream, held to the caller\'s event grant'],
  ['control.methods.get', 'one method descriptor'],
  ['control.methods.list', 'the method catalog'],
  ['control.status', 'daemon status and version'],
  ['control.web', 'a redirect into the web app'],
  ['cost.attribution.get', 'cost totals by dimension'],
  ['flags.graduation.report', 'feature defaults'],
  ['health.snapshot', 'daemon health'],
  ['homeassistant.conversation.health', 'whether the Home Assistant surface is on'],
  ['homeassistant.homeGraph.status', 'Home Graph counts and state; its records need read:knowledge-content'],
  ['intelligence.snapshot', 'language server status and diagnostic counts'],
  ['knowledge.connector.doctor', 'setup checks of a knowledge connector'],
  ['knowledge.connector.get', 'a connector manifest'],
  ['knowledge.connectors.list', 'available knowledge connectors'],
  ['knowledge.graphql.schema', 'the knowledge GraphQL schema text'],
  ['knowledge.job-runs.list', 'maintenance job runs and their outcomes'],
  ['knowledge.job.get', 'a maintenance job definition'],
  ['knowledge.jobs.list', 'maintenance job definitions'],
  ['knowledge.projections.list', 'projection targets that can be rendered'],
  ['knowledge.schedule.get', 'a maintenance schedule'],
  ['knowledge.schedules.list', 'maintenance schedules'],
  ['knowledge.status', 'knowledge record counts; the records need read:knowledge-content'],
  ['mcp.config.get', 'MCP configuration with values and credentials redacted'],
  ['mcp.servers.list', 'configured MCP servers and their sandbox posture'],
  ['mcp.tools.list', 'connected MCP tools'],
  ['media.providers.list', 'media provider capabilities'],
  ['models.current.get', 'the model a turn would use'],
  ['models.list', 'providers and their models'],
  ['multimodal.providers.list', 'multimodal provider catalog'],
  ['multimodal.status', 'multimodal runtime status'],
  ['notifications.deadLetters.list', 'failed notifications in their metadata-only form'],
  ['ops.doctor', 'runbooks for a symptom'],
  ['ops.memory.get', 'memory pressure of the daemon'],
  ['pairing.posture.get', 'TLS posture of a web origin'],
  ['panels.list', 'integration panel descriptors'],
  ['power.status.get', 'whether the host is kept awake and why'],
  ['projectPlanning.status', 'planning artifact counts; the plan needs read:knowledge-content'],
  ['providers.get', 'one provider\'s runtime metadata'],
  ['providers.list', 'provider runtime metadata'],
  ['providers.usage.get', 'one provider\'s usage and pricing'],
  ['push.subscriptions.list', 'only the caller\'s own push devices'],
  ['push.vapid.get', 'the public push key'],
  ['quota.fanout.get', 'whether a fan-out would exhaust a quota window'],
  ['quota.snapshot.get', 'the last observed quota window'],
  ['relay.reachability.get', 'relay registration state'],
  ['remote.node_host.contract', 'the published node host contract; peers need read:remote'],
  ['review.snapshot', 'counts of sessions, tasks, approvals and panels'],
  ['runtime.metrics.get', 'process-wide counters and histograms'],
  ['secureAddress.get', 'the https address, its names and end date, the local authority\'s public fingerprint; no key or token'],
  ['sessions.contextUsage.get', 'context window token counts'],
  ['sessions.hosted.workspaces', 'folders a hosted session may use'],
  ['sessions.permissionMode.get', 'the effective permission mode'],
  ['skills.list', 'skill index lines; bodies need read:skill-content'],
  ['stepup.challenge.mint', 'a single-use challenge for the caller\'s own relay call'],
  ['surfaces.list', 'registered surfaces'],
  ['tailscale.get', 'whether tailscale is usable'],
  ['tasks.list', 'task counts and states; each row\'s title, prompt and error need read:transcripts'],
  ['telemetry.errors.list', 'telemetry records, redacted without read:telemetry-sensitive'],
  ['telemetry.events.list', 'telemetry events, redacted without read:telemetry-sensitive'],
  ['telemetry.metrics.get', 'telemetry aggregates'],
  ['telemetry.otlp.logs', 'redacted telemetry as OTLP logs'],
  ['telemetry.otlp.metrics', 'telemetry metrics as OTLP'],
  ['telemetry.otlp.traces', 'redacted telemetry as OTLP traces'],
  ['telemetry.snapshot', 'redacted telemetry snapshot'],
  ['telemetry.stream', 'the redacted telemetry stream'],
  ['telemetry.traces.list', 'redacted spans'],
  ['update.status', 'whether the daemon keeps itself current'],
  ['voice.local.status', 'whether the local voice runtime is installed'],
  ['voice.providers.list', 'voice providers'],
  ['voice.status', 'voice provider posture'],
  ['voice.voices.list', 'voices a provider offers'],
  ['voice.wake.model.get', 'the published wake-word model bytes'],
  ['voice.wake.status', 'whether the wake-word model is on disk and verified'],
  ['watchers.list', 'configured watchers and their states'],
  ['web_search.providers.list', 'web search provider capabilities'],
  ['workspaces.registrations.list', 'registered workspace roots'],
  ['workspaces.resolve', 'whether a path is in a registered workspace'],
  ['worktrees.snapshot', 'worktree records: paths, branches, owners'],
]);

test('a non-admin user reads task counts and states but not an agent task\'s prompt or error', async () => {
  const d = daemon();
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

test('every method open to a non-admin user is on the reviewed list, and the list names nothing that is not', () => {
  const d = daemon();
  // The actor the daemon builds for the viewer's credential, as the request path admits it.
  const principal = d.helper.describeRequestPrincipal(d.viewer)!;
  const open = d.catalog.list().filter((descriptor) => refuseGatewayAccess(descriptor, principal.actor) === null).map((descriptor) => descriptor.id);
  expect(open.filter((id) => !OPEN_TO_NON_ADMIN.has(id))).toEqual([]);
  expect([...OPEN_TO_NON_ADMIN.keys()].filter((id) => !open.includes(id))).toEqual([]);
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
    ownedByOthers: (_session, principalId) => ownerAttached && principalId !== 'owner' });
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
