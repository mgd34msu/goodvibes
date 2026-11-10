import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { HomeGraphService } from '../platform/src/platform/knowledge/home-graph/service.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createAsyncDisposalScope } from '../platform/src/platform/runtime/async-disposal.js';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';

const starts: readonly { readonly name: string; readonly start: (service: HomeGraphService) => Promise<unknown> }[] = [
  { name: 'snapshot', start: service => service.syncSnapshot({ installationId: 'closing-house', pageAutomation: { enabled: false }, devices: [{ id: 'late-device', name: 'Late device' }] }) },
  { name: 'ask', start: service => service.ask({ installationId: 'closing-house', query: 'What is in this house?' }) },
  { name: 'reindex', start: service => service.reindex({ installationId: 'closing-house' }) },
  { name: 'device passport', start: service => service.refreshDevicePassport({ installationId: 'closing-house', deviceId: 'late-device' }) },
  { name: 'room page', start: service => service.generateRoomPage({ installationId: 'closing-house', areaId: 'late-room' }) },
  { name: 'packet', start: service => service.generatePacket({ installationId: 'closing-house' }) },
  { name: 'page listing', start: service => service.listPages({ installationId: 'closing-house' }) },
  { name: 'map', start: service => service.map({ installationId: 'closing-house' }) },
  { name: 'refinement', start: service => service.runRefinement({ installationId: 'closing-house' }) },
  { name: 'status', start: service => service.status({ installationId: 'closing-house' }) },
  { name: 'URL ingestion', start: service => service.ingestUrl({ installationId: 'closing-house', url: 'https://example.org/closing-note' }) },
  { name: 'note ingestion', start: service => service.ingestNote({ installationId: 'closing-house', body: 'Closing note.' }) },
  { name: 'artifact ingestion', start: service => service.ingestArtifact({ installationId: 'closing-house', uri: 'https://example.org/closing-artifact' }) },
  { name: 'link', start: service => service.linkKnowledge({ installationId: 'closing-house', sourceId: 'closing-source', target: { kind: 'device', id: 'closing-device' } }) },
  { name: 'unlink', start: service => service.unlinkKnowledge({ installationId: 'closing-house', sourceId: 'closing-source', target: { kind: 'device', id: 'closing-device' } }) },
  { name: 'issue listing', start: service => service.listIssues({ installationId: 'closing-house' }) },
  { name: 'fact review', start: service => service.reviewFact({ installationId: 'closing-house', action: 'accept', nodeId: 'closing-node' }) },
  { name: 'source listing', start: service => service.listSources({ installationId: 'closing-house' }) },
  { name: 'refinement task listing', start: service => service.listRefinementTasks({ installationId: 'closing-house' }) },
  { name: 'refinement task lookup', start: service => service.getRefinementTask({ installationId: 'closing-house', taskId: 'closing-task' }) },
  { name: 'refinement task cancellation', start: service => service.cancelRefinementTask({ installationId: 'closing-house', taskId: 'closing-task' }) },
  { name: 'browse', start: service => service.browse({ installationId: 'closing-house' }) },
  { name: 'export', start: service => service.exportSpace({ installationId: 'closing-house' }) },
  { name: 'import', start: service => service.importSpace({ installationId: 'closing-house', data: { version: 1, exportedAt: 1,
    spaceId: 'homeassistant:closing-house', installationId: 'closing-house', sources: [], nodes: [], edges: [], issues: [], extractions: [] } }) },
  { name: 'reset', start: service => service.resetSpace({ installationId: 'closing-house', dryRun: true }) },
];

