/**
 * Receipt-authorized snapshots only: no filesystem discovery, reads, or lexical fallback.
 *
 * The guard is asked where text leaves the machine or a result is published:
 * once per file, immediately before the request that sends its chunks (and
 * again before any retry of that request), and once for the whole generation
 * at the end of prepare and of each search. Chunking, row writes and reads of
 * this per-run in-memory database have no other writer and send nothing, so
 * they are not guarded; the run's signal and the store lifecycle are plain
 * reads checked at each step.
 */
import type { Database, SQLQueryBindings } from 'bun:sqlite';
import { chunkFileContent, type ChunkingIntelligence } from './code-index-chunking.js';
import { countIndexedChunks, countIndexedFiles, getChunkByRowId, writeChunk, type VectorRow } from './code-index-db.js';
import {
  HASHED_MEMORY_EMBEDDING_PROVIDER, batchEmbedderOf, type MemoryEmbeddingProvider,
  type MemoryEmbeddingProviderRegistry, type MemoryEmbeddingRequest,
} from './memory-embeddings.js';
import { MEMORY_VECTOR_DIMS } from './memory-vector-store.js';
import type { CodeContextResult, CodeIndexStats } from './code-index-types.js';

export type AuthorizedIndexBoundary = 'chunk' | 'cache' | 'embedding' | 'result';
export interface AuthorizedCodeSnapshot {
  readonly path: string;
  readonly content: string;
  readonly mtimeMs: number;
}
export interface AuthorizedCodePrepareInput {
  readonly snapshots: readonly AuthorizedCodeSnapshot[];
  /** Native per-run source owner label, not a content digest or permission. */
  readonly sourceRevision?: string;
  /** Exact object obtained from this store's registry, not an equivalent provider ID. */
  readonly provider: MemoryEmbeddingProvider;
  readonly signal: AbortSignal;
  /**
   * Must throw if receipt, scope, provider, or run is no longer authorized.
   * path identifies the current snapshot only; undefined requires the whole generation.
   * Every check still validates global receipt/root/generation metadata.
   */
  readonly guard: (boundary: AuthorizedIndexBoundary, path?: string) => Promise<void>;
  /** Chunks sent per embedding request when the provider takes a list. Default 64. */
  readonly batchSize?: number;
  readonly maxChunks?: number;
  /** Load one authorized file at a time, avoiding a second copy of the entire tree. */
  readonly loadSnapshot?: (snapshot: AuthorizedCodeSnapshot) => Promise<AuthorizedCodeSnapshot>;
}

export interface AuthorizedCodeIndex {
  search(query: string, options?: { limit?: number }): Promise<CodeContextResult[]>;
  stats(): Promise<CodeIndexStats>;
}

