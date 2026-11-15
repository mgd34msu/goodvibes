/**
 * A host that composes its own RuntimeServices may have no trigger family
 * (RuntimeServices.triggerManager is optional). Absence must mean "this runtime
 * has no triggers": the daemon still starts and stops, it never crashes on a
 * missing manager.
 */
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { DaemonServer } from '../platform/src/platform/daemon/facade.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { createRuntimeServices, type RuntimeServices } from '../platform/src/platform/runtime/services.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/index.js';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const roots: string[] = [];

afterEach(async () => {
  await disposables.flush();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function environment() {
  const root = mkdtempSync(join(tmpdir(), 'daemon-no-triggers-'));
  roots.push(root);
  const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true }); mkdirSync(homeDirectory, { recursive: true });
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
  await prepareConfiguredProjectContext(configManager, workingDir, 'knowledge-wiki.sqlite', { activate: true });
  return { configManager, workingDir, homeDirectory };
}

function withoutTriggerManager(runtime: RuntimeServices): void {
  delete (runtime as { -readonly [K in keyof RuntimeServices]?: RuntimeServices[K] }).triggerManager;
}

test('a hand-composed runtime with no trigger family starts and stops', async () => {
  const { configManager, workingDir, homeDirectory } = await environment();
  const runtime = disposables.add(createRuntimeServices({ configManager, runtimeBus: new RuntimeEventBus(),
    runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir, homeDirectory,
  }), graph => graph.close());
  withoutTriggerManager(runtime);
  const daemon = disposables.add(await DaemonServer.create({ runtimeServices: runtime, port: 0, host: '127.0.0.1' }), server => server.stop());
  expect(daemon.triggers).toBeUndefined();
  daemon.enable({ daemon: true }, 'no-trigger-token');
  await daemon.start();
  await daemon.stop();
});

test('a daemon that owns its runtime shuts down when its trigger manager is absent', async () => {
  const { configManager, workingDir, homeDirectory } = await environment();
  const daemon = new DaemonServer({ configManager, workingDir, homeDirectory, daemonHomeDir: join(homeDirectory, 'daemon'), port: 0, host: '127.0.0.1' });
  // The owned graph's trigger manager is what shutdown() reaches through; take it away.
  withoutTriggerManager((daemon as unknown as { runtimeServices: RuntimeServices }).runtimeServices);
  (daemon as unknown as { triggerManager: undefined }).triggerManager = undefined;
  await daemon.stop();
});
