import { expect, test } from 'bun:test';
import { createHostShutdown, settleDaemonStart } from '../platform/src/platform/daemon/cli-shutdown.js';

test('a second signal waits for the first shutdown and the first exit status wins', async () => {
  let stops = 0; const finished: number[] = [];
  const shutdown = createHostShutdown(async () => { stops++; }, code => { finished.push(code); });
  await Promise.all([shutdown(), shutdown(1)]);
  await shutdown(1);
  expect(stops).toBe(1);
  expect(finished).toEqual([0]);
});

test('the exit status is still set when stopping throws', async () => {
  const finished: number[] = [];
  const shutdown = createHostShutdown(async () => { throw new Error('socket stuck'); }, code => { finished.push(code); });
  await expect(shutdown(1)).rejects.toThrow('socket stuck');
  expect(finished).toEqual([1]);
});

test('a start that handed the runtime over ends the host with a failure status and does not report it started', async () => {
  const exits: (number | undefined)[] = []; const reports: string[] = [];
  const outcome = { state: 'handover' as const, drain: Promise.resolve(), cancel: () => {} };
  const settled = await settleDaemonStart(outcome, async code => { exits.push(code); }, message => reports.push(message));
  expect(settled).toBe('ended');
  expect(exits).toEqual([1]);
  expect(reports).toHaveLength(1);
});

test('a handover refused before anything stopped, and an ordinary start, keep the host serving', async () => {
  const exits: (number | undefined)[] = [];
  const shutdown = async (code?: number) => { exits.push(code); };
  const refused = { state: 'handover' as const, drain: Promise.resolve(), cancel: () => {}, resumed: () => true };
  expect(await settleDaemonStart(refused, shutdown, () => {})).toBe('serving');
  expect(await settleDaemonStart(undefined, shutdown, () => {})).toBe('serving');
  expect(exits).toEqual([]);
});
