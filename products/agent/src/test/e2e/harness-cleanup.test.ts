import { expect, spyOn, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { AsyncDisposalError } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { closeE2EFixture, makeHome, removeHome, startStubModel } from './harness.ts';

for (const close of ['home', 'fixture'] as const) test(`${close} cleanup retains its real home until the original decision server drain settles`, async () => {
  const model = startStubModel(() => ({ text: 'Unused cleanup fixture model' }));
  const home = await makeHome(model);
  const originalStop = home.judgments.stop.bind(home.judgments);
  const gate = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const stop = spyOn(home.judgments, 'stop').mockImplementation(async () => {
    entered.resolve();
    await gate.promise;
    await originalStop();
  });
  let settled = false;
  const closing = (close === 'home' ? removeHome(home) : closeE2EFixture(home, () => model.stop()))
    .finally(() => { settled = true; });
  try {
    await entered.promise;
    expect(settled).toBe(false);
    expect(existsSync(home.root)).toBe(true);
    gate.resolve();
    await closing;
    expect(settled).toBe(true);
    expect(existsSync(home.root)).toBe(false);
  } finally {
    gate.resolve();
    await closing.catch(() => {});
    stop.mockRestore();
    await model.stop();
    await removeHome(home);
  }
});

test('fixture cleanup drains every independent owner, retains all failures and preserves the home on failed drainage', async () => {
  const model = startStubModel(() => ({ text: 'Unused cleanup fixture model' }));
  const home = await makeHome(model);
  const first = new Error('First original owner failure');
  const second = new Error('Second original owner failure');
  const calls: string[] = [];
  const stop = home.judgments.stop.bind(home.judgments);
  const decision = spyOn(home.judgments, 'stop').mockImplementation(async () => { calls.push('decision'); await stop(); });
  try {
    const outcome = await closeE2EFixture(home,
      () => { calls.push('first'); throw first; },
      async () => { calls.push('second'); throw second; },
      async () => { calls.push('model'); await model.stop(); },
    ).then(() => undefined, (error: unknown) => error);
    expect(outcome).toBeInstanceOf(AsyncDisposalError);
    if (!(outcome instanceof AsyncDisposalError)) throw new Error('Original cleanup failures were not retained');
    expect(outcome.failures.map(failure => failure.error)).toEqual([first, second]);
    expect(calls).toEqual(['first', 'second', 'model', 'decision']);
    expect(existsSync(home.root)).toBe(true);
  } finally {
    decision.mockRestore();
    await model.stop();
    await removeHome(home);
  }
});
