import { snapshotNodeInput } from './activation/projection.js';
import type { KnowledgeIngestContext } from './ingest-context.js';
import { KnowledgeIngestStoppedError } from './ingest-stopped.js';
import { prepareKnowledgeSourceRecord } from './store-evidence-writes.js';
import type { KnowledgeSourceRecord, KnowledgeSourceUpsertInput } from './types.js';

/** Pending is a local draft until every required ingest reading has settled. */
export function stageKnowledgePendingSource(context: KnowledgeIngestContext,
  input: KnowledgeSourceUpsertInput & { readonly id: string }): KnowledgeSourceRecord {
  return snapshotNodeInput(prepareKnowledgeSourceRecord(input, context.store.getSource(input.id)));
}

/**
 * The one guard of an ingest: the stored source row, its extraction and the
 * owner of the canonical URI, compared by store generation (integers, no copy
 * of the rows). An abort is a cancellation; a moved row is a change.
 */
export function knowledgeIngestGuard(context: KnowledgeIngestContext, sourceId: string,
  canonicalUri?: string, signal?: AbortSignal): () => void {
  const store = context.store;
  const read = () => {
    const extractionId = store.getExtractionBySourceId(sourceId)?.id;
    const generations = store.getRecordGenerations(extractionId === undefined ? [{ kind: 'source', id: sourceId }]
      : [{ kind: 'source', id: sourceId }, { kind: 'extraction', id: extractionId }]);
    return `${extractionId ?? ''}|${generations.join('|')}|${canonicalUri ? store.getSourceByCanonicalUri(canonicalUri)?.id ?? '' : ''}`;
  };
  const expected = read();
  return () => {
    if (signal?.aborted) throw new KnowledgeIngestStoppedError('cancelled', undefined, { cause: signal.reason });
    if (read() !== expected) throw new KnowledgeIngestStoppedError('changed', `source ${sourceId} was written by another operation`);
  };
}
