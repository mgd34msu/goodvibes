import { notifyKnowledgeCommitted } from './commit-notification.js';
import { assertKnowledgeRestriction } from './extraction-ownership.js';
import { isClassicOperation } from '../runtime/decision-policy.js';
import { createKnowledgeIngestUriCanonicalizer, type KnowledgeIngestUriCanonicalizer } from './uri-canonicalization/ingest-owner.js';
import type { KnowledgeUriCanonicalizer } from './uri-canonicalization/reader.js';
import { knowledgeSourceCrawledNow } from './store-record-representation.js';
import { prepareKnowledgeSourceRecord, prepareKnowledgeExtractionRecord } from './store-evidence-writes.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { snapshotNodeInput } from './activation/projection.js';
import { knowledgeIngestGuard } from './ingest-preparation.js';
import { stableText } from './store-schema.js';
import { prepareStagedObservedKnowledgeNodeInput, type KnowledgeObservationOrigin } from './store-node-observation.js';
import {
  emitKnowledgeCompileCompleted,
  emitKnowledgeExtractionCompleted,
  emitKnowledgeExtractionFailed,
} from '../runtime/emitters/index.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { prepareKnowledgeExtraction, type PreparedKnowledgeExtraction } from './prepared-extraction.js';
import { KnowledgeIngestStoppedError } from './ingest-stopped.js';
import { knowledgeExtractionNeedsRefresh } from './extraction-policy.js';
import {
  extractTaggedValues,
  mergeTags,
  readMetadataStrings,
  slugify,
} from './shared.js';
import type { KnowledgeIngestContext, KnowledgeIngestOwnership } from './ingest-context.js';
import { readKnowledgeEntityAliases } from './entity-aliases.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeExtractionUpsertInput,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeNodeUpsertInput,
  KnowledgeEdgeUpsertInput,
} from './types.js';
import { getKnowledgeSpaceId, knowledgeSpaceMetadata } from './spaces.js';
import { knowledgeTopicSlug } from './topic-slug.js';

/** Heading topics one document may add (only headings that name a fact of it). */
const MAX_EXTRACTION_SECTION_NODES = 24;
/** Links from one document to sources already in the store. */
const MAX_EXTRACTION_LINK_EDGES = 200;
/** Tagged entity hints per kind from one document. */
const MAX_ENTITY_HINT_VALUES_PER_KIND = 32;

