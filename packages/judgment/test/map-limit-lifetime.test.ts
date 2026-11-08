import { expect, test } from 'bun:test';
import { mapLimit } from '../src/patterns/common.ts';

function barrier() { let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; }); return { wait, release }; }

test('a failed reading stops new admission and retains already admitted sibling ownership until settlement', async () => {
  const first = barrier(), second = barrier(); const started: number[] = [], settled: number[] = [];
  const failure = new Error('Fixture refusal');
  let returned = false;
  const result = mapLimit([0, 1, 2, 3], 2, async index => {
    started.push(index);
    if (index === 0) { await first.wait; throw failure; }
    await second.wait; settled.push(index); return index;
  });
  const observed = result.then(() => { returned = true; }, error => { returned = true; expect(error).toBe(failure); });
  expect(started).toEqual([0, 1]);
  first.release(); await Promise.resolve(); await Promise.resolve();
  expect(returned).toBe(false); expect(started).toEqual([0, 1]);
  second.release(); await observed;
  expect(settled).toEqual([1]); expect(started).toEqual([0, 1]); expect(returned).toBe(true);
});

test('concurrent failures preserve the first observed error and drain a later rejection', async () => {
  const earlier = barrier(), later = barrier(); const original = { kind: 'aborted' };
  const result = mapLimit([0, 1], 2, async index => {
    if (index === 1) { await earlier.wait; throw original; }
    await later.wait; throw new Error('Later failure');
  });
  const observed = result.then(() => null, error => error);
  earlier.release(); await Promise.resolve(); await Promise.resolve();
  later.release(); expect(await observed).toBe(original);
});

test('a synchronous callback failure cannot admit later work', async () => {
  const started: number[] = [];
  const result = mapLimit([0, 1, 2], 2, index => { started.push(index); throw undefined; });
  await expect(result).rejects.toBeUndefined();
  expect(started).toEqual([0]);
});
