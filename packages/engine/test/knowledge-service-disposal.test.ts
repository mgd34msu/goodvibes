import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/store.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { KnowledgeService } from '../platform/src/platform/knowledge/service.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/service.js';
import type { KnowledgeSemanticSelfImproveInput, KnowledgeSemanticSelfImproveResult } from '../platform/src/platform/knowledge/semantic/types.js';
import { createAsyncDisposalScope, registerRuntimePollers } from '../platform/src/platform/runtime/disposal.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const empty = (): KnowledgeSemanticSelfImproveResult => ({ scannedGaps: 0, processedGaps: 0, createdGaps: 0,
  repairableGaps: 0, suppressedGaps: 0, skippedGaps: 0, searched: 0, ingestedSources: 0, linkedRepairs: 0,
  blockedGaps: 0, closedGaps: 0, queuedTasks: 0, taskIds: [], ingestedSourceIds: [], errors: [] });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'knowledge-service-disposal-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  cleanups.push(async () => { await store.close(); rmSync(root, { recursive: true, force: true }); });
  const options = { memoryRegistry: { async add() { throw new Error('Unexpected memory publication'); }, getAll: () => [], getStore: () => undefined } };
  return { store, artifacts, options };
}

test('runtime poller close awaits the default-created semantic owner before closing its store', async () => {
  const f = fixture(), scope = createAsyncDisposalScope('default knowledge owner');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const originalDispose = KnowledgeSemanticService.prototype.dispose;
  let semanticDisposals = 0, storeClosed = false;
  let reentrantClosing: Promise<void> | undefined;
  const dispose = spyOn(KnowledgeSemanticService.prototype, 'dispose').mockImplementation(function(this: KnowledgeSemanticService) {
    semanticDisposals += 1;
    if (semanticDisposals === 1) reentrantClosing = service.dispose();
    entered.resolve();
    const drained = originalDispose.call(this);
    return drained.then(() => release.promise);
  });
  const service = new KnowledgeService(f.store, f.artifacts, undefined, f.options);
  await service.whenReady();
  scope.registry.add('knowledge store', async () => { await f.store.close(); storeClosed = true; });
  scope.registry.add('early knowledge service ownership', () => service.dispose());
  const stub = { dispose() {}, stop() {} };
  registerRuntimePollers(scope.registry, {
    stopConfigWatch() {}, watcherRegistry: stub, storeSnapshotScheduler: stub, appendOnlyRetentionScheduler: stub,
    memoryConsolidationScheduler: stub, codeIndexReindexScheduler: stub, sessionOrchestration: stub,
    knowledgeService: service, agentKnowledgeService: stub, homeGraphService: stub, contractRunner: stub,
    processRegistry: stub, memoryGovernor: stub, agentOrchestrator: stub, cancelHostedAgentRuns: () => 0,
  });
  const closing = scope.close();
  try {
    await entered.promise;
    expect(semanticDisposals).toBe(1); expect(storeClosed).toBe(false);
    expect(service.dispose()).toBe(service.dispose());
    expect(reentrantClosing).toBe(service.dispose());
  } finally { release.resolve(); await closing; dispose.mockRestore(); }
  expect(storeClosed).toBe(true); expect(semanticDisposals).toBe(1);
});

test('an early service owner drains interrupted construction startup before releasing its store', async () => {
  const f = fixture(), scope = createAsyncDisposalScope('partial knowledge factory');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const originalInit = f.store.init.bind(f.store);
  const init = spyOn(f.store, 'init').mockImplementation(async () => {
    entered.resolve(); await release.promise; await originalInit();
  });
  let storeClosed = false;
  scope.registry.add('knowledge store', async () => { await f.store.close(); storeClosed = true; });
  try {
    const service = new KnowledgeService(f.store, f.artifacts, undefined, f.options);
    scope.registry.add('knowledge service', () => service.dispose());
    throw new Error('Later constructor failed before poller registration');
  } catch (error) {
    expect(String(error)).toContain('Later constructor failed');
  }
  const closing = scope.close();
  try {
    await entered.promise; await Promise.resolve();
    expect(storeClosed).toBe(false);
  } finally { release.resolve(); await closing; init.mockRestore(); }
  expect(storeClosed).toBe(true);
});

test('the creator drains a borrowed semantic scheduler after service shutdown and before store close', async () => {
  const f = fixture(), scope = createAsyncDisposalScope('borrowed knowledge owner');
  const scheduled: Array<{ callback: () => void; signal: AbortSignal | undefined }> = [];
  const semantic = new KnowledgeSemanticService(f.store, { gapRepairer: async () => {},
    scheduleSeam(callback, _delayMs, signal) { scheduled.push({ callback, signal }); },
  });
  const service = new KnowledgeService(f.store, f.artifacts, undefined, { ...f.options, semanticService: semantic });
  await service.whenReady();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const inputs: Array<KnowledgeSemanticSelfImproveInput | undefined> = [];
  const improve = spyOn(semantic, 'selfImprove').mockImplementation(async input => {
    inputs.push(input); entered.resolve(); await release.promise; return empty();
  });
  let storeClosed = false;
  scope.registry.add('knowledge store', async () => { await f.store.close(); storeClosed = true; });
  // The creator owns the injected instance. Reverse disposal first stops the
  // borrower, then cancels/drains the semantic scheduler, then closes the store.
  scope.registry.add('knowledge semantic service', () => semantic.dispose());
  scope.registry.add('knowledge service', () => service.dispose());
  semantic.queueBackgroundSelfImprove({ knowledgeSpaceId: 'running-space', reason: 'reindex' });
  semantic.queueBackgroundSelfImprove({ knowledgeSpaceId: 'queued-space', reason: 'reindex' });
  scheduled[0]!.callback(); await entered.promise;
  await service.dispose();
  expect(inputs[0]?.signal?.aborted).toBe(false); // A borrower cannot retire the creator's service.
  const closing = scope.close();
  try {
    // Scope close awaits the borrower's already-settled promise before it
    // reaches the explicitly registered semantic owner.
    await Promise.resolve(); await Promise.resolve();
    expect(inputs[0]?.signal?.aborted).toBe(true);
    expect(scheduled[1]?.signal?.aborted).toBe(true);
    expect(storeClosed).toBe(false);
    scheduled[1]!.callback();
    semantic.queueBackgroundSelfImprove({ knowledgeSpaceId: 'late-space', reason: 'reindex' });
    expect(inputs).toHaveLength(1); expect(scheduled).toHaveLength(2);
  } finally { release.resolve(); await closing; improve.mockRestore(); }
  expect(inputs).toHaveLength(1); expect(storeClosed).toBe(true);
});
