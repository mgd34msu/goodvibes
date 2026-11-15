import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { DaemonServer } from '../platform/src/platform/daemon/facade.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { emitAgentCompleted } from '../platform/src/platform/runtime/emitters/agents.js';
import { createRuntimeServices } from '../platform/src/platform/runtime/services.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import type { AgentRecord } from '../platform/src/platform/tools/agent/record.js';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
type Spawner = { trySpawnAgent(input: unknown, label?: string, sessionId?: string): AgentRecord | Response };

describe('a spawn through the daemon facade', () => {
  test('gives the agent exactly one task row, and that row ends when the agent completes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-spawn-single-task-'));
    disposables.defer(() => rmSync(root, { recursive: true, force: true }));
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const runtimeBus = new RuntimeEventBus();
    const runtimeStore = createRuntimeStore();
    seedBenchmarkCache(homeDirectory, 'goodvibes');
    const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
    await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
    const services = disposables.add(createRuntimeServices({
      configManager,
      runtimeBus,
      runtimeStore,
      surfaceRoot: 'goodvibes',
      getConversationTitle: () => 'spawn single task',
      workingDir,
      homeDirectory,
    }));
    const record = { id: 'agent-1', task: 'Summarise the report', status: 'running', startedAt: 1 } as unknown as AgentRecord;
    spyOn(services.agentManager, 'spawn').mockReturnValue(record);
    const daemon = disposables.add(new DaemonServer({ runtimeServices: services }));

    expect((daemon as unknown as Spawner).trySpawnAgent({ mode: 'spawn', task: record.task }, 'test', 'session-1')).toBe(record);
    expect([...runtimeStore.getState().tasks.tasks.keys()]).toEqual(['agent-1']);

    emitAgentCompleted(runtimeBus, { sessionId: 'session-1', traceId: 't', source: 'test' }, { agentId: 'agent-1', durationMs: 5, output: 'ok' });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    const tasks = [...runtimeStore.getState().tasks.tasks.values()];
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ id: 'agent-1', status: 'completed' });
  });
});
