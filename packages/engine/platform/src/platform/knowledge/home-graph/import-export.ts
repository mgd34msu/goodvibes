import { activationSourceIds, activationSubjectIds, projectNodeActivation, snapshotNodeInput } from '../activation/projection.js';
import type { KnowledgeNodeActivationOptions } from '../activation/types.js';
import type { KnowledgeStore } from '../store.js';
import { buildHomeGraphMetadata } from './helpers.js';
import { readHomeGraphState } from './state.js';
import type { HomeGraphExport } from './types.js';
import { assertKnowledgeImportRecordSizes } from '../store-import.js';

/** Records per import publication. */
const IMPORT_BATCH_SIZE = 200;

function* batches<T>(records: readonly T[]): Generator<T[]> {
  for (let start = 0; start < records.length; start += IMPORT_BATCH_SIZE) yield records.slice(start, start + IMPORT_BATCH_SIZE);
}

export type HomeGraphImportCounts = { sources: number; nodes: number; edges: number; issues: number; extractions: number };
export type HomeGraphImportBatchKind = 'sources' | 'extractions' | 'nodes' | 'edges' | 'issues';

/**
 * An import that stopped after some of its batches were written. Each batch is
 * its own publication, so what came before the failed batch stays written; this
 * says what was written, which batch failed and why, and what to do next.
 */
export class HomeGraphImportIncompleteError extends Error {
  override readonly name = 'HomeGraphImportIncompleteError';
  readonly code = 'HOME_GRAPH_IMPORT_INCOMPLETE';
  readonly state = 'partly-imported';
  readonly next: readonly string[];
  /** 500 when the store failed (a full disk, a lost file); otherwise the route's own status. */
  readonly status?: number;
  constructor(
    readonly spaceId: string,
    readonly written: Readonly<HomeGraphImportCounts>,
    readonly total: Readonly<HomeGraphImportCounts>,
    readonly failedBatch: { readonly kind: HomeGraphImportBatchKind; readonly index: number; readonly of: number; readonly records: number },
    override readonly cause: unknown,
  ) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const counts = (value: Readonly<HomeGraphImportCounts>) => `${value.sources} sources, ${value.extractions} extractions, ${value.nodes} nodes, ${value.edges} edges, ${value.issues} issues`;
    super(`Home Graph import stopped at ${failedBatch.kind} batch ${failedBatch.index} of ${failedBatch.of} (${failedBatch.records} records): ${reason} `
      + `Written before it: ${counts(written)}, of ${counts(total)}.`);
    this.next = ['Run the same import again once the cause is fixed: records are written by id, so the ones already written are replaced, not duplicated.'];
    const code = cause !== null && typeof cause === 'object' ? (cause as { readonly code?: unknown }).code : undefined;
    if (typeof code === 'string' && /^E[A-Z0-9]+$/.test(code)) this.status = 500;
  }
}

export function exportHomeGraphSpace(
  store: KnowledgeStore,
  input: { readonly spaceId: string; readonly installationId: string },
): HomeGraphExport {
  const state = readHomeGraphState(store, input.spaceId);
  return {
    version: 1,
    exportedAt: Date.now(),
    spaceId: input.spaceId,
    installationId: input.installationId,
    sources: state.sources,
    nodes: state.nodes,
    edges: state.edges,
    issues: state.issues,
    extractions: state.extractions,
  };
}

