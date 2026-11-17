import { KnowledgeRecordAdmissionHeldError } from '../store-record-snapshot.js';
import { projectSemanticPrimaryClaim } from './primary-claim-projection.js';
import { assertJudgmentInput, JudgmentInputError } from '../../gate/judgment-input.js';
import type { PersistedKnowledgeRecordSelector } from '../../state/sqlite-store.js';
import { sourceRankingContent } from './answer-source-ranking.js';
import { getKnowledgeSpaceId } from '../spaces.js';
import { createKnowledgePageSourceReader, KnowledgeSourceQualityHeldError } from '../source-quality.js';
import type { KnowledgeStore } from '../store.js';
import type { KnowledgeExtractionRecord, KnowledgeNodeRecord, KnowledgeSourceRecord } from '../types.js';

/** A cooperative lifecycle stop never authorizes a fallback or late write. */
export function assertSemanticWriteAllowed(signal?: AbortSignal, shouldStop?: () => boolean): void {
  if (signal?.aborted || shouldStop?.()) throw new KnowledgeSourceQualityHeldError('aborted');
}

/**
 * The rows one persistence pass read, checked before its write. A source, node
 * or extraction row is held by its store generation, so a check is one indexed
 * read of the generations of exactly those rows; an edge window by its window
 * generation. `watch` keeps a value comparison for small values the caller
 * owns (a flag, an id list); never hand it a whole collection.
 */
export function createSemanticWriteGuard(store: KnowledgeStore, signal?: AbortSignal, shouldStop?: () => boolean) {
  const values = new Map<string, () => void>();
  const rows = new Map<string, { readonly selector: PersistedKnowledgeRecordSelector; readonly generation: string | null }>();
  const edgeWindows = new Map<string, { readonly endpoints: readonly string[]; readonly generation: string }>();
  const stale = () => new KnowledgeSourceQualityHeldError('stale');
  function watch<T>(key: string, read: () => T, expected: T = read()): T {
    const version = JSON.stringify(expected);
    const check = () => {
      if (JSON.stringify(read()) !== version) throw stale();
    };
    // A second observation may not silently replace the original version.
    values.get(key)?.();
    if (!values.has(key)) values.set(key, check);
    check();
    return expected;
  }
  /** Hold one row by generation. A caller's copy must equal the stored row once, here. */
  function row<T extends KnowledgeSourceRecord | KnowledgeNodeRecord | KnowledgeExtractionRecord | null>(
    key: string, selector: PersistedKnowledgeRecordSelector, read: () => T, expected: T | undefined,
  ): T {
    const current = read();
    if (expected !== undefined && JSON.stringify(expected) !== JSON.stringify(current)) throw stale();
    const generation = store.getRecordGenerations([selector])[0] ?? null;
    const held = rows.get(key);
    if (held && held.generation !== generation) throw stale();
    if (!held) rows.set(key, { selector, generation });
    return expected ?? current;
  }
  function extraction(sourceId: string, expected?: KnowledgeExtractionRecord | null): KnowledgeExtractionRecord | null {
    const current = store.getExtractionBySourceId(sourceId);
    if (!current) {
      // Absence is held as absence: a later extraction for the source is a change.
      watch(`extraction-absent:${sourceId}`, () => store.getExtractionBySourceId(sourceId) === null, true);
      if (expected) throw stale();
      return null;
    }
    return row(`extraction:${sourceId}`, { kind: 'extraction', id: current.id }, () => store.getExtractionBySourceId(sourceId), expected);
  }
  /** Every edge with an end at one of `endpoints` (`source:<id>`, `node:<id>`), by one window generation. */
  function edges(key: string, endpoints: readonly string[]): void {
    const unique = [...new Set(endpoints)];
    if (unique.length === 0) return;
    const generation = store.getEdgeWindowGeneration(unique, unique, true);
    const held = edgeWindows.get(key);
    if (held && held.generation !== generation) throw stale();
    if (!held) edgeWindows.set(key, { endpoints: unique, generation });
  }
  return {
    watch,
    edges,
    source(id: string, expected?: KnowledgeSourceRecord | null) { return row(`source:${id}`, { kind: 'source', id }, () => store.getSource(id), expected); },
    node(id: string, expected?: KnowledgeNodeRecord | null) { return row(`node:${id}`, { kind: 'node', id }, () => store.getNode(id), expected); },
    extraction,
    assertCurrent() {
      try { store.assertRecordSnapshotFrame(() => {
        assertSemanticWriteAllowed(signal, shouldStop);
        const held = [...rows.values()];
        if (held.length) {
          const now = store.getRecordGenerations(held.map((entry) => entry.selector));
          for (let index = 0; index < held.length; index += 1) if (now[index] !== held[index]!.generation) throw stale();
        }
        for (const window of edgeWindows.values()) {
          if (store.getEdgeWindowGeneration(window.endpoints, window.endpoints, true) !== window.generation) throw stale();
        }
        for (const check of values.values()) check();
      }); } catch (error) {
        if (error instanceof KnowledgeRecordAdmissionHeldError) throw stale();
        throw error;
      }
    },
  };
}
export type SemanticWriteGuard = ReturnType<typeof createSemanticWriteGuard>;
export interface SemanticPrimaryClaim {
  readonly kind: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly value?: unknown;
  readonly evidence?: unknown;
  readonly targetHints?: unknown;
  readonly subject?: unknown;
  readonly subjects: readonly Pick<KnowledgeNodeRecord, 'id' | 'title' | 'kind'>[];
}

