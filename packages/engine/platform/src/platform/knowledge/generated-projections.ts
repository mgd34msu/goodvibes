import { observeKnowledgeValue } from './local-value-observation.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { knowledgeClockIso, knowledgeClockNumber, knowledgeRawRepresentation, retainKnowledgeRepresentation, sameKnowledgeRecord } from './store-record-representation.js';
import { KnowledgeSourceQualityHeldError } from './source-quality.js';
import { KnowledgeRecordAdmissionHeldError } from './store-record-snapshot.js';
import { sanitizeArtifactFilename, type ArtifactDescriptor } from '../artifacts/types.js';
import { acquireArtifactPublication, type ArtifactOriginalObservation, type ArtifactPublicationLease, type ArtifactStore } from '../artifacts/index.js';
import type { KnowledgeStore } from './store.js';
import type { KnowledgeImportGraph } from './store-import.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
  KnowledgeNodeRecord,
} from './types.js';
import { logger } from '../utils/logger.js';
import { SQLitePublicationError } from '../state/sqlite-store-persistence.js';

export type GeneratedKnowledgeProjectionTargetKind = 'source' | 'node' | 'artifact';

export interface GeneratedKnowledgeProjectionInput {
  readonly store: KnowledgeStore;
  readonly artifactStore: ArtifactStore;
  readonly connectorId: string;
  readonly sourceId: string;
  readonly sourceType?: KnowledgeSourceType | undefined;
  readonly canonicalUri: string;
  readonly title: string;
  readonly summary?: string | undefined;
  readonly tags?: readonly string[] | undefined;
  readonly filename: string;
  readonly markdown: string;
  readonly projectionKind: string;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly sourceMetadata?: Record<string, unknown> | undefined;
  readonly artifactMetadata?: Record<string, unknown> | undefined;
  readonly edgeMetadata?: Record<string, unknown> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly target?: {
    readonly kind: GeneratedKnowledgeProjectionTargetKind;
    readonly id: string;
    readonly relation?: string | undefined;
  };
}

export interface GeneratedKnowledgeProjectionResult {
  readonly artifact: ArtifactDescriptor;
  readonly source: KnowledgeSourceRecord;
  readonly linked?: KnowledgeEdgeRecord | undefined;
  readonly artifactCreated: boolean;
}

export function isGeneratedKnowledgeSource(source: KnowledgeSourceRecord): boolean {
  return source.metadata.generatedKnowledgePage === true
    || source.metadata.generatedProjection === true;
}

export async function materializeGeneratedKnowledgeProjection(
  input: GeneratedKnowledgeProjectionInput,
): Promise<GeneratedKnowledgeProjectionResult> {
  return materializeProjection(input);
}

/** Internal page publication stages its complete graph before one atomic import. */
export async function materializeGeneratedKnowledgeGraphProjection(
  input: GeneratedKnowledgeProjectionInput,
  graph: KnowledgeImportGraph,
): Promise<GeneratedKnowledgeProjectionResult & { readonly nodes: readonly KnowledgeNodeRecord[] }> {
  const result = await materializeProjection(input, graph);
  return { ...result, nodes: result.nodes ?? [] };
}

