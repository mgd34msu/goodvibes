// Proves: A daemon capability acts in another project than the one its call names, or in the daemon's own folder when the call names none; or a refusing rule is escaped by naming another project.
// Red when: The daemon stops reading a program's project header into the call's context, capabilities.run stops taking the project from that context or lets it outrank the body's folder, a per-project service takes the daemon's working folder in place of a missing project instead of refusing, or a deny rule kept in one project stops applying when the call names another.
/**
 * One daemon, its own working folder and two projects. The calls go through the
 * daemon's real pieces: the header reader of its HTTP routes (daemon-api
 * `readCallContext`), its dispatch (authentication, admission), `capabilities.run`
 * and the capability services over the MCP config files. Nothing stands in for
 * the product: the method a capability might run is not reached here.
 *
 * A terminal program sends its project once per request as a header; the web UI
 * and an outside caller name it in the body. Either way the call acts there, the
 * body's folder first, and a subfolder of a repository is that repository's
 * project; with no project only the files for every project are read (never the
 * daemon folder's), and the daemon's own folder is used only when a caller names it;
 * and a rule that refuses a capability, kept in one project, is among the rules of
 * every project.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { createHookDispatcher } from '../platform/src/platform/hooks/index.ts';
import { MemoryStore } from '../platform/src/platform/state/memory-store.ts';
import { MemoryRegistry } from '../platform/src/platform/state/memory-registry.ts';
import { MemoryEmbeddingProviderRegistry } from '../platform/src/platform/state/memory-embeddings.ts';
import { CapabilityCatalog, createDaemonCapabilityServices, movedCapabilityEntries } from '../platform/src/platform/capabilities/index.ts';
import { CALL_PROJECT_HEADER } from '../platform/src/platform/runtime/client/call-context.ts';
import { daemonCallerProjectCheck } from '../platform/src/platform/daemon/facade-composition.ts';
import { UserPermissionRuleStore } from '../platform/src/platform/permissions/user-rule-store.ts';
import { ApprovalBroker } from '../platform/src/platform/control-plane/approval-broker.ts';
import { createCapabilityOwnerGate } from '../platform/src/platform/daemon/capability-owner-gate.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';

const OPERATOR_TOKEN = 'fixture-operator-token';
let dir: string;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  rmSync(dir, { recursive: true, force: true });
});

test('a capability acts in the project its call names, from its subfolder too, by header or body; with none only the files for every project; the daemon\'s folder only when named; a refusing rule in every project', async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-call-context-'));
  const home = join(dir, 'home');
  const daemonFolder = join(dir, 'daemon-own');
  const yellow = join(dir, 'projects', 'yellow');
  const zinc = join(dir, 'projects', 'zinc');
  // yellow is a repository with a subfolder: a program opened in the subfolder is in yellow (project-identity.ts).
  for (const folder of [home, daemonFolder, yellow, zinc, join(yellow, '.git'), join(yellow, 'sub')]) mkdirSync(folder, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: daemonFolder, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  const secrets = new SecretsManager({ projectRoot: daemonFolder, globalHome: home, surfaceRoot: 'daemon', daemonHome: join(home, '.goodvibes', 'daemon') });
  const memoryStore = new MemoryStore(join(dir, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(dir, 'memory-config') }) }) });
  cleanups.push(() => memoryStore.close());
  await memoryStore.init();
  const hookDispatcher = createHookDispatcher();
  const catalog = new GatewayMethodCatalog();
  const memoryRegistry = new MemoryRegistry(memoryStore);
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  // The owner's questions and rules, and `capabilities.run` with the owner's gate under ask-me, as the daemon composes them
  // (capability-wiring.ts): a call another caller makes that changes something is put to the owner and waits.
  const approvals = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  await approvals.start();
  const rules = new UserPermissionRuleStore(join(dir, 'permission-rules.json'));
  cleanups.push(() => rules.close());
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }], localOwnerActor()).ok).toBe(true);
  registerCapabilityGatewayMethods(catalog, {
    catalog: async () => new CapabilityCatalog(movedCapabilityEntries()),
    services: createDaemonCapabilityServices({ configManager: config, hookDispatcher, homeDirectory: home,
      secretsManager: secrets, memoryRegistry }),
    invokeMethod: async (methodId) => { throw new Error(`no method ${methodId} is reached in this proof`); },
    ...createCapabilityOwnerGate({ approvalBroker: approvals, configManager: config, policyRuntimeState: new PolicyRuntimeState(), hookDispatcher,
      featureFlags: null, userPermissionRuleStore: rules, secretsManager: secrets, pairingTokens: pairing,
    } as unknown as Parameters<typeof createCapabilityOwnerGate>[0]),
  });
  const userAuth = new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } });
  const helperContext = {
    gatewayMethods: catalog, pairingTokens: pairing, userAuth,
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
    // The daemon's one check of the project a call names, as the daemon composes it (facade-composition.ts).
    callerProject: daemonCallerProjectCheck(home),
  };
  const helper = new DaemonControlPlaneHelper(helperContext as unknown as DaemonControlPlaneContext);
  cleanups.push(() => helper.dispose());

  // The user's own signed-in session (the account made at first start); every credential of the user names any project.
  const ownerName = userAuth.ownerUsername();
  if (ownerName === null) throw new Error('the user store made no owner account at first start');
  const ownersSession = userAuth.createSession(ownerName).token;
  // The project folder of the MCP files a read of them names, or the refusal: where the call acted.
  const actedIn = async (headers: Record<string, string>, body: Record<string, unknown>, id = 'mcp.files', token = ownersSession): Promise<string> => {
    const call = readCallContext(new Request('http://daemon.local/api/control-plane/methods/capabilities.run/invoke', { method: 'POST', headers }));
    const answer = await helper.invokeGatewayMethodCall({ authToken: token, methodId: 'capabilities.run',
      // As the HTTP route sends it: the context carries the credential's own admin flag (a context never widens it).
      body: { id, inputs: {}, ...body }, context: { clientKind: 'tui', admin: true, ...(call ? { call } : {}) } });
    if (!answer.ok) return `refused ${answer.status} ${String((answer.body as { code?: unknown }).code)}`;
    const locations = ((answer.body as { data?: { locations?: Array<{ kind?: string; path?: string }> } }).data?.locations ?? []);
    const project = locations.find((location) => location.kind === 'project-goodvibes')?.path;
    return project ?? `no project file, ${locations.filter((location) => location.kind === 'global-xdg').length} for every project`;
  };
  const header = { [CALL_PROJECT_HEADER]: encodeURIComponent(yellow) };

  // The user's projects need no gift, but a project a call names must be registered: yellow and zinc are.
  mkdirSync(join(home, '.goodvibes', 'shared'), { recursive: true });
  writeFileSync(join(home, '.goodvibes', 'shared', 'workspace-registrations.json'), JSON.stringify({ workspaces: [yellow, zinc].map((root) => ({ root })) }));

  // A rule that refuses a capability, kept in yellow, and one that allows another there: the refusal is among zinc's rules.
  for (const [id, effect, capability] of [['refuses-in-yellow', 'deny', 'mcp.files'], ['allows-in-yellow', 'allow', 'memory.list']] as const) {
    await rules.add({ rule: { id, type: 'arg-shape', toolPattern: 'capability_run', argMatchers: { id: capability }, effect, origin: 'user' }, createdAt: Date.now(), tier: 'tool', tool: 'capability_run', project: yellow });
  }

  const rows = [
    `header ${await actedIn(header, {})}`,
    `subfolder ${await actedIn({ [CALL_PROJECT_HEADER]: encodeURIComponent(join(yellow, 'sub')) }, {})}`,
    `body over header ${await actedIn(header, { workingDirectory: zinc })}`,
    `none ${await actedIn({}, {})}`,
    `daemon's folder named ${await actedIn({}, { workingDirectory: daemonFolder })}`,
    `rules kept in yellow that apply in zinc ${rules.rules(zinc).map((rule) => rule.id).join(',')}`,
  ];
  expect(rows).toEqual([
    `header ${join(yellow, '.goodvibes', 'mcp.json')}`,
    `subfolder ${join(yellow, '.goodvibes', 'mcp.json')}`,
    `body over header ${join(zinc, '.goodvibes', 'mcp.json')}`,
    'none no project file, 1 for every project',
    `daemon's folder named ${join(daemonFolder, '.goodvibes', 'mcp.json')}`,
    'rules kept in yellow that apply in zinc refuses-in-yellow',
  ]);
});
