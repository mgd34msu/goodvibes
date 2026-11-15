import { afterAll, describe, expect, test } from 'bun:test';
import { listBenchmarkArtifacts, withModelReadingSource } from '../../tools/agent-harness-model-reading-source.ts';
import { cleanupResearchScreeningFixtures, ordinaryResearchOwner } from '../helpers/research-screening.ts';

afterAll(cleanupResearchScreeningFixtures);

describe('protected source release', () => {
  test('a release that fails after a successful reading does not replace the result', async () => {
    const owner = ordinaryResearchOwner();
    let releaseAttempts = 0;
    const failing = Object.create(owner, {
      release: { value: async (handle: Parameters<typeof owner.release>[0]) => { releaseAttempts++; await owner.release(handle); throw new Error('owner retired'); } },
    }) as typeof owner;
    const result = await withModelReadingSource({ text: 'plain provider note' }, { sourceOwner: failing }, async (captured) => `read ${captured.text}`);
    expect(result).toBe('read plain provider note');
    expect(releaseAttempts).toBeGreaterThan(0);
  });

  test('a release that fails after a failed reading leaves the reading error as the one reported', async () => {
    const owner = ordinaryResearchOwner();
    const failing = Object.create(owner, {
      release: { value: async (handle: Parameters<typeof owner.release>[0]) => { await owner.release(handle); throw new Error('owner retired'); } },
    }) as typeof owner;
    await expect(withModelReadingSource({ text: 'plain provider note' }, { sourceOwner: failing }, async () => { throw new Error('reading failed'); })).rejects.toThrow('reading failed');
  });
});

describe('benchmark artifact window', () => {
  const artifact = (id: string, purpose: string) => ({ id, metadata: { purpose } });
  const store = (artifacts: readonly unknown[]) => ({ list: (limit = 100) => artifacts.slice(0, limit) }) as never;

  test('a saved benchmark older than the newest hundred unrelated artifacts is still read', () => {
    const artifacts = [
      ...Array.from({ length: 119 }, (_, index) => artifact(`media-${index}`, 'agent-media')),
      artifact('benchmark-old', 'agent-model-compare'),
      artifact('judgment-old', 'agent-model-compare-judgment'),
    ];
    expect(listBenchmarkArtifacts(store(artifacts)).map((entry) => entry.id)).toEqual(['benchmark-old', 'judgment-old']);
  });

  test('only the newest hundred benchmark artifacts are kept', () => {
    const artifacts = Array.from({ length: 130 }, (_, index) => artifact(`b-${index}`, 'agent-model-compare'));
    const listed = listBenchmarkArtifacts(store(artifacts));
    expect(listed).toHaveLength(100);
    expect(listed[0]?.id).toBe('b-0');
  });

  test('no store means no artifacts', () => {
    expect(listBenchmarkArtifacts(undefined)).toEqual([]);
  });
});
