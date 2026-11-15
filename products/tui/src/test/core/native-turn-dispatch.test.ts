import { describe, expect, test } from 'bun:test';
import { runNativeTurnDispatch, type NativeTurnDispatchSteps } from '../../core/native-turn-dispatch.ts';

function steps(overrides: Partial<NativeTurnDispatchSteps> = {}) {
  const log: string[] = [];
  const built: NativeTurnDispatchSteps = {
    prepare: async () => { log.push('prepare'); },
    current: () => true,
    begin: () => { log.push('begin'); },
    start: async () => { log.push('start'); },
    failed: (error) => { log.push(`failed:${(error as Error).message}`); },
    ...overrides,
  };
  return { built, log };
}

describe('dispatching a native turn', () => {
  test('a current dispatch prepares, begins and starts its turn', async () => {
    const { built, log } = steps();
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['prepare', 'begin', 'start']);
  });

  test('a dispatch superseded while preparing starts nothing', async () => {
    const { built, log } = steps({ current: () => false });
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['prepare']);
  });

  test('an async failure handler finishes before the dispatch settles', async () => {
    const { built, log } = steps({
      start: async () => { throw new Error('bind failed'); },
      failed: async (error) => { await Promise.resolve(); log.push(`released:${(error as Error).message}`); },
    });
    await runNativeTurnDispatch(built);
    expect(log[log.length - 1]).toBe('released:bind failed');
  });

  test('a superseded dispatch that throws does not report over the newer one', async () => {
    let current = true;
    const { built, log } = steps({
      prepare: async () => { current = false; throw new Error('late failure'); },
      current: () => current,
    });
    await runNativeTurnDispatch(built);
    expect(log).toEqual([]);
  });
});
