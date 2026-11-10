import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { DaemonServer } from '../platform/src/platform/daemon/facade.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createRuntimeServices, type RuntimeServices } from '../platform/src/platform/runtime/services.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { GOODVIBES_AGENT_KNOWLEDGE_DB_FILE, KnowledgeService, KnowledgeStore, KnowledgeSemanticService, prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/index.js';
import { ProjectIdentityUnavailableError } from '../platform/src/platform/knowledge/project-planning/project-registry.js';
import { trackDisposables } from './_helpers/disposables.ts';

/**
 * The graph below is INJECTED into DaemonServer, and the facade deliberately
 * disposes only a graph it composed itself, an injected one may outlive the
 * daemon, so it is the caller's to stop. Here the caller is this test.
 */
const disposables = trackDisposables();

const tmpRoots: string[] = [];

async function injectedRuntime() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-agent-knowledge-owner-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true }); mkdirSync(homeDirectory, { recursive: true });
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
  await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
  const runtime = disposables.add(createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir, homeDirectory,
  }), graph => graph.close());
  await runtime.agentKnowledgeService.whenReady();
  return runtime;
}

function knowledgeResources(service: KnowledgeService): { readonly store: KnowledgeStore; readonly semanticService: KnowledgeSemanticService } {
  return service as unknown as { readonly store: KnowledgeStore; readonly semanticService: KnowledgeSemanticService };
}

function facadeRuntime(daemon: DaemonServer): RuntimeServices {
  return (daemon as unknown as { readonly runtimeServices: RuntimeServices }).runtimeServices;
}

function facadeAgentKnowledge(daemon: DaemonServer): KnowledgeService {
  return (daemon as unknown as { readonly httpRouter: { readonly context: { readonly agentKnowledgeService: KnowledgeService } } })
    .httpRouter.context.agentKnowledgeService;
}

function omitAgentKnowledge(runtime: RuntimeServices): void {
  delete (runtime as { -readonly [K in keyof RuntimeServices]?: RuntimeServices[K] }).agentKnowledgeService;
}

afterEach(async () => {
  await disposables.flush();
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function dispatch(
  daemon: DaemonServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const handleRequest = (daemon as unknown as {
    handleRequest(req: Request): Promise<Response>;
  }).handleRequest.bind(daemon);
  return await handleRequest(new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: 'Bearer test-token',
      ...(init.headers ?? {}),
    },
  }));
}

