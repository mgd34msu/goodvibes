import { afterEach, expect, test, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { createClientRuntimeServices, type ClientRuntimeServices } from '../platform/src/platform/runtime/client-services.ts';
import { SessionLiveTurnControlsHolder } from '../platform/src/platform/control-plane/routes/session-runtime.ts';
import { HostedSessionManager } from '../platform/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore, describeInvalidPersistedHostedSession } from '../platform/src/platform/hosted-sessions/store.ts';
import { currentExecutionModeOwner, isYoloExecution, type ExecutionModeOwner } from '../platform/src/platform/gate/execution-context.ts';
import { createHostedSessionRuntime } from '../platform/src/platform/hosted-sessions/session-runtime.ts';
import type { ChatRequest, ChatResponse, LLMProvider } from '../platform/src/platform/providers/interface.ts';
import type { ModelDefinition } from '../platform/src/platform/providers/registry.ts';
import { installHostedSessionReadings } from './_helpers/hosted-session-readings.ts';

const roots: string[] = [];
const disposals: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const answer = (): ChatResponse => ({ content: 'Complete.', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' });

function fixture(chat: (request: ChatRequest) => Promise<ChatResponse> = async () => answer(), existingRoot?: string) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), 'hosted-mode-'));
  if (!existingRoot) roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  const config = new ConfigManager({ surfaceRoot: 'goodvibes', configDir: join(root, 'cfg'), workingDir: workspace, homeDir: root });
  config.set('permissions.mode', 'safe-owner');
  const bus = new RuntimeEventBus();
  const controls = new SessionLiveTurnControlsHolder();
  const store = new HostedSessionStore(join(root, 'sessions'), { maxSessions: 20, maxMessagesPerSession: 100, terminatedRetentionMs: 60_000 });
  let floorCount = 0;
  let services: ClientRuntimeServices | undefined;
  const provider: LLMProvider = { name: 'mode-fixture', models: ['mode-fixture-1'], credentialAuthority: 'anonymous', modelSource: { kind: 'dated-static', asOf: '2026-01-01' }, chat };
  const model: ModelDefinition = { id: 'mode-fixture-1', provider: provider.name, registryKey: 'mode-fixture:mode-fixture-1', displayName: 'Mode fixture', description: 'Local test fixture', capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 8192, selectable: true };
  const manager = new HostedSessionManager({
    floorFactory: ({ workspaceRoot }) => {
      floorCount++;
      services = createClientRuntimeServices({ configManager: config, runtimeBus: bus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir: workspaceRoot, homeDirectory: root, requestApproval: async () => ({ approved: false }), modelDiscovery: 'skip' });
      services.providerRegistry.registerRuntimeProvider({ provider, models: [model], replace: true });
      services.providerRegistry.setCurrentModel(model.registryKey);
      return { services, contractRunner: services.contractRunner, dispose: () => services!.dispose() };
    },
    store, runtimeBus: bus, liveTurns: controls, systemPrompt: () => 'Hosted mode test',
    settings: { detachPolicy: () => 'survive', maxSessions: () => 8 }, isWorkspaceUsable: () => true,
  });
  disposals.push(() => manager.dispose());
  return { root, workspace, config, bus, controls, store, manager, floorCount: () => floorCount, services: () => { if (!services) throw new Error('Floor not composed'); return services; } };
}

test('hosted mode choices persist per session without mutating the shared floor configuration', async () => {
  const host = fixture();
  await host.manager.init();
  const a = await host.manager.create({ workspaceRoot: host.workspace });
  const b = await host.manager.create({ workspaceRoot: host.workspace });
  const ca = host.manager.liveTurnControls(a.id)!;
  const cb = host.manager.liveTurnControls(b.id)!;
  expect(ca.getPermissionMode!()).toBe('safe-owner');
  await ca.setPermissionMode!('yolo');
  await cb.setPermissionMode!('safe-jev');
  expect(ca.getPermissionMode!()).toBe('yolo');
  expect(cb.getPermissionMode!()).toBe('safe-jev');
  expect(host.config.get('permissions.mode')).toBe('safe-owner');
  expect(host.config.get('behavior.autoApprove')).toBe(false);
  expect(host.floorCount()).toBe(1);
  expect(host.manager.get(a.id)?.permissionMode).toBe('yolo');
  expect(host.manager.get(b.id)?.permissionMode).toBe('safe-jev');
  const savedA = JSON.parse(readFileSync(join(host.root, 'sessions', `${a.id}.json`), 'utf8'));
  const savedB = JSON.parse(readFileSync(join(host.root, 'sessions', `${b.id}.json`), 'utf8'));
  expect(savedA.record.permissionMode).toBe('yolo');
  expect(savedB.record.permissionMode).toBe('safe-jev');
});

