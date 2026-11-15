/** Offline live code-source fixture for real provider-loop regressions. */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../../platform/src/platform/state/code-index-store.js';
import { MemoryEmbeddingProviderRegistry } from '../../platform/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../../platform/src/platform/config/manager.js';
/** Real vector store and live file adapter, with only the provider and policy owner synthetic. */
export async function createCanonicalLiveCodeSource(nested = false) {
  const root = mkdtempSync(join(tmpdir(), 'canonical-live-code-'));
  const config = new ConfigManager({ configDir: join(root, '.goodvibes') });
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: config });
  // Asynchronous only, like every shipped HTTP embedding provider.
  const embedOne = () => { const vector = new Float32Array(384); vector[0] = 1; return { vector, dimensions: 384 }; };
  registry.register({ id: 'offline-code-provider', label: 'Offline code fixture', dimensions: 384, embed: async () => embedOne() }, { makeDefault: true });
  const directory = nested ? join(root, 'nested') : root;
  if (nested) mkdirSync(directory);
  const path = join(directory, 'backoff.ts'); writeFileSync(path, 'export async function backoff() { await sleep(base * 2 ** attempt); }\n');
  const store = new CodeIndexStore(root, ':memory:', registry);
  let allowed = true;
  try { await store.init(); await store.buildFull(); }
  catch (error) { store.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  return { store, path, directory, readAccessFilter: async () => allowed,
    deny: () => { allowed = false; }, mutate: () => writeFileSync(path, 'export const changed = true;\n'),
    dispose: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
