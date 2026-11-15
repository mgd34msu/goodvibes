import { describe, expect, test } from 'bun:test';
import { isTerminal, reachableFrom } from '../platform/src/platform/runtime/lifecycle-facade.ts';
import { taskLifecycle } from '../platform/src/platform/runtime/tasks/lifecycle.ts';
import { compactionLifecycle } from '../platform/src/platform/runtime/compaction/lifecycle.ts';

describe('lifecycle facade with a state name two machines share', () => {
  test('`failed` answers for the machine the caller names', () => {
    const task = [...reachableFrom('failed', 'task')].sort();
    const compaction = [...reachableFrom('failed', 'compaction')].sort();

    expect(task).toEqual([...taskLifecycle.next('failed')].sort());
    expect(compaction).toEqual([...compactionLifecycle.next('failed')].sort());
    expect(task).not.toEqual(compaction);
  });
});