test('concurrent real hosted turns inherit different mode owners on one shared floor', async () => {
  let entered = 0;
  let bothEntered!: () => void;
  const ready = new Promise<void>(resolve => { bothEntered = resolve; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const seen: { owner: ExecutionModeOwner; before: string; effective: string; after?: string }[] = [];
  const host = fixture(async () => {
    const owner = currentExecutionModeOwner();
    if (!owner) throw new Error('Missing hosted mode owner');
    const sample: { owner: ExecutionModeOwner; before: string; effective: string; after?: string } = { owner, before: owner.getMode(), effective: host.services().permissionManager.getMode() };
    seen.push(sample);
    if (++entered === 2) bothEntered();
    await hold;
    const afterOwner = currentExecutionModeOwner();
    if (!afterOwner) throw new Error('Hosted mode owner was lost after awaiting the provider');
    sample.after = afterOwner.getMode();
    return answer();
  });
  await host.manager.init();
  const a = await host.manager.create({ workspaceRoot: host.workspace });
  const b = await host.manager.create({ workspaceRoot: host.workspace });
  await host.manager.liveTurnControls(a.id)!.setPermissionMode!('yolo');
  await host.manager.liveTurnControls(b.id)!.setPermissionMode!('safe-jev');
  const readings = installHostedSessionReadings();
  try {
    const first = host.manager.deliver(a.id, 'First session');
    const second = host.manager.deliver(b.id, 'Second session');
    await Promise.race([ready, Promise.all([first, second]).then(() => { throw new Error("Hosted turns ended before both providers entered"); })]);
    expect(seen.map(item => item.before).sort()).toEqual(['safe-jev', 'yolo']);
    expect(seen.every(item => item.effective === item.before)).toBe(true);
    expect(seen[0]!.owner).not.toBe(seen[1]!.owner);
    release();
    await Promise.all([first, second]);
    expect(seen.map(item => item.after).sort()).toEqual(['safe-jev', 'yolo']);
    expect(host.floorCount()).toBe(1);
    expect(host.config.get('permissions.mode')).toBe('safe-owner');
  } finally { release(); readings.restore(); }
});

test('mode owner survives queued message acceptance and expires when its session is disposed', async () => {
  let owner: ExecutionModeOwner | undefined;
  let call = 0;
  let firstEntered!: () => void;
  const entered = new Promise<void>(resolve => { firstEntered = resolve; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const modes: string[] = [];
  const host = fixture(async () => {
    owner = currentExecutionModeOwner();
    modes.push(owner!.getMode());
    if (++call === 1) { firstEntered(); await hold; }
    return answer();
  });
  await host.manager.init();
  const record = await host.manager.create({ workspaceRoot: host.workspace });
  await host.manager.liveTurnControls(record.id)!.setPermissionMode!('yolo');
  const readings = installHostedSessionReadings();
  try {
    const first = host.manager.deliver(record.id, 'First turn');
    await Promise.race([entered, first.then(() => { throw new Error("Hosted turn ended before provider entered"); })]);
    await host.manager.deliver(record.id, 'Queued turn');
    release();
    await first;
    expect(modes).toEqual(['yolo', 'yolo']);
    expect(owner!.getMode()).toBe('yolo');
    await host.manager.kill(record.id);
    expect(() => owner!.getRevision()).toThrow('disposed');
  } finally { release(); readings.restore(); }
});

test('persisted hosted modes validate canonical values while old records without a mode remain readable', async () => {
  const host = fixture();
  await host.manager.init();
  const record = await host.manager.create({ workspaceRoot: host.workspace });
  const envelope = { version: 2, record, conversation: null };
  expect(describeInvalidPersistedHostedSession(envelope)).toBeNull();
  expect(describeInvalidPersistedHostedSession({ ...envelope, record: { ...record, permissionMode: 'allow-all' } })).toBe('invalid session execution mode');
  const { permissionMode: _mode, ...oldRecord } = record;
  expect(describeInvalidPersistedHostedSession({ ...envelope, record: oldRecord })).toBeNull();
});

test('a saved session mode survives daemon restart and restored composition', async () => {
  const original = fixture();
  await original.manager.init();
  const record = await original.manager.create({ workspaceRoot: original.workspace });
  await original.manager.liveTurnControls(record.id)!.setPermissionMode!('safe-jev');
  await original.manager.dispose();
  const restored = fixture(undefined, original.root);
  await restored.manager.init();
  expect(restored.manager.get(record.id)?.permissionMode).toBe('safe-jev');
  await restored.manager.attach(record.id, 'reattached-client');
  expect(restored.manager.liveTurnControls(record.id)!.getPermissionMode!()).toBe('safe-jev');
  expect(restored.config.get('permissions.mode')).toBe('safe-owner');
  expect(restored.floorCount()).toBe(1);
});

test('changing session mode increments authority and cancels its pending turn', async () => {
  const entered = Promise.withResolvers<void>();
  let owner: ExecutionModeOwner | undefined;
  let revision = -1;
  let providerSignal: AbortSignal | undefined;
  const host = fixture(async request => {
    owner = currentExecutionModeOwner();
    revision = owner!.getRevision();
    providerSignal = request.signal;
    entered.resolve();
    return new Promise<ChatResponse>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new Error('Provider cancelled by session mode change')), { once: true });
    });
  });
  await host.manager.init();
  const record = await host.manager.create({ workspaceRoot: host.workspace });
  const controls = host.manager.liveTurnControls(record.id)!;
  await controls.setPermissionMode!('yolo');
  const readings = installHostedSessionReadings();
  try {
    const pending = host.manager.deliver(record.id, 'Wait for provider').catch(error => error);
    await entered.promise;
    await controls.setPermissionMode!('safe-owner');
    expect(owner!.getRevision()).toBe(revision + 1);
    expect(owner!.getMode()).toBe('safe-owner');
    expect(providerSignal?.aborted).toBe(true);
    await pending;
    expect(host.manager.get(record.id)?.permissionMode).toBe('safe-owner');
    expect(host.config.get('permissions.mode')).toBe('safe-owner');
  } finally { readings.restore(); }
});