interface ProjectionPublication {
  lease?: ArtifactPublicationLease | undefined;
  candidate?: ArtifactOriginalObservation | undefined;
}
async function materializeProjection(
  input: GeneratedKnowledgeProjectionInput,
  graph?: KnowledgeImportGraph,
): Promise<GeneratedKnowledgeProjectionResult & { readonly nodes?: readonly KnowledgeNodeRecord[] }> {
  const publication: ProjectionPublication = {}, store = input.store;
  let failed = false;
  try { return await materializeProjectionOwned(input, graph, publication); }
  catch (error) {
    failed = true;
    // A failed candidate must leave its own publication lock before cleanup
    // tries the same lock. An uncertain DB publication keeps the artifact.
    try { releaseProjectionPublication(publication); }
    catch { logger.warn('Generated knowledge artifact publication release could not be confirmed.'); }
    if (publication.candidate && !(error instanceof SQLitePublicationError && error.phase === 'indeterminate')) {
      await cleanOriginalGeneratedArtifact(store, publication.candidate);
    }
    throw error;
  } finally {
    try { releaseProjectionPublication(publication); }
    catch (error) { if (!failed) throw error; }
  }
}
function releaseProjectionPublication(publication: ProjectionPublication): void {
  const lease = publication.lease; publication.lease = undefined;
  if (lease) assertSynchronousProjectionGuard(lease.release, lease);
}
async function materializeProjectionOwned(
  input: GeneratedKnowledgeProjectionInput,
  graph: KnowledgeImportGraph | undefined,
  publication: ProjectionPublication,
): Promise<GeneratedKnowledgeProjectionResult & { readonly nodes?: readonly KnowledgeNodeRecord[] }> {
  const store = input.store, artifactStore = input.artifactStore;
  const authority = input.assertCurrent, graphAssertion = graph?.assertCurrent;
  const signal = input.signal;
  const existing = input.store.getSource(input.sourceId);
  const oldArtifact = existing?.artifactId ? artifactStore.get(existing.artifactId) : null;
  const oldOriginal = oldArtifact ? observePreviousGeneratedArtifact(artifactStore, oldArtifact.id) : undefined;
  const supersededOriginal = oldArtifact && readRecord(oldArtifact.metadata).generatedKnowledgePage === true ? oldOriginal : undefined;
  let artifactAssertion: (() => void) | undefined;
  const originalSource = observeKnowledgeValue(existing);
  const target = input.target;
  const readTarget = () => !target ? null : target.kind === 'node' ? input.store.getNode(target.id)
    : target.kind === 'source' ? input.store.getSource(target.id) : input.artifactStore.getRecord(target.id);
  const originalTarget = readTarget(), targetObservation = observeKnowledgeValue(originalTarget);
  const readLinked = () => !target ? undefined : input.store.edgesFor('source', input.sourceId).find((edge) =>
    edge.toKind === target.kind && edge.toId === target.id && edge.relation === (target.relation ?? 'source_for'));
  const originalLinked = readLinked(), linkedObservation = observeKnowledgeValue(originalLinked);
  const outputState = () => ({ sourceId: input.sourceId, sourceType: input.sourceType, connectorId: input.connectorId,
    canonicalUri: input.canonicalUri, title: input.title, summary: input.summary, tags: input.tags, filename: input.filename,
    markdown: input.markdown, projectionKind: input.projectionKind, metadata: input.metadata, sourceMetadata: input.sourceMetadata,
    artifactMetadata: input.artifactMetadata, edgeMetadata: input.edgeMetadata, target: input.target });
  const outputObservation = observeKnowledgeValue(outputState());
  const stale = () => { throw new KnowledgeSourceQualityHeldError('stale'); };
  const checkInputCurrent = () => {
    throwIfAborted(signal);
    if (authority && (input.store !== store || input.artifactStore !== artifactStore || input.assertCurrent !== authority || input.signal !== signal || !outputObservation.matches(outputState()))) stale();
  };
  const checkOwner = () => {
    throwIfAborted(signal);
    assertSynchronousProjectionGuard(authority);
    if (graph?.assertCurrent !== graphAssertion) stale();
    assertSynchronousProjectionGuard(graphAssertion, graph);
    assertSynchronousProjectionGuard(artifactAssertion);
    if (graph?.assertCurrent !== graphAssertion) stale();
    checkInputCurrent();
    if (authority && (readTarget() !== originalTarget || !targetObservation.matches(readTarget()))) stale();
  };
  const check = () => {
    // Authority, graph and source-identity guards often consume the same rows.
    // Keep every original assertion, sharing one fresh native read image only
    // for this synchronous boundary. The next await or write gets a new frame.
    let accepting = true, invoked = false, completed = false, repeated = false, failed = false;
    let originalFailure: unknown, framed: unknown;
    const rethrow = (error: unknown): never => {
      drainOwned(error);
      if (error instanceof KnowledgeRecordAdmissionHeldError) stale();
      throw error;
    };
    try { framed = store.assertRecordSnapshotFrame(() => {
      // A borrowed frame cannot defer the original assertions beyond this
      // synchronous boundary, suppress their failure, or invoke them twice.
      if (!accepting) return;
      if (invoked) { repeated = true; stale(); }
      invoked = true;
      try {
        checkOwner();
        if (authority && (input.store.getSource(input.sourceId) !== existing || !originalSource.matches(input.store.getSource(input.sourceId))
          || readLinked() !== originalLinked || !linkedObservation.matches(readLinked()))) stale();
        completed = true;
      } catch (error) { failed = true; originalFailure = error; throw error; }
    }); } catch (error) {
      if (failed && error !== originalFailure) drainOwned(error);
      rethrow(failed ? originalFailure : error);
    } finally { accepting = false; }
    if (framed !== undefined) drainOwned(framed);
    if (failed) rethrow(originalFailure);
    if (!completed || repeated || framed !== undefined) stale();
  };
  check();
  const stagedTarget = target?.kind === 'node' && graph?.nodes.some(node => node.id === target.id);
  if (input.target && !stagedTarget) {
    assertGeneratedProjectionTarget(input.artifactStore, input.store, {
      toKind: input.target.kind,
      toId: input.target.id,
    });
  }
  check();
  const reused = await findReusableGeneratedArtifact(artifactStore, existing, input.markdown, input.filename, oldOriginal, signal, check);
  publication.lease = reused?.lease;
  artifactAssertion = reused?.assertCurrent;
  const reusedArtifact = reused?.artifact;
  check();
  const existingMetadata = readRecord(existing?.metadata);
  const existingGeneratedAt = knowledgeRawRepresentation(existingMetadata).generatedAt;
  // Artifact reuse already compares the actual complete bytes. A second hash
  // of the same markdown neither improves that comparison nor proves custody.
  const contentUnchanged = reusedArtifact !== undefined;
  const generatedAt = contentUnchanged && existingGeneratedAt !== undefined ? existingGeneratedAt : knowledgeClockIso(Date.now());
  const projectionMetadata = {
    ...(input.metadata ?? {}),
    generatedKnowledgePage: true,
    generatedProjection: true,
    projectionKind: input.projectionKind,
    generatedAt,
    // Clear the obsolete cache field when source metadata is merged with an
    // older saved page. Older readers treat null as a cache miss, not proof.
    generatedContentHash: null,
    pageEditable: true,
  };
  let artifact: ArtifactDescriptor;
  if (reusedArtifact) artifact = reusedArtifact;
  else {
    const created = await artifactStore.createForPublication({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: input.filename,
      text: input.markdown,
      retentionMs: 0,
      metadata: {
        ...projectionMetadata,
        ...(input.artifactMetadata ?? {}),
        generatedAt,
        generatedContentHash: null,
      },
    }, { signal, assertCurrent: check });
    publication.lease = created.lease; publication.candidate = created.original; artifact = created.artifact;
    artifactAssertion = () => {
      assertSynchronousProjectionGuard(created.original.assertCurrent, created.original);
      assertSynchronousProjectionGuard(created.lease.assertCurrent, created.lease);
    };
  }
  const sourceInputView = {
    id: input.sourceId,
    connectorId: input.connectorId,
    sourceType: input.sourceType ?? 'document',
    title: input.title,
    sourceUri: input.canonicalUri,
    canonicalUri: input.canonicalUri,
    ...(input.summary ? { summary: input.summary } : {}),
    tags: uniqueStrings(input.tags ?? []),
    status: 'indexed' as const,
    artifactId: artifact.id,
    lastCrawledAt: contentUnchanged && typeof existing?.lastCrawledAt === 'number'
      ? existing.lastCrawledAt
      : knowledgeClockNumber(generatedAt),
    metadata: {
      ...projectionMetadata,
      artifactId: artifact.id,
      filename: artifact.filename,
      ...(input.sourceMetadata ?? {}),
      generatedAt,
      generatedContentHash: null,
    },
  };
  const sourceInput = retainKnowledgeRepresentation(sourceInputView, { ...knowledgeRawRepresentation(sourceInputView),
    lastCrawledAt: contentUnchanged && existing ? knowledgeRawRepresentation(existing).lastCrawledAt : generatedAt });
  const edgeInput = input.target
    ? {
        fromKind: 'source' as const,
        fromId: input.sourceId,
        toKind: input.target.kind,
        toId: input.target.id,
        relation: input.target.relation ?? 'source_for',
        metadata: {
          generatedKnowledgePage: true,
          generatedProjection: true,
          projectionKind: input.projectionKind,
          ...(input.edgeMetadata ?? {}),
        },
      }
    : undefined;
  const existingLinked = edgeInput
    ? input.store.edgesFor(edgeInput.fromKind, edgeInput.fromId).find((edge) => (
        edge.toKind === edgeInput.toKind
        && edge.toId === edgeInput.toId
        && edge.relation === edgeInput.relation
      ))
    : undefined;
  let source: KnowledgeSourceRecord | undefined;
  let linked: KnowledgeEdgeRecord | undefined;
  let nodes: readonly KnowledgeNodeRecord[] | undefined;
  try {
    check();
    if (authority || graph) {
      const receipt = await input.store.applyPreparedIngest({ sources: [sourceInput], extractions: [], nodes: [], edges: [], issues: [] }, async () => ({
        nodes: graph?.nodes ?? [], edges: [...(graph?.edges ?? []), ...(edgeInput ? [edgeInput] : [])],
        issues: graph?.issues ?? [], assertCurrent: check,
      }), { signal, ...(graph ? { requireAccepted: true } : {}) });
      checkInputCurrent();
      if (authority && target) {
        const committedTarget = target.kind === 'node' ? receipt.nodes.find(record => record.id === target.id)
          : target.kind === 'source' ? receipt.sources.find(record => record.id === target.id) : undefined;
        if (committedTarget) {
          const persistedTarget = target.kind === 'node' ? store.getRecordSnapshot('node', target.id).record
            : store.getSourceSnapshot({ id: target.id }).source;
          if (readTarget() !== committedTarget || !persistedTarget || !sameKnowledgeRecord(committedTarget, persistedTarget)) stale();
        } else if (readTarget() !== originalTarget || !targetObservation.matches(readTarget())) stale();
      }
      // The graph owner was checked synchronously before the complete commit.
      // Its original read set intentionally changes when those rows publish.
      nodes = receipt.nodes;
      source = receipt.sources.find((record) => record.id === input.sourceId);
      linked = edgeInput ? receipt.edges.find((record) => record.fromId === input.sourceId && record.toKind === edgeInput.toKind
        && record.toId === edgeInput.toId && record.relation === edgeInput.relation) : undefined;
      if (!source || input.store.getSource(input.sourceId) !== source || source.artifactId !== artifact.id
        || (edgeInput && (!linked || readLinked() !== linked))) stale();
    } else {
      source = await input.store.upsertSource(sourceInput);
      check();
      linked = edgeInput ? await input.store.upsertEdge(edgeInput) : undefined;
      check();
    }
  } catch (error) {
    // An uncertain rename may already expose this artifact through the database.
    if (error instanceof SQLitePublicationError && error.phase === 'indeterminate') throw error;
    if (authority || graph) {
      // The guarded ingest either committed atomically under the original owner,
      // or made no mutation. Never overwrite a concurrent writer or compensate
      // an already valid commit after a later owner retirement.
      throw error;
    }
    const currentLinked = edgeInput
      ? input.store.edgesFor(edgeInput.fromKind, edgeInput.fromId).find((edge) => (
          edge.toKind === edgeInput.toKind
          && edge.toId === edgeInput.toId
          && edge.relation === edgeInput.relation
        ))
      : undefined;
    if (currentLinked && edgeInput) {
      if (existingLinked) {
        await input.store.replaceEdgeRecord(existingLinked);
      } else {
        await input.store.deleteEdge(currentLinked.id);
      }
    }
    const persistedSource = input.store.getSource(input.sourceId);
    if (!existing && persistedSource) {
      await input.store.deleteSource(persistedSource.id);
    } else if (existing && persistedSource) {
      await input.store.replaceSourceRecord(existing);
    }
    throw error;
  }
  if (!source) throw new Error(`Generated projection '${input.sourceId}' did not persist a source record.`);
  if (!reusedArtifact && supersededOriginal && supersededOriginal.id !== artifact.id) {
    const publishedTarget = readTarget();
    const publishedValues = observeKnowledgeValue({ source, linked, nodes, target: publishedTarget });
    const published = store.captureSourcePublication();
    await cleanOriginalGeneratedArtifact(store, supersededOriginal);
    checkInputCurrent();
    assertSynchronousProjectionGuard(artifactAssertion);
    published();
    if (store.getSource(source.id) !== source || (edgeInput && readLinked() !== linked) || readTarget() !== publishedTarget
      || !publishedValues.matches({ source, linked, nodes, target: readTarget() })) stale();
  }
  return {
    artifact,
    source,
    ...(linked ? { linked } : {}),
    artifactCreated: !reusedArtifact,
    ...(nodes ? { nodes } : {}),
  };
}

