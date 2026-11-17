/**
 * A signed-in user without the admin role cannot read the owner's
 * transcripts, paired devices or contracts. Every method open to that user is
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
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, userAuth, pairingTokens: pairing,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => 'fixture-operator-token', trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
  } as unknown as DaemonControlPlaneContext);
  const owner = userAuth.createSession('owner').token;
  const viewer = userAuth.createSession('viewer').token;
  const call = (token: string, methodId: string, body: Record<string, unknown> = {}) =>
    helper.invokeGatewayMethodCall({ authToken: token, methodId, body });
  return { userAuth, catalog, pairing, helper, owner, viewer, call };
}

test('a non-admin user cannot read transcripts, paired devices or any owner-private record', async () => {
  const d = daemon();
  // A token is listed as a device once it has been used.
  expect(d.pairing.authenticate(d.pairing.mint({ name: 'owner phone' }).token)).not.toBeNull();
  const principal = d.helper.describeRequestPrincipal(d.viewer)!;
  expect(principal.admin).toBe(false);
  for (const scope of [...OWNER_PRIVATE_READ_SCOPES]) expect(`${scope}: ${principal.scopes.includes(scope)}`).toBe(`${scope}: false`);
  for (const methodId of ['sessions.get', 'sessions.messages.list', 'sessions.inputs.list', 'pairing.tokens.list']) {
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
 * Every method a signed-in user without the admin role may call, reviewed.
 * Owner-private reads (mail, profile, purchases, dates, memory, transcripts,
 * paired devices) are absent because their scopes are outside that grant;
 * contracts are listed because each contract is shown only to the principal
 * that started it (see the contract test below).
 */
