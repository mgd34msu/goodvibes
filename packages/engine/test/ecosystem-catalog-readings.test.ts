/**
 * ecosystem-catalog-readings.test.ts
 *
 * Catalog search and review. Which entries answer a search query is the
 * `engine.ecosystem.catalog-search` reading, one request per page of entries; whether a
 * trust note raises the risk label is the `engine.ecosystem.trust-note-caution`
 * reading. Pins that a blank query and a note-free or remote entry ask
 * nothing, that only strong readings act (a strong no hides a search row, a
 * strong yes raises the risk), that kept rows stay in name order, that
 * install takes no reading, and that a read with no port installed throws.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { JudgmentError, type EntryType, type Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import {
  installEcosystemCatalogEntry,
  reviewEcosystemCatalogEntry,
  reviewEcosystemCatalogSource,
  searchEcosystemCatalog,
  upsertEcosystemCatalogEntry,
  type EcosystemCatalogEntry,
} from '../platform/src/platform/runtime/ecosystem/catalog.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { rankRecommendationCandidates } from '../platform/src/platform/runtime/ecosystem/recommendations.js';

type SearchState = { readonly query: string; readonly entries: readonly { readonly id: string }[] };
type NoteState = { readonly name: string; readonly trustNotes: string };

/** A port answering one named question through `probability`, recording every request. */
function portFor<S>(question: string, probability: (state: S) => number) {
  return fakePort((name: string, _question: Question, state: EntryType) => {
    if (name !== question) throw new Error(`catalog port: unexpected question ${name}`);
    return noulAnswer(probability(state as unknown as S));
  });
}

function plugin(id: string, name: string, extra: Partial<EcosystemCatalogEntry> = {}): EcosystemCatalogEntry {
  return { id, kind: 'plugin', name, summary: `${name} summary`, source: 'catalog', tags: [], ...extra };
}

let options: { cwd: string; homeDir: string };
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  const root = makeProjectTempDir('eco-catalog-');
  options = { cwd: root, homeDir: root };
  previous = installJudgmentPort(undefined);
});
afterEach(() => {
  installJudgmentPort(previous);
});

test('Classic catalog browsing and source inspection use literal records without inventing trust or recommendations', async () => {
  let metadata = 0, requests = 0;
  installJudgmentPort({ get model(): never { metadata++; throw new Error('Classic model lookup'); },
    async ask() { requests++; throw new Error('Classic decision request'); } });
  const entry = plugin('pr-tools', 'Pull request tools', { tags: ['review'] });
  upsertEcosystemCatalogEntry(entry, options);
  upsertEcosystemCatalogEntry(plugin('author-stats', 'Author statistics'), options);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    expect((await searchEcosystemCatalog('plugin', 'pull request', options)).map(row => row.id)).toEqual(['pr-tools']);
    expect((await searchEcosystemCatalog('plugin', '', options))).toHaveLength(2);
    expect(reviewEcosystemCatalogSource(entry, options).entry.id).toBe('pr-tools');
    const review = await reviewEcosystemCatalogEntry(entry, options);
    expect(review.entry.id).toBe('pr-tools');
    expect(review.riskLevel).toBe('low');
    await expect(rankRecommendationCandidates([])).rejects.toMatchObject({ code: 'decision-models-disabled' });
  });
  expect({ metadata, requests }).toEqual({ metadata: 0, requests: 0 });
});

test('Preferred exhausted catalog search continues literal browsing without restarting its decision phase', async () => {
  upsertEcosystemCatalogEntry(plugin('pr-tools', 'Pull request tools'), options);
  const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); installJudgmentPort(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    expect((await searchEcosystemCatalog('plugin', 'pull request', options)).map(row => row.id)).toEqual(['pr-tools']);
    const attempted = fake.requests.length;
    expect(attempted).toBeGreaterThan(0);
    await searchEcosystemCatalog('plugin', 'request', options);
    expect(fake.requests).toHaveLength(attempted);
  });
});

