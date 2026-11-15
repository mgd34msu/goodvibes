/**
 * TaskScheduler: cron scanning across a DST fall-back, persistence honesty,
 * run history outcomes, restart bookkeeping and early timer wake-ups.
 */

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskScheduler } from '../platform/src/platform/scheduler/scheduler.ts';
import type { TaskRunRecord } from '../platform/src/platform/scheduler/scheduler.ts';

let dir: string;
const originalTz = process.env['TZ'];
const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  dir = join(tmpdir(), `gv-scheduler-lifecycle-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  setSystemTime();
  globalThis.setTimeout = originalSetTimeout;
  if (originalTz === undefined) delete process.env['TZ'];
  else process.env['TZ'] = originalTz;
  rmSync(dir, { recursive: true, force: true });
});

function storePath(name = 'scheduler.json'): string {
  return join(dir, name);
}

describe('cron scan with no timezone across a DST fall-back', () => {
  test('a weekday-only cron scanned from the day before the fall-back returns', () => {
    process.env['TZ'] = 'America/New_York';
    const scheduler = new TaskScheduler({ storePath: storePath() });
    // Saturday 2026-10-31 20:00 EDT; the next Monday 09:00 is after the 25-hour Sunday.
    const next = scheduler.getNextRun('0 9 * * 1-5', new Date('2026-11-01T00:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-02T14:00:00.000Z');
  });

  test('a daily cron scanned across the repeated 01:00 hour returns', () => {
    process.env['TZ'] = 'America/New_York';
    const scheduler = new TaskScheduler({ storePath: storePath() });
    const next = scheduler.getNextRun('0 9 * * *', new Date('2026-11-01T03:00:00Z'));
    expect(next.toISOString()).toBe('2026-11-01T14:00:00.000Z');
  });

  test('a month-restricted cron scanned across the fall-back returns', () => {
    process.env['TZ'] = 'America/New_York';
    const scheduler = new TaskScheduler({ storePath: storePath() });
    const next = scheduler.getNextRun('30 1 1 12 *', new Date('2026-10-31T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-12-01T06:30:00.000Z');
  });
});

describe('add', () => {
  test('stamps the process timezone on a task created without one', () => {
    const scheduler = new TaskScheduler({ storePath: storePath() });
    const task = scheduler.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false });
    expect(task.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(task.timezone).toBeTruthy();
  });

  test('keeps an explicit timezone', () => {
    const scheduler = new TaskScheduler({ storePath: storePath() });
    const task = scheduler.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false, timezone: 'Europe/London' });
    expect(task.timezone).toBe('Europe/London');
  });
});

describe('persistence', () => {
  test('whenPersisted rejects when the schedule could not be written', async () => {
    // A directory component that is a regular file makes every write fail,
    // whoever runs the test.
    const blocker = storePath('blocker');
    writeFileSync(blocker, 'x');
    const scheduler = new TaskScheduler({ storePath: join(blocker, 'scheduler.json') });
    scheduler.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false });
    await expect(scheduler.whenPersisted()).rejects.toThrow('could not save its schedules');
  });

  test('whenPersisted resolves once the write reached disk', async () => {
    const path = storePath();
    const scheduler = new TaskScheduler({ storePath: path });
    const task = scheduler.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false });
    await scheduler.whenPersisted();
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { tasks: { id: string }[] };
    expect(onDisk.tasks.map((t) => t.id)).toEqual([task.id]);
  });

  test('stop writes the history a pending debounce had not saved', async () => {
    const path = storePath();
    const scheduler = new TaskScheduler({ storePath: path, spawnTask: () => 'agent-1' });
    const task = scheduler.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false });
    await scheduler.whenPersisted();
    await scheduler.runNow(task.id);
    await scheduler.stop();
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as { tasks: { runCount: number }[]; history: TaskRunRecord[] };
    expect(onDisk.tasks[0]!.runCount).toBe(1);
    expect(onDisk.history.map((r) => r.agentId)).toEqual(['agent-1']);
  });
});

describe('run outcomes', () => {
  async function runOnce(outcome: Promise<{ status: 'completed' | 'failed'; error?: string }>): Promise<TaskRunRecord[]> {
    const scheduler = new TaskScheduler({
      storePath: storePath(),
      spawnTask: () => 'agent-1',
      awaitRun: () => outcome,
    });
    const task = scheduler.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false });
    await scheduler.runNow(task.id);
    await outcome.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    return scheduler.getHistory(task.id);
  }

  test('a finished agent ends its run as completed', async () => {
    const history = await runOnce(Promise.resolve({ status: 'completed' }));
    expect(history.map((r) => r.status)).toEqual(['completed']);
  });

  test('a failed agent ends its run as failed with its error', async () => {
    const history = await runOnce(Promise.resolve({ status: 'failed', error: 'boom' }));
    expect(history[0]!.status).toBe('failed');
    expect(history[0]!.error).toBe('boom');
  });

  test('a tracker that rejects ends the run as failed', async () => {
    const history = await runOnce(Promise.reject(new Error('lost agent')));
    expect(history[0]!.status).toBe('failed');
    expect(history[0]!.error).toContain('lost agent');
  });

  test('a run left running by an earlier process is failed on load when runs are tracked', async () => {
    const path = storePath();
    const first = new TaskScheduler({ storePath: path, spawnTask: () => 'agent-1' });
    const task = first.add({ name: 'n', cron: '0 9 * * *', prompt: 'p', enabled: false });
    await first.whenPersisted();
    await first.runNow(task.id);
    await first.stop();

    const second = new TaskScheduler({ storePath: path, spawnTask: () => 'agent-2', awaitRun: () => new Promise(() => {}) });
    await second.start();
    const history = second.getHistory(task.id);
    expect(history.map((r) => r.status)).toEqual(['failed']);
    expect(history[0]!.error).toContain('stopped before this run reported');
    await second.stop();
  });
});

describe('missed runs on start', () => {
  function seed(path: string, patch: { enabled: boolean }): void {
    const lastRun = Date.parse('2026-01-01T00:00:00Z');
    writeFileSync(path, JSON.stringify({
      tasks: [{
        id: 'sched-1', name: 'n', cron: '0 9 * * *', timezone: 'UTC', prompt: 'p', enabled: patch.enabled,
        runCount: 1, missedRuns: 0, createdAt: lastRun, lastRun,
      }],
      history: [],
    }));
  }

  test('starting twice over the same store records one missed run', async () => {
    const path = storePath();
    seed(path, { enabled: true });
    const first = new TaskScheduler({ storePath: path });
    await first.start();
    (first as unknown as { saveTracked: () => void }).saveTracked();
    await first.stop();
    const second = new TaskScheduler({ storePath: path });
    await second.start();
    expect(second.getHistory('sched-1').filter((r) => r.error === 'Missed (scheduler was offline)')).toHaveLength(1);
    await second.stop();
  });

  test('a disabled task is not reported as missed', async () => {
    const path = storePath();
    seed(path, { enabled: false });
    const scheduler = new TaskScheduler({ storePath: path });
    await scheduler.start();
    expect(scheduler.getHistory('sched-1')).toHaveLength(0);
    await scheduler.stop();
  });

  test('the missed record does not push out the saved runs', async () => {
    const path = storePath();
    const lastRun = Date.parse('2026-01-01T00:00:00Z');
    const history = Array.from({ length: 5 }, (_, i) => ({
      taskId: 'sched-1', startedAt: lastRun - (5 - i) * 1000, agentId: `a${i}`, status: 'completed',
    }));
    writeFileSync(path, JSON.stringify({
      tasks: [{
        id: 'sched-1', name: 'n', cron: '0 9 * * *', timezone: 'UTC', prompt: 'p', enabled: true,
        runCount: 5, missedRuns: 0, createdAt: lastRun, lastRun,
      }],
      history,
    }));
    const scheduler = new TaskScheduler({ storePath: path });
    await scheduler.start();
    const kept = scheduler.getHistory('sched-1');
    expect(kept.at(-1)!.error).toBe('Missed (scheduler was offline)');
    await scheduler.stop();
  });
});

describe('a timer that wakes a moment early', () => {
  test('does not schedule the same minute again', async () => {
    setSystemTime(new Date('2026-06-01T08:59:00.000Z'));
    const timers: { fn: () => void; delay: number }[] = [];
    globalThis.setTimeout = ((fn: () => void, delay?: number) => {
      timers.push({ fn, delay: delay ?? 0 });
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    let spawned = 0;
    const scheduler = new TaskScheduler({ storePath: storePath(), spawnTask: () => `agent-${++spawned}` });
    (scheduler as unknown as { running: boolean }).running = true;
    scheduler.add({ name: 'n', cron: '0 9 * * *', timezone: 'UTC', prompt: 'p', enabled: true });
    const armed = timers.filter((t) => t.delay > 0 && t.delay <= 120_000);
    expect(armed).toHaveLength(1);

    // The timer fires 1 ms before 09:00.
    setSystemTime(new Date('2026-06-01T08:59:59.999Z'));
    timers.length = 0;
    armed[0]!.fn();
    await originalSetTimeoutPromise();
    expect(spawned).toBe(1);
    const next = timers.filter((t) => t.delay > 60_000);
    expect(next).toHaveLength(1);
    expect(timers.filter((t) => t.delay <= 60_000 && t.delay !== 1_000)).toHaveLength(0);
  });
});

function originalSetTimeoutPromise(): Promise<void> {
  return new Promise((resolve) => originalSetTimeout(resolve, 0));
}