const OPEN_TO_NON_ADMIN: ReadonlySet<string> = new Set([
  'accounts.snapshot',
  'acp.agents.list',
  'approvals.list',
  'automation.heartbeat.list', 'automation.integration.snapshot', 'automation.jobs.list', 'automation.runs.get', 'automation.runs.list',
  'automation.schedules.list',
  'batch.jobs.get', 'batch.jobs.list', 'batch.runtime.get',
  'browser.extract', 'browser.readText', 'browser.screenshot', 'browser.sessions.list', 'browser.snapshot', 'browser.status',
  'browser.tabs.list', 'browser.waitFor',
  'calendar.calendars.list', 'calendar.events.get', 'calendar.events.list', 'calendar.ics.export',
  'channels.accounts.get', 'channels.accounts.list', 'channels.accounts.surface.list', 'channels.actions.list',
  'channels.actions.surface.list', 'channels.agent_tools.list', 'channels.agent_tools.surface.list', 'channels.capabilities.list',
  'channels.capabilities.surface.list', 'channels.directory.query', 'channels.doctor.get', 'channels.drafts.get', 'channels.drafts.list',
  'channels.inbox.list', 'channels.lifecycle.get', 'channels.policies.audit', 'channels.policies.list', 'channels.profiles.get',
  'channels.profiles.list', 'channels.repairs.list', 'channels.routing.list', 'channels.setup.get', 'channels.status',
  'channels.tools.list', 'channels.tools.surface.list',
  'checkin.config.get', 'checkin.receipts.list',
  'checkpoints.diff', 'checkpoints.list', 'checkpoints.restorePreview', 'checkpoints.revertHunkPreview',
  'ci.status', 'ci.watches.list',
  'companion.chat.sessions.list',
  'continuity.snapshot',
  'contracts.get', 'contracts.list', 'contracts.status', 'contracts.summaries',
  'control.auth.current', 'control.auth.login', 'control.clients.list', 'control.contract', 'control.events.catalog',
  'control.events.stream', 'control.messages.list', 'control.methods.get', 'control.methods.list', 'control.snapshot', 'control.status',
  'control.web',
  'cost.attribution.get',
  'deliveries.get', 'deliveries.list',
  'devices.grants.list', 'devices.nodes.list',
  'flags.graduation.report',
  'fleet.archived.list', 'fleet.attempts.list', 'fleet.conflicts.list', 'fleet.graph.get', 'fleet.list', 'fleet.snapshot',
  'health.snapshot',
  'homeassistant.conversation.health', 'homeassistant.homeGraph.askHomeGraph', 'homeassistant.homeGraph.browse',
  'homeassistant.homeGraph.export', 'homeassistant.homeGraph.listHomeGraphIssues', 'homeassistant.homeGraph.map',
  'homeassistant.homeGraph.pages.list', 'homeassistant.homeGraph.refinement.task.get', 'homeassistant.homeGraph.refinement.tasks.list',
  'homeassistant.homeGraph.sources.list', 'homeassistant.homeGraph.status',
  'inbox.list',
  'intelligence.snapshot',
  'knowledge.ask', 'knowledge.candidate.get', 'knowledge.candidates.list', 'knowledge.connector.doctor', 'knowledge.connector.get',
  'knowledge.connectors.list', 'knowledge.extraction.get', 'knowledge.extractions.list', 'knowledge.graphql.execute',
  'knowledge.graphql.schema', 'knowledge.issues.list', 'knowledge.item.get', 'knowledge.job.get', 'knowledge.job-runs.list',
  'knowledge.jobs.list', 'knowledge.map', 'knowledge.nodes.list', 'knowledge.packet', 'knowledge.projection.render',
  'knowledge.projections.list', 'knowledge.refinement.task.get', 'knowledge.refinement.tasks.list', 'knowledge.report.get',
  'knowledge.reports.list', 'knowledge.schedule.get', 'knowledge.schedules.list', 'knowledge.search', 'knowledge.source.extraction.get',
  'knowledge.sources.list', 'knowledge.status', 'knowledge.usage.list',
  'mcp.config.get', 'mcp.servers.list', 'mcp.tools.list',
  'media.providers.list',
  'models.current.get', 'models.list',
  'multimodal.providers.list', 'multimodal.status',
  'notifications.deadLetters.list',
  'ops.doctor', 'ops.memory.get',
  'pairing.posture.get',
  'panels.list',
  'permissions.rules.list',
  'power.status.get',
  'principals.get', 'principals.list', 'principals.resolve',
  'projectPlanning.decisions.list', 'projectPlanning.language.get', 'projectPlanning.state.get', 'projectPlanning.status',
  'projectPlanning.workPlan.snapshot', 'projectPlanning.workPlan.task.get', 'projectPlanning.workPlan.tasks.list',
  'providers.get', 'providers.list', 'providers.usage.get',
  'push.subscriptions.list', 'push.vapid.get',
  'quota.fanout.get', 'quota.snapshot.get',
  'relay.reachability.get',
  'remote.node_host.contract', 'remote.pair.requests.list', 'remote.peers.get', 'remote.peers.list', 'remote.snapshot', 'remote.work.list',
  'review.snapshot',
  'rewind.plan',
  'routes.snapshot',
  'runtime.metrics.get',
  'sessions.changes.get', 'sessions.contextUsage.get', 'sessions.hosted.list', 'sessions.hosted.workspaces',
  'sessions.integration.snapshot', 'sessions.list', 'sessions.permissionMode.get', 'sessions.search',
  'skills.get', 'skills.list',
  'stepup.challenge.mint',
  'surfaces.list',
  'tailscale.get',
  'tasks.get', 'tasks.list', 'tasks.status',
  'telemetry.errors.list', 'telemetry.events.list', 'telemetry.metrics.get', 'telemetry.otlp.logs', 'telemetry.otlp.metrics',
  'telemetry.otlp.traces', 'telemetry.snapshot', 'telemetry.stream', 'telemetry.traces.list',
  'update.status',
  'voice.local.status', 'voice.providers.list', 'voice.status', 'voice.voices.list', 'voice.wake.model.get', 'voice.wake.status',
  'watchers.list',
  'web_search.providers.list',
  'workspaces.registrations.list', 'workspaces.resolve',
  'worktrees.snapshot',
]);

test('every method open to a non-admin user is on the reviewed list, and the list names nothing that is not', () => {
  const d = daemon();
  const principal = d.helper.describeRequestPrincipal(d.viewer)!;
  const open = d.catalog.list().filter((descriptor) => refuseGatewayAccess(descriptor, principal) === null).map((descriptor) => descriptor.id);
  expect(open.filter((id) => !OPEN_TO_NON_ADMIN.has(id))).toEqual([]);
  expect([...OPEN_TO_NON_ADMIN].filter((id) => !open.includes(id))).toEqual([]);
});

test('a contract is shown only to the principal that started it, also after the owner detaches from its session', async () => {
  const d = daemon();
  const root = makeRepo();
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const harness: Harness = makeHarness({ root, contract: { maxActiveContracts: 0 }, plan: oneUnitPlan(), scripts: {} });
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
