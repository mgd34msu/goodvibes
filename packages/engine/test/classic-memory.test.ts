import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../sdk/src/platform/runtime/decision-policy.js';
import { detectReferencedMemoryIds } from '../sdk/src/platform/state/memory-usage-detection.js';
import { runMemoryConsolidation } from '../sdk/src/platform/state/memory-consolidation.js';
import { DEFAULT_MEMORY_CONSOLIDATION_CONFIG } from '../sdk/src/platform/state/memory-consolidation-config.js';

let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; });
function outage() {
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  restore = () => { installJudgmentPort(previous); };
  return fake.requests;
}

test.each(['Classic - Off', 'Preferred'] as const)('%s memory bookkeeping never credits an unassessed reference', async policy => {
  const requests = outage();
  await withDecisionModelPolicy(() => policy, async () => {
    const records = [{ id: 'memory-one', summary: 'Owner-declared project fact.' }];
    const result = await detectReferencedMemoryIds('The task is complete.', records);
    expect(result).toMatchObject({ provenance: 'classic', referenced: [], present: ['memory-one'] });
    expect(result.perId.get('memory-one')).toBe('present'); result.assertCurrent();
    const attempted = requests.length;
    expect(attempted).toBe(policy === 'Preferred' ? 1 : 0);
    await detectReferencedMemoryIds('Another answer.', records);
    expect(requests).toHaveLength(attempted);
    records[0]!.summary = 'Changed after observation';
    expect(result.assertCurrent).toThrow();
  });
});

test('Classic idle consolidation explicitly skips without merging, decaying or archiving memory', async () => {
  const requests = outage();
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    let reads = 0, writes = 0;
    const receipt = await runMemoryConsolidation({
      memoryRegistry: {
        getAll() { reads++; return []; },
        review() { writes++; return null; },
        update() { writes++; return null; },
      },
      config: DEFAULT_MEMORY_CONSOLIDATION_CONFIG,
      now: 1_000_000, trigger: 'idle', idle: true, randomSuffix: () => 'synthetic',
    });
    expect(receipt).toMatchObject({ disposition: 'skipped', provenance: 'classic', merged: [], decayed: [], archived: [], proposed: [] });
    expect(reads).toBe(0); expect(writes).toBe(0);
  });
  expect(requests).toHaveLength(0);
});
