/** One activation pass's original native read set. Complete selected values are
 * checked once, and later native writer versions plus original data descriptors
 * retire stale model results without rehashing or recopying source bodies. */
import { isDeepStrictEqual } from 'node:util';
import { captureSQLiteActivationPublication, type SQLiteStore, type PersistedKnowledgeRecordSelector } from '../state/sqlite-store.js';
import { captureKnowledgePendingNode, type KnowledgeStore } from './store.js';
import type { KnowledgeNodeRecord } from './types.js';
import { KnowledgeNodeActivationHeldError as Held } from './activation/types.js';
import { observeKnowledgeValue } from './local-value-observation.js';
import { knowledgeRowGenerationFromRows } from './store-row-revisions.js';

interface OriginalRow { readonly selector: PersistedKnowledgeRecordSelector; generation: string | null; current: (() => boolean) | undefined;
  write?: { readonly generation: string; readonly state: () => 'pending' | 'published' } | undefined; }
export class KnowledgeActivationReadset {
  private readonly rows = new Map<string, OriginalRow>();
  private readonly sourceIds = new Set<string>();
  private readonly targetIds = new Set<string>();
  private readonly extractions = new Map<string, string | null>();
  private anchor: string | undefined;
  private sealed = false;
  constructor(private readonly store: KnowledgeStore) {}
  private key(kind: string, id: string): string { return JSON.stringify([kind, id]); }
  private read(kind: PersistedKnowledgeRecordSelector['kind'], id: string): unknown {
    return kind === 'source' ? this.store.getSource(id) : kind === 'node' ? this.store.getNode(id) : this.store.getExtraction(id);
  }
  private captureRow(kind: PersistedKnowledgeRecordSelector['kind'], id: string): void {
    const key = this.key(kind, id), previous = this.rows.get(key);
    if (previous) { if (!previous.current?.()) throw new Held('stale'); return; }
    const snapshot = kind === 'source' ? (() => { const source = this.store.getSourceSnapshot({ id }); return { record: source.source, generation: source.generation }; })()
      : this.store.getRecordSnapshot(kind, id);
    const current = this.read(kind, id);
    const original = observeKnowledgeValue(current);
    // The right side is decoded by the native SQL mapper, not caller JSON.
    const same = isDeepStrictEqual(original.snapshot, snapshot.record);
    const pending = !same && kind === 'node' && current !== null
      ? captureKnowledgePendingNode(this.store, current as KnowledgeNodeRecord) : undefined;
    if (!same && !pending) throw new Held('stale');
    this.rows.set(key, { selector: { kind, id }, generation: snapshot.generation,
      current: () => original.matches(this.read(kind, id)), ...(pending ? { write: pending } : {}) });
  }
  /** Called in the original single synchronous read frame, before model I/O. */
  capture(nodeId: string, sourceIds: readonly string[], subjectIds: readonly string[], observation: string | null): ReturnType<KnowledgeStore['getNodeActivationState']> {
    if (this.sealed) throw new Held('stale');
    this.anchor ??= nodeId; this.targetIds.add(nodeId); this.captureRow('node', nodeId);
    const state = this.store.getNodeActivationState(nodeId, [...sourceIds.map(id => ({ kind: 'source' as const, id })),
      ...subjectIds.map(id => ({ kind: 'node' as const, id }))], observation);
    for (const source of state.dependencies.evidence) {
      this.sourceIds.add(source.sourceId); this.captureRow('source', source.sourceId);
      if (this.extractions.has(source.sourceId) && this.extractions.get(source.sourceId) !== source.extractionId) throw new Held('stale');
      this.extractions.set(source.sourceId, source.extractionId);
      const current = this.store.getExtractionBySourceId(source.sourceId);
      if ((current?.id ?? null) !== source.extractionId) throw new Held('stale');
      if (source.extractionId !== null) this.captureRow('extraction', source.extractionId);
    }
    for (const id of subjectIds) this.captureRow('node', id);
    return state;
  }
  /** Initial complete-value witnesses serve only synchronous input capture;
   * model I/O keeps compact actual writer versions, never duplicate bodies. */
  seal(): void { this.sealed = true; for (const row of this.rows.values()) row.current = undefined; }
  assertCurrent(): void {
    const anchor = this.anchor;
    if (anchor === undefined) return;
    this.store.assertRecordSnapshotFrame(() => {
      const entries = [...this.rows.values()];
      const actual = this.store.getRecordGenerations(entries.map(row => row.selector));
      for (const [index, row] of entries.entries()) {
        const write = row.write;
        if (!write || write.state() === 'pending') {
          if (row.generation !== actual[index]) throw new Held('stale');
        } else {
          if (write.generation !== actual[index]) throw new Held('stale');
          row.generation = write.generation;
        }
      }
      const state = this.store.getNodeActivationState(anchor, [...this.sourceIds].map(id => ({ kind: 'source' as const, id })), null);
      for (const source of state.dependencies.evidence) if (source.extractionId !== this.extractions.get(source.sourceId)) throw new Held('stale');
      // A future per-row cache written during I/O is preserved, not replaced by
      // the result of an earlier interpretation using our older receipt shape.
      for (const id of this.targetIds) this.store.getNodeActivationCache(id);
      return undefined;
    });
  }
  /** Only the actual original native row writer advances its own node. Source
   * and extraction baselines never adopt unrelated changes during a pass. */
  prepareWritten(nodeId: string, record: KnowledgeNodeRecord, sqlite: SQLiteStore): () => void {
    const row = this.rows.get(this.key('node', nodeId));
    if (!row || !Object.isFrozen(record)) throw new Held('stale');
    const native = sqlite.exec('SELECT gv_revision FROM knowledge_nodes WHERE id = ? LIMIT 1', [nodeId]);
    const generation = knowledgeRowGenerationFromRows(native);
    if (generation === null) throw new Held('stale');
    const write = generation !== row.generation ? { generation, state: captureSQLiteActivationPublication(sqlite, nodeId, generation) } : undefined;
    // Native selection may fail. Its acknowledgment is published only after
    // the enclosing SQL savepoint succeeds, never while it can still roll back.
    return () => { if (write) row.write = write; };
  }
}
