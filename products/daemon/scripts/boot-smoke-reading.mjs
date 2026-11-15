import assert from 'node:assert/strict';

/**
 * Shared assertion body used by the compiled consumer and source HTTP test.
 * The daemon reports an addon that failed to load or index through its own
 * structured `vector.error` and `platformLimitReason`; those fields, plus a
 * finite vec0 distance for the added record, are the whole proof.
 */
export async function proveNativeMemoryRoundTrip(invoke) {
  const summary = 'boot-smoke sqlite-vec native addon semantic search';
  const added = await invoke('memory.records.add', { cls: 'fact', scope: 'session', summary });
  assert.equal(typeof added.record?.id, 'string');
  const vector = await invoke('memory.vector.stats');
  assert.equal(vector.vector?.backend, 'sqlite-vec'); assert.equal(vector.vector?.available, true);
  assert.equal(vector.vector?.enabled, true); assert(vector.vector.indexedRecords >= 1);
  assert.equal(vector.vector.error, undefined); assert.equal(vector.vector.platformLimitReason, undefined);
  const searched = await invoke('memory.records.search-semantic', { query: summary });
  assert(Array.isArray(searched.results));
  const found = searched.results.find(result => result.record?.id === added.record.id);
  assert(found, 'The added memory must be returned by semantic search');
  assert.equal(typeof found.distance, 'number'); assert(Number.isFinite(found.distance), 'Lexical fallback does not prove vec0 query execution');
  return { added, searched, vector };
}
