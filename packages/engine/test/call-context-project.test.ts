// Proves: A daemon capability acts in another project than the one its call names, or in the daemon's own folder when the call names none.
// Red when: The daemon stops reading a program's project header into the call's context, capabilities.run stops taking the project from that context or lets it outrank the body's folder, or a per-project service takes the daemon's working folder in place of a missing project instead of refusing.
/**
 * One daemon, its own working folder and two projects. The calls go through the
 * daemon's real pieces: the header reader of its HTTP routes (daemon-api
 * `readCallContext`), its dispatch (authentication, admission), `capabilities.run`
 * and the capability services over the MCP config files. Nothing stands in for
 * the product: the method a capability might run is not reached here.
 *
 * A terminal program sends its project once per request as a header; the web UI
 * and an outside caller name it in the body. Either way the call acts there, the
 * body's folder first; with no project the call is refused, and the daemon's
 * own folder is used only when a caller names it.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCallContext } from '../daemon-api/src/control-routes.ts';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { ControlPlaneGateway } from '../platform/src/platform/control-plane/gateway.ts';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { registerCapabilityGatewayMethods } from '../platform/src/platform/control-plane/routes/capabilities.ts';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../platform/src/platform/daemon/control-plane.ts';
import { PairingTokenManager } from '../platform/src/platform/pairing/pairing-token-store.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { UserAuthManager } from '../platform/src/platform/security/user-auth.ts';
import { createHookDispatcher, createHookWorkbench } from '../platform/src/platform/hooks/index.ts';
import { MemoryStore } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { CapabilityCatalog, createDaemonCapabilityServices, movedCapabilityEntries } from '../platform/src/platform/capabilities/index.ts';
import { CALL_PROJECT_HEADER } from '../platform/src/platform/runtime/client/call-context.ts';

const OPERATOR_TOKEN = 'fixture-operator-token';
let dir: string;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test('a capability acts in the project its call names, by header or body, and is refused with none; the daemon\'s folder only when named', async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-call-context-'));
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
      hookWorkbench: createHookWorkbench({ hookDispatcher, configManager: config }), secretsManager: secrets, memoryRegistry: new MemoryRegistry(memoryStore) }),
    invokeMethod: async (methodId) => { throw new Error(`no method ${methodId} is reached in this proof`); },
  });
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, pairingTokens: new PairingTokenManager(join(dir, 'pairing-tokens.json')),
    userAuth: new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } }),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
  } as unknown as DaemonControlPlaneContext);

  // The project folder of the MCP files a read of them names, or the refusal: where the call acted.
  const actedIn = async (headers: Record<string, string>, body: Record<string, unknown>): Promise<string> => {
    const call = readCallContext(new Request('http://daemon.local/api/control-plane/methods/capabilities.run/invoke', { method: 'POST', headers }));
    const answer = await helper.invokeGatewayMethodCall({ authToken: OPERATOR_TOKEN, methodId: 'capabilities.run',
      body: { id: 'mcp.files', inputs: {}, ...body }, context: { clientKind: 'tui', ...(call ? { call } : {}) } });
    if (!answer.ok) return `refused ${answer.status} ${String((answer.body as { code?: unknown }).code)}`;
    const locations = ((answer.body as { data?: { locations?: Array<{ kind?: string; path?: string }> } }).data?.locations ?? []);
    return locations.find((location) => location.kind === 'project-goodvibes')?.path ?? 'no project file named';
  };
  const header = { [CALL_PROJECT_HEADER]: encodeURIComponent(yellow) };
  const rows = [
    `header ${await actedIn(header, {})}`,
    `body over header ${await actedIn(header, { workingDirectory: zinc })}`,
    `none ${await actedIn({}, {})}`,
    `daemon's folder named ${await actedIn({}, { workingDirectory: daemonFolder })}`,
  ];
  expect(rows).toEqual([
    `header ${join(yellow, '.goodvibes', 'mcp.json')}`,
    `body over header ${join(zinc, '.goodvibes', 'mcp.json')}`,
    'none refused 422 NO_PROJECT',
    `daemon's folder named ${join(daemonFolder, '.goodvibes', 'mcp.json')}`,
  ]);
});
