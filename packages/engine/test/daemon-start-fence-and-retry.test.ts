/** Lifecycle edges of DaemonServer.start(): a fenced host must not arm native
 * activation, a busy port must leave no owner running, and a start retried
 * after a failure must not restore hosted sessions twice. Each case uses the
 * real constructor-owned graph in an isolated home. */
import { afterEach, expect, mock, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { DaemonServer } from '../platform/src/platform/daemon/facade.ts';
import type { DaemonLifecycleRuntime } from '../platform/src/platform/daemon/facade-lifecycle.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function makeServer(extra: { port?: number; deferNativeActivationUntilHostReady?: boolean } = {}): Promise<DaemonServer> {
  const home = mkdtempSync(join(tmpdir(), 'daemon-start-'));
  const work = join(home, 'work');
  mkdirSync(work);
  seedBenchmarkCache(home, 'goodvibes');
  const configManager = new ConfigManager({ workingDir: work, homeDir: home, surfaceRoot: 'goodvibes', ownsDaemonTier: true });
  const server = await DaemonServer.create({
    port: extra.port ?? 0,
    host: '127.0.0.1',
    workingDir: work,
    homeDirectory: home,
    daemonHomeDir: join(home, 'daemon'),
    configManager,
    ...(extra.deferNativeActivationUntilHostReady ? { deferNativeActivationUntilHostReady: true } : {}),
  });
  cleanups.push(async () => {
    try { await server.stop(); } finally { rmSync(home, { recursive: true, force: true }); }
  });
  return server;
}

type Internals = {
  lifecycle: DaemonLifecycleRuntime;
  surfaceActionHelper: { startDelegatedTelegram(): void; closeDelegatedTelegram(): void };
  hostedSessions: { init(): Promise<unknown>; dispose(): Promise<void> } | null;
  runtimeServices: { memoryStore: { init(): Promise<void> } };
};

test('completeHostStartup after fenceRestartAdmission arms no native lifecycle', async () => {
  const server = await makeServer({ deferNativeActivationUntilHostReady: true });
  const internals = server as unknown as Internals;
  const started = spyOn(internals.lifecycle, 'onStarted');
  const activated = spyOn(internals.lifecycle, 'activateNativeLifecycle');
  server.enable({ daemon: true }, 'fence-fixture-token');
  await server.start();
  expect(server.isRunning).toBe(true);

  server.fenceRestartAdmission();
  expect(server.completeHostStartup()).toBeUndefined();

  expect(started).not.toHaveBeenCalled();
  expect(activated).not.toHaveBeenCalled();
}, 60_000);

test('completeHostStartup without a fence still activates the native lifecycle', async () => {
  const server = await makeServer({ deferNativeActivationUntilHostReady: true });
  const internals = server as unknown as Internals;
  const activated = spyOn(internals.lifecycle, 'activateNativeLifecycle');
  server.enable({ daemon: true }, 'fence-fixture-token');
  await server.start();

  server.completeHostStartup();

  expect(activated).toHaveBeenCalledTimes(1);
}, 60_000);

test('a start refused for a busy port attaches no lifecycle owner', async () => {
  const occupier = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('busy') });
  cleanups.push(() => occupier.stop(true));
  if (occupier.port === undefined) throw new Error('the occupying server bound no port');
  const server = await makeServer({ port: occupier.port });
  const internals = server as unknown as Internals;
  const started = spyOn(internals.surfaceActionHelper, 'startDelegatedTelegram');
  server.enable({ daemon: true }, 'busy-fixture-token');

  await expect(server.start()).rejects.toThrow();

  expect(started).not.toHaveBeenCalled();
  expect(server.isRunning).toBe(false);
}, 60_000);

test('a start retried after a failure restores hosted sessions once', async () => {
  const server = await makeServer();
  const internals = server as unknown as Internals;
  // The default graph hosts no sessions; stand in a manager so the count of init calls is observable.
  const init = mock(async () => ({ restored: [], rejected: [], swept: [], evicted: [] }));
  internals.hostedSessions = { init, dispose: async () => {} };
  const memoryInit = spyOn(internals.runtimeServices.memoryStore, 'init');
  memoryInit.mockImplementationOnce(async () => { throw new Error('memory store unavailable'); });
  server.enable({ daemon: true }, 'retry-fixture-token');

  await expect(server.start()).rejects.toThrow('memory store unavailable');
  await server.start();

  expect(server.isRunning).toBe(true);
  expect(init).toHaveBeenCalledTimes(1);
}, 60_000);