/** Internal implementation; the public entry is the one-shot CodeIndexStore method. */
let sourceSequence = 0;
export async function prepareAuthorizedCodeSnapshots(
  input: AuthorizedCodePrepareInput,
  registry: MemoryEmbeddingProviderRegistry,
  db: Database,
  intelligence: ChunkingIntelligence,
  checkLifecycle: () => void,
): Promise<AuthorizedCodeIndex> {
  const { provider, signal, guard, loadSnapshot } = input;
  if (!Number.isSafeInteger(++sourceSequence)) throw new Error('Authorized code source identity exhausted');
  const sourceRevision = input.sourceRevision ?? `authorized-code-${sourceSequence}`;
  if (!sourceRevision || sourceRevision.length > 256) throw new Error('Authorized code source identity is invalid');
  const embed = provider.embed;
  const embedSync = provider.embedSync;
  const embedMany = batchEmbedderOf(provider);
  /** No I/O: the run is live, the store is the one prepared, and the provider is the pinned one. */
  const checkLocal = (): void => {
    signal.throwIfAborted();
    checkLifecycle();
    if (registry.getDefaultProviderOrNull() !== provider || registry.get(provider.id) !== provider
      || provider.capturedInputAdmission !== 'per-attempt'
      || provider.id === HASHED_MEMORY_EMBEDDING_PROVIDER.id
      || provider.dimensions !== MEMORY_VECTOR_DIMS || (!embed && !embedSync)
      || provider.embed !== embed || provider.embedSync !== embedSync || batchEmbedderOf(provider) !== embedMany) {
      throw new Error('Authorized code index requires the unchanged registered semantic provider');
    }
  };
  const check = async (boundary: AuthorizedIndexBoundary, path?: string): Promise<void> => {
    checkLocal();
    await guard(boundary, path);
    checkLocal();
  };
  const maxChunks = input.maxChunks ?? Infinity;
  if (input.maxChunks !== undefined && (!Number.isSafeInteger(maxChunks) || maxChunks < 1)) {
    throw new Error('Authorized code index bounds are invalid');
  }
  const batchSize = input.batchSize ?? 64;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Authorized code index bounds are invalid');
  // Copy caller-owned containers before the first await. Never retain mutable input views.
  const snapshots = input.snapshots.map(({ path, content, mtimeMs }) => ({ path, content, mtimeMs }));
  const paths = new Set<string>();
  for (const snapshot of snapshots) {
    if (!snapshot.path || snapshot.path.startsWith('/') || snapshot.path.includes('\\')
      || snapshot.path.split('/').some((part) => !part || part === '.' || part === '..')
      || /^[a-z]:/i.test(snapshot.path) || snapshot.path.includes('\0')
      || paths.has(snapshot.path) || !Number.isFinite(snapshot.mtimeMs)) {
      throw new Error('Authorized code snapshot path or metadata is invalid');
    }
    paths.add(snapshot.path);
  }
  checkLocal();
  if (countIndexedChunks(db) !== 0) throw new Error('Authorized code index requires an empty per-run database');
  const toVector = (vector: Float32Array | readonly number[], dimensions: number): Float32Array => {
    if (dimensions !== MEMORY_VECTOR_DIMS || vector.length !== MEMORY_VECTOR_DIMS
      || Array.from(vector).some((value) => !Number.isFinite(value))) {
      throw new Error('Authorized code index received an unsupported embedding vector');
    }
    return new Float32Array(vector);
  };
  /**
   * Embed one file's texts (or the query). The guard runs once before the
   * provider is called, so a revoked run sends nothing; the provider's
   * per-attempt hook then guards every later attempt (a retry, or the next
   * request of the same file), and skips only the first, which that guard
   * just covered with no await in between.
   */
  const embedTexts = async (texts: readonly string[], usage: MemoryEmbeddingRequest['usage'], path?: string): Promise<Float32Array[]> => {
    await check('embedding', path);
    let covered = true;
    const beforeAttempt = (): Promise<void> | void => {
      if (covered) { covered = false; checkLocal(); return; }
      return check('embedding', path);
    };
    if (embedMany) {
      const vectors: Float32Array[] = [];
      for (let start = 0; start < texts.length; start += batchSize) {
        const batch = texts.slice(start, start + batchSize);
        const results = await awaitAbortable(() => embedMany.call(provider, { texts: batch, dimensions: MEMORY_VECTOR_DIMS, usage, signal, beforeAttempt }), signal);
        checkLocal();
        if (results.length !== batch.length) throw new Error('Authorized code index received an unsupported embedding vector');
        for (const result of results) vectors.push(toVector(result.vector, result.dimensions));
      }
      return vectors;
    }
    const vectors: Float32Array[] = [];
    for (const text of texts) {
      const request: MemoryEmbeddingRequest = { text, dimensions: MEMORY_VECTOR_DIMS, usage, signal, beforeAttempt };
      let result;
      if (embed) result = await awaitAbortable(() => embed.call(provider, request), signal);
      else { await beforeAttempt(); result = embedSync!.call(provider, request); }
      checkLocal();
      vectors.push(toVector(result.vector, result.dimensions));
    }
    return vectors;
  };
  let chunkCount = 0;
  for (const descriptor of snapshots) {
    const snapshot = loadSnapshot ? await loadSnapshot(descriptor) : descriptor;
    if (snapshot.path !== descriptor.path || snapshot.mtimeMs !== descriptor.mtimeMs) throw new Error('Authorized code snapshot identity changed');
    checkLocal();
    const { drafts } = await chunkFileContent({
      intelligence, absPath: snapshot.path, relPath: snapshot.path,
      // The receipt owner guards exact source bytes; this per-run database is
      // new and never needs a content commitment for cross-run cache lookup.
      content: snapshot.content, fileRevision: sourceRevision, mtimeMs: snapshot.mtimeMs,
    });
    checkLocal();
    if (chunkCount + drafts.length > maxChunks) {
      throw new Error('Authorized code index chunk budget exceeded');
    }
    chunkCount += drafts.length;
    if (drafts.length === 0) continue;
    const vectors = await embedTexts(drafts.map((draft) => draft.embedText), 'record', snapshot.path);
    db.transaction(() => { drafts.forEach((draft, i) => writeChunk(db, draft.chunk, vectors[i]!)); })();
  }
  await check('result');
  return {
    async stats() {
      checkLocal();
      return { backend: 'sqlite-vec', enabled: true, available: true, path: ':memory:',
        dimensions: MEMORY_VECTOR_DIMS, indexedFiles: countIndexedFiles(db), indexedChunks: countIndexedChunks(db),
        embeddingProviderId: provider.id, embeddingProviderLabel: provider.label, semanticRetrievalAvailable: true,
        building: false, lastBuild: null };
    },
    async search(query, options = {}) {
      const limit = options.limit ?? 5;
      if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Authorized code query exceeds bounds');
      }
      checkLocal();
      if (!query.trim() || !chunkCount) return [];
      const [vector] = await embedTexts([query.trim()], 'query');
      const rows = db.query<VectorRow, SQLQueryBindings[]>(
        'SELECT rowid, distance FROM code_vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance',
      ).all(vector!, limit);
      const results: CodeContextResult[] = [];
      for (const row of rows) {
        const chunk = getChunkByRowId(db, Number(row.rowid));
        if (!chunk) continue;
        const distance = Number(row.distance);
        results.push({ chunk, distance, similarity: Math.max(0, Math.min(1, 1 - distance / 2)), label: 'semantic' });
      }
      await check('result');
      return results;
    },
  };
}

/** A non-cooperating custom provider may finish late, but cannot keep this run pending or publish its result. */
function awaitAbortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason ?? new Error('Authorized code embedding aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    try {
      signal.throwIfAborted();
      operation().then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    } catch (error) {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    }
  });
}
