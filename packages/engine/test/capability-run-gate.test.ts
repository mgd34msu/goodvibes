// Proves: A capability that writes a credential runs when a model calls it through capability_run without the owner being asked, or the owner's own request for it is put to him a second time.
// Red when: capability_run's definition stops putting a capability that declares secret.write (secrets.set) among the calls that loosen a protection, so Jev settles the model's call and the secret is stored, or capabilities.run stops running a person's own request at once.
/**
 * `capability_run` is registered as a terminal program registers it, in a
 * real tool registry bound to a real PermissionManager in jev-decides. The
 * daemon is the real control-plane dispatch (authentication, admission, the
 * capability handlers over a real secret store, hook workbench and memory
 * store in a scratch home). The stand-ins are what is outside the product:
 * the decision model, which answers act to every disposition, and the owner's
 * answer to an ask, which is No.
 *
 * Storing a secret writes a credential (secret.write): a model's call of it is
 * the owner's to decide, as a call that loosens a protection is, even kept
 * encrypted. It is put to the owner and, on No, stores nothing; the owner
 * typing the line on his own screen (his paired device's credential, with a
 * person's claim) stores it at once, asked nothing.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes/judgment';
import { choiceAnswer, fakePort } from '@goodvibes/judgment/testing';
import { installJudgmentPort } from '@goodvibes/engine/errors';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { SecretsManager } from '../platform/src/platform/config/secrets.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { createShellPathService } from '../platform/src/platform/runtime/shell-paths.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
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
import type { DaemonVerbCaller } from '../platform/src/platform/runtime/client/daemon-verbs.ts';
import { registerCapabilityTools } from '../terminal-shell/src/agent-turn/capability-tools.ts';
import { createSecretsCommand, type SecretsCommandContext } from '../terminal-shell/src/secrets-command.ts';
import { forgetGateReadings, gateReadingsPort } from './_helpers/gate-readings.ts';

const OPERATOR_TOKEN = 'fixture-operator-token';

let dir: string;
let restorePort: () => void;
const cleanups: Array<() => void | Promise<void>> = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gv-capability-run-gate-'));
  forgetGateReadings();
  const readings = gateReadingsPort();
  // The decision model, outside the product: it would let every call run.
  const disposition = fakePort((name, question) => {
    if (name !== 'disposition') throw new Error(`unexpected question ${name}`);
    return choiceAnswer(question, 'act', 0.97);
  });
  const log = new SqliteDecisionLog(':memory:');
  const port: JudgmentPort = { model: 'fixture-model', ask: (request) =>
    request.context?.site === 'engine.gate.autonomous-tool' ? disposition.port.ask(request) : readings.port.ask(request) };
  const previous = installJudgmentPort(withDecisionLog(port, log));
  restorePort = () => { installJudgmentPort(previous); log[Symbol.dispose](); forgetGateReadings(); };
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  restorePort();
  rmSync(dir, { recursive: true, force: true });
});

test('a model\'s capability_run that stores a secret is put to the owner and stores nothing on No; the owner\'s own line stores it at once', async () => {
  const home = join(dir, 'home');
  const workspace = join(dir, 'workspace');
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'tui', workingDir: workspace, homeDir: home, configDir: join(home, '.goodvibes', 'tui'), ownsDaemonTier: true });
  expect(config.setMany([
    { key: 'permissions.mode' as ConfigKey, value: 'jev-decides' },
    { key: 'judgment.endpoint' as ConfigKey, value: 'http://127.0.0.1:9/v1' },
    { key: 'judgment.model' as ConfigKey, value: 'fixture-model' },
    { key: 'judgment.keySource' as ConfigKey, value: 'secret' },
  ], localOwnerActor()).ok).toBe(true);

  // The daemon: real dispatch over the capabilities and their stores.
  const secrets = new SecretsManager({ projectRoot: workspace, globalHome: home, surfaceRoot: 'daemon', daemonHome: join(home, '.goodvibes', 'daemon') });
  const memoryStore = new MemoryStore(join(dir, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(dir, 'memory-config') }) }) });
  cleanups.push(() => memoryStore.close());
  await memoryStore.init();
  const hookDispatcher = createHookDispatcher();
  const catalog = new GatewayMethodCatalog();
  const reached: string[] = [];
  registerCapabilityGatewayMethods(catalog, {
    catalog: async () => new CapabilityCatalog(movedCapabilityEntries()),
    services: createDaemonCapabilityServices({ configManager: config, hookDispatcher,
      hookWorkbench: createHookWorkbench({ hookDispatcher, configManager: config }), secretsManager: secrets, memoryRegistry: new MemoryRegistry(memoryStore) }),
    invokeMethod: async (methodId) => { throw new Error(`no method ${methodId} in this proof`); },
  });
  const pairing = new PairingTokenManager(join(dir, 'pairing-tokens.json'));
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog, pairingTokens: pairing,
    userAuth: new UserAuthManager({ bootstrapFilePath: join(dir, 'users.json'), bootstrapCredentialPath: join(dir, 'bootstrap.txt'), scryptParams: { N: 1024, r: 1, p: 1 } }),
    controlPlaneGateway: new ControlPlaneGateway({ runtimeBus: new RuntimeEventBus() }),
    authToken: () => OPERATOR_TOKEN, trustProxyEnabled: () => false, host: '127.0.0.1', port: 0,
  } as unknown as DaemonControlPlaneContext);

  // The model's side: the real gate, registry and capability tools of a terminal program.
  const asks: { readonly ownerOnly?: unknown }[] = [];
  const manager = new PermissionManager(async (request) => { asks.push(request as { ownerOnly?: unknown }); return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, {});
  const registry = new ToolRegistry(manager);
  const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
  registerCapabilityTools(registry, shellPaths, config, {
    catalog: () => new CapabilityCatalog(movedCapabilityEntries()), program: 'tui', workingDirectory: () => workspace,
  });
  const deps: ToolExecutionDeps = { permissionManager: manager, toolRegistry: registry,
    autonomousSource: () => ({ goal: 'Set up the owner\'s project keys', criteria: [] }),
    hookDispatcher: null, runtimeBus: null, sessionId: 'turn', emitterContext: () => ({ sessionId: 'turn', traceId: 'turn', source: 'orchestrator' }) };
  let calls = 0;
  const run = async (name: string, args: Record<string, unknown>) =>
    (await executeToolCalls(deps, `turn-${++calls}`, [{ id: `call-${calls}`, name, arguments: args }]))[0]!;
  expect((await run('tool_schema', { names: ['capability_run'] })).success).toBe(true);

  const modelCall = await run('capability_run', { id: 'secrets.set', inputs: { key: 'MODEL_KEY', value: 'model-value', scope: 'user', storage: 'secure' } });
  expect(`${modelCall.success ? 'ran' : 'refused'}; asked ${asks.length} (${asks.map((ask) => String(ask.ownerOnly)).join(',')}); stored ${await secrets.get('MODEL_KEY') !== null}`)
    .toBe('refused; asked 1 (loosen-security); stored false');

  // The owner's own screen: his paired device types the same line, and it runs at once.
  const device = pairing.mint({ name: 'owner phone', origin: 'owner-pairing' }).token;
  const daemon: DaemonVerbCaller = {
    probe: () => ({ available: true }),
    async invoke<T>(methodId: string, input?: unknown, options?: { readonly explicitUserRequest?: boolean | undefined }): Promise<T> {
      reached.push(methodId);
      // As the HTTP route calls it: the context carries what the transport read (a context never widens the credential).
      const answer = await helper.invokeGatewayMethodCall({ authToken: device, methodId, body: input,
        context: { admin: true, ...(options?.explicitUserRequest ? { explicitUserRequest: true } : {}) } });
      if (!answer.ok) throw new Error(JSON.stringify(answer.body));
      return answer.body as T;
    },
  };
  const printed: string[] = [];
  const command = createSecretsCommand<SecretsCommandContext>({ writeScope: (_key, requested) => requested, deleteScope: (_key, requested) => requested, relocationNote: () => '' },
    { daemon: () => daemon, caller: () => ({ workingDirectory: workspace, program: 'tui' }) });
  await command.handler(['set', 'OWNER_KEY', 'owner-value', '--scope', 'user', '--storage', 'plaintext'],
    { print: (line: string) => printed.push(line), platform: { secretsManager: null } } as SecretsCommandContext);
  expect(`asked ${asks.length}; reached ${reached.join(',')}; stored ${await secrets.get('OWNER_KEY') !== null}; said ${printed.join(' ').includes('This loosened a protection')}`)
    .toBe('asked 1; reached capabilities.run; stored true; said true');
});
