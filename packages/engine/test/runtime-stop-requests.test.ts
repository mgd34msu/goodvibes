import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';
import { createRuntimeServices } from '../platform/src/platform/runtime/services.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { AsyncDisposalError, createAsyncDisposalScope, createRuntimeStopRequests } from '../platform/src/platform/runtime/disposal.js';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';

test('the actual platform graph cancels independent owners before held trigger drainage and awaits its original HomeGraph drain once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-native-stop-request-'));
  const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDir); mkdirSync(homeDirectory);
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes-test', workingDir, homeDir: homeDirectory });
  await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
  const services = createRuntimeServices({ configManager, workingDir, homeDirectory, surfaceRoot: 'goodvibes',
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  const trigger = services.triggerManager;
  if (!trigger) throw new Error('The full platform graph must own its native trigger supervisor');
  const triggerEntered = Promise.withResolvers<void>(), releaseTrigger = Promise.withResolvers<void>();
  const releaseHomeGraph = Promise.withResolvers<void>();
  const nativeJoin = trigger.join.bind(trigger), nativeHomeGraphDispose = services.homeGraphService.dispose.bind(services.homeGraphService);
  const triggerJoin = spyOn(trigger, 'join').mockImplementation(async () => {
    triggerEntered.resolve(); await releaseTrigger.promise; await nativeJoin();
  });
  const homeGraphDispose = spyOn(services.homeGraphService, 'dispose').mockImplementation(async () => {
    await nativeHomeGraphDispose(); await releaseHomeGraph.promise;
  });
  const governorStop = spyOn(services.memoryGovernor, 'stop'), watcherStop = spyOn(services.watcherRegistry, 'dispose');
  let closing: Promise<void> | undefined;
  try {
    closing = services.close(); services.dispose();
    expect(services.close()).toBe(closing);
    expect(homeGraphDispose).toHaveBeenCalledTimes(1);
    expect(governorStop).toHaveBeenCalledTimes(1); expect(watcherStop).toHaveBeenCalledTimes(1);
    await triggerEntered.promise;
    let settled = false; void closing.then(() => { settled = true; }, () => {});
    expect(settled).toBe(false);
    releaseTrigger.resolve();
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    expect(homeGraphDispose).toHaveBeenCalledTimes(1);
    releaseHomeGraph.resolve(); await closing;
    expect(settled).toBe(true); expect(triggerJoin).toHaveBeenCalledTimes(1);
    expect(homeGraphDispose).toHaveBeenCalledTimes(1);
  } finally {
    releaseTrigger.resolve(); releaseHomeGraph.resolve();
    try { await (closing ?? services.close()); }
    finally { triggerJoin.mockRestore(); homeGraphDispose.mockRestore(); governorStop.mockRestore(); watcherStop.mockRestore(); }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('a synchronous stop failure cannot strand other requests or erase the existing cleanup failure', async () => {
  const scope = createAsyncDisposalScope('native stop failure fixture');
  const failure = new Error('Synthetic original stop failure');
  const calls: string[] = [];
  const stops = createRuntimeStopRequests(scope.registry, {
    homeGraphService: { dispose() { calls.push('home graph'); throw failure; } },
    memoryGovernor: { stop() { calls.push('governor'); } },
    watcherRegistry: { dispose() { calls.push('watchers'); } },
    conversationRewind() { calls.push('rewind'); },
  });
  scope.registry.add('watcher timer', stops.watchers);
  scope.registry.add('memory governor', stops.memoryGovernor);
  scope.registry.add('home graph original drain', stops.homeGraph);
  stops.request(); stops.request();
  expect(calls).toEqual(['home graph', 'rewind', 'governor', 'watchers']);
  const closing = scope.close();
  const result = await closing.then(() => undefined, (error: unknown) => error);
  expect(result).toBeInstanceOf(AsyncDisposalError);
  if (!(result instanceof AsyncDisposalError)) throw new Error('The original stop failure was lost');
  expect(result.failures).toEqual([{ label: 'home graph cancellation', error: failure }]);
  expect(calls).toEqual(['home graph', 'rewind', 'governor', 'watchers']);
});

for (const failHomeGraph of [false, true]) test(`the full graph closes all original knowledge stores before its log (close failure=${failHomeGraph})`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'platform-native-store-close-'));
  const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDir); mkdirSync(homeDirectory);
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  const configManager = new ConfigManager({ surfaceRoot: 'goodvibes-test', workingDir, homeDir: homeDirectory });
  await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
  const services = createRuntimeServices({ configManager, workingDir, homeDirectory, surfaceRoot: 'goodvibes',
    runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore() });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const failure = new Error('Synthetic original HomeGraph storage close failure');
  const stores: string[] = [];
  const nativeClose = KnowledgeStore.prototype.close;
  const storeClose = spyOn(KnowledgeStore.prototype, 'close').mockImplementation(function(this: KnowledgeStore) {
    const file = basename(this.storagePath);
    if (!relative(root, this.storagePath).startsWith('..') && ['knowledge-wiki.sqlite', 'knowledge-agent.sqlite', 'knowledge-home-graph.sqlite'].includes(file)) {
      stores.push(file);
      // The real native close retires the artifact reference ensemble and
      // drains accepted native storage work. Extend that original result to
      // prove graph cleanup waits, rather than replacing the actual store.
      const original = nativeClose.call(this);
      if (file === 'knowledge-home-graph.sqlite') return original.then(async () => {
        entered.resolve(); await release.promise;
        if (failHomeGraph) throw failure;
      });
      return original;
    }
    return nativeClose.call(this);
  });
  const logClose = spyOn(services.judgment.decisionLog, Symbol.dispose);
  let closing: Promise<void> | undefined;
  try {
    closing = services.close();
    const observed = closing.then(() => undefined, (error: unknown) => error);
    await entered.promise;
    expect(stores).toEqual(['knowledge-home-graph.sqlite']);
    expect(logClose).not.toHaveBeenCalled();
    release.resolve();
    const result = await observed;
    if (failHomeGraph) {
      expect(result).toBeInstanceOf(AsyncDisposalError);
      if (!(result instanceof AsyncDisposalError)) throw new Error('The original storage close failure was lost');
      expect(result.failures).toEqual([{ label: 'home graph knowledge store', error: failure }]);
    } else expect(result).toBeUndefined();
    expect(stores).toEqual(['knowledge-home-graph.sqlite', 'knowledge-agent.sqlite', 'knowledge-wiki.sqlite']);
    expect(logClose).toHaveBeenCalledTimes(1);
  } finally {
    release.resolve();
    try { await (closing ?? services.close()).catch(() => {}); }
    finally { storeClose.mockRestore(); logClose.mockRestore(); }
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('reentrant close sees the reserved original child drain before any dependency can close', async () => {
  const scope = createAsyncDisposalScope('reentrant native child fixture');
  const held = Promise.withResolvers<void>();
  const calls: string[] = [];
  let reentrant: Promise<void> | undefined;
  const stops = createRuntimeStopRequests(scope.registry, {
    homeGraphService: { dispose() { calls.push('child stop'); reentrant = scope.close(); return held.promise; } },
    memoryGovernor: { stop() { calls.push('governor'); } },
    watcherRegistry: { dispose() { calls.push('watchers'); } },
  });
  scope.registry.add('dependent store', () => { calls.push('store closed'); });
  scope.registry.add('original child drain', stops.homeGraph);
  stops.request();
  const closing = scope.close();
  expect(reentrant).toBe(closing);
  expect(stops.homeGraph()).toBe(held.promise);
  expect(calls).toEqual(['child stop', 'governor', 'watchers']);
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(calls).not.toContain('store closed');
  } finally { held.resolve(); await closing; }
  expect(calls).toEqual(['child stop', 'governor', 'watchers', 'store closed']);
});

test('a stop returning its own parent close is rejected once without a parent-child await cycle', async () => {
  const scope = createAsyncDisposalScope('reentrant native parent fixture');
  const calls: string[] = [];
  const stops = createRuntimeStopRequests(scope.registry, {
    homeGraphService: { dispose() { calls.push('child stop'); return scope.close(); } },
    memoryGovernor: { stop() { calls.push('governor'); } },
    watcherRegistry: { dispose() { calls.push('watchers'); } },
  });
  scope.registry.add('dependent store', () => { calls.push('store closed'); });
  scope.registry.add('original child drain', stops.homeGraph);
  stops.request(); stops.request();
  const closing = scope.close();
  const failure = await closing.then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(AsyncDisposalError);
  if (!(failure instanceof AsyncDisposalError)) throw new Error('The direct parent-close cycle was not rejected');
  expect(failure.failures).toHaveLength(1);
  expect(failure.failures[0]?.label).toBe('home graph cancellation');
  expect(failure.failures[0]?.error).toBeInstanceOf(Error);
  const childError = failure.failures[0]?.error;
  if (!(childError instanceof Error)) throw new Error('The direct parent-close failure has no original error');
  expect(childError.message).toBe('A cleanup callback cannot await its own scope close.');
  expect(calls).toEqual(['child stop', 'governor', 'watchers', 'store closed']);
});
