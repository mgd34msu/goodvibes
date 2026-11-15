/**
 * Live-managers integration: the fleet registry over REAL manager
 * instances (AgentManager with a stub executor, ProcessManager spawning a
 * real shell command, createWorkflowServices(), a real RuntimeEventBus).
 * Proves the narrow structural deps match the real classes and that the
 * end-to-end flow (spawn → events → derived state → control dispatch) holds
 * without any stubbed read surface.
 */
import { describe, expect, test } from 'bun:test';
import { createProcessRegistry } from '../platform/src/platform/runtime/fleet/index.js';
import { AgentManager } from '../platform/src/platform/tools/agent/manager.js';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { createWorkflowServices } from '../platform/src/platform/tools/workflow/index.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Background spawns read which environment variable names are credentials;
// the fake port reads none as one.
useToolReadings();

/** `finished` is called once the stub executor has written the record's final state. */
function makeAgentManager(bus: RuntimeEventBus, finished: () => void = () => {}): AgentManager {
  const manager = new AgentManager({
    // `get` is generic over `ConfigKey` with a per-key conditional return type
    // (`ConfigValue<K>`). Typing the stub's own signature that way makes the
    // checker compare two such generic conditionals structurally and it gives
    // up: "Excessive stack depth comparing types 'ConfigValue<?>' and
    // 'ConfigValue<?>'" (TS2321). Casting the stub object once at the boundary
    // avoids the comparison while still naming the real member type, so a
    // rename or removal of ConfigManager.get still breaks this file.
    configManager: { get: () => null } as unknown as Pick<ConfigManager, 'get'>,
    messageBus: { registerAgent() { /* no-op */ } },
    archetypeLoader: { loadArchetype: () => null },
    executor: {
      async runAgent(record) {
        // Mirrors orchestrator-runner: mutate the exact AgentRecord in place.
        record.status = 'running';
        await Promise.resolve();
        record.usage = {
          inputTokens: 500,
          outputTokens: 120,
          cacheReadTokens: 10,
          cacheWriteTokens: 5,
          llmCallCount: 2,
          turnCount: 2,
          reasoningSummaryCount: 0,
        };
        record.toolCallCount = 3;
        record.status = 'completed';
        record.completedAt = Date.now();
        finished();
      },
    },
  });
  manager.setRuntimeBus(bus);
  return manager;
}

describe('fleet registry: live managers integration', () => {
  test('real AgentManager + ProcessManager + workflow services flow through query/kill', async () => {
    const bus = new RuntimeEventBus();
    const agentFinished = Promise.withResolvers<void>();
    const agentManager = makeAgentManager(bus, agentFinished.resolve);
    const processManager = new ProcessManager();
    const workflow = createWorkflowServices();

    const registry = createProcessRegistry({
      agentManager,
      contractRunner: { list: () => [], cancel: () => false },
      processManager,
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: workflow.workflowManager,
        triggerManager: workflow.triggerManager,
        scheduleManager: workflow.scheduleManager,
      },
      runtimeBus: bus,
    });

    try {
      // Agent: spawn through the real manager, observe the node lifecycle.
      const spawned = agentManager.spawn({
        mode: 'spawn',
        task: 'integration probe',
        outsideContract: true,
      });
      const agentId = spawned.id;
      expect(registry.getNode(agentId)).not.toBeNull();
      await agentFinished.promise;
      expect(registry.getNode(agentId)?.state).toBe('done');
      const agentNode = registry.getNode(agentId);
      expect(agentNode?.usage?.inputTokens).toBe(500);
      expect(agentNode?.usage?.toolCallCount).toBe(3);
      expect(agentNode?.costUsd).toBeNull(); // no priceUsage injected → honest unpriced
      expect(agentNode?.costState).toBe('unpriced');

      // Background process: real spawn, real completion, real stdout tail.
      const bg = await processManager.spawn('echo fleet-hello', undefined, undefined);
      const bgId = bg.process_id;
      if (!bgId) throw new Error('spawn did not return a process_id');
      await processManager.captureProcessLifetime(bg).completion;
      expect(registry.getNode(bgId)?.state).toBe('done');
      expect(registry.getNode(bgId)?.currentActivity?.text).toBe('fleet-hello');

      // Workflow FSM + trigger + schedule from the real managers.
      const instance = workflow.workflowManager.start('fix_loop', 'ship it');
      const trigger = workflow.triggerManager.add({ event: 'push', action: 'test' });
      workflow.scheduleManager.add('fleet-nightly', '1h', 'true');

      expect(registry.getNode(instance.id)?.kind).toBe('workflow');
      expect(registry.getNode(trigger.id)?.state).toBe('idle');
      expect(registry.getNode('schedule:fleet-nightly')?.state).toBe('idle');

      // Control dispatch end-to-end against the real managers.
      expect(registry.kill(instance.id)).toEqual([instance.id]);
      expect(workflow.workflowManager.getStatus(instance.id)?.cancelled).toBe(true);
      expect(registry.interrupt('schedule:fleet-nightly')).toBe(true);
      // Pause/resume through the registry: disabled is 'paused', NOT 'killed', the entry
      // still exists and ScheduleManager.enable() can re-arm it.
      expect(registry.getNode('schedule:fleet-nightly')?.state).toBe('paused');
      expect(registry.getNode('schedule:fleet-nightly')?.capabilities.resumable).toBe(true);
      // resume() round-trips against the REAL ScheduleManager.
      expect(registry.resume('schedule:fleet-nightly')).toBe(true);
      expect(registry.getNode('schedule:fleet-nightly')?.state).toBe('idle');
      expect(registry.getNode('schedule:fleet-nightly')?.capabilities.resumable).toBe(false);
      // Already armed, resume() honestly refuses (nothing to resume).
      expect(registry.resume('schedule:fleet-nightly')).toBe(false);
      expect(registry.kill(trigger.id)).toEqual([trigger.id]);
      expect(registry.getNode(trigger.id)).toBeNull(); // removed

      // A snapshot over the live fleet keeps parent edges resolvable.
      const snapshot = registry.query();
      const ids = new Set(snapshot.nodes.map((node) => node.id));
      for (const node of snapshot.nodes) {
        if (node.parentId !== undefined) expect(ids.has(node.parentId)).toBe(true);
      }
    } finally {
      registry.dispose();
      workflow.scheduleManager.destroy();
    }
  });

  test('subscribe over live managers delivers a changed snapshot on the next tick', async () => {
    const bus = new RuntimeEventBus();
    const agentManager = makeAgentManager(bus);
    const workflow = createWorkflowServices();
    let tick: () => void = () => {};
    const registry = createProcessRegistry({
      agentManager,
      contractRunner: { list: () => [], cancel: () => false },
      processManager: new ProcessManager(),
      watcherRegistry: { list: () => [], stopWatcher: () => null },
      workflow: {
        workflowManager: workflow.workflowManager,
        triggerManager: workflow.triggerManager,
        scheduleManager: workflow.scheduleManager,
      },
      runtimeBus: bus,
      timers: {
        setInterval: (callback) => { tick = callback; return {}; },
        clearInterval: () => { tick = () => {}; },
      },
    });
    try {
      const snapshots: number[] = [];
      registry.subscribe((snapshot) => snapshots.push(snapshot.nodes.length));
      agentManager.spawn({ mode: 'spawn', task: 'tick probe', outsideContract: true });
      expect(snapshots).toEqual([]);
      tick();
      expect(snapshots[snapshots.length - 1]).toBe(1);
    } finally {
      registry.dispose();
      workflow.scheduleManager.destroy();
    }
  });
});
