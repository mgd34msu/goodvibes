import { expect, test } from 'bun:test';
import { CostTracker } from '../platform/src/platform/observe/cost-tracker.js';

const price = (input: number, output: number, _cacheRead: number, _cacheWrite: number, model: string) => (input + output) * (model === 'expensive' ? 10 : 1);
const usage = (input: number, model: string) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, model });

test('tokens used before a model switch keep the price of the model that produced them', () => {
  const tracker = new CostTracker({ price });
  tracker.refreshSession(usage(1_000, 'expensive'));
  expect(tracker.sessionCost()).toBe(10_000);
  tracker.refreshSession(usage(3_000, 'cheap'));
  expect(tracker.sessionCost()).toBe(10_000 + 2_000);
  expect(tracker.costHistory()).toEqual([10_000, 2_000]);
  tracker.refreshSession(usage(4_000, 'cheap'));
  expect(tracker.sessionCost()).toBe(10_000 + 3_000);
});

test('counters that restart are priced from zero rather than against the old model', () => {
  const tracker = new CostTracker({ price });
  tracker.refreshSession(usage(5_000, 'expensive'));
  tracker.refreshSession(usage(100, 'cheap'));
  expect(tracker.sessionCost()).toBe(100);
});