test('a hosted tool ignoring abort cannot reuse captured YOLO after its mode changes', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  let chats = 0;
  let effects = 0;
  let guarded = false;
  const host = fixture(async () => ++chats === 1 ? {
    content: '', toolCalls: [{ id: 'late-effect', name: 'delayed_mode_effect', arguments: {} }],
    usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'tool_call',
  } : answer());
  await host.manager.init();
  await host.manager.create({ workspaceRoot: host.workspace });
  const services = host.services();
  const runtime = createHostedSessionRuntime({ sessionId: 'late-mode-effect', workspaceRoot: host.workspace,
    floor: { services, contractRunner: services.contractRunner, dispose: () => {} },
    systemPrompt: 'Execute the registered synthetic operation', permissionMode: 'yolo' });
  disposals.push(() => runtime.dispose());
  runtime.toolRegistry.register({ definition: { name: 'delayed_mode_effect', description: 'Synthetic delayed operation',
    parameters: { type: 'object', properties: {}, additionalProperties: false }, sideEffects: [] },
    async execute() {
      entered.resolve();
      await release.promise; // Deliberately ignores the supplied cancellation signal.
      try {
        if (isYoloExecution()) effects++;
        return { success: true, output: 'Synthetic operation' };
      } catch (error) { guarded = true; throw error; }
      finally { finished.resolve(); }
    } }, { inputProjection: { async project(request) {
      return { status: 'projected', args: request.args, assertCurrent: request.assertCurrent, resultPublication: 'read-only' };
    } } });
  const readings = installHostedSessionReadings();
  disposals.push(() => readings.restore());
  const turn = runtime.submit('Perform the synthetic delayed operation');
  try {
    await Promise.race([entered.promise, turn.then(() => { throw new Error(`Hosted turn ended before its synthetic operation: ${JSON.stringify(runtime.conversation.getMessageSnapshot())}`); })]);
    await runtime.liveTurnControls.setPermissionMode('safe-owner');
  } finally { release.resolve(); }
  await finished.promise;
  await turn;
  expect(guarded).toBe(true);
  expect(effects).toBe(0);
});

test('failed mode persistence rejects, exposes its actual live selection and retries that same choice', async () => {
  const host = fixture();
  await host.manager.init();
  const record = await host.manager.create({ workspaceRoot: host.workspace });
  const controls = host.manager.liveTurnControls(record.id)!;
  const save = host.store.save.bind(host.store);
  let writes = 0;
  const intercepted = spyOn(host.store, 'save').mockImplementation(async (...args) => {
    if (++writes === 1) throw new Error('Synthetic durable-write failure');
    return save(...args);
  });
  try {
    await expect(controls.setPermissionMode!('yolo')).rejects.toThrow('Synthetic durable-write failure');
    expect(controls.getPermissionMode!()).toBe('yolo');
    expect(host.manager.get(record.id)?.permissionMode).toBe('yolo');
    expect(JSON.parse(readFileSync(join(host.root, 'sessions', `${record.id}.json`), 'utf8')).record.permissionMode).toBe('safe-owner');
    await controls.setPermissionMode!('yolo');
    expect(writes).toBe(2);
    expect(JSON.parse(readFileSync(join(host.root, 'sessions', `${record.id}.json`), 'utf8')).record.permissionMode).toBe('yolo');
    await controls.setPermissionMode!('yolo');
    expect(writes).toBe(2);
  } finally { intercepted.mockRestore(); }
});

test('setting the current durable mode leaves its running turn and revision intact', async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let owner: ExecutionModeOwner | undefined;
  let signal: AbortSignal | undefined;
  const host = fixture(async request => {
    owner = currentExecutionModeOwner();
    signal = request.signal;
    entered.resolve();
    await release.promise;
    return answer();
  });
  await host.manager.init();
  const record = await host.manager.create({ workspaceRoot: host.workspace });
  const controls = host.manager.liveTurnControls(record.id)!;
  await controls.setPermissionMode!('yolo');
  const readings = installHostedSessionReadings();
  try {
    const pending = host.manager.deliver(record.id, 'Wait at provider');
    await entered.promise;
    const revision = owner!.getRevision();
    await controls.setPermissionMode!('yolo');
    expect(owner!.getRevision()).toBe(revision);
    expect(signal?.aborted).toBe(false);
    release.resolve();
    await pending;
  } finally { release.resolve(); readings.restore(); }
});
