/**
 * What the orchestrator keeps per working directory and per captured run: a
 * registry, the project index built for it, and its session state store. A
 * finished run's worktree releases all three, a channel plugin change does not
 * pull them out from under a captured run that is still going, and a refused
 * captured run does not leave its REPL history open.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOrchestrator } from '../platform/src/platform/agents/orchestrator.js';
import { AgentMessageBus } from '../platform/src/platform/agents/message-bus.js';
import { AgentManager, type AgentRecord } from '../platform/src/platform/tools/agent/manager.js';
import { FileStateCache } from '../platform/src/platform/state/file-cache.js';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { FileUndoManager } from '../platform/src/platform/state/file-undo.js';
import { ModeManager } from '../platform/src/platform/state/mode-manager.js';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { createWorkflowServices } from '../platform/src/platform/tools/workflow/index.js';
import { CrossSessionTaskRegistry } from '../platform/src/platform/sessions/orchestration/registry.js';
import { SandboxSessionRegistry } from '../platform/src/platform/runtime/sandbox/session-registry.js';
import { OverflowHandler } from '../platform/src/platform/tools/shared/overflow.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { wrapReadToolForAdmittedAgentPolicy } from '../platform/src/platform/gate/policy/read-policy.js';
import { wrapSettingsToolForAdmittedAgentPolicy } from '../platform/src/platform/gate/policy/settings-write-policy.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { ContractRunner } from '../platform/src/platform/contract/runner.js';
import type { LLMProvider } from '../platform/src/platform/providers/interface.js';
import type { ModelDefinition } from '../platform/src/platform/providers/registry-types.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { EXEC_GATE_TABLE } from './_helpers/gate-readings.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings([], EXEC_GATE_TABLE);

type Private = {
  toolDeps: Record<string, unknown>;
  fullRegistries: Map<string, ToolRegistry>;
  ownedProjectIndexes: Map<string, ProjectIndex>;
  registryDisposers: Map<string, () => Promise<void>>;
  getFullRegistry(workingDirectory?: string, authority?: unknown, signal?: AbortSignal, runKey?: string): ToolRegistry;
  runAgent(record: AgentRecord): Promise<void>;
  buildScopedRegistry(allowedNames: string[], fullRegistry: ToolRegistry): ToolRegistry;
};

const disposables = trackDisposables();
const dirs: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `registry-lifetime-${label}-`));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  try { await disposables.flush(); } finally { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); }
});

const MODEL: ModelDefinition = {
  id: 'fake-model', provider: 'fake', registryKey: 'fake:fake-model', displayName: 'Fake', description: 'stub',
  capabilities: { toolCalling: true, codeEditing: true, reasoning: false, multimodal: false }, contextWindow: 0, selectable: true,
};
const provider: LLMProvider = {
  name: 'fake', models: ['fake-model'],
  async chat() { return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' }; },
};

function makeOrchestrator(defaultDir: string, scratchRoot: string, channelVersion: () => number = () => 0): Private {
  const channelRegistry = { getVersion: channelVersion, listAgentTools: () => [] };
  const orchestrator = disposables.add(new AgentOrchestrator({
    messageBus: new AgentMessageBus(), channelRegistry: channelRegistry as never,
  })) as unknown as Private;
  orchestrator.toolDeps = {
    fileCache: new FileStateCache(),
    projectIndex: disposables.add(new ProjectIndex(defaultDir)),
    workingDirectory: defaultDir,
    surfaceRoot: 'test-surface',
    fileUndoManager: new FileUndoManager(),
    modeManager: new ModeManager(),
    processManager: new ProcessManager(),
    agentMessageBus: new AgentMessageBus(),
    sessionOrchestration: disposables.add(new CrossSessionTaskRegistry(join(scratchRoot, 'session-tasks.json'))),
    sandboxSessionRegistry: new SandboxSessionRegistry(scratchRoot),
    workflowServices: createWorkflowServices(),
    contractRunner: { start() { throw new Error('not used'); }, list: () => [], get: () => null } satisfies Pick<ContractRunner, 'start' | 'list' | 'get'>,
    overflowHandler: new OverflowHandler({ baseDir: scratchRoot }),
    agentManager: new AgentManager({
      configManager: { get: ((_key: string): unknown => undefined) as ConfigManager['get'] },
      messageBus: { registerAgent() { /* no-op */ } },
      executor: { async runAgent() { /* not spawned */ } },
    }),
    configManager: { get: () => undefined, getCategory: () => undefined, getHomeDirectory: () => scratchRoot, getWorkingDirectory: () => defaultDir },
    providerRegistry: {
      getCurrentModel: () => MODEL, getForModel: () => provider, listModels: () => [MODEL],
      getContextWindowForModel: () => 0, getKnownContextWindowForModel: () => 0, recordContextWindowRejection: () => {},
    },
    toolLLM: {},
  };
  return orchestrator;
}

