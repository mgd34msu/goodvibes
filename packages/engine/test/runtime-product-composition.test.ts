/**
 * The one service composition: a product's choices decide where its memory
 * lands and whether a workspace trust owner stands in front of its asks. A
 * product that names the shipped choices gets the shipped owners; the embedded
 * choices keep their per-project store and no trust owner.
 */
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import {
  composeRuntimeServices,
  embeddedProductComposition,
  type ProductComposition,
} from '../platform/src/platform/runtime/services.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { resolveCanonicalMemoryDbPath } from '../platform/src/platform/state/canonical-memory.js';
import { WebhookNotifier } from '../platform/src/platform/integrations/webhooks.js';
import { trackDisposables } from './_helpers/disposables.ts';

const disposables = trackDisposables();
const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function prepareRoots() {
  const root = mkdtempSync(join(tmpdir(), 'goodvibes-product-composition-'));
  tmpRoots.push(root);
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes-test' });
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
  const options = { configManager, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir, homeDirectory };
  return { workingDir, homeDirectory, options };
}

describe('composeRuntimeServices', () => {
  test('the shipped choices open the home memory store and compose a workspace trust owner', async () => {
    const { homeDirectory, options } = await prepareRoots();
    const productNotifier = new WebhookNotifier();
    let extrasSawBase = false;
    const product: ProductComposition = {
      surface: 'daemon',
      roots: options,
      hostSeams: options,
      memoryStore: 'home',
      workspaceTrust: 'surface',
      permissionHost: {},
      extras: (base) => {
        extrasSawBase = base.surfaceRoot === 'goodvibes';
        return { webhookNotifier: productNotifier };
      },
    };
    const services = disposables.add(composeRuntimeServices(product));
    expect(services.memoryStore.dbPath).toBe(resolveCanonicalMemoryDbPath(homeDirectory));
    expect(services.workspaceTrustManager).toBeDefined();
    expect(services.permissionManager).toBeDefined();
    expect(extrasSawBase).toBe(true);
    expect(services.webhookNotifier).toBe(productNotifier);
  });

  test('the embedded choices keep memory in the project and compose no trust owner', async () => {
    const { workingDir, options } = await prepareRoots();
    const services = disposables.add(composeRuntimeServices(embeddedProductComposition(options)));
    expect(services.memoryStore.dbPath).toBe(join(workingDir, '.goodvibes', 'goodvibes', 'memory.sqlite'));
    expect(services.workspaceTrustManager).toBeUndefined();
  });
});
