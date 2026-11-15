import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { createDefaultKnowledgeConnectorRegistry } from '../platform/src/platform/knowledge/connectors.js';
import { discoverBrowserKnowledgeProfiles } from '../platform/src/platform/knowledge/browser-history/discover.js';
import { ingestBrowserKnowledge } from '../platform/src/platform/knowledge/browser-history/ingest.js';
import { copyLockedBrowserSqlite } from '../platform/src/platform/knowledge/browser-history/locked-db.js';
import { readBrowserKnowledgeProfile } from '../platform/src/platform/knowledge/browser-history/readers.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import type { KnowledgeIngestContext } from '../platform/src/platform/knowledge/ingest-context.js';

const CHROMIUM_EPOCH_OFFSET_MS = 11_644_473_600_000;
const BASE_MS = Date.UTC(2026, 0, 1);
const tempDirs: string[] = [];

const micros = (ms: number): number => Math.floor((ms + CHROMIUM_EPOCH_OFFSET_MS) * 1000);

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'goodvibes-browser-limits-'));
  tempDirs.push(dir);
  return dir;
}

/** Visits are minutes after BASE_MS; `urlOfVisit` picks which URL each visit belongs to. */
async function createProfile(home: string, visits: number, urlOfVisit: (index: number) => number, bookmarkUrls: readonly string[]): Promise<void> {
  const profile = join(home, '.config', 'chromium', 'Default');
  await mkdir(profile, { recursive: true });
  const db = new Database(join(profile, 'History'));
  db.run('CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT NOT NULL, title TEXT, visit_count INTEGER NOT NULL)');
  db.run('CREATE TABLE visits (id INTEGER PRIMARY KEY, url INTEGER NOT NULL, visit_time INTEGER NOT NULL, transition INTEGER NOT NULL)');
  for (let id = 1; id <= 6; id += 1) db.run('INSERT INTO urls (id, url, title, visit_count) VALUES (?, ?, ?, ?)', [id, `https://example.com/page-${id}`, `Page ${id}`, 1]);
  for (let index = 0; index < visits; index += 1) {
    db.run('INSERT INTO visits (id, url, visit_time, transition) VALUES (?, ?, ?, 1)', [index + 1, urlOfVisit(index), micros(BASE_MS + (index + 1) * 60_000)]);
  }
  db.close();
  await writeFile(join(profile, 'Bookmarks'), JSON.stringify({
    roots: { bookmark_bar: { type: 'folder', name: 'Bar', children: bookmarkUrls.map((url, index) => ({
      id: String(index + 10), type: 'url', name: `Saved ${index}`, url, date_added: String(micros(BASE_MS - (index + 1) * 86_400_000)),
    })) } },
  }));
}

type Emitted = { type: string; sourceId?: string };