for (const { name, start } of starts) test(`runtime close drains an accepted ${name} before closing its store and prevents late publication`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-snapshot-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }));
  const scope = createAsyncDisposalScope('foreground snapshot owner');
  let storeClosed = false;
  scope.registry.add('knowledge store', async () => { await store.close(); storeClosed = true; });
  scope.registry.add('home graph service', () => service.dispose());
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const initialize = store.init.bind(store);
  const admission = spyOn(store, 'init').mockImplementationOnce(async () => {
    entered.resolve();
    await release.promise;
    await initialize();
  });
  const sync = start(service);
  const outcome = sync.then(() => 'completed', (error: unknown) => error);
  try {
    await entered.promise;
    const closing = scope.close();
    let disposed = false;
    void closing.then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    expect(storeClosed).toBe(false);
    release.resolve();
    const failure = await outcome;
    if (name === 'map') expect(failure).toMatchObject({ reason: 'aborted' });
    else {
      expect(failure).toBeInstanceOf(DOMException);
      if (!(failure instanceof DOMException)) throw new Error('Foreground cancellation was not delivered to its caller');
      expect(failure.name).toBe('AbortError');
    }
    await closing;
    expect(storeClosed).toBe(true);
    const reopened = new KnowledgeStore({ dbPath: store.storagePath });
    try {
      await reopened.init();
      expect(reopened.listSources()).toEqual([]);
      expect(reopened.listNodes()).toEqual([]);
      expect(reopened.listEdges()).toEqual([]);
    } finally { await reopened.close(); }
    await expect(start(service)).rejects.toThrow('aborted');
  } finally {
    release.resolve();
    await outcome;
    await scope.close();
    admission.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('dispose drains a real admitted reindex and cancellation prevents its later quality publication', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-admitted-reindex-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }));
  const previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const initialize = store.init.bind(store), replaceIssues = store.replaceIssuesGuarded.bind(store);
  let calls = 0, qualityWrites = 0, disposed = false;
  let initialization: ReturnType<typeof spyOn<typeof store, 'init'>> | undefined;
  let publication: ReturnType<typeof spyOn<typeof store, 'replaceIssuesGuarded'>> | undefined;
  let outcome: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  try {
    await service.syncSnapshot({ installationId: 'reindex-drain-house', pageAutomation: { enabled: false },
      devices: [{ id: 'one', name: 'Physical device' }] });
    initialization = spyOn(store, 'init').mockImplementation(async () => {
      if (++calls === 2) { entered.resolve(); await release.promise; }
      return initialize();
    });
    publication = spyOn(store, 'replaceIssuesGuarded').mockImplementation(async (...args) => {
      qualityWrites++;
      return replaceIssues(...args);
    });
    outcome = service.reindex({ installationId: 'reindex-drain-house', refreshPages: false })
      .then(() => 'completed', (error: unknown) => error);
    await entered.promise;
    closing = service.dispose().then(() => { disposed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    release.resolve();
    const failure = await outcome;
    expect(failure).toBeInstanceOf(DOMException);
    if (!(failure instanceof DOMException)) throw new Error('Reindex cancellation was not delivered to its caller');
    expect(failure.name).toBe('AbortError');
    await closing;
    expect(disposed).toBe(true);
    expect(qualityWrites).toBe(0);
    expect(store.listNodes().some(node => node.title === 'Physical device')).toBe(true);
    await expect(service.reindex({ installationId: 'reindex-drain-house' })).rejects.toThrow('aborted');
  } finally {
    release.resolve();
    await outcome;
    await closing;
    await service.dispose();
    initialization?.mockRestore(); publication?.mockRestore();
    installJudgmentPort(previous);
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('reentrant initialization shutdown observes its foreground owner before the dependency is invoked', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-reentrant-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }));
  const scope = createAsyncDisposalScope('reentrant foreground owner');
  let storeClosed = false, disposed = false;
  scope.registry.add('knowledge store', async () => { await store.close(); storeClosed = true; });
  scope.registry.add('home graph service', () => service.dispose());
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const initialize = store.init.bind(store);
  let closing: Promise<void> | undefined;
  const admission = spyOn(store, 'init').mockImplementationOnce(async () => {
    closing = scope.close().then(() => { disposed = true; });
    entered.resolve();
    await release.promise;
    return initialize();
  });
  const outcome = service.syncSnapshot({ installationId: 'reentrant-house' }).then(() => 'completed', (error: unknown) => error);
  try {
    await entered.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    expect(storeClosed).toBe(false);
    release.resolve();
    expect(await outcome).toBeInstanceOf(DOMException);
    await closing;
    expect(storeClosed).toBe(true);
  } finally {
    release.resolve(); await outcome; await closing; await scope.close();
    admission.mockRestore(); rmSync(root, { recursive: true, force: true });
  }
});

