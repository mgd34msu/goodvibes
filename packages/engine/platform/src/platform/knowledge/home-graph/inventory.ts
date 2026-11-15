import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
} from '../types.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphSpaceInput } from './types.js';

/** One page of a list: how many exist, whether more follow, and the cursor for the next page. */
export interface HomeGraphListPage {
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor?: string | undefined;
}

/** A cursor is the offset of the next item; anything else starts at the beginning. */
function offsetOf(cursor: string | undefined): number {
  const offset = cursor !== undefined && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  return Number.isSafeInteger(offset) ? offset : 0;
}
function page<T>(items: readonly T[], offset: number, limit: number): { readonly items: readonly T[]; readonly page: HomeGraphListPage } {
  const slice = items.slice(offset, offset + limit);
  const next = offset + slice.length;
  return { items: slice, page: { total: items.length, truncated: next < items.length, ...(next < items.length ? { nextCursor: String(next) } : {}) } };
}

export async function listHomeGraphSources(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}): Promise<{ readonly ok: true; readonly spaceId: string; readonly sources: readonly KnowledgeSourceRecord[] } & HomeGraphListPage> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const listed = page(readHomeGraphState(input.store, spaceId).sources, offsetOf(input.cursor), Math.max(1, input.limit ?? 100));
  return { ok: true, spaceId, sources: listed.items, ...listed.page };
}

/**
 * One page of the Home Graph. Nodes, sources and issues are paged on their own
 * (each with a total and the cursor for its next page, `cursor` paging all
 * three together); edges are those between returned nodes and sources, so no
 * returned edge points at something left out.
 */
export async function browseHomeGraph(input: HomeGraphSpaceInput & {
  readonly store: KnowledgeStore;
  readonly limit?: number | undefined;
  readonly cursor?: string | undefined;
}): Promise<{
  readonly ok: true;
  readonly spaceId: string;
  readonly nodes: readonly KnowledgeNodeRecord[];
  readonly edges: readonly KnowledgeEdgeRecord[];
  readonly sources: readonly KnowledgeSourceRecord[];
  readonly issues: readonly KnowledgeIssueRecord[];
  readonly pages: { readonly nodes: HomeGraphListPage; readonly edges: HomeGraphListPage; readonly sources: HomeGraphListPage; readonly issues: HomeGraphListPage };
  readonly truncated: boolean;
}> {
  await input.store.init();
  const { spaceId } = resolveReadableHomeGraphSpace(input.store, input);
  const limit = Math.max(1, input.limit ?? 250);
  const offset = offsetOf(input.cursor);
  const state = readHomeGraphState(input.store, spaceId);
  const nodes = page(state.nodes, offset, limit), sources = page(state.sources, offset, limit), issues = page(state.issues, offset, limit);
  const shown = new Set([...nodes.items.map((node) => `node:${node.id}`), ...sources.items.map((source) => `source:${source.id}`)]);
  const connected = state.edges.filter((edge) => shown.has(`${edge.fromKind}:${edge.fromId}`) && shown.has(`${edge.toKind}:${edge.toId}`));
  const edges = connected.slice(0, limit);
  const edgePage: HomeGraphListPage = { total: connected.length, truncated: edges.length < connected.length };
  return {
    ok: true,
    spaceId,
    nodes: nodes.items,
    edges,
    sources: sources.items,
    issues: issues.items,
    pages: { nodes: nodes.page, edges: edgePage, sources: sources.page, issues: issues.page },
    truncated: nodes.page.truncated || sources.page.truncated || issues.page.truncated || edgePage.truncated,
  };
}