function record(id: string, workingDirectory: string): AgentRecord {
  return {
    id, task: 'do work', template: 'engineer', tools: [], status: 'pending', startedAt: Date.now(), toolCallCount: 0,
    orchestrationDepth: 0, executionProtocol: 'direct', reviewMode: 'none', communicationLane: 'parent-only', workingDirectory,
  };
}

describe('registries for dedicated worktrees', () => {
  test('a finished agent releases its worktree registry, index and session state; the default directory keeps its own', async () => {
    const defaultDir = tempDir('default'); const scratch = tempDir('scratch');
    const orchestrator = makeOrchestrator(defaultDir, scratch);
    for (let i = 0; i < 4; i++) {
      const worktree = tempDir(`wt${i}`);
      const run = record(`ag-wt-${i}`, worktree);
      await orchestrator.runAgent(run);
      // The run may end completed or failed; either way it is over.
      expect(['completed', 'failed']).toContain(run.status);
    }
    expect([...orchestrator.fullRegistries.keys()]).toEqual([]);
    expect(orchestrator.ownedProjectIndexes.size).toBe(0);
    expect(orchestrator.registryDisposers.size).toBe(0);

    await orchestrator.runAgent(record('ag-default', defaultDir));
    expect([...orchestrator.fullRegistries.keys()]).toEqual([defaultDir]);
  }, 30_000);

  test('the registry is released only when the last agent using the directory ends', async () => {
    const defaultDir = tempDir('default'); const scratch = tempDir('scratch'); const worktree = tempDir('shared');
    const orchestrator = makeOrchestrator(defaultDir, scratch);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered = 0;
    let announce!: () => void;
    const bothRunning = new Promise<void>((resolve) => { announce = resolve; });
    const slow: LLMProvider = { ...provider, async chat() {
      entered += 1; if (entered === 2) announce(); await gate;
      return { content: 'done', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'completed' };
    } };
    (orchestrator.toolDeps.providerRegistry as { getForModel: () => LLMProvider }).getForModel = () => slow;
    const first = orchestrator.runAgent(record('ag-shared-1', worktree));
    const second = orchestrator.runAgent(record('ag-shared-2', worktree));
    await bothRunning;
    expect(orchestrator.fullRegistries.has(worktree)).toBe(true);
    release();
    await Promise.all([first, second]);
    expect(orchestrator.fullRegistries.has(worktree)).toBe(false);
  }, 30_000);
});

describe('a channel plugin change', () => {
  test('drops cached directory registries but leaves a captured run its own until the run ends', async () => {
    const defaultDir = tempDir('default'); const scratch = tempDir('scratch'); const worktree = tempDir('wt'); const other = tempDir('other');
    let version = 0;
    const orchestrator = makeOrchestrator(defaultDir, scratch, () => version);
    orchestrator.getFullRegistry(worktree, undefined, undefined, 'run-key-1');
    orchestrator.getFullRegistry(other);
    const runIndex = orchestrator.ownedProjectIndexes.get('run-key-1')!;
    const disposed = spyOn(runIndex, 'dispose');
    expect(orchestrator.fullRegistries.has('run-key-1')).toBe(true);

    version = 1;
    orchestrator.getFullRegistry(defaultDir);
    expect(orchestrator.fullRegistries.has('run-key-1')).toBe(true);
    expect(orchestrator.ownedProjectIndexes.get('run-key-1')).toBe(runIndex);
    expect(disposed).not.toHaveBeenCalled();
    expect(orchestrator.fullRegistries.has(other)).toBe(false);
    expect(orchestrator.registryDisposers.has(other)).toBe(false);
  });
});