test('shutdown cancels queued foreground admission before any store dependency starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-queued-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }));
  const initialize = spyOn(store, 'init');
  const outcome = service.syncSnapshot({ installationId: 'queued-house' }).then(() => 'completed', (error: unknown) => error);
  try {
    await service.dispose();
    expect(await outcome).toBeInstanceOf(DOMException);
    expect(initialize).not.toHaveBeenCalled();
  } finally {
    await outcome; await service.dispose(); initialize.mockRestore(); await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an untimed real ask forwards shutdown to its actual judgment request and consumes a late borrowed result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-ask-cancel-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const service = new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }));
  const fake = fakePort(() => noulAnswer(0.99));
  const previous = installJudgmentPort(fake.port);
  const entered = Promise.withResolvers<AbortSignal | undefined>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  let outcome: Promise<unknown> | undefined, closing: Promise<void> | undefined, rawStarted = false;
  try {
    await service.syncSnapshot({ installationId: 'ask-cancel-house', pageAutomation: { enabled: false },
      devices: [{ id: 'one', name: 'Physical device' }] });
    installJudgmentPort({ ...fake.port, async ask(request) {
      rawStarted = true; entered.resolve(request.signal);
      try { await release.promise; return await fake.port.ask(request); }
      finally { finished.resolve(); }
    } });
    const before = JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() });
    outcome = service.ask({ installationId: 'ask-cancel-house', query: 'What physical devices are in this house?', timeoutMs: 0 })
      .then(() => 'completed', (error: unknown) => error);
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (!signal) throw new Error('Actual judgment request omitted its owner signal');
    expect(signal.aborted).toBe(false);
    closing = service.dispose();
    expect(signal.aborted).toBe(true);
    await closing;
    expect(await outcome).toMatchObject({ reason: 'aborted' });
    release.resolve(); await finished.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(), issues: store.listIssues() })).toBe(before);
  } finally {
    release.resolve();
    if (rawStarted) await finished.promise;
    await outcome; await closing; await service.dispose();
    installJudgmentPort(previous); await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('packet publication forwards shutdown to its actual artifact owner and drains before disposal returns', async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-packet-cancel-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifacts);
  const previous = installJudgmentPort(fakePort(() => noulAnswer(0.99)).port);
  const entered = Promise.withResolvers<AbortSignal | undefined>(), release = Promise.withResolvers<void>();
  const create = artifacts.createForPublication.bind(artifacts);
  let creation: ReturnType<typeof spyOn<typeof artifacts, 'createForPublication'>> | undefined;
  let outcome: Promise<unknown> | undefined, closing: Promise<void> | undefined, disposed = false;
  try {
    await service.syncSnapshot({ installationId: 'packet-cancel-house', pageAutomation: { enabled: false },
      devices: [{ id: 'one', name: 'Physical device' }] });
    const records = () => JSON.stringify({ sources: store.listSources(), nodes: store.listNodes(), edges: store.listEdges(),
      issues: store.listIssues(), artifacts: artifacts.list(20) });
    const before = records();
    creation = spyOn(artifacts, 'createForPublication').mockImplementation(async (input, ownership = {}) => {
      entered.resolve(ownership.signal);
      await release.promise;
      return create(input, ownership);
    });
    outcome = service.generatePacket({ installationId: 'packet-cancel-house' }).then(() => 'completed', (error: unknown) => error);
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (!signal) throw new Error('Actual artifact publication omitted its owner signal');
    expect(signal.aborted).toBe(false);
    closing = service.dispose().then(() => { disposed = true; });
    expect(signal.aborted).toBe(true);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(disposed).toBe(false);
    release.resolve();
    expect(await outcome).toBeInstanceOf(Error);
    await closing;
    expect(records()).toBe(before);
  } finally {
    release.resolve(); await outcome; await closing; await service.dispose();
    creation?.mockRestore(); installJudgmentPort(previous); await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const stage of ['fetch', 'body'] as const) for (const cancelledBy of ['service', 'caller'] as const) {
test(`URL ingestion owns its actual ${stage} acquisition when cancelled by ${cancelledBy}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-url-close-'));
  const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') });
  const artifacts = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const service = new HomeGraphService(store, artifacts);
  const entered = Promise.withResolvers<AbortSignal | null | undefined>(), release = Promise.withResolvers<void>();
  const controller = new AbortController();
  let bodyCancelled = false, acquiredSignal: AbortSignal | null | undefined;
  const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(async (_request: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    acquiredSignal = init?.signal;
    if (stage === 'fetch') {
      entered.resolve(acquiredSignal);
      await release.promise;
      acquiredSignal?.throwIfAborted();
      return new Response('Owned remote note.', { headers: { 'Content-Type': 'text/plain' } });
    }
    const body = new ReadableStream<Uint8Array>({
      start(stream) { stream.enqueue(new TextEncoder().encode('Owned remote note prefix.')); },
      pull() { entered.resolve(acquiredSignal); return release.promise; },
      cancel() { bodyCancelled = true; },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/plain' } });
  }, { preconnect: fetch.preconnect }));
  const outcome = service.ingestUrl({ installationId: 'url-close-house', url: 'https://example.org/owned-note.txt' },
    cancelledBy === 'caller' ? { signal: controller.signal } : {}).then(() => 'completed', (error: unknown) => error);
  let closing: Promise<void> | undefined, disposed = false;
  try {
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    if (!signal) throw new Error('Actual URL acquisition omitted its owner signal');
    expect(signal.aborted).toBe(false);
    if (cancelledBy === 'service') closing = service.dispose().then(() => { disposed = true; });
    else controller.abort();
    expect(signal.aborted).toBe(true);
    if (stage === 'fetch') {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(disposed).toBe(false);
      release.resolve();
    }
    expect(await outcome).toBeInstanceOf(Error);
    await closing;
    if (stage === 'body') expect(bodyCancelled).toBe(true);
    expect(artifacts.list(20)).toEqual([]);
    expect(store.listSources()).toEqual([]);
    expect(store.listNodes()).toEqual([]);
    expect(store.listExtractions()).toEqual([]);
  } finally {
    release.resolve(); await outcome; await closing; await service.dispose();
    transport.mockRestore(); await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
}
