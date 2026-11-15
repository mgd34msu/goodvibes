import { describe, expect, test } from 'bun:test';
import { createMemorySpineRecheck, resolveMemorySpineRecheckMs, MEMORY_SPINE_RECHECK_DEFAULT_MS, MEMORY_SPINE_RECHECK_MIN_MS } from '../../runtime/memory-spine-recheck.ts';
import { createStartupNotices } from '../../runtime/startup-notices.ts';
import { startPlanActivationTurn } from '../../runtime/plan-activation.ts';
import { recordComposedPromptUsage } from '../../runtime/prompt-usage-record.ts';

/** Lets every already-queued promise continuation run; no timers involved. */
const flush = async (): Promise<void> => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

describe('memory-spine recheck', () => {
  function fakeScheduler() {
    const armed: number[] = [];
    const schedule = ((_fn: () => void, ms: number) => { armed.push(ms); return { unref() {} } as unknown as ReturnType<typeof setInterval>; }) as unknown as typeof setInterval;
    return { armed, schedule };
  }

  test('a task resuming after shutdown took the timer arms nothing', () => {
    const { armed, schedule } = fakeScheduler();
    const recheck = createMemorySpineRecheck({ intervalMs: () => 5000, reconcile: async () => undefined, setIntervalFn: schedule });
    expect(recheck.take()).toBeNull();
    recheck.arm();
    expect(armed).toEqual([]);
  });

  test('arming is idempotent and the taken timer is the one that was armed', () => {
    const { armed, schedule } = fakeScheduler();
    const recheck = createMemorySpineRecheck({ intervalMs: () => 5000, reconcile: async () => undefined, setIntervalFn: schedule });
    recheck.arm();
    recheck.arm();
    expect(armed).toEqual([5000]);
    expect(recheck.take()).not.toBeNull();
    expect(recheck.take()).toBeNull();
  });

  test('the interval is finite and floored: junk falls back to the default, tiny values to the minimum', () => {
    expect(resolveMemorySpineRecheckMs('abc')).toBe(MEMORY_SPINE_RECHECK_DEFAULT_MS);
    expect(resolveMemorySpineRecheckMs(undefined)).toBe(MEMORY_SPINE_RECHECK_DEFAULT_MS);
    expect(resolveMemorySpineRecheckMs(Number.NaN)).toBe(MEMORY_SPINE_RECHECK_DEFAULT_MS);
    expect(resolveMemorySpineRecheckMs(1)).toBe(MEMORY_SPINE_RECHECK_MIN_MS);
    expect(resolveMemorySpineRecheckMs('45000')).toBe(45_000);
  });
});

describe('startup notices', () => {
  test('a boot-time failure is held until the router exists and then shown once', async () => {
    let router: { high(message: string): void } | null = null;
    const shown: string[] = [];
    const notices = createStartupNotices(() => router);
    notices.guard('Saved approvals could not be loaded', async () => { throw new Error('corrupt file'); });
    await flush();
    expect(shown).toEqual([]);
    router = { high: (message) => { shown.push(message); } };
    notices.flush();
    notices.flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('Saved approvals could not be loaded');
    expect(shown[0]).toContain('corrupt file');
  });

  test('a task that succeeds shows nothing, and a failure after the router exists shows immediately', async () => {
    const shown: string[] = [];
    const notices = createStartupNotices(() => ({ high: (message: string) => { shown.push(message); } }));
    notices.guard('fine', async () => undefined);
    notices.guard('broken', async () => { throw new Error('nope'); });
    await flush();
    expect(shown).toHaveLength(1);
    expect(shown[0]).toContain('broken');
  });
});

describe('plan activation turn', () => {
  test('a turn that cannot start is shown to the user, naming the plan', async () => {
    const notices: string[] = [];
    startPlanActivationTurn({
      planId: 'plan-7', task: 'do it',
      handleUserInput: async () => { throw new Error('a turn is already running'); },
      notify: (message) => { notices.push(message); },
    });
    await flush();
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('plan-7');
    expect(notices[0]).toContain('a turn is already running');
  });

  test('the turn starts after the caller returns, with the task, and nothing is announced on success', async () => {
    const seen: string[] = [];
    const notices: string[] = [];
    startPlanActivationTurn({ planId: 'p', task: 'ship it', handleUserInput: async (task) => { seen.push(task); }, notify: (m) => { notices.push(m); } });
    expect(seen).toEqual([]);
    await flush();
    expect(seen).toEqual(['ship it']);
    expect(notices).toEqual([]);
  });
});

describe('prompt usage recording', () => {
  test('a counter file that cannot be written does not fail the prompt', () => {
    expect(recordComposedPromptUsage(() => { throw new Error('EROFS'); })).toBe(false);
    expect(recordComposedPromptUsage(() => undefined)).toBe(true);
  });
});
