import type { KnowledgeStore } from '../store.js';
import type { PersistedKnowledgeRecordSelector } from '../../state/sqlite-store.js';

/** The rows an operation read, as the store names them. */
export interface HomeGraphRowsRead {
  readonly sources?: readonly string[];
  readonly nodes?: readonly string[];
  readonly extractions?: readonly string[];
  /** Edge windows by endpoint key (`source:<id>`, `node:<id>`): a link added or removed at any of them counts. */
  readonly edgeEndpoints?: readonly string[];
}

/**
 * Captures the store's row generations for exactly the rows an operation used
 * and returns the check: it compares those generations (a write anywhere else in
 * the space does not count) and throws `stale()` when one moved. One indexed
 * read per check, no serialization. Run it before the first model request and
 * at the write that commits; nowhere else.
 */
export function captureHomeGraphRows(store: KnowledgeStore, rows: HomeGraphRowsRead, stale: () => Error): () => void {
  const selectors: PersistedKnowledgeRecordSelector[] = [
    ...(rows.sources ?? []).map((id) => ({ kind: 'source' as const, id })),
    ...(rows.nodes ?? []).map((id) => ({ kind: 'node' as const, id })),
    ...(rows.extractions ?? []).map((id) => ({ kind: 'extraction' as const, id })),
  ];
  const endpoints = [...new Set(rows.edgeEndpoints ?? [])];
  const generations = selectors.length ? store.getRecordGenerations(selectors) : [];
  // Every edge with an end at one of the endpoints, wherever its other end is.
  const edgeWindow = () => store.getEdgeWindowGeneration(endpoints, endpoints, true);
  const window = endpoints.length ? edgeWindow() : undefined;
  return () => {
    if (selectors.length) {
      const now = store.getRecordGenerations(selectors);
      for (let index = 0; index < generations.length; index += 1) if (now[index] !== generations[index]) throw stale();
    }
    if (window !== undefined && edgeWindow() !== window) throw stale();
  };
}