function makeContext(store: KnowledgeStore, artifactStore: ArtifactStore, emitted: Emitted[] = []): KnowledgeIngestContext {
  const connectorRegistry = createDefaultKnowledgeConnectorRegistry();
  return {
    store,
    artifactStore,
    connectorRegistry,
    emitIfReady: (fn) => {
      fn({ emit: (_domain: string, envelope: { payload: Emitted }) => { emitted.push(envelope.payload); } } as never,
        { traceId: 't', sessionId: 's', source: 'test' });
    },
    syncReviewedMemory: async () => {},
    lint: async () => [],
    listConnectors: () => connectorRegistry.list(),
  };
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('browser history limits and writes', () => {
  test('a profile with more visits than the limit still returns its bookmarks', async () => {
    const home = await makeTempDir();
    await createProfile(home, 600, (index) => (index % 3) + 1, ['https://example.com/page-4', 'https://example.com/page-5', 'https://example.com/page-6']);
    const [profile] = await discoverBrowserKnowledgeProfiles({ homeOverride: home, browsers: ['chromium'] });
    const entries = await readBrowserKnowledgeProfile(profile!, { limit: 500 });
    expect(entries.filter((entry) => entry.sourceKind === 'history')).toHaveLength(500);
    expect(entries.filter((entry) => entry.sourceKind === 'bookmark')).toHaveLength(3);

    const store = new KnowledgeStore({ dbPath: join(home, 'knowledge.sqlite') });
    const result = await ingestBrowserKnowledge(makeContext(store, new ArtifactStore({ rootDir: join(home, 'artifacts') })), {
      homeOverride: home, browsers: ['chromium'], limit: 500,
    });
    const bookmarked = result.sources.filter((source) => source.metadata.browserSourceKinds && (source.metadata.browserSourceKinds as string[]).includes('bookmark'));
    expect(bookmarked.map((source) => source.canonicalUri).sort()).toEqual([
      'https://example.com/page-4', 'https://example.com/page-5', 'https://example.com/page-6',
    ]);
  });

  test('many visits of one URL write one node and one edge dated by the newest visit, and refresh the extraction on re-ingest', async () => {
    const home = await makeTempDir();
    await createProfile(home, 5, () => 1, []);
    const store = new KnowledgeStore({ dbPath: join(home, 'knowledge.sqlite') });
    const context = makeContext(store, new ArtifactStore({ rootDir: join(home, 'artifacts') }));
    let nodeWrites = 0;
    const upsertPreparedNode = store.upsertPreparedNode.bind(store);
    store.upsertPreparedNode = ((...args: Parameters<typeof upsertPreparedNode>) => { nodeWrites += 1; return upsertPreparedNode(...args); }) as typeof store.upsertPreparedNode;

    const first = await ingestBrowserKnowledge(context, { homeOverride: home, browsers: ['chromium'], limit: 50 });
    const source = first.sources[0]!;
    const profileNodeWrites = nodeWrites;
    expect(profileNodeWrites).toBe(1);
    const edge = store.listEdges().find((candidate) => candidate.fromId === source.id && candidate.relation === 'visited_in_browser_profile');
    expect(edge?.metadata.recordedAt).toBe(BASE_MS + 5 * 60_000);
    const firstSummary = store.getExtractionBySourceId(source.id)?.summary;
    expect(firstSummary).toContain('Visit count: 5.');

    // Two more visits arrive; the extraction text must follow the source metadata.
    const db = new Database(join(home, '.config', 'chromium', 'Default', 'History'));
    for (const id of [6, 7]) db.run('INSERT INTO visits (id, url, visit_time, transition) VALUES (?, 1, ?, 1)', [id, micros(BASE_MS + id * 60_000)]);
    db.close();
    await ingestBrowserKnowledge(context, { homeOverride: home, browsers: ['chromium'], limit: 50 });
    expect(store.getSourceByCanonicalUri('https://example.com/page-1')?.metadata.browserVisitCount).toBe(7);
    expect(store.getExtractionBySourceId(source.id)?.summary).toContain('Visit count: 7.');
  });

  test('a richer extraction from another extractor is not replaced by the browser summary', async () => {
    const home = await makeTempDir();
    await createProfile(home, 2, () => 1, []);
    const store = new KnowledgeStore({ dbPath: join(home, 'knowledge.sqlite') });
    const context = makeContext(store, new ArtifactStore({ rootDir: join(home, 'artifacts') }));
    const first = await ingestBrowserKnowledge(context, { homeOverride: home, browsers: ['chromium'], limit: 50 });
    const source = first.sources[0]!;
    const fetched = await store.upsertExtraction({ id: store.getExtractionBySourceId(source.id)!.id, sourceId: source.id, extractorId: 'html', format: 'html', summary: 'Fetched article text', excerpt: 'Fetched article text' });
    await ingestBrowserKnowledge(context, { homeOverride: home, browsers: ['chromium'], limit: 50 });
    expect(store.getExtractionBySourceId(source.id)).toEqual(fetched);
  });

  test('STARTED and COMPLETED name the same source id', async () => {
    const home = await makeTempDir();
    await createProfile(home, 2, () => 1, []);
    const emitted: Emitted[] = [];
    const store = new KnowledgeStore({ dbPath: join(home, 'knowledge.sqlite') });
    const result = await ingestBrowserKnowledge(makeContext(store, new ArtifactStore({ rootDir: join(home, 'artifacts') }), emitted), {
      homeOverride: home, browsers: ['chromium'], limit: 50,
    });
    const started = emitted.find((event) => event.type === 'KNOWLEDGE_INGEST_STARTED');
    const completed = emitted.find((event) => event.type === 'KNOWLEDGE_INGEST_COMPLETED');
    expect(started?.sourceId).toBe(result.sources[0]!.id);
    expect(completed?.sourceId).toBe(started?.sourceId);
  });
});

describe('locked browser database copy', () => {
  test('a failed journal copy leaves no copy of the history behind', async () => {
    const dir = await makeTempDir();
    const scratch = join(dir, 'tmp');
    const source = join(dir, 'History');
    await mkdir(scratch);
    await writeFile(source, 'not really sqlite');
    // A directory where the journal file should be makes copyFile fail after the temp directory exists.
    await mkdir(`${source}-wal`);
    const previous = process.env['TMPDIR'];
    process.env['TMPDIR'] = scratch;
    try {
      await expect(copyLockedBrowserSqlite(source)).rejects.toThrow();
    } finally {
      if (previous === undefined) delete process.env['TMPDIR']; else process.env['TMPDIR'] = previous;
    }
    expect(await readdir(scratch)).toEqual([]);
  });
});
