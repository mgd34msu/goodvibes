import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { PermissionManager, createPermissionConfigReader } from '../platform/src/platform/permissions/manager.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';
import { ToolRegistry, isInvocationAdmitted } from '../platform/src/platform/tools/registry.ts';
import { executeToolCalls, type ToolExecutionDeps } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { currentExecutionMode, currentExecutionModeOwner, withExecutionMode, withRetainedExecutionMode, withInvocationExecutionMode, withExecutionModeOwner, type ExecutionModeOwner } from '../platform/src/platform/gate/execution-context.ts';
import { createFetchTool } from '../platform/src/platform/tools/fetch/runtime.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { AgentExecutionLedger } from '../platform/src/platform/gate/policy/execution-ledger.ts';
import { AgentManager } from '../platform/src/platform/tools/agent/manager.ts';
import type { GatePresetName } from '../platform/src/platform/gate/presets.ts';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

test('YOLO reaches the same authentic executor without judgment, approval or hook veto', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'execution-mode-runtime-')); directories.push(directory);
  const config = new ConfigManager({ configDir: directory });
  config.set('permissions.mode', 'yolo');
  config.set('permissions.tools.exec', 'deny');
  let prompts = 0, judgments = 0;
  const hooks: string[] = [];
  const manager = new PermissionManager(async () => { prompts++; return { approved: false }; },
    createPermissionConfigReader(config), new PolicyRuntimeState());
  const runtimeBus = new RuntimeEventBus();
  const ledger = new AgentExecutionLedger(runtimeBus);
  const registry = new ToolRegistry(manager);
  const bodies: Record<string, unknown>[] = [];
  const release = Promise.withResolvers<void>();
  let detachedExact: Promise<boolean> = Promise.resolve(false);
  registry.register({ definition: { name: 'exec', description: 'Intercepted execution; no shell runs.',
    parameters: { type: 'object', properties: { command: { type: 'string' }, password: { type: 'string' } }, required: ['command'] } },
  async execute(args) {
    expect(currentExecutionMode()).toBe('yolo');
    expect(isInvocationAdmitted('exec', args)).toBe(true);
    expect(isInvocationAdmitted('fetch', args)).toBe(false);
    expect(isInvocationAdmitted('exec', { ...args })).toBe(false);
    bodies.push(args);
    detachedExact = release.promise.then(() => isInvocationAdmitted('exec', args));
    void detachedExact.catch(() => {});
    return { success: true, output: 'intercepted' };
  } });
  const deps: ToolExecutionDeps = {
    autonomousSource: () => ({ goal: 'Execute the exact synthetic input', criteria: ['Execute once'] }),
    permissionManager: manager, toolRegistry: registry, runtimeBus,
    hookDispatcher: { async fire(event) { hooks.push(event.path); return { ok: true, decision: 'deny' }; } },
    sessionId: 'yolo-runtime-fixture', emitterContext: () => ({ sessionId: 'yolo-runtime-fixture', traceId: 'fixture', source: 'orchestrator' }),
  };
  const previous = installJudgmentPort({ model: 'offline-fixture', async ask() { judgments++; throw new Error('No judgment service'); } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('local mode fixture') });
  try {
    const calls = [{ id: 'operation', name: 'exec', arguments: { command: 'rm -rf /', password: 'synthetic-inline-value' } }];
    expect(await executeToolCalls(deps, 'turn', calls)).toMatchObject([{ success: true, output: 'intercepted' }]);
    expect(bodies).toEqual([calls[0]!.arguments]);
    expect(judgments).toBe(0);
    expect(prompts).toBe(0);
    expect(hooks.filter(path => path.startsWith('Pre:'))).toHaveLength(0);
    release.resolve();
    await expect(detachedExact).rejects.toThrow();
    expect(isInvocationAdmitted('exec', calls[0]!.arguments)).toBe(false);
    await expect(executeToolCalls(deps, 'turn', calls)).rejects.toThrow('claimed');
    expect(bodies).toHaveLength(1);
    let localApprovals = 0;
    registry.register(createFetchTool({ approveLocalhostFetch: async () => {
      localApprovals++;
      throw new Error('YOLO must not require a localhost permit');
    } }));
    const [fetched] = await executeToolCalls(deps, 'turn', [{ id: 'local-fetch', name: 'fetch', arguments: {
      urls: [{ url: `http://localhost:${server.port}/` }, { url: `http://127.0.0.1:${server.port}/` }],
      extract: 'raw', sanitize_mode: 'none',
    } }]);
    expect(fetched?.success).toBe(true);
    expect(JSON.parse(fetched?.output ?? '{}')).toMatchObject({ summary: { succeeded: 2, failed: 0 } });
    expect(localApprovals).toBe(0);
    await ledger.settled();
    expect(ledger.getSnapshot().total).toBe(2);
    expect(judgments).toBe(0);
  } finally { ledger.dispose(); server.stop(true); installJudgmentPort(previous); release.resolve(); }
});

test('queued background wakes retain their originating session mode owner', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'execution-mode-agent-')); directories.push(directory);
  const config = new ConfigManager({ configDir: directory });
  let mode: GatePresetName = 'safe-owner';
  let revision = 0;
  const owner: ExecutionModeOwner = { getMode: () => mode, getRevision: () => revision };
  const otherOwner: ExecutionModeOwner = { getMode: () => 'safe-jev', getRevision: () => 0 };
  const release = Promise.withResolvers<void>();
  const awakened = Promise.withResolvers<void>();
  const observed: { owner: ExecutionModeOwner | undefined; mode: GatePresetName | undefined }[] = [];
  const agents = new AgentManager({ configManager: config, messageBus: { registerAgent() {} }, archetypeLoader: { loadArchetype: () => null },
    executor: { async runAgent(record) {
      const current = currentExecutionModeOwner();
      observed.push({ owner: current, mode: current?.getMode() });
      if (observed.length === 1) { record.status = 'failed'; await release.promise; }
      else { record.status = 'completed'; awakened.resolve(); }
    } },
  });
  const record = withExecutionModeOwner(owner, () => agents.spawn({ mode: 'spawn', task: 'Synthetic delegated work', outsideContract: true }));
  mode = 'yolo'; revision++;
  const wake = withExecutionModeOwner(otherOwner, () => agents.wakeWithSteer(record.id, 'Continue the same synthetic work'));
  expect(wake.woke).toBe(true);
  release.resolve();
  await awakened.promise;
  expect(observed).toEqual([{ owner, mode: 'safe-owner' }, { owner, mode: 'yolo' }]);
});


for (const revoked of [false, true]) test(`retained execution keeps host mode checks after the initiating tool returns: ${revoked}`, async () => {
  const resume = Promise.withResolvers<void>();
  let hostCurrent = true, toolCurrent = true;
  let pending!: Promise<unknown>;
  await withExecutionMode('yolo', async () => {
    await withInvocationExecutionMode('yolo', async () => {
      pending = withRetainedExecutionMode(async () => { await resume.promise; return currentExecutionMode(); });
    }, () => { if (!toolCurrent) throw new Error('tool expired'); });
  }, () => { if (!hostCurrent) throw new Error('host mode changed'); });
  toolCurrent = false; hostCurrent = !revoked; resume.resolve();
  if (revoked) await expect(pending).rejects.toThrow('host mode changed');
  else expect(await pending).toBe('yolo');
});
