import { expect, test } from 'bun:test';
import { poolFor, type RoutePlanRequest } from '../platform/src/platform/routing/route-planner.ts';
import { CHOICE_SHORTLIST, TIER_READ_ROUNDS, TIER_READ_SHORTLIST } from '../platform/src/platform/routing/policy.ts';
import type { ModelFacts, TierRecord } from '../platform/src/platform/routing/model-tiers.ts';
import type { RouteTier } from '../platform/src/platform/routing/tiers.ts';
import { JudgmentHeldError } from '../platform/src/platform/types/judgment-held.ts';

const request = {} as RoutePlanRequest;

function catalog(count: number): ModelFacts[] {
  return Array.from({ length: count }, (_, index) => ({
    registryKey: `fixture:m${String(index).padStart(3, '0')}`, id: `m${index}`, name: `Model ${index}`, provider: 'fixture',
    price: { input: index + 1, output: index + 1 },
  }));
}

/** A tier store that reads every model as `tier` and counts what it was asked to read. */
function tiers(tier: RouteTier, settle = true) {
  const known = new Map<string, TierRecord>();
  const reads: number[] = [];
  return {
    reads,
    store: {
      known: (facts: ModelFacts) => known.get(facts.registryKey),
      readMany: async (models: readonly ModelFacts[]) => {
        reads.push(models.length);
        if (settle) for (const model of models) known.set(model.registryKey, { tier, frontier: 0, small: 0 });
        return new Map();
      },
    },
  };
}

test('a first plan over a large catalog reads one shortlist when it fills the tier', async () => {
  const fixture = tiers('economy');
  const pool = await poolFor({ tiers: fixture.store }, catalog(100), 'economy', request);
  expect(fixture.reads).toEqual([TIER_READ_SHORTLIST]);
  expect(pool.members.length).toBe(TIER_READ_SHORTLIST);
  expect(pool.members.length).toBeGreaterThanOrEqual(CHOICE_SHORTLIST);
});

test('when the wanted tier stays empty the reading stops after the documented number of rounds', async () => {
  const fixture = tiers('standard');
  const pool = await poolFor({ tiers: fixture.store }, catalog(100), 'premium', request);
  expect(fixture.reads).toEqual(Array.from({ length: TIER_READ_ROUNDS }, () => TIER_READ_SHORTLIST));
  expect(pool.members).toEqual([]);
});

test('a catalog smaller than the shortlist is read once in full', async () => {
  const fixture = tiers('economy');
  await poolFor({ tiers: fixture.store }, catalog(5), 'economy', request);
  expect(fixture.reads).toEqual([5]);
});

test('a reading that settles no tier holds the plan', async () => {
  const fixture = tiers('economy', false);
  await expect(poolFor({ tiers: fixture.store }, catalog(5), 'economy', request)).rejects.toBeInstanceOf(JudgmentHeldError);
});