describe('daemon Agent knowledge route wiring', () => {
  test('an unprepared project refuses before reading runtime configuration or starting its graph', () => {
    const root = mkdtempSync(join(tmpdir(), 'unprepared-runtime-project-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
    const read = spyOn(configManager, 'get').mockImplementation(() => {
      throw new Error('An unprepared graph reached runtime configuration');
    });
    try {
      expect(() => createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(),
        runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir, homeDirectory,
      })).toThrow(ProjectIdentityUnavailableError);
      expect(read).not.toHaveBeenCalled();
    } finally { read.mockRestore(); }
  });

  test('normalizes injected runtime services that predate agentKnowledgeService', async () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-agent-knowledge-routes-'));
    tmpRoots.push(root);
    const workingDir = join(root, 'workspace');
    const homeDirectory = join(root, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDirectory, { recursive: true });
    seedBenchmarkCache(homeDirectory, 'goodvibes');
    const runtimeBus = new RuntimeEventBus();
    const configManager = new ConfigManager({
      homeDir: homeDirectory,
      workingDir,
      surfaceRoot: 'goodvibes-test',
    });
    await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
    const runtimeServices = disposables.add(createRuntimeServices({
      configManager,
      runtimeBus,
      runtimeStore: createRuntimeStore(),
      surfaceRoot: 'goodvibes',
      getConversationTitle: () => 'goodvibes test daemon',
      workingDir,
      homeDirectory,
    }), runtime => runtime.close());

    // Finish this current graph's original Agent bootstrap before simulating
    // an older graph without that service; two independent bootstrap writers
    // to the same native file are not the compatibility scenario.
    await runtimeServices.agentKnowledgeService.whenReady();

    // Simulate an embedding host that updated DaemonServer before refreshing
    // its injected runtime-services object. The daemon must still create an
    // isolated Agent knowledge service instead of wiring undefined handlers or
    // falling back to regular Knowledge/Wiki.
    delete (runtimeServices as { -readonly [K in keyof typeof runtimeServices]?: typeof runtimeServices[K] }).agentKnowledgeService;

    const daemon = disposables.add(new DaemonServer({ runtimeServices }), server => server.stop());
    daemon.enable({ daemon: true }, 'test-token');

    const status = await dispatch(daemon, '/api/goodvibes-agent/knowledge/status');
    expect(status.status).toBe(200);
    const statusBody = await status.json() as Record<string, unknown>;
    expect(statusBody).toMatchObject({ sourceCount: 0, nodeCount: 0, issueCount: 0 });

    const ask = await dispatch(daemon, '/api/goodvibes-agent/knowledge/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'What is GoodVibes Agent?' }),
    });
    expect(ask.status).toBe(200);

    const search = await dispatch(daemon, '/api/goodvibes-agent/knowledge/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'GoodVibes Agent', limit: 5 }),
    });
    expect(search.status).toBe(200);
    const searchBody = await search.json() as { results?: unknown[] };
    expect(searchBody.results).toEqual([]);

    expect(knowledgeResources(facadeAgentKnowledge(daemon)).store.storagePath)
      .toEndWith(GOODVIBES_AGENT_KNOWLEDGE_DB_FILE);
    expect(Object.hasOwn(runtimeServices, 'agentKnowledgeService')).toBe(false);

    await daemon.stop();
    // Listener shutdown must leave the composing host's graph usable. Its
    // fleet still observes the same live trigger source until the host closes.
    expect(() => runtimeServices.processRegistry.query()).not.toThrow();
  });

  test('a started facade drains only its supplemental knowledge owners and leaves the borrowed graph unchanged', async () => {
    const runtime = await injectedRuntime();
    const original = runtime.agentKnowledgeService;
    const originalStore = knowledgeResources(original).store;
    omitAgentKnowledge(runtime);
    const daemon = disposables.add(await DaemonServer.create({ runtimeServices: runtime, port: 0, host: '127.0.0.1' }), server => server.stop());
    const supplemental = facadeAgentKnowledge(daemon);
    const resources = knowledgeResources(supplemental);
    await supplemental.whenReady();
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const originalDispose = supplemental.dispose.bind(supplemental);
    const ownedDrain = spyOn(supplemental, 'dispose').mockImplementation(async () => {
      const originalDrain = originalDispose();
      entered.resolve();
      await release.promise;
      await originalDrain;
    });
    const semanticClose = spyOn(resources.semanticService, 'dispose');
    const storeClose = spyOn(resources.store, 'close');
    const borrowedClose = spyOn(runtime, 'close');
    const borrowedServiceClose = spyOn(original, 'dispose');
    const borrowedStoreClose = spyOn(originalStore, 'close');
    let closing: Promise<void> | undefined, stopped = false;
    try {
      daemon.enable({ daemon: true }, 'supplemental-owner-token');
      await daemon.start();
      closing = daemon.stop().then(() => { stopped = true; });
      await entered.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(stopped).toBe(false);
      expect(semanticClose).not.toHaveBeenCalled();
      expect(storeClose).not.toHaveBeenCalled();
      expect(borrowedClose).not.toHaveBeenCalled();
      expect(borrowedServiceClose).not.toHaveBeenCalled();
      expect(borrowedStoreClose).not.toHaveBeenCalled();
      release.resolve();
      await closing;
      await daemon.stop();
      expect(ownedDrain).toHaveBeenCalledTimes(1);
      expect(semanticClose).toHaveBeenCalledTimes(1);
      expect(storeClose).toHaveBeenCalledTimes(1);
      expect(borrowedClose).not.toHaveBeenCalled();
      expect(borrowedServiceClose).not.toHaveBeenCalled();
      expect(borrowedStoreClose).not.toHaveBeenCalled();
      expect(Object.hasOwn(runtime, 'agentKnowledgeService')).toBe(false);
      expect(facadeRuntime(daemon)).toBe(runtime);
      expect(() => runtime.processRegistry.query()).not.toThrow();
      expect(await original.getStatus()).toMatchObject({ nodeCount: 0 });
    } finally {
      release.resolve(); await closing; await daemon.stop();
      ownedDrain.mockRestore(); semanticClose.mockRestore(); storeClose.mockRestore();
      borrowedClose.mockRestore(); borrowedServiceClose.mockRestore(); borrowedStoreClose.mockRestore();
    }
  });

  test('a failed async facade factory waits for partial supplemental startup before closing its store', async () => {
    const runtime = await injectedRuntime();
    const original = runtime.agentKnowledgeService, originalStore = knowledgeResources(original).store;
    omitAgentKnowledge(runtime);
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const initialize = KnowledgeStore.prototype.init;
    const attach = KnowledgeService.prototype.attachRuntimeBus;
    let ownedStore: KnowledgeStore | undefined, ownedService: KnowledgeService | undefined;
    const init = spyOn(KnowledgeStore.prototype, 'init').mockImplementation(async function (this: KnowledgeStore) {
      if (this !== originalStore && this.storagePath.endsWith(GOODVIBES_AGENT_KNOWLEDGE_DB_FILE)) {
        ownedStore = this; entered.resolve(); await release.promise;
      }
      await initialize.call(this);
    });
    const failed = new Error('supplemental facade attachment failed');
    const attachment = spyOn(KnowledgeService.prototype, 'attachRuntimeBus').mockImplementation(function (this: KnowledgeService, bus) {
      if (this !== original && knowledgeResources(this).store === ownedStore) { ownedService = this; throw failed; }
      return attach.call(this, bus);
    });
    const serviceClose = spyOn(KnowledgeService.prototype, 'dispose');
    const semanticClose = spyOn(KnowledgeSemanticService.prototype, 'dispose');
    const storeClose = spyOn(KnowledgeStore.prototype, 'close');
    const borrowedClose = spyOn(runtime, 'close');
    let settled = false;
    const outcome = DaemonServer.create({ runtimeServices: runtime }).then(() => { settled = true; return 'created'; },
      (error: unknown) => { settled = true; return error; });
    try {
      await entered.promise;
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(serviceClose.mock.contexts).toContain(ownedService);
      expect(storeClose.mock.contexts).not.toContain(ownedStore);
      expect(semanticClose).not.toHaveBeenCalled();
      expect(borrowedClose).not.toHaveBeenCalled();
      release.resolve();
      expect(await outcome).toBe(failed);
      expect(storeClose.mock.contexts).toEqual([ownedStore]);
      expect(serviceClose.mock.contexts).toEqual([ownedService]);
      expect(semanticClose).toHaveBeenCalledTimes(1);
      expect(Object.hasOwn(runtime, 'agentKnowledgeService')).toBe(false);
      expect(() => runtime.processRegistry.query()).not.toThrow();
      expect(await original.getStatus()).toMatchObject({ nodeCount: 0 });
    } finally {
      release.resolve(); await outcome;
      init.mockRestore(); attachment.mockRestore(); serviceClose.mockRestore();
      semanticClose.mockRestore(); storeClose.mockRestore(); borrowedClose.mockRestore();
    }
  });

  test('supplemental cleanup failure still closes its other owners and remains observable on repeated stop', async () => {
    const runtime = await injectedRuntime();
    const original = runtime.agentKnowledgeService;
    omitAgentKnowledge(runtime);
    const daemon = await DaemonServer.create({ runtimeServices: runtime });
    const supplemental = facadeAgentKnowledge(daemon), resources = knowledgeResources(supplemental);
    await supplemental.whenReady();
    const dispose = supplemental.dispose.bind(supplemental);
    const failure = new Error('supplemental service cleanup failed');
    const serviceClose = spyOn(supplemental, 'dispose').mockImplementation(async () => { await dispose(); throw failure; });
    const semanticClose = spyOn(resources.semanticService, 'dispose');
    const storeClose = spyOn(resources.store, 'close');
    const borrowedClose = spyOn(runtime, 'close');
    try {
      await expect(daemon.stop()).rejects.toThrow('Daemon runtime services cleanup failed');
      await expect(daemon.stop()).rejects.toThrow('cleanup operation(s) failed');
      expect(serviceClose).toHaveBeenCalledTimes(1);
      expect(semanticClose).toHaveBeenCalledTimes(1);
      expect(storeClose).toHaveBeenCalledTimes(1);
      expect(borrowedClose).not.toHaveBeenCalled();
      expect(await original.getStatus()).toMatchObject({ nodeCount: 0 });
    } finally {
      serviceClose.mockRestore(); semanticClose.mockRestore(); storeClose.mockRestore(); borrowedClose.mockRestore();
    }
  });
});