describe('catalog search', () => {
  /** A port answering each page question from the entry its index names. */
  function pagePort(probability: (id: string) => number) {
    return fakePort((name: string, _question: Question, state: EntryType) => {
      const match = /^entry(\d+)__wanted$/.exec(name);
      if (!match) throw new Error(`catalog port: unexpected question ${name}`);
      return noulAnswer(probability((state as unknown as SearchState).entries[Number(match[1])]!.id));
    });
  }

  test('one request per page; only a strong no hides a row; kept rows stay in name order; a repeat asks nothing', async () => {
    upsertEcosystemCatalogEntry(plugin('zeta', 'Zeta pull requests'), options);
    upsertEcosystemCatalogEntry(plugin('alpha', 'Alpha author stats'), options);
    upsertEcosystemCatalogEntry(plugin('mid', 'Mid code host'), options);
    const readings: Record<string, number> = { zeta: 0.9, alpha: 0.1, mid: 0.43 }; // mid is a weak no: kept
    const { port, requests } = pagePort((id) => readings[id]!);
    installJudgmentPort(port);

    const found = await searchEcosystemCatalog('plugin', '  github ', options);
    expect(found.map((entry) => entry.id)).toEqual(['mid', 'zeta']);
    expect(requests).toHaveLength(1);
    expect((requests[0]!.state as unknown as SearchState).query).toBe('github');
    expect((await searchEcosystemCatalog('plugin', 'github', options)).map((entry) => entry.id)).toEqual(['mid', 'zeta']);
    expect(requests).toHaveLength(1);
  });

  test('a changed catalog is read again', async () => {
    upsertEcosystemCatalogEntry(plugin('a', 'Alpha'), options);
    const { port, requests } = pagePort(() => 0.9);
    installJudgmentPort(port);
    await searchEcosystemCatalog('plugin', 'alpha', options);
    upsertEcosystemCatalogEntry(plugin('b', 'Beta'), options);
    expect((await searchEcosystemCatalog('plugin', 'alpha', options)).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(requests).toHaveLength(2);
  });

  test('the question sees the entry words, not its source', async () => {
    upsertEcosystemCatalogEntry(plugin('p', 'P', { source: '/secret/path', trustNotes: 'note', installHint: 'hint', tags: ['t'] }), options);
    const { port, requests } = pagePort(() => 0.9);
    installJudgmentPort(port);
    await searchEcosystemCatalog('plugin', 'p', options);
    expect(requests[0]!.state).toEqual({
      query: 'p',
      entries: [{ kind: 'plugin', id: 'p', name: 'P', summary: 'P summary', tags: ['t'], installHint: 'hint', trustNotes: 'note' }],
    });
  });

  test('a blank query lists every entry and asks nothing', async () => {
    upsertEcosystemCatalogEntry(plugin('b', 'Beta'), options);
    upsertEcosystemCatalogEntry(plugin('a', 'Alpha'), options);
    const { port, requests } = portFor<SearchState>('entry0__wanted', () => 0.1);
    installJudgmentPort(port);
    expect((await searchEcosystemCatalog('plugin', '   ', options)).map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(requests).toHaveLength(0);
  });

  test('a search with no judgment port installed throws', async () => {
    upsertEcosystemCatalogEntry(plugin('a', 'Alpha'), options);
    await expect(searchEcosystemCatalog('plugin', 'alpha', options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});

describe('catalog review risk', () => {
  test('a strong yes on the trust note is medium; a weak yes or a no stays low', async () => {
    const readings: Record<string, number> = { warns: 0.9, weak: 0.57, reassures: 0.1 };
    const { port, requests } = portFor<NoteState>('cautions', (state) => readings[state.name]!);
    installJudgmentPort(port);

    expect((await reviewEcosystemCatalogEntry(plugin('w', 'warns', { trustNotes: 'Runs shell commands unasked.' }), options)).riskLevel).toBe('medium');
    expect((await reviewEcosystemCatalogEntry(plugin('k', 'weak', { trustNotes: 'Beta quality.' }), options)).riskLevel).toBe('low');
    expect((await reviewEcosystemCatalogEntry(plugin('r', 'reassures', { trustNotes: 'Maintained by the core team.' }), options)).riskLevel).toBe('low');
    expect(requests).toHaveLength(3);
    expect(requests[0]!.state).toEqual({ name: 'warns', kind: 'plugin', trustNotes: 'Runs shell commands unasked.' });
  });

  test('no trust note, or a remote source, asks nothing; remote is medium', async () => {
    const { port, requests } = portFor<NoteState>('cautions', () => 0.9);
    installJudgmentPort(port);
    expect((await reviewEcosystemCatalogEntry(plugin('a', 'A'), options)).riskLevel).toBe('low');
    expect((await reviewEcosystemCatalogEntry(plugin('b', 'B', { trustNotes: '  ' }), options)).riskLevel).toBe('low');
    const remote = await reviewEcosystemCatalogEntry(plugin('c', 'C', { source: 'git+https://example.com/c.git', trustNotes: 'Unreviewed.' }), options);
    expect(remote.riskLevel).toBe('medium');
    expect(remote.sourceKind).toBe('remote');
    expect(requests).toHaveLength(0);
  });

  test('a review of a noted entry with no judgment port installed throws', async () => {
    await expect(reviewEcosystemCatalogEntry(plugin('a', 'A', { trustNotes: 'Unreviewed.' }), options)).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });

  test('install takes no reading, even for an entry with a trust note', () => {
    const source = join(options.cwd, 'noted-source');
    mkdirSync(source);
    upsertEcosystemCatalogEntry(plugin('noted', 'Noted', { source, trustNotes: 'Unreviewed third-party code.' }), options);
    expect(installEcosystemCatalogEntry('plugin', 'noted', options).ok).toBe(true);
  });
});
