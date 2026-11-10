import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { configureKnowledgeArtifactReferences } from '../platform/src/platform/knowledge/artifact-reference-ensemble.js';
import * as generatedPages from '../platform/src/platform/knowledge/home-graph/generated-pages.js';
import { buildHomeGraphMetadata } from '../platform/src/platform/knowledge/home-graph/helpers.js';
import { enrichHomeGraphSpaceSources } from '../platform/src/platform/knowledge/home-graph/sync-self-improvement.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import type { KnowledgeSemanticSelfImproveResult } from '../platform/src/platform/knowledge/semantic/types.js';
import { HOME_GRAPH_KNOWLEDGE_DB_FILE } from '../platform/src/platform/knowledge/store-config.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { seedHomeAssistantObservation } from './_helpers/homegraph-observation-fixtures.js';

const roots: string[] = [], stores: KnowledgeStore[] = [], restores: Array<() => void> = [];
afterEach(async () => {
  for (const restore of restores.splice(0).reverse()) restore();
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function result(progress = false): KnowledgeSemanticSelfImproveResult {
  return { scannedGaps: 1, candidateGaps: 1, processedGaps: 1, createdGaps: 0, repairableGaps: 0,
    suppressedGaps: 0, skippedGaps: 0, searched: 0, ingestedSources: 0, linkedRepairs: 0, blockedGaps: 0,
    closedGaps: progress ? 1 : 0, queuedTasks: 0, taskIds: [], ingestedSourceIds: [], acceptedSourceIds: progress ? ['manual-source'] : [], errors: [] };
}
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'homegraph-space-signal-')); roots.push(root);
  const path = join(root, HOME_GRAPH_KNOWLEDGE_DB_FILE), store = new KnowledgeStore({ dbPath: path }); stores.push(store);
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  configureKnowledgeArtifactReferences({ artifactStore, controlPlaneDirectory: root, stores: [store] });
  const spaceId = 'homeassistant:signal-house', installationId = 'signal-house';
  const metadata = buildHomeGraphMetadata(spaceId, installationId);
  const device = await seedHomeAssistantObservation(store, { id: 'native-signal-device', kind: 'ha_device', slug: 'signal-device',
    title: 'Synthetic signal device', status: 'active', metadata: buildHomeGraphMetadata(spaceId, installationId, {
      homeAssistant: { installationId, objectKind: 'device', objectId: 'signal-device' }, objectId: 'signal-device',
    }) });
  await store.upsertSource({ id: 'manual-source', connectorId: 'homeassistant', sourceType: 'manual', title: 'Synthetic manual', status: 'indexed', metadata });
  await store.upsertEdge({ fromKind: 'source', fromId: 'manual-source', toKind: 'node', toId: device.id, relation: 'has_manual', metadata });
  const semanticService = new KnowledgeSemanticService(store), errors: unknown[] = [];
  const runtime = { store, artifactStore, semanticService, reportBackgroundError(_event: string, error: unknown) { errors.push(error); } };
  return { runtime, spaceId, path, errors };
}

for (const phase of ['before-entry', 'enrichment', 'self-improvement', 'page'] as const) test(`original space signal cancels ${phase} without a later callback or publication`, async () => {
  const f = await fixture(), controller = new AbortController(), entered = deferred(), release = deferred();
  const reason = new Error('Original space owner retired');
  const original = readFileSync(f.path), originalSources = f.runtime.store.listSources(20), originalNodes = f.runtime.store.listNodes(20);
  const enrich = spyOn(f.runtime.semanticService, 'enrichSources').mockImplementation(async (sources, options = {}) => {
    expect(sources.map(source => source.id)).toEqual(['manual-source']);
    expect(options.signal).toBe(controller.signal);
    if (phase === 'enrichment') { entered.resolve(); await release.promise; }
    return [];
  });
  const improve = spyOn(f.runtime.semanticService, 'selfImprove').mockImplementation(async (input = {}, options) => {
    expect(input.signal).toBe(controller.signal); expect(options).toEqual({ stopWhenPaused: true });
    if (phase === 'self-improvement') { entered.resolve(); await release.promise; }
    return result(true);
  });
  const refresh = generatedPages.refreshHomeGraphDevicePassport;
  const page = spyOn(generatedPages, 'refreshHomeGraphDevicePassport').mockImplementation(async context => {
    expect(context.signal).toBe(controller.signal);
    entered.resolve(); await release.promise;
    // Resume the actual materializer with its original signal. It must refuse
    // before publication, rather than relying on this callback to fake a page.
    return refresh(context);
  });
  restores.push(() => enrich.mockRestore(), () => improve.mockRestore(), () => page.mockRestore());
  if (phase === 'before-entry') controller.abort(reason);
  const reading = enrichHomeGraphSpaceSources(f.runtime, f.spaceId, controller.signal);
  try {
    if (phase !== 'before-entry') {
      await Promise.race([entered.promise, reading.then(() => { throw new Error('Operation finished before its held phase'); })]);
      controller.abort(reason); release.resolve();
    }
    await expect(reading).rejects.toBe(reason);
    expect(enrich).toHaveBeenCalledTimes(phase === 'before-entry' ? 0 : 1);
    expect(improve).toHaveBeenCalledTimes(phase === 'self-improvement' || phase === 'page' ? 1 : 0);
    expect(page).toHaveBeenCalledTimes(phase === 'page' ? 1 : 0);
    expect(f.errors).toEqual([]); expect(readFileSync(f.path)).toEqual(original);
    expect(f.runtime.store.listSources(20)).toEqual(originalSources); expect(f.runtime.store.listNodes(20)).toEqual(originalNodes);
    expect(f.runtime.artifactStore.list(20)).toEqual([]);
  } finally { release.resolve(); await reading.catch(() => undefined); }
});

test('standalone unowned space enrichment retains its existing two-argument behavior', async () => {
  const f = await fixture();
  const enrich = spyOn(f.runtime.semanticService, 'enrichSources').mockResolvedValue([]);
  const improve = spyOn(f.runtime.semanticService, 'selfImprove').mockResolvedValue(result());
  restores.push(() => enrich.mockRestore(), () => improve.mockRestore());
  await enrichHomeGraphSpaceSources(f.runtime, f.spaceId);
  expect(enrich).toHaveBeenCalledWith(expect.any(Array), { knowledgeSpaceId: f.spaceId });
  expect(improve).toHaveBeenCalledWith({ knowledgeSpaceId: f.spaceId, reason: 'reindex' }, { stopWhenPaused: true });
  expect(f.errors).toEqual([]);
});