describe('a channel plugin change and the default directory registry', () => {
  test('its session state is kept for a registry the host may hold, then released when the orchestrator is disposed', async () => {
    const defaultDir = tempDir('default'); const scratch = tempDir('scratch');
    let version = 0;
    const orchestrator = makeOrchestrator(defaultDir, scratch, () => version);
    orchestrator.getFullRegistry();
    const original = orchestrator.registryDisposers.get(defaultDir)!;
    let released = 0;
    orchestrator.registryDisposers.set(defaultDir, async () => { released += 1; await original(); });

    for (version = 1; version <= 3; version++) orchestrator.getFullRegistry();
    // Each rebuild built a new state; the dropped ones are not closed while a caller may still hold their registry.
    expect(released).toBe(0);
    expect(orchestrator.registryDisposers.size).toBe(1);

    (orchestrator as unknown as { dispose(): void }).dispose();
    await Promise.resolve();
    expect(released).toBe(1);
  });
});

describe('a refused captured run', () => {
  test('leaves no REPL history file open', async () => {
    const defaultDir = tempDir('default'); const scratch = tempDir('scratch');
    const home = tempDir('home');
    const previous = process.env.GOODVIBES_HOME;
    process.env.GOODVIBES_HOME = home;
    try {
      const orchestrator = makeOrchestrator(defaultDir, scratch);
      const { readdirSync, existsSync } = await import('node:fs');
      const authority = {} as never;
      const createRunContext = (orchestrator as unknown as { createRunContext(...args: unknown[]): Promise<unknown> }).createRunContext.bind(orchestrator);
      await expect(createRunContext(defaultDir, authority, undefined, 'run-key-2')).rejects.toThrow();
      const historyDir = join(home, '.goodvibes', 'repl-history');
      expect(existsSync(historyDir) ? readdirSync(historyDir) : []).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.GOODVIBES_HOME; else process.env.GOODVIBES_HOME = previous;
    }
  });
});

describe('the exec posture of a worker registry', () => {
  async function runEcho(orchestrator: Private): Promise<{ success: boolean; stderr: string; stdout: string }> {
    const exec = orchestrator.getFullRegistry().list().find((tool) => tool.definition.name === 'exec');
    if (!exec) throw new Error('the worker registry has no exec tool');
    const result = await exec.execute({ commands: [{ cmd: 'echo worker-ran' }] });
    const output = JSON.parse(String(result.output ?? '{}')) as { stderr?: string; stdout?: string };
    return { success: result.success, stderr: String(output.stderr ?? ''), stdout: String(output.stdout ?? '') };
  }

  test('a composition that requires the boundary refuses a worker command it cannot contain', async () => {
    const orchestrator = makeOrchestrator(tempDir('default'), tempDir('scratch'));
    orchestrator.toolDeps.execContainment = { posture: 'required', reason: 'a hosted turn nobody is watching' };
    const ran = await runEcho(orchestrator);
    expect(ran.success).toBe(false);
    expect(ran.stderr).toContain('requires commands to run inside the exec boundary');
    expect(ran.stdout).not.toContain('worker-ran');
  });

  test('a composition that states nothing runs the worker command on the host as before', async () => {
    const ran = await runEcho(makeOrchestrator(tempDir('default'), tempDir('scratch')));
    expect(ran.success).toBe(true);
    expect(ran.stdout).toContain('worker-ran');
  });
});

describe('a product decoration of a worker registry', () => {
  test('is applied to the registry each worker uses, once its tools are registered', () => {
    const orchestrator = makeOrchestrator(tempDir('default'), tempDir('scratch'));
    const decorated: string[][] = [];
    orchestrator.toolDeps.decorateRegistry = (registry: ToolRegistry) => { decorated.push(registry.list().map((tool) => tool.definition.name)); };
    const registry = orchestrator.getFullRegistry();
    expect(orchestrator.getFullRegistry()).toBe(registry);
    expect(decorated).toHaveLength(1);
    expect(decorated[0]).toContain('exec');
    expect(decorated[0]).toContain('agent');
  });
});

