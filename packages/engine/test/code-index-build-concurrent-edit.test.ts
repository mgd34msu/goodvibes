import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../platform/src/platform/state/code-index-store.js';
import {
  MemoryEmbeddingProviderRegistry,
  embedMemoryText,
  type MemoryEmbeddingProvider,
} from '../platform/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';

const roots: string[] = [];
const stores: CodeIndexStore[] = [];
/** Every store a test opens is closed in afterEach, so a failed assertion cannot leak a handle. */
function openStore(...args: ConstructorParameters<typeof CodeIndexStore>): CodeIndexStore {
  const store = new CodeIndexStore(...args);
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(onEmbed: (text: string) => Promise<void> | void): { root: string; store: CodeIndexStore } {
  const root = mkdtempSync(join(tmpdir(), 'gv-code-index-concurrent-'));
  roots.push(root);
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(root, '.config') }) });
  const provider: MemoryEmbeddingProvider = {
    id: 'concurrent-test',
    label: 'Concurrent test provider',
    dimensions: 384,
    deterministic: true,
    embedSync: (request) => ({ vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions }),
    async embed(request) {
      await onEmbed(request.text);
      return { vector: embedMemoryText(request.text, request.dimensions), dimensions: request.dimensions };
    },
  };
  registry.register(provider, { makeDefault: true });
  return { root, store: openStore(root, ':memory:', registry) };
}

describe('CodeIndexStore full build with concurrent edits', () => {
  test('a file edited while it is embedded is skipped and the build still completes', async () => {
    let rewritten = false;
    let rootRef = '';
    const { root, store } = setup((text) => {
      if (!rewritten && text.includes('alphaMarker')) {
        rewritten = true;
        writeFileSync(join(rootRef, 'a.ts'), 'export const alphaMarker = 2; // edited\n');
      }
    });
    rootRef = root;
    writeFileSync(join(root, 'a.ts'), 'export const alphaMarker = 1;\n');
    writeFileSync(join(root, 'b.ts'), 'export const betaMarker = 1;\n');
    await store.init();
    const stats = await store.buildFull();
    expect(stats.abortReason).toBeUndefined();
    expect(stats.skip.readErrors).toBe(1);
    expect(stats.filesIndexed).toBe(1);
    expect(store.stats().lastBuild).not.toBeNull();
    store.close();
  });

  test('a file reindexed during a build survives that build\'s sweep', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const firstEmbed = new Promise<void>((resolve) => { started = resolve; });
    let first = true;
    const { root, store } = setup(async () => {
      if (first) {
        first = false;
        started();
        await gate;
      }
    });
    writeFileSync(join(root, 'a.ts'), 'export const alphaMarker = 1;\n');
    await store.init();
    const build = store.buildFull();
    await firstEmbed;
    const lateFile = join(root, 'late.ts');
    writeFileSync(lateFile, 'export const lateMarker = 1;\n');
    expect((await store.reindexFile(lateFile)).indexed).toBe(true);
    release();
    await build;
    const hits = await store.search('lateMarker', { limit: 10 });
    expect(hits.some((hit) => hit.chunk.path === 'late.ts')).toBe(true);
    store.close();
  });

  test('closing during a build does not leave the store reading as building after reopen', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started: () => void = () => {};
    const firstEmbed = new Promise<void>((resolve) => { started = resolve; });
    const { root, store } = setup(async () => { started(); await gate; });
    writeFileSync(join(root, 'a.ts'), 'export const alphaMarker = 1;\n');
    await store.init();
    const build = store.buildFull();
    await firstEmbed;
    store.close();
    release();
    await build;
    await store.init();
    expect(store.isBuilding()).toBe(false);
    store.close();
  });
});
