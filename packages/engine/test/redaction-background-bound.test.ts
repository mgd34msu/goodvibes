import { afterEach, beforeEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { redactSensitiveData } from '../platform/src/platform/utils/redaction.js';

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

test('a loop over many distinct texts starts a bounded number of background readings', async () => {
  const { port } = fakePort(() => { throw new Error('unused'); });
  let asks = 0;
  // Never answers, so every started reading stays in flight.
  installJudgmentPort({ ...port, ask() { asks++; return new Promise(() => {}); } });
  for (let i = 0; i < 1000; i++) redactSensitiveData(`The bearer ${i} of bad news arrived.`);
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(asks).toBeGreaterThan(0);
  expect(asks).toBeLessThan(100);
});