/** Claim-specific, bounded decisions. No winner is shared between different claims. */
export function createSemanticPrimarySourcePlanner(store: KnowledgeStore, guard: SemanticWriteGuard, signal?: AbortSignal) {
  const decisions = new Map<string, Promise<string>>();
  let requests = 0;
  function prepare(spaceId: string, claim: SemanticPrimaryClaim, sourceIds: readonly string[]): () => Promise<string> {
    const projectedClaim = projectSemanticPrimaryClaim(claim);
    const candidates = [...new Set(sourceIds)].map((id) => guard.source(id))
      .filter((source): source is KnowledgeSourceRecord => Boolean(source
        && getKnowledgeSpaceId(source) === spaceId
        && (source.status === 'indexed' || source.status === 'pending')))
      .sort((a, b) => a.id.localeCompare(b.id));
    // All supplied IDs were snapshotted before filtering, including missing records.
    // Refuse oversized sets rather than choosing a winner from a hidden truncation.
    if (candidates.length > 50) throw new JudgmentInputError('unsupported-input');
    const purpose = `Choose a useful, credible primary reference supporting this exact claim and subject: ${JSON.stringify(projectedClaim)}`;
    // All prepares run before any resolver. Refuse a protected later claim or
    // support set before an earlier request can leave this persistence pass.
    if (candidates.length > 1) assertJudgmentInput(candidates.map((source) => ({
      purpose, candidate: sourceRankingContent(source), effectiveStatus: source.status,
    })));
    const key = JSON.stringify({ spaceId, claim: projectedClaim, sources: candidates });
    return async () => {
      guard.assertCurrent();
      if (candidates.length === 0) throw new KnowledgeSourceQualityHeldError('no-match');
      // One known in-space source is provenance bookkeeping, not a preference.
      if (candidates.length === 1) return candidates[0]!.id;
      let decision = decisions.get(key);
      if (!decision) {
        if (decisions.size >= 400 || requests + candidates.length > 4_000) {
          throw new JudgmentInputError('unsupported-input');
        }
        requests += candidates.length;
        const reader = createKnowledgePageSourceReader({ purpose, signal });
        decision = reader.rank(candidates).then((ranked) => {
          reader.assertCurrent((id) => store.getSource(id));
          if (!ranked[0]) throw new KnowledgeSourceQualityHeldError('no-match');
          return ranked[0].source.id;
        });
        decisions.set(key, decision);
      }
      return decision;
    };
  }
  return { prepare };
}
export type SemanticPrimarySourcePlanner = ReturnType<typeof createSemanticPrimarySourcePlanner>;
