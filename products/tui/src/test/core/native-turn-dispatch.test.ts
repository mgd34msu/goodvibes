import { describe, expect, test } from 'bun:test';
import { runNativeTurnDispatch, type NativeTurnDispatchSteps } from '../../core/native-turn-dispatch.ts';

function steps(overrides: Partial<NativeTurnDispatchSteps> = {}) {
  const log: string[] = [];
  const arm = { disarm: () => { log.push('disarm'); return true; } };
  const built: NativeTurnDispatchSteps = {
    armSpeech: () => { log.push('arm'); return arm; },
    prepare: async () => { log.push('prepare'); },
    current: () => true,
    begin: () => { log.push('begin'); },
    start: async () => { log.push('start'); },
    failed: (error) => { log.push(`failed:${(error as Error).message}`); },
    ...overrides,
  };
  return { built, log };
}

describe('dispatching a native turn with spoken output', () => {
  test('a turn that starts keeps its arm for the turn to consume', async () => {
    const { built, log } = steps();
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['arm', 'prepare', 'begin', 'start']);
  });

  test('a dispatch superseded while preparing withdraws its own arm and starts nothing', async () => {
    const { built, log } = steps({ current: () => false });
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['arm', 'prepare', 'disarm']);
  });

  test('an async failure handler finishes before the dispatch settles', async () => {
    const { built, log } = steps({
      start: async () => { throw new Error('bind failed'); },
      failed: async (error) => { await Promise.resolve(); log.push(`released:${(error as Error).message}`); },
    });
    await runNativeTurnDispatch(built);
    expect(log[log.length - 1]).toBe('released:bind failed');
  });

  test('a dispatch that throws before a turn is submitted withdraws its arm and says why', async () => {
    const { built, log } = steps({ start: async () => { throw new Error('intake refused'); } });
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['arm', 'prepare', 'begin', 'disarm', 'failed:intake refused']);
  });

  test('a superseded dispatch that throws withdraws its arm but does not report over the newer one', async () => {
    let current = true;
    const { built, log } = steps({
      prepare: async () => { current = false; throw new Error('late failure'); },
      current: () => current,
    });
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['arm', 'disarm']);
  });

  test('without speech there is nothing to withdraw', async () => {
    const { built, log } = steps({ armSpeech: () => null, start: async () => { throw new Error('x'); } });
    await runNativeTurnDispatch(built);
    expect(log).toEqual(['prepare', 'begin', 'failed:x']);
  });
});
