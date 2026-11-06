import { afterEach, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { withDecisionModelPolicy } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { createClassicProtectedSourceOwner } from '@goodvibes-jev/engine/sdk/platform/security';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { rankHarnessCatalog } from '../../tools/agent-harness-catalog-ranking.ts';
import { selectHarnessCatalog, selectHarnessCatalogGroup } from '../../tools/agent-harness-catalog-selection.ts';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

function fixture() {
  let requests = 0;
  const fake = fakePort(() => { requests++; throw new JudgmentError('unavailable', 'Synthetic decision outage'); });
  const previous = installJudgmentPort(fake.port);
  cleanup.push(() => { installJudgmentPort(previous); });
  const lifetime = new AbortController();
  const sourceOwner = createClassicProtectedSourceOwner({ ownerId: 'classic-catalog-test', revision: '1', signal: lifetime.signal, assertCurrent() {} });
  cleanup.push(() => sourceOwner.close());
  const entries = [{ id: 'inspect_file', description: 'Inspect a source file' }, { id: 'search_docs', description: 'Search documentation files' }];
  return { entries, sourceOwner, requests: () => requests, options: { sourceOwner } };
}

test('Classic catalog search publishes literal matches without invented readings or model calls', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = fixture();
    const ranked = await rankHarnessCatalog(f.entries, 'documentation', entry => entry, 'agent.test.classic-catalog', f.options);
    expect(ranked.provenance).toBe('classic');
    expect(ranked.judgments).toEqual([]);
    expect(ranked.matches).toHaveLength(1);
    expect(ranked.matches[0]).toMatchObject({ id: 'search_docs', provenance: 'classic', entry: f.entries[1] });
    expect(ranked.matches[0]?.judgment).toBeUndefined();
    expect(f.requests()).toBe(0);
  });
});

test('Classic selects exact catalog identities and leaves natural-language matches unselected', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = fixture();
    expect(await selectHarnessCatalog(f.entries, 'SEARCH_DOCS', entry => entry, f.options)).toBe(f.entries[1]!);
    expect(await selectHarnessCatalog(f.entries, 'Search documentation files', entry => entry, f.options)).toBeNull();
    expect(await selectHarnessCatalogGroup(f.entries, 'inspect_file', entry => entry, f.options)).toBe(f.entries[0]!);
    expect(f.requests()).toBe(0);
  });
});

test('Preferred exhausted catalog reading switches to the same local search without a fabricated judgment', async () => {
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const f = fixture();
    const ranked = await rankHarnessCatalog(f.entries, 'documentation', entry => entry, 'agent.test.preferred-catalog', f.options);
    expect(ranked.provenance).toBe('classic');
    expect(ranked.matches[0]?.id).toBe('search_docs');
    expect(ranked.judgments).toEqual([]);
    const attempted = f.requests();
    expect(attempted).toBeGreaterThan(0);
    await rankHarnessCatalog(f.entries, 'source', entry => entry, 'agent.test.preferred-catalog', f.options);
    expect(f.requests()).toBe(attempted);
  });
});

test('Classic catalog cancellation and source mutations still prevent publication', async () => {
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const f = fixture(), cancellation = new AbortController();
    cancellation.abort();
    await expect(rankHarnessCatalog(f.entries, 'source', entry => entry, 'agent.test.cancelled-catalog', {
      ...f.options, signal: cancellation.signal,
    })).rejects.toThrow();
    const screen = f.sourceOwner.screen;
    f.sourceOwner.screen = async (...args) => {
      const result = await screen(...args);
      f.entries[0]!.description = 'Changed after source capture';
      return result;
    };
    await expect(rankHarnessCatalog(f.entries, 'source', entry => entry, 'agent.test.mutated-catalog', f.options)).rejects.toThrow();
    expect(f.requests()).toBe(0);
  });
});