/** A broken previous file is a cache miss, not permission to adopt or delete
 * its replacement. Fresh creation still uses the actual native write owner. */
function observePreviousGeneratedArtifact(store: ArtifactStore, id: string): ArtifactOriginalObservation | undefined {
  try { return store.captureOriginal(id); }
  catch {
    logger.warn('The previous generated knowledge artifact could not be bound to its original files; preserving it during regeneration.');
    return undefined;
  }
}

/** Cleanup never grants publication authority and never replaces its primary
 * outcome. Only an actual complete family ensemble may remove the original. */
async function cleanOriginalGeneratedArtifact(store: KnowledgeStore, original: ArtifactOriginalObservation): Promise<void> {
  try {
    const result = await store.cleanupUnreferencedArtifact(original);
    if (result === 'held' || result === 'unavailable') logger.debug('Generated knowledge artifact cleanup is pending; the original artifact was preserved.', { artifactId: original.id, reason: result });
  } catch {
    logger.warn('Generated knowledge artifact cleanup could not be confirmed; the original artifact was preserved.', { artifactId: original.id });
  }
}

function assertSynchronousProjectionGuard(guard: (() => void) | undefined, receiver?: unknown): void {
  if (!guard) return;
  const result: unknown = Reflect.apply(guard, receiver, []);
  if (result !== undefined) { drainOwned(result); throw new KnowledgeSourceQualityHeldError('stale'); }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw new Error('Generated knowledge projection was cancelled.');
}