export async function finalizeKnowledgeIngestedSource(
  context: KnowledgeIngestContext,
  input: {
    readonly sourceId: string;
    readonly artifactId: string;
    readonly inputTitle?: string | undefined;
    readonly preparedExtraction?: PreparedKnowledgeExtraction | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly sourceType: KnowledgeSourceType;
    readonly connectorId: string;
    readonly tags: readonly string[];
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly metadata: Record<string, unknown>;
  },
  uris: KnowledgeIngestUriCanonicalizer,
  ownership: KnowledgeIngestOwnership = {},
): Promise<{ source: KnowledgeSourceRecord; artifactId: string; extraction: KnowledgeExtractionRecord }> {
  const { signal } = input;
  await context.store.init();
  const artifactRecord = context.artifactStore.getRecord(input.artifactId);
  if (!artifactRecord) throw new KnowledgeIngestStoppedError('changed', `artifact ${input.artifactId} is no longer stored`);
  const canonicalUri = await uris.canonicalize(artifactRecord.sourceUri ?? '');
  // One guard: the stored source row (and the owner of its canonical URI) by
  // generation, plus the caller's own check and the abort signal.
  const sourceCurrent = knowledgeIngestGuard(context, input.sourceId, canonicalUri ?? undefined, signal);
  const assertCurrent = () => { assertKnowledgeRestriction(ownership.assertCurrent); uris.assertCurrent(); sourceCurrent(); };
  assertCurrent();
  let published = false;
  let committed = undefined as { source: KnowledgeSourceRecord; extraction: KnowledgeExtractionRecord } | undefined;
  try {
    let prepared = input.preparedExtraction;
    if (!prepared) {
      const read = await prepareKnowledgeExtraction(context, input.sourceId, input.artifactId, uris, { signal, assertCurrent });
      if (read.kind !== 'extracted') throw new KnowledgeIngestStoppedError('changed', 'the artifact was not extracted');
      prepared = read;
    }
    const { record, extracted, contentHash } = prepared;
    const previousExtraction = context.store.getExtractionBySourceId(input.sourceId);
    const extractionEvidence = {
      title: stableText(extracted.title) ?? previousExtraction?.title,
      summary: stableText(extracted.summary) ?? previousExtraction?.summary,
    };
    const extractionId = previousExtraction?.id ?? `extract-${crypto.randomUUID()}`;
    let compiled = { nodeCount: 0, edgeCount: 0 };
    let assertAliasesCurrent = () => {};
    const assertPrepared = () => {
      assertCurrent();
      assertAliasesCurrent();
    };
    const sourceInput = {
      id: input.sourceId, connectorId: input.connectorId, sourceType: input.sourceType,
      title: input.inputTitle?.trim() || extractionEvidence.title || record.filename,
      sourceUri: record.sourceUri, canonicalUri: canonicalUri ?? undefined,
      summary: extractionEvidence.summary, description: stableText(extracted.excerpt) ?? previousExtraction?.excerpt,
      tags: input.tags, folderPath: input.folderPath, status: 'indexed' as const, artifactId: input.artifactId,
      contentHash, sessionId: input.sessionId,
      // A published ingest ends any earlier hold on this source.
      metadata: { ...input.metadata, ingestHold: undefined, contentType: record.mimeType, extractionId,
        extractionFormat: extracted.format, outboundLinks: extracted.links },
    };
    const extractionInput = { id: extractionId, sourceId: input.sourceId, artifactId: input.artifactId,
      extractorId: extracted.extractorId, format: extracted.format, title: extracted.title,
      summary: extracted.summary, excerpt: extracted.excerpt, sections: extracted.sections,
      links: extracted.links, estimatedTokens: extracted.estimatedTokens, structure: extracted.structure, metadata: extracted.metadata };
    // Settle the pure alias phase against the same native normalization used
    // by the staged import. Hybrid may switch policy here; capture final
    // source provenance only afterwards, before the one atomic publication.
    const prospectiveSource = prepareKnowledgeSourceRecord(sourceInput, context.store.getSource(input.sourceId));
    const prospectiveExtraction = prepareKnowledgeExtractionRecord(extractionInput, previousExtraction, prospectiveSource);
    const entityHints = await prepareKnowledgeStructuredEntityHints(prospectiveSource, prospectiveExtraction, signal,
      (guard) => { assertAliasesCurrent = guard; }, assertCurrent);
    assertPrepared();
    await context.store.applyPreparedIngest({
      sources: [knowledgeSourceCrawledNow({ ...sourceInput, metadata: { ...sourceInput.metadata,
        ...(isClassicOperation() ? { provenance: 'classic', semanticAssessment: 'not-evaluated' } : {}),
      } })],
      extractions: [extractionInput],
      nodes: [], edges: [], issues: [],
    }, async (stage) => {
      assertPrepared();
      const source = stage.sources[0]!;
      const extraction = stage.extractions[0]!;
      committed = { source, extraction };
      const check = () => { assertPrepared(); stage.assertCurrent(); };
      const draft = stagedCompileWriter(context, check);
      await compileKnowledgeSourceRecords(context, source, extraction, entityHints, draft.writer, uris);
      check();
      compiled = { nodeCount: draft.nodes.size, edgeCount: draft.edges.length };
      return { nodes: [...draft.nodes.values()], edges: draft.edges, issues: [], assertCurrent: assertPrepared };
    }, { signal }, () => {
      published = true;
      notifyKnowledgeCommitted(() => ownership.onCommitted?.(input.sourceId));
    });
    const { source, extraction } = committed!;
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionCompleted(bus, ctx, {
      sourceId: input.sourceId, extractionId: extraction.id, format: extraction.format, estimatedTokens: extraction.estimatedTokens,
    }), input.sessionId);
    context.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
      sourceId: source.id, ...compiled,
    }), source.sessionId);
    // Host-owned repair consumers promote under their retained read set. Do not
    // launch an unowned second publisher after the guarded source commit.
    if (!ownership.deferSemanticEnrichment && !isClassicOperation()) void Promise.resolve(context.semanticEnrichSource?.(source.id, readKnowledgeSpaceId(source.metadata))).catch((error: unknown) => {
      logger.warn('Knowledge semantic enrichment after ingest failed', {
        sourceId: source.id,
        error: summarizeError(error),
      });
    });
    return { source, artifactId: input.artifactId, extraction };
  } catch (error) {
    if (published && committed) {
      // The source is already durably published, so a failure in a later step
      // (memory mirror, completion event) must not be reported to the caller as
      // a failed ingest, which would stamp a crawl error on indexed content.
      try { logger.warn('Knowledge source committed; a later ingest completion step failed.', { sourceId: input.sourceId, error: summarizeError(error) }); }
      catch (reportingError) { drainOwned(reportingError); }
      return { source: committed.source, artifactId: input.artifactId, extraction: committed.extraction };
    }
    context.emitIfReady((bus, ctx) => emitKnowledgeExtractionFailed(bus, ctx, {
      sourceId: input.sourceId,
      error: summarizeError(error),
    }), input.sessionId);
    throw error;
  }
}

