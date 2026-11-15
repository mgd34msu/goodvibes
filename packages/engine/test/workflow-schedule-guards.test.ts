/**
 * Scheduled workflow commands: a schedule that could never run or would run
 * away is refused when it is added, quoted arguments survive, runs never pile
 * up, and nothing starts after the manager was destroyed.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ScheduleManager, createWorkflowServices, createWorkflowTool, splitCommand } from '../platform/src/platform/tools/workflow/index.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings([]);

const managers: ScheduleManager[] = [];
afterEach(() => { for (const manager of managers.splice(0)) manager.destroy(); });

function tool() {
  const services = createWorkflowServices();
  managers.push(services.scheduleManager);
  const workflow = createWorkflowTool(services, {
    contractRunner: { start: () => { throw new Error('unused'); } } as never,
    projectRoot: '/tmp',
    resolveSessionId: () => 's',
  });
  const add = (scheduleInterval: string, scheduleCommand = 'true') =>
    workflow.execute({ mode: 'schedule', scheduleAction: 'add', scheduleName: 'job', scheduleInterval, scheduleCommand });
  return { services, add };
}

/** setInterval captured so a test can run the tick by hand instead of waiting. */
function captureTimers() {
  const callbacks: Array<() => void> = [];
  const spy = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    callbacks.push(callback);
    return { unref() {} } as unknown as ReturnType<typeof setInterval>;
  }) as unknown as typeof setInterval);
  return { callbacks, restore: () => spy.mockRestore() };
}

describe('schedule add refuses what could never run correctly', () => {
  for (const [interval, why] of [['0s', 'shorter'], ['0.5s', 'shorter'], ['banana', 'Unrecognised'], ['5 minutes', 'Unrecognised'], ['30d', 'maximum']] as const) {
    test(`interval "${interval}" is refused and nothing is scheduled`, async () => {
      const { services, add } = tool();
      const result = await add(interval);
      expect(result.success).toBe(false);
      expect(result.error).toContain(why);
      expect(services.scheduleManager.list()).toEqual([]);
    });
  }

  test('a reasonable interval is accepted with a next run', async () => {
    const { services, add } = tool();
    const result = await add('30s');
    expect(result.success).toBe(true);
    expect(services.scheduleManager.list()[0]?.nextRun).toBeGreaterThan(0);
  });

  test('a command with an unclosed quote is refused', async () => {
    const { add } = tool();
    const result = await add('30s', 'echo "unterminated');
    expect(result.success).toBe(false);
    expect(result.error).toContain('unclosed');
  });
});

describe('splitCommand', () => {
  test('quotes group words without a shell', () => {
    expect(splitCommand(`git commit -m "fix the thing" 'a b'`)).toEqual(['git', 'commit', '-m', 'fix the thing', 'a b']);
    expect(splitCommand('echo "" x')).toEqual(['echo', '', 'x']);
  });
});

describe('a schedule tick', () => {
  test('is skipped while the previous run is still going', async () => {
    const timers = captureTimers();
    const manager = new ScheduleManager(); managers.push(manager);
    const spawned = Promise.withResolvers<void>();
    const spawn = Bun.spawn;
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((...args: unknown[]) => {
      const proc = Reflect.apply(spawn, Bun, args) as ReturnType<typeof Bun.spawn>;
      spawned.resolve();
      return proc;
    }) as typeof Bun.spawn);
    const debug = spyOn(logger, 'debug').mockImplementation(() => {});
    try {
      manager.add('job', '30s', 'sleep 30');
      timers.restore();
      timers.callbacks[0]!();
      await spawned.promise;
      timers.callbacks[0]!();
      expect(spawnSpy.mock.calls).toHaveLength(1);
      expect(debug.mock.calls.some(([message]) => String(message).includes('tick skipped'))).toBe(true);
      expect(manager.list()[0]?.lastRun).toBeGreaterThan(0);
    } finally { debug.mockRestore(); spawnSpy.mockRestore(); manager.destroy(); }
  });

  test('does not start a command when the manager is destroyed while the environment is being read', async () => {
    const timers = captureTimers();
    const manager = new ScheduleManager(); managers.push(manager);
    const spawnSpy = spyOn(Bun, 'spawn');
    try {
      manager.add('job', '30s', 'true');
      timers.restore();
      timers.callbacks[0]!();
      manager.destroy();
      // Let the environment reading finish; the start that was waiting on it must not proceed.
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(spawnSpy).not.toHaveBeenCalled();
    } finally { spawnSpy.mockRestore(); }
  });

  test('records lastRun only when the command actually started', async () => {
    const timers = captureTimers();
    const manager = new ScheduleManager(); managers.push(manager);
    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation((() => { throw new Error('exec failed'); }) as unknown as typeof Bun.spawn);
    const warn = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      manager.add('job', '30s', 'true');
      timers.restore();
      timers.callbacks[0]!();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(spawnSpy).toHaveBeenCalled();
      expect(manager.list()[0]?.lastRun).toBeUndefined();
    } finally { warn.mockRestore(); spawnSpy.mockRestore(); }
  });
});