function assertGeneratedProjectionTarget(
  artifactStore: ArtifactStore,
  store: KnowledgeStore,
  edge: {
    readonly toKind: string;
    readonly toId: string;
  },
): void {
  switch (edge.toKind) {
    case 'node':
      if (!store.getNode(edge.toId)) throw new Error(`Generated projection target node does not exist: ${edge.toId}`);
      return;
    case 'source':
      if (!store.getSource(edge.toId)) throw new Error(`Generated projection target source does not exist: ${edge.toId}`);
      return;
    case 'artifact':
      if (!artifactStore.get(edge.toId)) throw new Error(`Generated projection target artifact does not exist: ${edge.toId}`);
      return;
    default:
      throw new Error(`Generated projection target kind is not supported: ${edge.toKind}`);
  }
}

async function findReusableGeneratedArtifact(
  artifactStore: ArtifactStore,
  source: KnowledgeSourceRecord | null,
  markdown: string,
  filename: string,
  original: ArtifactOriginalObservation | undefined,
  signal: AbortSignal | undefined,
  assertOwner: () => void,
): Promise<{ readonly artifact: ArtifactDescriptor; readonly lease: ArtifactPublicationLease; readonly assertCurrent: () => void } | undefined> {
  if (!source?.artifactId || !original || original.id !== source.artifactId) return undefined;
  const artifact = artifactStore.get(source.artifactId);
  if (!artifact || artifact.kind !== 'document' || artifact.mimeType !== 'text/markdown'
    || artifact.filename !== sanitizeArtifactFilename(filename, 'artifact.txt')) return undefined;
  const lease = await acquireArtifactPublication(original, signal);
  let retained = false, failed = false;
  try {
    assertSynchronousProjectionGuard(assertOwner);
    let read: Awaited<ReturnType<ArtifactStore['readContent']>>;
    try { read = await artifactStore.readContent(artifact.id); }
    catch {
      logger.warn('Unable to read the previous generated knowledge artifact; preserving it during regeneration.');
      return undefined;
    }
    const assertCurrent = () => {
      assertSynchronousProjectionGuard(lease.assertCurrent, lease);
      assertSynchronousProjectionGuard(read.assertCurrent, read);
      assertSynchronousProjectionGuard(original.assertCurrent, original);
      assertSynchronousProjectionGuard(lease.assertCurrent, lease);
    };
    assertCurrent();
    if (!read.buffer.equals(Buffer.from(markdown, 'utf-8'))) return undefined;
    retained = true; return { artifact, lease, assertCurrent };
  } catch (error) { failed = true; throw error; }
  finally {
    if (!retained) {
      try { assertSynchronousProjectionGuard(lease.release, lease); }
      catch (error) {
        if (!failed) throw error;
        logger.warn('Generated knowledge artifact read publication release could not be confirmed.');
      }
    }
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function uniqueStrings(values: Iterable<string | undefined | null>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}