function readKnowledgeSpaceId(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.knowledgeSpaceId ?? metadata.spaceId ?? metadata.namespace;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

interface KnowledgeCompileOptions { readonly signal?: AbortSignal | undefined; readonly assertCurrent?: (() => void) | undefined; }

export async function recompileKnowledgeSource(context: KnowledgeIngestContext, source: KnowledgeSourceRecord,
  options: KnowledgeCompileOptions = {}): Promise<void> {
  const { signal } = options;
  source = snapshotNodeInput(source);
  await context.store.init();
  const extraction = snapshotNodeInput(context.store.getExtractionBySourceId(source.id));
  const sourceCurrent = knowledgeCompileGuard(context, source, extraction, signal);
  const uris = createKnowledgeIngestUriCanonicalizer(context, options, sourceCurrent);
  const assertCurrent = () => { sourceCurrent(); uris.assertCurrent(); };
  let refreshed: KnowledgeExtractionUpsertInput | undefined;
  if (source.artifactId && knowledgeExtractionNeedsRefresh(extraction, undefined, source.artifactId)) {
    assertCurrent();
    uris.attachArtifact(source.artifactId);
    const prepared = await abortableCompileRead(prepareKnowledgeExtraction(context, source.id, source.artifactId, uris, { signal, assertCurrent }), signal);
    if (prepared.kind === 'extracted') refreshed = { ...prepared.extracted, sourceId: source.id, artifactId: source.artifactId };
  }
  assertCurrent();
  await commitKnowledgeCompilation(context, source, extraction, false, signal, assertCurrent, uris, refreshed);
}

export async function compileKnowledgeSource(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
  options: KnowledgeCompileOptions = {},
): Promise<void> {
  const { signal } = options;
  source = snapshotNodeInput(source);
  extraction = snapshotNodeInput(extraction);
  await context.store.init();
  const sourceCurrent = knowledgeCompileGuard(context, source, extraction, signal);
  const uris = createKnowledgeIngestUriCanonicalizer(context, options, sourceCurrent);
  await commitKnowledgeCompilation(context, source, extraction, false, signal,
    () => { sourceCurrent(); uris.assertCurrent(); }, uris);
}

/** The caller's rows must be the stored ones (same write time) before compiling from them. */
function knowledgeCompileGuard(context: KnowledgeIngestContext, source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined, signal?: AbortSignal): () => void {
  const storedSource = context.store.getSource(source.id);
  const storedExtraction = extraction ? context.store.getExtractionBySourceId(source.id) : undefined;
  if (!storedSource || storedSource.updatedAt !== source.updatedAt
    || (extraction && (!storedExtraction || storedExtraction.id !== extraction.id || storedExtraction.updatedAt !== extraction.updatedAt))) {
    throw new KnowledgeIngestStoppedError('changed', `source ${source.id} was written after it was read`);
  }
  const check = knowledgeIngestGuard(context, source.id, source.canonicalUri, signal);
  check();
  return check;
}

/** Extraction readers can finish in the background after cancellation, but never publish. */
async function abortableCompileRead<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return read;
  let abort = () => {};
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new KnowledgeIngestStoppedError('cancelled', undefined, { cause: signal.reason }));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([read, stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

async function commitKnowledgeCompilation(context: KnowledgeIngestContext, source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined, structuredOnly: boolean, signal: AbortSignal | undefined,
  assertEvidenceCurrent: () => void, uris: KnowledgeUriCanonicalizer, refreshed?: KnowledgeExtractionUpsertInput): Promise<void> {
  let compiled = { nodeCount: 0, edgeCount: 0 };
  let assertAliasesCurrent = () => {};
  const assertCurrent = () => { assertEvidenceCurrent(); assertAliasesCurrent(); };
  assertCurrent();
  await context.store.applyPreparedIngest({ sources: [], extractions: refreshed ? [refreshed] : [], nodes: [], edges: [], issues: [] }, async (stage) => {
    assertCurrent();
    const nextExtraction = stage.extractions[0] ?? extraction;
    const hints = await prepareKnowledgeStructuredEntityHints(source, nextExtraction, signal, (guard) => { assertAliasesCurrent = guard; });
    const check = () => { assertCurrent(); stage.assertCurrent(); };
    check();
    const draft = stagedCompileWriter(context, check);
    if (structuredOnly) await writeKnowledgeStructuredEntityHints(context, source, hints, draft.writer);
    else await compileKnowledgeSourceRecords(context, source, nextExtraction, hints, draft.writer, uris);
    check();
    compiled = { nodeCount: draft.nodes.size, edgeCount: draft.edges.length };
    return { nodes: [...draft.nodes.values()], edges: draft.edges, issues: [], assertCurrent };
  }, { signal });
  if (structuredOnly) return;
  context.emitIfReady((bus, ctx) => emitKnowledgeCompileCompleted(bus, ctx, {
    sourceId: source.id, ...compiled,
  }), source.sessionId);
}

interface KnowledgeCompileWriter {
  node(input: KnowledgeNodeUpsertInput): Promise<{ readonly id: string }>;
  observed(input: KnowledgeNodeUpsertInput, evidence: unknown, readEvidence: () => unknown, origin?: KnowledgeObservationOrigin): Promise<{ readonly id: string }>;
  edge(input: KnowledgeEdgeUpsertInput): Promise<unknown>;
}
function stagedCompileWriter(context: KnowledgeIngestContext, assertCurrent: () => void) {
  const nodes = new Map<string, KnowledgeNodeUpsertInput>();
  const edges: KnowledgeEdgeUpsertInput[] = [];
  function stageNode(input: KnowledgeNodeUpsertInput, observed?: { evidence: unknown; readEvidence: () => unknown; origin?: KnowledgeObservationOrigin | undefined }) {
    const key = JSON.stringify([input.kind, input.slug]);
    const prior = nodes.get(key);
    const id = prior?.id ?? context.store.getNodeByKindAndSlug(input.kind, input.slug)?.id ?? `node-${crypto.randomUUID()}`;
    const candidate = { ...prior, ...input, id, metadata: { ...prior?.metadata, ...input.metadata } };
    nodes.set(key, observed ? prepareStagedObservedKnowledgeNodeInput(context.store, candidate,
      observed.evidence, observed.readEvidence, assertCurrent, observed.origin) : snapshotNodeInput(candidate));
    return { id };
  }
  const writer: KnowledgeCompileWriter = {
    node: async (input) => stageNode(input),
    observed: async (input, evidence, readEvidence, origin) => stageNode(input, { evidence, readEvidence, origin }),
    edge: async (input) => { edges.push(snapshotNodeInput(input)); },
  };
  return { writer, nodes, edges };
}

async function compileKnowledgeSourceRecords(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction: KnowledgeExtractionRecord | null | undefined,
  entityHints: readonly CompiledEntityHint[],
  writer: KnowledgeCompileWriter,
  uris: KnowledgeUriCanonicalizer,
): Promise<void> {
  const spaceId = getKnowledgeSpaceId(source);
  if (source.artifactId) {
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'artifact',
      toId: source.artifactId,
      relation: 'snapshotted_as',
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }

  const domain = source.canonicalUri ?? source.sourceUri;
  if (domain) {
    let hostname: string | undefined;
    try { hostname = new URL(domain).hostname.toLowerCase(); }
    catch (error) {
      logger.debug('Knowledge ingest: source URL could not be canonicalized for domain node', {
        sourceId: source.id, uri: domain, error: summarizeError(error),
      });
    }
    if (hostname !== undefined) {
      const domainNode = await writer.observed({
        kind: 'domain',
        slug: slugify(`${spaceId}-${hostname}`),
        title: hostname,
        summary: `Knowledge sources cataloged under ${hostname}.`,
        aliases: [hostname],
        metadata: knowledgeSpaceMetadata(spaceId, { hostname }),
      }, source, () => context.store.getSource(source.id));
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: domainNode.id,
        relation: 'belongs_to_domain',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
  }

  if (source.folderPath) {
    const segments = source.folderPath.split('/').map((entry) => entry.trim()).filter(Boolean);
    let previousNode: { readonly id: string } | null = null;
    let accumulated = '';
    for (const segment of segments) {
      accumulated = accumulated ? `${accumulated}/${segment}` : segment;
      const folderNode = await writer.observed({
        kind: 'bookmark_folder',
        slug: slugify(`${spaceId}-${accumulated}`),
        title: segment,
        summary: `Bookmark folder ${accumulated}.`,
        aliases: [accumulated],
        metadata: knowledgeSpaceMetadata(spaceId, { folderPath: accumulated }),
      }, source, () => context.store.getSource(source.id));
      if (previousNode) {
        await writer.edge({
          fromKind: 'node',
          fromId: previousNode.id,
          toKind: 'node',
          toId: folderNode.id,
          relation: 'contains_folder',
          metadata: knowledgeSpaceMetadata(spaceId),
        });
      }
      previousNode = folderNode;
    }
    if (previousNode) {
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: previousNode.id,
        relation: 'cataloged_in_folder',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
  }

  for (const tag of source.tags) {
    const topicNode = await writer.observed({
      kind: 'topic',
      slug: knowledgeTopicSlug(spaceId, tag),
      title: tag,
      summary: `Topic tag ${tag}.`,
      aliases: [tag],
      metadata: knowledgeSpaceMetadata(spaceId, { tag }),
    }, source, () => context.store.getSource(source.id));
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: topicNode.id,
      relation: 'tagged_with',
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }

  await writeKnowledgeStructuredEntityHints(context, source, entityHints, writer);

  if (extraction) {
    const tagSlugs = new Set(source.tags.map((tag) => slugify(tag)));
    const sectionTitles: string[] = [];
    const seenSectionSlugs = new Set<string>();
    // A heading is a topic only when it names a fact read from this document;
    // "Introduction" or a cover line stays searchable text in the extraction.
    const factNames = extraction.sections.length > 0 ? sourceFactNames(context, source.id, spaceId) : new Set<string>();
    for (const section of extraction.sections.map((entry) => entry.trim()).filter((entry) => entry.length > 0)) {
      const sectionSlug = slugify(section);
      if (!sectionSlug || seenSectionSlugs.has(sectionSlug) || !factNames.has(sectionSlug)) continue;
      seenSectionSlugs.add(sectionSlug);
      sectionTitles.push(section);
      if (sectionTitles.length >= MAX_EXTRACTION_SECTION_NODES) break;
    }
    for (const section of sectionTitles) {
      if (tagSlugs.has(slugify(section))) continue;
      const topicNode = await writer.observed({
        kind: 'topic',
        slug: knowledgeTopicSlug(spaceId, section),
        title: section,
        summary: `Compiled section or concept from source ${source.id}.`,
        aliases: [section],
        metadata: knowledgeSpaceMetadata(spaceId, {
          sourceId: source.id,
          extractionId: extraction.id,
        }),
      }, { source, extraction }, () => ({ source: context.store.getSource(source.id), extraction: context.store.getExtractionBySourceId(source.id) }));
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'node',
        toId: topicNode.id,
        relation: 'mentions_section',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
    const settledLinks = await uris.canonicalizeAll(extraction.links);
    uris.assertCurrent();
    const outboundUris = [...new Set(settledLinks.filter((link): link is string => link !== null))]
      .slice(0, MAX_EXTRACTION_LINK_EDGES);
    for (const canonicalOutbound of outboundUris) {
      const linked = context.store.getSourceByCanonicalUri(canonicalOutbound);
      if (!linked) continue;
      await writer.edge({
        fromKind: 'source',
        fromId: source.id,
        toKind: 'source',
        toId: linked.id,
        relation: 'links_to_source',
        metadata: knowledgeSpaceMetadata(spaceId),
      });
    }
  }

  if (source.sessionId) {
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'session',
      toId: source.sessionId,
      relation: 'ingested_during',
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }
}

/** Slugged titles and labels of the facts the store holds for one source. */
function sourceFactNames(context: KnowledgeIngestContext, sourceId: string, spaceId: string): Set<string> {
  const names = new Set<string>();
  for (const node of context.store.listNodesInSpace(spaceId)) {
    if (node.kind !== 'fact' || node.status !== 'active') continue;
    const sourceIds = node.metadata.sourceIds;
    if (node.sourceId !== sourceId && !(Array.isArray(sourceIds) && sourceIds.includes(sourceId))) continue;
    for (const name of [node.title, ...node.aliases]) {
      const slug = slugify(name);
      if (slug) names.add(slug);
    }
  }
  return names;
}

export async function compileKnowledgeStructuredEntityHints(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  extraction?: KnowledgeExtractionRecord | null,
  options: KnowledgeCompileOptions = {},
): Promise<void> {
  const { signal } = options;
  source = snapshotNodeInput(source);
  extraction = snapshotNodeInput(extraction);
  await context.store.init();
  const sourceCurrent = knowledgeCompileGuard(context, source, extraction, signal);
  const uris = createKnowledgeIngestUriCanonicalizer(context, options, sourceCurrent);
  await commitKnowledgeCompilation(context, source, extraction, true, signal,
    () => { sourceCurrent(); uris.assertCurrent(); }, uris);
}

interface CompiledEntityHint {
  readonly kind: KnowledgeNodeRecord['kind'];
  readonly title: string;
  readonly relation: string;
  readonly summaryPrefix: string;
  readonly aliases: readonly string[];
}

async function prepareKnowledgeStructuredEntityHints(
  source: Pick<KnowledgeSourceRecord, 'id' | 'sourceType' | 'sourceUri' | 'title' | 'summary' | 'tags' | 'metadata'>,
  extraction: Pick<KnowledgeExtractionRecord, 'summary' | 'excerpt' | 'sections'> | null | undefined,
  signal?: AbortSignal,
  retainGuard?: (assertCurrent: () => void) => void,
  ownerCurrent?: () => void,
): Promise<readonly CompiledEntityHint[]> {
  const metadata = source.metadata ?? {};
  const entitySpecs: Array<{
    kind: KnowledgeNodeRecord['kind'];
    values: readonly string[];
    relation: string;
    summaryPrefix: string;
  }> = [
    {
      kind: 'project',
      values: mergeTags(
        extractTaggedValues(source.tags, ['project', 'proj']),
        readMetadataStrings(metadata, ['project', 'projects']),
      ),
      relation: 'belongs_to_project',
      summaryPrefix: 'Project',
    },
    {
      kind: 'capability',
      values: mergeTags(
        extractTaggedValues(source.tags, ['capability', 'feature']),
        readMetadataStrings(metadata, ['capability', 'capabilities', 'feature', 'features']),
      ),
      relation: 'documents_capability',
      summaryPrefix: 'Capability',
    },
    {
      kind: 'repo',
      values: mergeTags(
        extractTaggedValues(source.tags, ['repo', 'repository']),
        readMetadataStrings(metadata, ['repo', 'repository', 'repositories']),
        source.sourceType === 'repo' ? [source.title ?? source.sourceUri ?? source.id] : [],
      ),
      relation: 'references_repo',
      summaryPrefix: 'Repository',
    },
    {
      kind: 'provider',
      values: mergeTags(
        extractTaggedValues(source.tags, ['provider']),
        readMetadataStrings(metadata, ['provider', 'providers']),
      ),
      relation: 'references_provider',
      summaryPrefix: 'Provider',
    },
    {
      kind: 'service',
      values: mergeTags(
        extractTaggedValues(source.tags, ['service']),
        readMetadataStrings(metadata, ['service', 'services']),
      ),
      relation: 'references_service',
      summaryPrefix: 'Service',
    },
    {
      kind: 'environment',
      values: mergeTags(
        extractTaggedValues(source.tags, ['env', 'environment']),
        readMetadataStrings(metadata, ['env', 'environment', 'environments']),
      ),
      relation: 'references_environment',
      summaryPrefix: 'Environment',
    },
    {
      kind: 'user',
      values: mergeTags(
        extractTaggedValues(source.tags, ['user', 'owner']),
        readMetadataStrings(metadata, ['user', 'users', 'owner', 'owners']),
      ),
      relation: 'references_user',
      summaryPrefix: 'User',
    },
  ];

  const entities = entitySpecs.flatMap((spec) => spec.values.slice(0, MAX_ENTITY_HINT_VALUES_PER_KIND)
    .map((value) => ({ kind: spec.kind, title: value.trim(), relation: spec.relation, summaryPrefix: spec.summaryPrefix }))
    .filter((entity) => entity.title.length > 0));
  const aliases = await readKnowledgeEntityAliases(entities, {
    title: source.title ?? '', summary: source.summary ?? '',
    extractionSummary: extraction?.summary ?? '', excerpt: extraction?.excerpt, sections: extraction?.sections ?? [],
  }, signal, retainGuard, ownerCurrent);
  return entities.map((entity, index) => ({ ...entity, aliases: aliases[index]! }));
}

async function writeKnowledgeStructuredEntityHints(
  context: KnowledgeIngestContext,
  source: KnowledgeSourceRecord,
  entities: readonly CompiledEntityHint[],
  writer: KnowledgeCompileWriter,
): Promise<void> {
  const spaceId = getKnowledgeSpaceId(source);
  for (const entity of entities) {
    const { kind, title, summaryPrefix, aliases, relation } = entity;
    const input: KnowledgeNodeUpsertInput = {
      kind,
      slug: slugify(`${spaceId}-${title}`),
      title,
      summary: `${summaryPrefix} entity compiled from structured knowledge sources.`,
      aliases,
      metadata: knowledgeSpaceMetadata(spaceId, {
        compiledFrom: source.id,
        tags: [...source.tags],
        ...(isClassicOperation() ? { provenance: 'classic', semanticAssessment: 'not-evaluated' } : {}),
      }),
    };
    const node = isClassicOperation()
      ? await writer.observed(input, source, () => context.store.getSource(source.id), 'source-declaration')
      : await writer.node(input);
    await writer.edge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: node.id,
      relation,
      metadata: knowledgeSpaceMetadata(spaceId),
    });
  }
}
