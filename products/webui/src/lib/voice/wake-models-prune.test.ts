/** A new model version replaces the cached one rather than piling up beside it. */
import { describe, expect, test } from 'bun:test';
import {
  loadWakeModel,
  wakeModelCacheKey,
  webCryptoDigest,
  type WakeModelCache,
  type WakeModelComponent,
} from './wake-models';

function memoryCache(): WakeModelCache & { entries: Map<string, Uint8Array> } {
  const entries = new Map<string, Uint8Array>();
  return {
    entries,
    match: async (key) => {
      const hit = entries.get(key);
      return hit ? { arrayBuffer: async () => hit.slice().buffer as ArrayBuffer } : undefined;
    },
    put: async (key, bytes) => {
      entries.set(key, bytes.slice());
    },
    keys: async () => [...entries.keys()],
    delete: async (key) => {
      entries.delete(key);
    },
  };
}

async function load(component: WakeModelComponent, bytes: Uint8Array, version: string, cache: WakeModelCache) {
  const sha256 = await webCryptoDigest(bytes);
  return loadWakeModel(component, {
    cache,
    modelVersion: version,
    readChunk: async ({ offset }) => ({
      component,
      offset,
      bytes: bytes.length,
      totalBytes: bytes.length,
      sha256,
      dataBase64: Buffer.from(bytes).toString('base64'),
      complete: true,
    }),
  });
}

describe('wake model cache pruning', () => {
  test('a verified new version removes older entries of the same component only', async () => {
    const cache = memoryCache();
    const oldBytes = new Uint8Array([1, 2, 3]);
    const newBytes = new Uint8Array([4, 5, 6, 7]);
    const oldKey = wakeModelCacheKey('classifier', 'v1', await webCryptoDigest(oldBytes));
    const otherKey = wakeModelCacheKey('embedding', 'v1', 'beef');
    cache.entries.set(oldKey, oldBytes);
    cache.entries.set(otherKey, new Uint8Array([9]));

    await load('classifier', newBytes, 'v2', cache);

    const newKey = wakeModelCacheKey('classifier', 'v2', await webCryptoDigest(newBytes));
    expect([...cache.entries.keys()].sort()).toEqual([newKey, otherKey].sort());
  });

  test('a cache hit leaves other entries alone', async () => {
    const cache = memoryCache();
    const bytes = new Uint8Array([1, 2, 3]);
    await load('vad', bytes, 'v1', cache);
    const stale = wakeModelCacheKey('vad', 'v0', 'old');
    cache.entries.set(stale, new Uint8Array([0]));
    const again = await load('vad', bytes, 'v1', cache);
    expect(again.fromCache).toBe(true);
    expect(cache.entries.has(stale)).toBe(true);
  });
});