describe('a worker registry whose product installs the admitted read and settings wrappers', () => {
  function decorateWithAdmittedWrappers(registry: ToolRegistry): void {
    for (const tool of registry.list()) {
      if (tool.definition.name === 'read') wrapReadToolForAdmittedAgentPolicy(tool);
      if (tool.definition.name === 'goodvibes_settings') wrapSettingsToolForAdmittedAgentPolicy(tool);
    }
  }

  async function outcome(run: () => Promise<{ error?: string | undefined; output?: string | undefined }>): Promise<string> {
    try {
      const result = await run();
      return `${result.error ?? ''}${result.output ?? ''}`;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async function readAndSet(orchestrator: Private, dir: string): Promise<{ read: string; set: string }> {
    writeFileSync(join(dir, 'note.txt'), 'worker readable');
    orchestrator.toolDeps.decorateRegistry = decorateWithAdmittedWrappers;
    const registry = orchestrator.getFullRegistry();
    return {
      read: await outcome(() => registry.execute('worker-read', 'read', { files: [{ path: join(dir, 'note.txt') }] })),
      set: await outcome(() => registry.execute('worker-set', 'goodvibes_settings', { mode: 'set', key: 'display.theme', value: 'dark' })),
    };
  }

  test('without the matching admission policies every worker read and settings call is held for lack of a projector', async () => {
    const dir = tempDir('default');
    const held = await readAndSet(makeOrchestrator(dir, tempDir('scratch')), dir);
    expect(held.read).toContain('Agent read held');
    expect(held.set).toContain('Tool input projection held');
  });

  test('with the policies passed to the orchestrator the worker settings tool has its projector, so the call is no longer held for lack of one', async () => {
    const dir = tempDir('default');
    const orchestrator = makeOrchestrator(dir, tempDir('scratch'));
    orchestrator.toolDeps.readAdmissionPolicy = 'agent-main-conversation';
    orchestrator.toolDeps.settingsAdmissionPolicy = 'agent-main-conversation';
    const result = await readAndSet(orchestrator, dir);
    // The read call still needs the host executor's recorded admission, which a direct registry call does not carry; the settings call shows the projector now runs.
    expect(result.set).not.toContain('held');
  });

  test('the scoped registry a worker actually runs keeps each tool\'s projector, so its settings call is not held for lack of one', async () => {
    const dir = tempDir('default');
    const orchestrator = makeOrchestrator(dir, tempDir('scratch'));
    orchestrator.toolDeps.readAdmissionPolicy = 'agent-main-conversation';
    orchestrator.toolDeps.settingsAdmissionPolicy = 'agent-main-conversation';
    orchestrator.toolDeps.decorateRegistry = decorateWithAdmittedWrappers;
    const scoped = orchestrator.buildScopedRegistry(['read', 'goodvibes_settings'], orchestrator.getFullRegistry());
    const set = await outcome(() => scoped.execute('worker-set', 'goodvibes_settings', { mode: 'set', key: 'display.theme', value: 'dark' }));
    expect(set).not.toContain('held');
  });

  test('the registry of a captured-authority run keeps each tool\'s projector, so its read is not held for lack of one', async () => {
    const dir = tempDir('default');
    const orchestrator = makeOrchestrator(dir, tempDir('scratch'));
    orchestrator.toolDeps.readAdmissionPolicy = 'agent-main-conversation';
    orchestrator.toolDeps.settingsAdmissionPolicy = 'agent-main-conversation';
    orchestrator.toolDeps.decorateRegistry = decorateWithAdmittedWrappers;
    const registry = orchestrator.getFullRegistry(dir, {} as never, undefined, 'captured-run');
    const set = await outcome(() => registry.execute('captured-set', 'goodvibes_settings', { mode: 'set', key: 'display.theme', value: 'dark' }));
    expect(set).not.toContain('Tool input projection held');
    expect(registry.registrationOptionsFor('read')?.inputProjection).toBeDefined();
  });
});
