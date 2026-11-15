import { describe, expect, test } from 'bun:test';
import { createOrderedShutdown } from '../terminal-shell/src/ordered-shutdown.js';

describe('createOrderedShutdown failures', () => {
  test('one failure is thrown as it is and several as an aggregate carrying the message', async () => {
    const one = new Error('one');
    const single = createOrderedShutdown<void>(async (_data, attempt) => { await attempt(() => { throw one; }); }, 'release failed');
    await expect(single()).rejects.toBe(one);

    const first = new Error('first');
    const second = new Error('second');
    const several = createOrderedShutdown<void>(async (_data, attempt) => {
      await attempt(() => { throw first; });
      await attempt(() => { throw second; });
    }, 'release failed');
    const error = await several().then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toBe('release failed');
    expect((error as AggregateError).errors).toEqual([first, second]);
  });

  test('a failure chooser receives every error in invocation order and decides what is thrown', async () => {
    class Saved extends Error {}
    const first = new Error('first');
    const second = new Error('second');
    let saved = false;
    const shutdown = createOrderedShutdown<void>(async (_data, attempt) => {
      // The later-invoked cleanup settles first; the order reported is still invocation order.
      const late = attempt(async () => { throw first; });
      const early = attempt(() => { throw second; });
      await Promise.all([early, late]);
      saved = true;
    }, 'release failed', (errors, message) => {
      expect(saved).toBe(true);
      return Object.assign(new Saved(message), { errors });
    });
    const error = await shutdown().then(() => undefined, (thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Saved);
    expect((error as Saved & { errors: unknown[] }).errors).toEqual([first, second]);
  });

  test('the chooser is not consulted when nothing failed, and every caller shares one completion', async () => {
    let chosen = 0;
    let runs = 0;
    const shutdown = createOrderedShutdown<void>(async () => { runs++; }, 'release failed', () => { chosen++; return new Error('unused'); });
    const a = shutdown();
    const b = shutdown();
    expect(b).toBe(a);
    await a;
    expect(chosen).toBe(0);
    expect(runs).toBe(1);
  });

  test('a callback that returns the shutdown it belongs to is reported instead of deadlocking', async () => {
    let shutdown!: (data: void) => Promise<void>;
    shutdown = createOrderedShutdown<void>(async (_data, attempt) => { await attempt(() => shutdown()); }, 'release failed');
    await expect(shutdown()).rejects.toThrow('cannot await its own shutdown');
  });
});
