import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceCheckpointManager } from '../platform/src/platform/workspace/checkpoint/manager.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { emitTurnCompleted, emitTurnError, emitTurnCancel } from '../platform/src/platform/runtime/emitters/turn.js';
import { emitAgentCompleted } from '../platform/src/platform/runtime/emitters/agents.js';
import type { TurnEvent } from '../platform/src/events/turn.js';
import type { EmitterContext } from '../platform/src/platform/runtime/emitters/index.js';

const roots: string[] = [];
const managers: WorkspaceCheckpointManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempWorkspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function newManager(root: string, bus: RuntimeEventBus): WorkspaceCheckpointManager {
  const manager = new WorkspaceCheckpointManager({ workspaceRoot: root, runtimeBus: bus });
  managers.push(manager);
  return manager;
}

const ctx: EmitterContext = { sessionId: 'sess-1', traceId: 'trace-1', source: 'test' };

/** One turn of the event loop: the bus dispatches listeners from a microtask, so after this every listener of an earlier emit has run. */
function flushBus(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Observes `create()` without changing it, so a test waits for the exact snapshot work an emit started instead of sleeping. */
function watchCreate(manager: WorkspaceCheckpointManager) {
  const create = spyOn(manager, 'create');
  return {
    create,
    async settled(): Promise<void> {
      await flushBus();
      await Promise.allSettled(create.mock.results.map((result) => result.value));
    },
  };
}

describe('WorkspaceCheckpointManager automatic snapshots', () => {
  test('TURN_COMPLETED triggers an automatic turn-kind checkpoint carrying the turnId', async () => {
    const root = tempWorkspace('wcp-events-turn-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    await manager.init();
    const watch = watchCreate(manager);

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-1', response: 'ok', stopReason: 'completed' });

    await watch.settled();
    expect(await manager.list()).toHaveLength(1);
    const [checkpoint] = await manager.list();
    expect(checkpoint!.kind).toBe('turn');
    expect(checkpoint!.turnId).toBe('turn-1');
  });

  test('resolveSessionId stamps the owning session on automatic snapshots; an unresolved agent stays unstamped', async () => {
    const root = tempWorkspace('wcp-events-session-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    manager.setSessionResolver(({ agentId }) => (agentId === 'agent-known' ? 'sess-known' : undefined));
    await manager.init();
    const watch = watchCreate(manager);

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitAgentCompleted(bus, ctx, { agentId: 'agent-known', durationMs: 1 });
    await watch.settled();
    expect(await manager.list()).toHaveLength(1);
    const [stamped] = await manager.list();
    expect(stamped!.sessionId).toBe('sess-known');
    expect((await manager.list({ sessionId: 'sess-known' })).map((c) => c.id)).toEqual([stamped!.id]);

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitAgentCompleted(bus, ctx, { agentId: 'agent-unknown', durationMs: 1 });
    await watch.settled();
    expect(await manager.list()).toHaveLength(2);
    const unstamped = (await manager.list()).find((c) => c.agentId === 'agent-unknown');
    expect(unstamped!.sessionId).toBeUndefined();
  });

  test('TURN_ERROR and TURN_CANCEL also trigger turn-kind checkpoints', async () => {
    const root = tempWorkspace('wcp-events-turn-err-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    await manager.init();
    const watch = watchCreate(manager);

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnError(bus, ctx, { turnId: 'turn-err', error: 'boom', stopReason: 'provider_error' });
    await watch.settled();
    expect(await manager.list()).toHaveLength(1);

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitTurnCancel(bus, ctx, { turnId: 'turn-cancel', stopReason: 'cancelled' });
    await watch.settled();
    expect(await manager.list()).toHaveLength(2);

    const all = await manager.list();
    expect(all.every((c) => c.kind === 'turn')).toBe(true);
    expect(all.map((c) => c.turnId).sort()).toEqual(['turn-cancel', 'turn-err']);
  });

  test('AGENT_COMPLETED triggers an automatic agent-run-kind checkpoint carrying the agentId, and lineage chains across turns', async () => {
    const root = tempWorkspace('wcp-events-agent-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    await manager.init();
    const watch = watchCreate(manager);

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-1', response: 'ok', stopReason: 'completed' });
    await watch.settled();
    expect(await manager.list()).toHaveLength(1);

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitAgentCompleted(bus, ctx, { agentId: 'agent-1', durationMs: 100, output: 'done' });
    await watch.settled();
    expect(await manager.list()).toHaveLength(2);

    const all = await manager.list();
    const agentCheckpoint = all.find((c) => c.kind === 'agent-run')!;
    const turnCheckpoint = all.find((c) => c.kind === 'turn')!;
    expect(agentCheckpoint.agentId).toBe('agent-1');
    expect(agentCheckpoint.parentId).toBe(turnCheckpoint.id);
  });

  test('a failing snapshot never throws back into the bus, never becomes an unhandled rejection, and other listeners still run', async () => {
    const root = tempWorkspace('wcp-events-failing-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    await manager.init();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    const create = spyOn(manager, 'create').mockRejectedValue(new Error('side repository is locked'));
    const seenByOthers: string[] = [];
    bus.on<Extract<TurnEvent, { type: 'TURN_COMPLETED' }>>('TURN_COMPLETED', ({ payload }) => { seenByOthers.push(payload.turnId); });
    try {
      expect(() => emitTurnCompleted(bus, ctx, { turnId: 'turn-fails', response: 'ok', stopReason: 'completed' })).not.toThrow();
      await flushBus();
      await flushBus();
      expect(create).toHaveBeenCalledTimes(1);
      expect(unhandled).toEqual([]);
      expect(seenByOthers).toEqual(['turn-fails']);

      // The bus is still healthy: a later emit reaches the manager again.
      emitTurnCompleted(bus, ctx, { turnId: 'turn-after', response: 'ok', stopReason: 'completed' });
      await flushBus();
      await flushBus();
      expect(create).toHaveBeenCalledTimes(2);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('TURN_COMPLETED on an unchanged tree runs the snapshot, which dedupes to no checkpoint', async () => {
    const root = tempWorkspace('wcp-events-noop-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    await manager.init();
    const watch = watchCreate(manager);

    emitTurnCompleted(bus, ctx, { turnId: 'noop-turn', response: 'ok', stopReason: 'completed' });
    await watch.settled();

    expect(watch.create).toHaveBeenCalledTimes(1);
    await expect(watch.create.mock.results[0]!.value).resolves.toBeNull();
    expect(await manager.list()).toHaveLength(0);
  });

  test('dispose() unsubscribes from the bus: events after dispose never reach create()', async () => {
    const root = tempWorkspace('wcp-events-dispose-');
    const bus = new RuntimeEventBus();
    const manager = newManager(root, bus);
    await manager.init();
    const watch = watchCreate(manager);

    writeFileSync(join(root, 'a.txt'), 'v1\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-before-dispose', response: 'ok', stopReason: 'completed' });
    await watch.settled();
    expect(await manager.list()).toHaveLength(1);
    expect(watch.create).toHaveBeenCalledTimes(1);

    manager.dispose();

    writeFileSync(join(root, 'a.txt'), 'v2\n');
    emitTurnCompleted(bus, ctx, { turnId: 'turn-after-dispose', response: 'ok', stopReason: 'completed' });
    await watch.settled();

    expect(watch.create).toHaveBeenCalledTimes(1);
    expect(await manager.list()).toHaveLength(1);
  });
});
