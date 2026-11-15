import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import { createClassicProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { JudgmentError } from '@goodvibes-jev/judgment';
import type { CommandContext } from '../../input/command-registry.ts';
import { describeHarnessModelRoute } from '../../tools/agent-harness-model-routing.ts';
import { mapWithConcurrency } from '../../tools/agent-harness-model-routing-utils.ts';
import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(fakePort(() => { throw new JudgmentError('unavailable', 'No decision model in this test'); }).port); });
afterEach(() => { installJudgmentPort(previous); });

describe('mapWithConcurrency', () => {
  test('never has more than the limit in flight, keeps input order and runs everything', async () => {
    let inFlight = 0, peak = 0;
    const gates: Array<() => void> = [];
    const work = mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
      inFlight++; peak = Math.max(peak, inFlight);
      await new Promise<void>((release) => { gates.push(release); });
      inFlight--;
      return value * 10;
    });
    expect(gates.length).toBe(3);
    // Release one waiting call at a time; each release lets its worker start the next item.
    while (gates.length > 0) {
      gates.shift()!();
      await new Promise<void>((resume) => setImmediate(resume));
    }
    expect(await work).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(3);
  });

  test('after a failure no further item is started and the failure is rethrown', async () => {
    const started: number[] = [];
    await expect(mapWithConcurrency([1, 2, 3, 4, 5], 1, async (value) => {
      started.push(value);
      if (value === 2) throw new Error('boom');
      return value;
    })).rejects.toThrow('boom');
    expect(started).toEqual([1, 2]);
  });
});

describe('model route lookup by model id', () => {
  const model = (registryKey: string, providerId: string, modelId: string) => ({
    registryKey, id: registryKey, modelId, provider: providerId, name: modelId, displayName: modelId, contextWindow: 8000,
    capabilities: { toolCalling: true, multimodal: false }, tier: 'free', selectable: true,
  });
  const models = [model('direct:llama3.1:8b', 'direct', 'llama3.1:8b'), model('aggregator:llama3.1:8b', 'aggregator', 'llama3.1:8b'), model('direct:unique', 'direct', 'unique')];
  const context = () => ({
    clients: { providerApi: { getFavorites: async () => ({ pinned: [] }), getCurrentModel: async () => null, listModels: async () => models, listProviderIds: () => ['direct', 'aggregator'] } },
    provider: { providerRegistry: { listModels: () => models, listProviders: () => [] } },
    session: { runtime: { model: 'direct:unique', provider: 'direct', sessionId: 's' } },
    platform: { configManager: { get: () => undefined }, readModels: {}, artifactStore: undefined },
  }) as unknown as CommandContext;

  async function lookup(input: string) {
    return withDecisionModelPolicy(() => 'Classic - Off', async () => {
      const owner = createClassicProtectedSourceOwner({ ownerId: 'model-lookup', revision: '1', signal: new AbortController().signal, assertCurrent() {} });
      try { return await describeHarnessModelRoute(context(), { modelRouteId: input }, { sourceOwner: owner }); }
      finally { await owner.close(); }
    });
  }

  test('a model id listed under two providers is ambiguous and names both registry keys', async () => {
    const result = await lookup('llama3.1:8b');
    if (result.status !== 'ambiguous') throw new Error(`expected an ambiguous lookup, got ${result.status}`);
    const keys = result.candidates.map((candidate) => candidate['modelRouteId']);
    expect(keys.sort()).toEqual(['aggregator:llama3.1:8b', 'direct:llama3.1:8b']);
  });

  test('an exact registry key still resolves to its own route', async () => {
    const result = await lookup('aggregator:llama3.1:8b');
    if (result.status !== 'found') throw new Error(`expected a found route, got ${result.status}`);
    expect(result.route['registryKey']).toBe('aggregator:llama3.1:8b');
  });

  test('a model id that only one provider lists resolves', async () => {
    expect((await lookup('unique')).status).toBe('found');
  });
});
