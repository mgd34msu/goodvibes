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
  for (const sources of batches(sourceInputs)) {
    const ids = new Set(sources.map((source) => source.id));
    await store.applyImport({ ...empty, sources, extractions: extractionInputs.filter((extraction) => ids.has(extraction.sourceId)) }, options);
  }
  const importedSourceIds = new Set(sourceInputs.map((source) => source.id));
  const orphanExtractions = extractionInputs.filter((extraction) => !importedSourceIds.has(extraction.sourceId));
  for (const extractions of batches(orphanExtractions)) await store.applyImport({ ...empty, extractions }, options);
  for (const nodes of batches(nodeInputs)) await store.applyImport({ ...empty, nodes }, options);
  for (const edges of batches(edgeInputs)) await store.applyImport({ ...empty, edges }, options);
  for (const issues of batches(issueInputs)) await store.applyImport({ ...empty, issues }, options);
  return { ok: true, spaceId: input.spaceId, imported: {
    sources: sourceInputs.length, nodes: nodeInputs.length, edges: edgeInputs.length, issues: issueInputs.length, extractions: extractionInputs.length,
  } };
}
