/**
 * After a restart every unfinished contract resumes on its own: one that is still shaping or planning
 * must not hold the others back until its model calls finish.
 */
import { afterEach, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import type { DecompositionRunner } from '../../platform/src/platform/core/plan-decomposition.js';
import { makeHarness, makeRepo, startContract, waitFor, type Harness } from './runner-support.js';

// Never answers, but settles on cancellation so teardown can drain.
const hangUntilAborted: DecompositionRunner['run'] = (request) =>
  new Promise((resolve) => request.signal?.addEventListener('abort', () => resolve({ status: 'cancelled', output: '', elapsedMs: 0 }), { once: true }));

const roots: string[] = [];
const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(h => h.dispose()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('every contract is resumed while the first one is still planning', async () => {
  const root = makeRepo();
  roots.push(root);
  const first = makeHarness({ root, planner: { run: hangUntilAborted }, scripts: {} });
  harnesses.push(first);
  const ids = [(await startContract(first)).contract.id, (await startContract(first)).contract.id];
  await waitFor(() => ids.every((id) => first.store.get(id)?.status === 'planning'), 'both contracts to reach planning');
  first.dispose();

  // Planning never answers, so the first contract stays in it; the second must still reach its own planner.
  let planners = 0;
  const second = makeHarness({ root, planner: { run: (request) => { planners += 1; return hangUntilAborted(request); } }, scripts: {} });
  harnesses.push(second);
  void second.runner.resumeAll();
  await waitFor(() => planners === 2, 'the second contract to start planning while the first still plans');
});
