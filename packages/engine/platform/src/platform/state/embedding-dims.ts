/**
 * The width of every stored embedding vector. One constant, in a module with
 * no imports, so the memory vector index and the code index (both
 * `float[N]` tables) and the embedding providers read the same number
 * without an import cycle. Changing it changes the shape of vectors already
 * on disk: bump MEMORY_VECTOR_SCHEMA_VERSION (memory-vector-store.ts) and the
 * code index schema version in the same change, so those caches are rebuilt.
 */
export const MEMORY_VECTOR_DIMS = 384;
