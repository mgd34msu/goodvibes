// Proves: A "this project" memory remembered in one project is given to work in another project, or is kept with no project when the call names none.
// Red when: The memory store stops filtering a search by the asking project, memory.add stops stamping the caller's project on a project record, or a project record is kept for a call that names no project.
/**
 * Memory is one store for the person (the daemon's home). A record kept for "this project" carries the project it was
 * remembered in and is given only to work there; the person's own records go everywhere. The calls go through the
 * daemon's real pieces: dispatch, `capabilities.run`, the memory capabilities and the memory store over its file.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerCapabilityGatewayMethods } from '../platform/src/platform/control-plane/routes/capabilities.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { createHookDispatcher } from '../platform/src/platform/hooks/index.ts';
import { MemoryStore } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { CapabilityCatalog, createDaemonCapabilityServices, movedCapabilityEntries } from '../platform/src/platform/capabilities/index.ts';
import { daemonCallerProjectCheck } from '../platform/src/platform/daemon/facade-composition.ts';
import { createDaemonIntegrationRouteHandlers } from '../daemon-api/src/integration-routes.ts';
import type { DaemonIntegrationRouteContext } from '../daemon-api/src/integration-route-types.ts';
import { memoryProjectOf } from '../platform/src/platform/state/memory-project.ts';

const OPERATOR_TOKEN = 'fixture-operator-token';
let dir: string;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test('a project\'s memory is given to work in that project only, and none is kept for a call that names no project', async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-memory-project-'));
  const home = join(dir, 'home');
  const daemonFolder = join(dir, 'daemon-own');
  const yellow = join(dir, 'projects', 'yellow');
  const zinc = join(dir, 'projects', 'zinc');
  for (const folder of [home, daemonFolder, yellow, zinc]) mkdirSync(folder, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: daemonFolder, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  const secrets = new SecretsManager({ projectRoot: daemonFolder, globalHome: home, surfaceRoot: 'daemon', daemonHome: join(home, '.goodvibes', 'daemon') });
  const memoryStore = new MemoryStore(join(dir, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(dir, 'memory-config') }) }) });
  cleanups.push(() => memoryStore.close());
  await memoryStore.init();
  const hookDispatcher = createHookDispatcher();
  const catalog = new GatewayMethodCatalog();
  registerCapabilityGatewayMethods(catalog, {
    catalog: async () => new CapabilityCatalog(movedCapabilityEntries()),
    services: createDaemonCapabilityServices({ configManager: config, hookDispatcher, homeDirectory: home,
      secretsManager: secrets, memoryRegistry: new MemoryRegistry(memoryStore) }),
    invokeMethod: async (methodId) => { throw new Error(`no method ${methodId} is reached in this proof`); },
  });
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, pairingTokens: new PairingTokenManager(join(dir, 'pairing-tokens.json')),
    userAuth,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    // The daemon's one check of the project a caller names, as every daemon composes it (facade-composition.ts).
    callerProject: daemonCallerProjectCheck(home),
  } as unknown as DaemonControlPlaneContext);
  // The user's own signed-in session (the account made at first start).
  const ownerName = userAuth.ownerUsername();
  if (ownerName === null) throw new Error('the user store made no owner account at first start');
  const owner = userAuth.createSession(ownerName).token;
  const run = async (id: string, inputs: Record<string, string>, project?: string): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
    // The owner's own press on their own screen, in the project they name.
    const answer = await helper.invokeGatewayMethodCall({ authToken: owner, methodId: 'capabilities.run',
      body: { id, inputs, ...(project ? { workingDirectory: project } : {}) }, context: { admin: true, explicitUserRequest: true } });
    return { ok: answer.ok, status: answer.status, body: answer.body as Record<string, unknown> };
  };
  const found = async (project: string): Promise<string> => {
    const answer = await run('memory.search', {}, project);
    const records = ((answer.body['data'] as { records?: Array<{ summary: string }> } | undefined)?.records ?? []).map((record) => record.summary).sort();
    return records.join(', ') || 'nothing';
  };
  await run('memory.add', { class: 'constraint', summary: 'yellow only: never touch the payments schema', scope: 'project' }, yellow);
  await run('memory.add', { class: 'decision', summary: 'zinc only: keep the old parser', scope: 'project' }, zinc);
  const none = await run('memory.add', { class: 'fact', summary: 'kept for no project', scope: 'project' });
  // The list a place open in a project reads (the terminal programs' Memory place, the web UI's): the daemon's records
  // route, its call naming the project by the header every program and the web UI send.
  const routes = createDaemonIntegrationRouteHandlers({
    memoryRegistry: new MemoryRegistry(memoryStore), memoryProjectOf,
    parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
  } as unknown as DaemonIntegrationRouteContext);
  const listed = async (project: string): Promise<string> => {
    const answer = await routes.postMemoryRecordList(new Request('http://127.0.0.1/api/memory/records/list', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-goodvibes-project': encodeURIComponent(project) }, body: '{}' }));
    const records = ((await (answer as Response).json()) as { records?: Array<{ summary: string }> }).records ?? [];
    return records.map((record) => record.summary).sort().join(', ') || 'nothing';
  };
  const rows = [
    `from yellow: ${await found(yellow)}`,
    `from zinc: ${await found(zinc)}`,
    `this project with none: ${none.ok ? 'kept' : `refused ${none.status} ${String(none.body['error']).slice(0, 22)}`}`,
    `listed in zinc's place: ${await listed(zinc)}`,
  ];
  expect(rows).toEqual([
    'from yellow: yellow only: never touch the payments schema',
    'from zinc: zinc only: keep the old parser',
    'this project with none: refused 409 Nothing was remembered',
    'listed in zinc\'s place: zinc only: keep the old parser',
  ]);
  expect((await memoryStore.search({})).map((record) => record.summary)).not.toContain('kept for no project');
});
