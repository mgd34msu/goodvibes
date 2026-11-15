/**
 * A task list honours its limit, a failed daemon lookup is not "no such task",
 * and a task only this surface runs is not cancelled through the daemon.
 */
import { describe, expect, test } from 'bun:test';
import { createTasksClient } from '../platform/src/platform/runtime/client/tasks-client.ts';
import type { DaemonVerbCaller } from '../platform/src/platform/runtime/client/daemon-verbs.ts';
import type { RuntimeTask } from '../platform/src/platform/runtime/store/index.ts';

function task(id: string, title: string): RuntimeTask {
  return {
    id, kind: 'agent', title, status: 'running', owner: 'someone',
    cancellable: true, childTaskIds: [], queuedAt: 1_000,
  } as unknown as RuntimeTask;
}

function localSource(tasks: readonly RuntimeTask[]): { list: (limit: number) => readonly RuntimeTask[]; get: (id: string) => RuntimeTask | null } {
  return {
    list: () => tasks,
    get: (id: string) => tasks.find((t) => t.id === id) ?? null,
  };
}

function verbs(
  answers: Record<string, unknown>,
  options: { unavailable?: string; throws?: boolean } = {},
): DaemonVerbCaller & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  return {
    calls,
    probe: () => (options.unavailable
      ? { available: false as const, reason: options.unavailable }
      : { available: true as const }),
    invoke: async <T,>(methodId: string, input?: unknown): Promise<T> => {
      calls.push([methodId, input]);
      if (options.throws) throw new Error('connection reset');
      return (answers[methodId] ?? {}) as T;
    },
  };
}


describe('limits, lookups and local ids', () => {
  test('the union never exceeds the requested limit', async () => {
    const many = Array.from({ length: 600 }, (_, index) => task(`d${index}`, 'scheduled work'));
    const client = createTasksClient({ local: localSource([task('l1', 'local work')]), verbs: verbs({ 'tasks.list': { tasks: many } }) });
    const result = await client.list(50);
    expect(result.tasks).toHaveLength(50);
    expect(result.tasks[0]?.task.id).toBe('l1');
  });

  test('a daemon that fails the lookup is not reported as "no such task"', async () => {
    const client = createTasksClient({ local: localSource([]), verbs: verbs({}, { throws: true }) });
    expect(await client.lookup('d1')).toEqual({ found: null, daemonUnavailable: 'connection reset' });
    const absent = createTasksClient({ local: localSource([]), verbs: verbs({ 'tasks.get': {} }) });
    expect(await absent.lookup('d1')).toEqual({ found: null, daemonUnavailable: null });
  });

  test('cancel of a task only this surface runs is refused instead of sent to the daemon', async () => {
    const caller = verbs({ 'tasks.get': {} });
    const client = createTasksClient({ local: localSource([task('l1', 'local work')]), verbs: caller });
    await expect(client.cancel('l1')).rejects.toThrow('runs itself');
    expect(caller.calls.some(([method]) => method === 'tasks.cancel')).toBe(false);
  });
});
