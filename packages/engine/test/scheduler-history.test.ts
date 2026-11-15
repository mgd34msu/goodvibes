/**
 *
 * TaskScheduler per-task run history: indexed by task, capped per task, and
 * written through a debounce that coalesces rapid saves.
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskScheduler } from '../platform/src/platform/scheduler/scheduler.ts';
import type { TaskRunRecord } from '../platform/src/platform/scheduler/scheduler.ts';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-scheduler-history-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function makeScheduler(): { scheduler: TaskScheduler; cleanup: () => void } {
  const dir = tempDir('sched');
  const storePath = join(dir, 'scheduler.json');
  const scheduler = new TaskScheduler({ storePath });
  return {
    scheduler,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('TaskScheduler per-task history Map', () => {
  test('getHistory returns records for the given taskId only', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { pushHistory: (rec: TaskRunRecord) => void };

      s.pushHistory({ taskId: 'task-a', startedAt: 1000, agentId: 'ag-1', status: 'completed' });
      s.pushHistory({ taskId: 'task-b', startedAt: 3000, agentId: 'ag-2', status: 'failed', error: 'oops' });
      s.pushHistory({ taskId: 'task-a', startedAt: 5000, agentId: 'ag-3', status: 'completed' });

      const histA = scheduler.getHistory('task-a');
      const histB = scheduler.getHistory('task-b');

      expect(histA.length).toBe(2);
      expect(histA.every((r) => r.taskId === 'task-a')).toBe(true);
      expect(histB.length).toBe(1);
      expect(histB[0]!.taskId).toBe('task-b');
    } finally {
      cleanup();
    }
  });

  test('history keeps only the newest records of a task, in order, and leaves other tasks alone', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { pushHistory: (rec: TaskRunRecord) => void };

      s.pushHistory({ taskId: 'task-other', startedAt: 99, agentId: 'ag-other', status: 'completed' });
      for (let i = 0; i < 12; i++) {
        s.pushHistory({ taskId: 'task-cap', startedAt: i, agentId: `ag-${i}`, status: 'completed' });
      }

      // The cap is the scheduler's MAX_HISTORY_PER_TASK (not exported): 12 pushes keep the last 5.
      expect(scheduler.getHistory('task-cap').map((r) => r.startedAt)).toEqual([7, 8, 9, 10, 11]);
      expect(scheduler.getHistory('task-other').map((r) => r.startedAt)).toEqual([99]);
    } finally {
      cleanup();
    }
  });

  test('rapid saves coalesce into one write that stop() flushes', async () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { scheduleSave: () => void; saveTracked: () => void };
      let writes = 0;
      s.saveTracked = () => { writes++; };

      s.scheduleSave();
      s.scheduleSave();
      s.scheduleSave();
      expect(writes).toBe(0);

      await scheduler.stop();
      expect(writes).toBe(1);

      await scheduler.stop();
      expect(writes).toBe(1);
    } finally {
      cleanup();
    }
  });

  test('getAllHistory returns records from all tasks', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      const s = scheduler as unknown as { pushHistory: (rec: TaskRunRecord) => void };

      s.pushHistory({ taskId: 'task-x', startedAt: 1, agentId: 'ag-x', status: 'completed' });
      s.pushHistory({ taskId: 'task-y', startedAt: 3, agentId: 'ag-y', status: 'completed' });

      const all = scheduler.getAllHistory();
      expect(all.length).toBe(2);
      const taskIds = new Set(all.map((r) => r.taskId));
      expect(taskIds.has('task-x')).toBe(true);
      expect(taskIds.has('task-y')).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('getNextRun rejects invalid timezones instead of using local time', () => {
    const { scheduler, cleanup } = makeScheduler();
    try {
      expect(() => scheduler.getNextRun('* * * * *', new Date(0), 'Not/AZone')).toThrow(/Invalid timezone/);
    } finally {
      cleanup();
    }
  });
});
