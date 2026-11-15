import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import {
  MemoryEmbeddingProviderRegistry,
  type MemoryEmbeddingProvider,
} from '../platform/src/platform/state/memory-embeddings.ts';
import { createBuiltinMemoryEmbeddingProviders } from '../platform/src/platform/state/memory-embedding-http.ts';
import { SqliteVecMemoryIndex } from '../platform/src/platform/state/memory-vector-store.ts';
import type { MemoryRecord } from '../platform/src/platform/state/memory-store.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

/**
 * The embedding provider a person picks must be the one that embeds, and what
 * a provider returns must be what the index stores.
 */

function makeRegistry(): { registry: MemoryEmbeddingProviderRegistry; configManager: ConfigManager; root: string } {
  const root = makeProjectTempDir('memory-embedding-config');
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  return { registry: new MemoryEmbeddingProviderRegistry({ configManager }), configManager, root };
}

function syncProvider(id: string, onEmbed: () => void): MemoryEmbeddingProvider {
  return {
    id, label: id, dimensions: 384, deterministic: true,
    embedSync(request) {
      onEmbed();
      const vector = new Float32Array(request.dimensions);
      vector[id.length % request.dimensions] = 1;
      return { vector, dimensions: request.dimensions };
    },
  };
}

describe('the provider setting is read live', () => {
  test('changing provider.embeddingProvider changes the provider in use, without a restart', () => {
    const { registry, configManager } = makeRegistry();
    registry.register(syncProvider('custom-a', () => {}));
    expect(registry.getDefaultProviderId()).toBe('hashed-local');
    configManager.set('provider.embeddingProvider', 'custom-a');
    expect(registry.getDefaultProviderId()).toBe('custom-a');
    expect(registry.getDefaultProviderOrNull()?.id).toBe('custom-a');
  });

  test('a provider id that is not registered is named, never replaced by another provider', async () => {
    const { registry, configManager } = makeRegistry();
    configManager.set('provider.embeddingProvider', 'not-installed');
    expect(registry.getDefaultProviderOrNull()).toBeNull();
    expect(() => registry.getDefaultProvider()).toThrow(/not-installed/);
    expect((await registry.doctor()).warnings.join(' ')).toContain('not-installed');
  });
});

describe('the vector index follows a provider change', () => {
  function recordAt(revision: number): MemoryRecord {
    return { id: 'mem_a', scope: 'project', cls: 'fact', summary: 'deploy plan', tags: [], provenance: [], reviewState: 'fresh', confidence: 60, createdAt: revision, updatedAt: revision };
  }

  test('a record indexed by one provider is embedded again after the setting names another', async () => {
    const { registry, configManager, root } = makeRegistry();
    const embeds: string[] = [];
    registry.register(syncProvider('custom-a', () => embeds.push('a')));
    registry.register(syncProvider('custom-b', () => embeds.push('b')));
    configManager.set('provider.embeddingProvider', 'custom-a');
    const index = new SqliteVecMemoryIndex(join(root, 'memory.vec.sqlite'), undefined, registry);
    await index.init();
    expect(index.stats().available).toBe(true);
    const entry = { record: recordAt(1), revision: 'r1' };
    index.sync([entry]);
    index.sync([entry]);
    expect(embeds).toEqual(['a']);
    configManager.set('provider.embeddingProvider', 'custom-b');
    index.sync([entry]);
    expect(embeds).toEqual(['a', 'b']);
    index.close();
  });
});

describe('a refused write to the vector file', () => {
  test('is reported as a file problem, and the record keeps its previous vector', async () => {
    const { registry, root } = makeRegistry();
    registry.register(syncProvider('custom-a', () => {}), { makeDefault: true });
    const index = new SqliteVecMemoryIndex(join(root, 'memory.vec.sqlite'), undefined, registry);
    await index.init();
    const before: MemoryRecord = { id: 'mem_a', scope: 'project', cls: 'fact', summary: 'deploy plan', tags: [], provenance: [], reviewState: 'fresh', confidence: 60, createdAt: 1, updatedAt: 1 };
    index.upsert(before);
    expect(index.stats().indexedRecords).toBe(1);

    // Another process holding the file is a refused write; a read-only connection refuses the same way.
    (index as unknown as { db: { run(sql: string): void } }).db.run('PRAGMA query_only = ON');
    index.upsert({ ...before, summary: 'deploy plan, edited', updatedAt: 2 });

    const stats = index.stats();
    expect(stats.error).toContain('vector index file could not be written');
    expect(stats.error).not.toContain('custom-a');
    expect(stats.indexedRecords).toBe(1);
    expect((await index.search('deploy plan')).map((candidate) => candidate.id)).toEqual(['mem_a']);
    index.close();
  });
});

