import { captureJudgmentPort, JudgmentPortMissingError, type JudgmentPortCapture } from '@goodvibes-jev/engine/errors';
import type { KnowledgeSourceRecord } from '../types.js';
import { KnowledgeFactReadSetStaleError } from '../semantic/fact-quality.js';
import type { KnowledgeStore } from '../store.js';
import { KnowledgeRepairFactUsefulnessHeldError as Held } from '../semantic/repair-usefulness/types.js';
import { captureHomeGraphRows } from './rows-current.js';

/**
 * Currentness for an ask's page refresh, scoped to the rows it uses: the
 * selected devices and the sources the answer named. Each check compares their
 * store generations (one indexed read); a write elsewhere in the space does not
 * make the refresh stale. One fresh reading after real fact churn, never a
 * replacement authorization.
 */
export function createAskPageRecovery(store: KnowledgeStore, spaceId: string, rows: { readonly nodes: readonly string[]; readonly sources: readonly string[] },
  assertRequest: () => void, signal?: AbortSignal) {
  let owner: JudgmentPortCapture | undefined;
  try { owner = captureJudgmentPort('engine.knowledge.page-fact-quality', { signal }); }
  catch (error) { if (!(error instanceof JudgmentPortMissingError)) throw error; }
  const sourceIds = new Set(rows.sources);
  const capture = () => captureHomeGraphRows(store, { nodes: rows.nodes, sources: [...sourceIds],
    extractions: [...sourceIds].flatMap((id) => { const extraction = store.getExtractionBySourceId(id); return extraction ? [extraction.id] : []; }) },
  () => new Held('stale'));
  let rowsCurrent = capture();
  const current = () => {
    if (signal?.aborted) throw new Held('aborted');
    assertRequest();
    try { owner?.assertCurrent(); } catch { throw new Held('stale'); }
    rowsCurrent();
  };
  const factIds = () => store.listNodesInSpace(spaceId).filter((node) => node.kind === 'fact' || node.metadata.semanticKind === 'fact').map((node) => node.id);
  return {
    assertCurrent: current,
    /** This refresh wrote the source: take its new generation as the baseline. */
    acknowledgeSourceWritten(source: KnowledgeSourceRecord) {
      if (store.getSource(source.id) !== source) throw new Held('stale');
      sourceIds.add(source.id);
      rowsCurrent = capture();
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      current();
      const ids = factIds();
      const factGenerations = ids.length ? store.getRecordGenerations(ids.map((id) => ({ kind: 'node' as const, id }))) : [];
      const factKeys = ids.map((id) => `node:${id}`);
      const factEdges = ids.length ? store.getEdgeWindowGeneration(factKeys, factKeys, true) : undefined;
      try { const value = await operation(); current(); return value; }
      catch (error) {
        if (!(error instanceof KnowledgeFactReadSetStaleError) || !owner) throw error;
        current();
        const index = ids.indexOf(error.factId);
        const factChanged = index < 0 || store.getRecordGeneration('node', error.factId) !== factGenerations[index];
        const edgesChanged = factEdges !== undefined && store.getEdgeWindowGeneration(factKeys, factKeys, true) !== factEdges;
        if (!factChanged && !edgesChanged) throw error;
        // The second operation owns an entirely new data read-set and judgments.
        // Its failure escapes; it cannot become an unbounded retry loop.
        const value = await operation(); current(); return value;
      }
    },
  };
}
