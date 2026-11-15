import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeConnectorRegistry } from '../platform/src/platform/knowledge/connectors.js';
import { ingestKnowledgeBookmarkSeeds, ingestKnowledgeUrl, refreshKnowledgeSources } from '../platform/src/platform/knowledge/ingest-inputs.js';
import { KnowledgeExtractionJudgmentHoldError } from '../platform/src/platform/knowledge/extraction-policy.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import type { KnowledgeEvent } from '../platform/src/events/knowledge.js';

let previous: JudgmentPort | undefined;
let root: string;
const stores: KnowledgeStore[] = [];
beforeEach(() => {
  previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  root = mkdtempSync(join(tmpdir(), 'knowledge-ingest-post-commit-'));
});
afterEach(async () => {
  installJudgmentPort(previous);
  await Promise.all(stores.splice(0).map(store => store.close()));
  rmSync(root, { recursive: true, force: true });
});

type Seen = Extract<KnowledgeEvent, { type: 'KNOWLEDGE_INGEST_FAILED' | 'KNOWLEDGE_INGEST_STARTED' | 'KNOWLEDGE_COMPILE_COMPLETED' | 'KNOWLEDGE_INGEST_COMPLETED' }>;

function setup(overrides: { syncReviewedMemory?: () => Promise<void>; lint?: () => Promise<never[]> } = {}) {
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  stores.push(store);
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const bus = new RuntimeEventBus();
  const events: Seen[] = [];
  for (const type of ['KNOWLEDGE_INGEST_FAILED', 'KNOWLEDGE_INGEST_STARTED', 'KNOWLEDGE_COMPILE_COMPLETED', 'KNOWLEDGE_INGEST_COMPLETED'] as const) {
    bus.on<Seen>(type, ({ payload }) => { events.push(payload); });
  }
  const context = {
    store, artifactStore, connectorRegistry: new KnowledgeConnectorRegistry(),
    emitIfReady: (fn: (bus: RuntimeEventBus, ctx: { traceId: string; sessionId: string; source: string }) => void) => fn(bus, { traceId: 't', sessionId: 's', source: 'test' }),
    syncReviewedMemory: overrides.syncReviewedMemory ?? (async () => {}),
    lint: overrides.lint ?? (async () => []),
    listConnectors: () => [],
  };
  return { store, artifactStore, context, events };
}

async function textArtifact(artifactStore: ArtifactStore, text: string) {
  return artifactStore.createFromStream({ kind: 'document', filename: 'note.txt', mimeType: 'text/plain', stream: [text] });
}

describe('a source that is already published', () => {
  for (const step of ['syncReviewedMemory', 'lint'] as const) {
    test(`is not marked as a failed crawl when ${step} fails afterwards`, async () => {
      const { store, artifactStore, context, events } = setup({ [step]: async () => { throw new Error('post-commit outage'); } });
      const artifact = await textArtifact(artifactStore, 'A synthetic note about local control.');
      spyOn(artifactStore, 'create').mockResolvedValue(artifact);
      const result = await ingestKnowledgeUrl(context, { url: 'https://example.invalid/note.txt', sourceType: 'document' });
      expect(result.source.status).toBe('indexed');
      expect(result.source.crawlError).toBeUndefined();
      expect(store.getSource(result.source.id)?.crawlError).toBeUndefined();
      expect(events.some((event) => event.type === 'KNOWLEDGE_INGEST_FAILED')).toBe(false);
    });
  }
});

describe('ingest events', () => {
  test('the started event carries no credentials or query string', async () => {
    const { artifactStore, context, events } = setup();
    spyOn(artifactStore, 'create').mockResolvedValue(await textArtifact(artifactStore, 'A synthetic note.'));
    await ingestKnowledgeUrl(context, { url: 'https://user:secret@example.invalid/note.txt?token=abc#frag', sourceType: 'document' });
    const started = events.find((event) => event.type === 'KNOWLEDGE_INGEST_STARTED');
    expect(started && 'uri' in started ? started.uri : undefined).toBe('https://example.invalid/note.txt');
  });

  test('the compile event counts what the compile produced, so recompiling an unchanged source is not zero', async () => {
    const { artifactStore, context, events } = setup();
    const create = spyOn(artifactStore, 'create');
    create.mockResolvedValue(await textArtifact(artifactStore, 'A synthetic note about local control.'));
    const url = 'https://example.invalid/note.txt';
    await ingestKnowledgeUrl(context, { url, sourceType: 'document' });
    events.length = 0;
    await ingestKnowledgeUrl(context, { url, sourceType: 'document' });
    const compiled = events.find((event) => event.type === 'KNOWLEDGE_COMPILE_COMPLETED');
    expect(compiled && 'nodeCount' in compiled ? compiled.nodeCount : 0).toBeGreaterThan(0);
  });
});

describe('batch ingest and refresh', () => {
  test('a batch runs the whole-store lint and memory sync once, not once per source', async () => {
    let lints = 0, syncs = 0;
    const { artifactStore, context } = setup({ lint: async () => { lints++; return []; }, syncReviewedMemory: async () => { syncs++; } });
    spyOn(artifactStore, 'create').mockImplementation(async (input) => textArtifact(artifactStore, `Note for ${String((input as { uri?: string }).uri)}`));
    const result = await ingestKnowledgeBookmarkSeeds(context, [
      { url: 'https://example.invalid/one' }, { url: 'https://example.invalid/two' }, { url: 'https://example.invalid/three' },
    ]);
    expect(result.imported).toBe(3);
    expect([lints, syncs]).toEqual([1, 1]);
  });

  test('refresh honours the stored private-host intent and keeps going after one source is held', async () => {
    const { store, artifactStore, context } = setup();
    await store.init();
    const seed = (title: string, metadata: Record<string, unknown>) => store.upsertSource({
      connectorId: 'url', sourceType: 'url', title, sourceUri: `https://${title}.invalid/doc`, canonicalUri: `https://${title}.invalid/doc`,
      tags: [], status: 'stale', metadata,
    });
    const held = await seed('held', {});
    const lan = await seed('lan', { knowledgeIntent: { ingestMode: 'url', remoteFetchMode: 'allow-private-hosts' } });
    const modes: Array<[string, boolean | undefined]> = [];
    spyOn(artifactStore, 'create').mockImplementation(async (input) => {
      const request = input as { uri?: string; allowPrivateHosts?: boolean };
      modes.push([request.uri ?? '', request.allowPrivateHosts]);
      if (request.uri?.includes('held')) throw new KnowledgeExtractionJudgmentHoldError();
      return textArtifact(artifactStore, 'A synthetic document on the local network.');
    });
    const refreshed = await refreshKnowledgeSources(context, [held, lan]);
    expect(modes).toEqual([['https://held.invalid/doc', undefined], ['https://lan.invalid/doc', true]]);
    expect(refreshed).toBe(1);
    expect(store.getSource(lan.id)?.status).toBe('indexed');
    expect(store.getSource(lan.id)?.crawlError).toBeUndefined();
  });
});