describe('a refused write with an async-only provider', () => {
  test('is reported as a file problem, not as the provider failing', async () => {
    const { registry, root } = makeRegistry();
    registry.register({
      id: 'async-only', label: 'async-only', dimensions: 384,
      embed: async (request) => {
        const vector = new Float32Array(request.dimensions);
        vector[0] = 1;
        return { vector, dimensions: request.dimensions };
      },
    }, { makeDefault: true });
    const index = new SqliteVecMemoryIndex(join(root, 'memory.vec.sqlite'), undefined, registry);
    await index.init();
    (index as unknown as { db: { run(sql: string): void } }).db.run('PRAGMA query_only = ON');
    await index.upsertAsync({ id: 'mem_a', scope: 'project', cls: 'fact', summary: 'deploy plan', tags: [], provenance: [], reviewState: 'fresh', confidence: 60, createdAt: 1, updatedAt: 1 });
    const stats = index.stats();
    expect(stats.error).toContain('vector index file could not be written');
    expect(stats.error).not.toContain('async-only');
    index.close();
  });
});

describe('built-in HTTP providers', () => {
  const requestOf = { text: 'note', dimensions: 384, usage: 'record' as const };
  const okFetch = (length: number) => async () => new Response(JSON.stringify({ embeddings: [Array.from({ length }, () => 0.5)], data: [{ embedding: Array.from({ length }, () => 0.5) }] }), { status: 200, headers: { 'content-type': 'application/json' } });

  test('chat-model variables do not choose the embedding model', async () => {
    const providers = createBuiltinMemoryEmbeddingProviders({ env: { OLLAMA_MODEL: 'llama3', MISTRAL_MODEL: 'mistral-large', GEMINI_MODEL: 'gemini-pro', MISTRAL_API_KEY: 'k', GEMINI_API_KEY: 'k' }, fetchImpl: okFetch(384) });
    for (const id of ['ollama', 'mistral', 'gemini']) {
      const status = await providers.find((p) => p.id === id)!.status!();
      expect(status.metadata.model).not.toMatch(/llama3|mistral-large|gemini-pro/);
    }
  });

  test('a host written without a scheme is reached over http', async () => {
    let url = '';
    const providers = createBuiltinMemoryEmbeddingProviders({ env: { OLLAMA_HOST: '127.0.0.1:11434' }, fetchImpl: async (input) => { url = String(input); return okFetch(384)(); } });
    await providers.find((p) => p.id === 'ollama')!.embed!(requestOf);
    expect(url).toBe('http://127.0.0.1:11434/api/embed');
  });

  test('a vector shorter than the stored width is refused, not padded with zeros', async () => {
    const providers = createBuiltinMemoryEmbeddingProviders({ env: { OPENAI_COMPATIBLE_BASE_URL: 'http://fixture.invalid/v1' }, fetchImpl: okFetch(128) });
    await expect(providers.find((p) => p.id === 'openai-compatible')!.embed!(requestOf)).rejects.toThrow(/128 dimensions/);
  });

  test('without a caller signal the request still has a deadline and never follows a redirect', async () => {
    let init: RequestInit | undefined;
    const providers = createBuiltinMemoryEmbeddingProviders({ env: { OLLAMA_BASE_URL: 'http://fixture.invalid' }, fetchImpl: async (_input, options) => { init = options; return okFetch(384)(); } });
    await providers.find((p) => p.id === 'ollama')!.embed!(requestOf);
    expect(init?.redirect).toBe('error');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('the doctor', () => {
  test('warns that a provider which ignores the requested size is cut to the stored width', async () => {
    const { registry, configManager } = makeRegistry();
    configManager.set('provider.embeddingProvider', 'ollama');
    const warnings = (await registry.doctor()).warnings.join(' ');
    expect(warnings).toContain('ignores the requested vector size');
  });
});