export async function importHomeGraphSpace(
  store: KnowledgeStore,
  input: { readonly spaceId: string; readonly installationId: string; readonly data: HomeGraphExport },
  options: KnowledgeNodeActivationOptions = {},
): Promise<{
  readonly ok: true;
  readonly spaceId: string;
  readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
}> {
  input = snapshotNodeInput(input);
  const sourceInputs = (input.data.sources ?? []).map((source) => ({ ...source, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, source.metadata) }));
  const extractionInputs = (input.data.extractions ?? []).map((extraction) => ({ ...extraction, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, extraction.metadata) }));
  const nodeInputs = (input.data.nodes ?? []).map((node) => ({ ...node, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, node.metadata) }));
  await store.init();
  const sourceById = new Map(sourceInputs.map((source) => [source.id, source]));
  const extractionBySourceId = new Map(extractionInputs.map((extraction) => [extraction.sourceId, extraction]));
  const nodesById = new Map(nodeInputs.map((node) => [node.id, node]));
  // Preflight the complete selected import before its first source, extraction or node write.
  // Imported records are untrusted data; no observation or operator capability is minted.
  for (const node of nodeInputs) {
    projectNodeActivation(node, activationSourceIds(node).map((id) => ({ id,
      source: sourceById.get(id) ?? store.getSource(id), extraction: extractionBySourceId.get(id) ?? store.getExtractionBySourceId(id) })),
    activationSubjectIds(node).map((id) => ({ id, node: nodesById.get(id) ?? store.getNode(id) })));
    await store.assertNodeMutation(node);
  }
  const edgeInputs = (input.data.edges ?? []).map((edge) => ({ ...edge, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, edge.metadata) }));
  const issueInputs = (input.data.issues ?? []).map((issue) => ({ ...issue, metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, issue.metadata) }));
  const empty = { sources: [], extractions: [], nodes: [], edges: [], issues: [] };
  // Every record is checked before the first batch is written.
  assertKnowledgeImportRecordSizes({ sources: sourceInputs, extractions: extractionInputs, nodes: nodeInputs, edges: edgeInputs, issues: issueInputs });
  // A home of any size imports in bounded batches, each one publication: sources with
  // their extractions first, then nodes, then the edges and issues that refer to them.
  // A batch that fails stops the import with what the earlier batches wrote.
  const total: HomeGraphImportCounts = { sources: sourceInputs.length, nodes: nodeInputs.length, edges: edgeInputs.length,
    issues: issueInputs.length, extractions: extractionInputs.length };
  const written: HomeGraphImportCounts = { sources: 0, nodes: 0, edges: 0, issues: 0, extractions: 0 };
  const write = async <T>(kind: HomeGraphImportBatchKind, records: readonly T[], apply: (batch: T[]) => Promise<HomeGraphImportCounts>): Promise<void> => {
    const of = Math.ceil(records.length / IMPORT_BATCH_SIZE);
    let index = 0;
    for (const batch of batches(records)) {
      index += 1;
      let added: HomeGraphImportCounts;
      try { added = await apply(batch); } catch (error) {
        throw new HomeGraphImportIncompleteError(input.spaceId, { ...written }, total, { kind, index, of, records: batch.length }, error);
      }
      for (const key of Object.keys(written) as (keyof HomeGraphImportCounts)[]) written[key] += added[key];
    }
  };
  const none: HomeGraphImportCounts = { sources: 0, nodes: 0, edges: 0, issues: 0, extractions: 0 };
  await write('sources', sourceInputs, async (sources) => {
    const ids = new Set(sources.map((source) => source.id));
    const extractions = extractionInputs.filter((extraction) => ids.has(extraction.sourceId));
    await store.applyImport({ ...empty, sources, extractions }, options);
    return { ...none, sources: sources.length, extractions: extractions.length };
  });
  const importedSourceIds = new Set(sourceInputs.map((source) => source.id));
  const orphanExtractions = extractionInputs.filter((extraction) => !importedSourceIds.has(extraction.sourceId));
  await write('extractions', orphanExtractions, async (extractions) => { await store.applyImport({ ...empty, extractions }, options); return { ...none, extractions: extractions.length }; });
  await write('nodes', nodeInputs, async (nodes) => { await store.applyImport({ ...empty, nodes }, options); return { ...none, nodes: nodes.length }; });
  await write('edges', edgeInputs, async (edges) => { await store.applyImport({ ...empty, edges }, options); return { ...none, edges: edges.length }; });
  await write('issues', issueInputs, async (issues) => { await store.applyImport({ ...empty, issues }, options); return { ...none, issues: issues.length }; });
  return { ok: true, spaceId: input.spaceId, imported: total };
}
