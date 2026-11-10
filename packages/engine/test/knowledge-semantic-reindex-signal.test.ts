import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.ts';
import type { KnowledgeSemanticSelfImproveResult } from '../platform/src/platform/knowledge/semantic/types.ts';
import { extractionValueFixtureFor, extractionValueFixtureReading } from './_helpers/knowledge-extraction-value-readings.js';

let previous: JudgmentPort | undefined;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => {
  installJudgmentPort(previous);
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-reindex-signal-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  cleanups.push(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const source = await store.upsertSource({ id: 'reindex-original', connectorId: 'fixture', sourceType: 'manual', title: 'AC-7', status: 'indexed' });
  const extraction = await store.upsertExtraction({ sourceId: source.id, extractorId: 'fixture', format: 'text', excerpt: 'Mass: 12 kg.' });
  const authored = [extractionValueFixtureFor(source, extraction, .99)];
  const decisions = fakePort((name, question, state) => {
    const value = extractionValueFixtureReading(name, question, state, authored);
    if (value !== undefined) return noulAnswer(value);
    if (name === 'included') return noulAnswer(.99);
    throw new Error(`Unscripted reindex question: ${name}`);
  });
  installJudgmentPort(decisions.port);
  const snapshot = () => ({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(),
    extraction: store.getExtractionBySourceId(source.id), semantic: store.getSemanticEnrichmentState(source.id) });
  return { store, source, decisions, snapshot };
}
const emptyImprovement = (): KnowledgeSemanticSelfImproveResult => ({ scannedGaps: 0, processedGaps: 0, createdGaps: 0,
  repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0, searched: 0, ingestedSources: 0, linkedRepairs: 0,
  blockedGaps: 0, closedGaps: 0, queuedTasks: 0, taskIds: [], ingestedSourceIds: [], errors: [] });

test('already cancelled semantic reindex reaches neither a decision, model, self-improvement nor publication', async () => {
  const f = await fixture(), owner = new AbortController(), reason = new Error('Original reindex owner retired');
  const before = f.snapshot(); let generated = 0;
  const service = new KnowledgeSemanticService(f.store, { llm: { async completeJson() { generated++; return null; }, async completeText() { return null; } } });
  const improve = spyOn(service, 'selfImprove'), queue = spyOn(service, 'queueBackgroundSelfImprove');
  owner.abort(reason);
  try {
    await expect(service.reindex({ signal: owner.signal, sourceIds: [f.source.id], force: true })).rejects.toBe(reason);
    expect(f.decisions.requests).toHaveLength(0); expect(generated).toBe(0);
    expect(improve).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  } finally { improve.mockRestore(); queue.mockRestore(); }
});

test('owning signal reaches the actual held extraction judgment and a late answer cannot publish or continue reindex', async () => {
  const f = await fixture(), owner = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const before = f.snapshot(), reason = new Error('Original reindex owner retired');
  const observedSignals: Array<AbortSignal | undefined> = []; let generated = 0;
  installJudgmentPort({ ...f.decisions.port, async ask(request) {
    if ('extractionValue' in request.questions) { observedSignals.push(request.signal); entered.resolve(); await release.promise; }
    return f.decisions.port.ask(request);
  } });
  const service = new KnowledgeSemanticService(f.store, { llm: { async completeJson() { generated++; return null; }, async completeText() { return null; } } });
  const improve = spyOn(service, 'selfImprove'), queue = spyOn(service, 'queueBackgroundSelfImprove');
  const work = service.reindex({ signal: owner.signal, sourceIds: [f.source.id], force: true }).catch((error: unknown) => error);
  try {
    await Promise.race([entered.promise, work.then(() => { throw new Error('Reindex ended before its extraction judgment'); })]);
    expect(observedSignals).toHaveLength(1); expect(observedSignals[0]).toBeDefined(); expect(observedSignals[0]?.aborted).toBe(false);
    owner.abort(reason); expect(observedSignals[0]?.aborted).toBe(true); release.resolve();
    expect(await work).toBe(reason); expect(generated).toBe(0);
    expect(improve).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  } finally { owner.abort(reason); release.resolve(); await work; improve.mockRestore(); queue.mockRestore(); }
});

test('owning signal reaches the actual generation call and retired late generation cannot write semantic results', async () => {
  const f = await fixture(), owner = new AbortController(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const before = f.snapshot(), reason = new Error('Original generation owner retired');
  const observedSignals: Array<AbortSignal | undefined> = []; let generated = 0;
  const service = new KnowledgeSemanticService(f.store, { llm: {
    async completeJson(input) { generated++; observedSignals.push(input.signal); entered.resolve(); await release.promise;
      return { entities: [], facts: [], relations: [], gaps: [], wikiPage: { markdown: 'Late output must not be published.' } }; },
    async completeText() { throw new Error('No other model call is authorized'); },
  } });
  const improve = spyOn(service, 'selfImprove'), queue = spyOn(service, 'queueBackgroundSelfImprove');
  const work = service.reindex({ signal: owner.signal, sourceIds: [f.source.id], force: true }).catch((error: unknown) => error);
  try {
    await Promise.race([entered.promise, work.then(() => { throw new Error('Reindex ended before generation'); })]);
    expect(observedSignals).toHaveLength(1); expect(observedSignals[0]).toBe(owner.signal); owner.abort(reason); expect(observedSignals[0]?.aborted).toBe(true); release.resolve();
    expect(await work).toBe(reason); expect(generated).toBe(1);
    expect(improve).not.toHaveBeenCalled(); expect(queue).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  } finally { owner.abort(reason); release.resolve(); await work; improve.mockRestore(); queue.mockRestore(); }
});

test('unretired reindex forwards the original optional signal to foreground and queued improvement', async () => {
  const f = await fixture(), owner = new AbortController(), service = new KnowledgeSemanticService(f.store);
  const improve = spyOn(service, 'selfImprove').mockResolvedValue(emptyImprovement());
  const queue = spyOn(service, 'queueBackgroundSelfImprove').mockImplementation(() => {});
  try {
    const result = await service.reindex({ sourceIds: ['not-selected'], signal: owner.signal });
    expect(result.scanned).toBe(0); expect(improve.mock.calls[0]?.[0]?.signal).toBe(owner.signal);
    expect(queue.mock.calls[0]?.[0]?.signal).toBe(owner.signal);
    expect(f.decisions.requests).toHaveLength(0);
  } finally { improve.mockRestore(); queue.mockRestore(); }
});

test('retirement during foreground improvement refuses the reindex result and queues no orphan follow-up', async () => {
  const f = await fixture(), owner = new AbortController(), service = new KnowledgeSemanticService(f.store);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), reason = new Error('Improvement owner retired');
  const before = f.snapshot(), observedSignals: Array<AbortSignal | undefined> = [];
  const improve = spyOn(service, 'selfImprove').mockImplementation(async input => {
    observedSignals.push(input?.signal); entered.resolve(); await release.promise; return emptyImprovement();
  });
  const queue = spyOn(service, 'queueBackgroundSelfImprove').mockImplementation(() => {});
  const work = service.reindex({ sourceIds: ['not-selected'], signal: owner.signal }).catch((error: unknown) => error);
  try {
    await Promise.race([entered.promise, work.then(() => { throw new Error('Reindex ended before improvement'); })]);
    expect(observedSignals).toHaveLength(1); expect(observedSignals[0]).toBe(owner.signal); owner.abort(reason); release.resolve();
    expect(await work).toBe(reason); expect(queue).not.toHaveBeenCalled(); expect(f.snapshot()).toEqual(before);
  } finally { owner.abort(reason); release.resolve(); await work; improve.mockRestore(); queue.mockRestore(); }
});
