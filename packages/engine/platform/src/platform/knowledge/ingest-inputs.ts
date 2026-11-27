import { withConfiguredDecisionModelPolicy } from '../runtime/decision-policy.js';
import { knowledgeRawRepresentation } from './store-record-representation.js';
import { knowledgeClockIso } from './store-record-representation.js';
import { createKnowledgeIngestUriCanonicalizer } from './uri-canonicalization/ingest-owner.js';
import { KnowledgeUriCanonicalizationHeldError } from './uri-canonicalization/reader.js';
import { KnowledgeNodeActivationHeldError } from './activation/types.js';
import { KnowledgeNodeMutationHeldError } from './store-node-authority.js';
import { knowledgeIngestGuard, stageKnowledgePendingSource } from './ingest-preparation.js';
import { JudgmentInputError } from '../gate/judgment-input.js';
import { KnowledgeIngestStoppedError, knowledgeIngestStop } from './ingest-stopped.js';
import { prepareKnowledgeExtraction, type PreparedKnowledgeExtraction, type UnchangedKnowledgeContent } from './prepared-extraction.js';
import { readFile } from 'node:fs/promises';
import {
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
} from '../runtime/emitters/index.js';
import { readNormalizedError, summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { createSemanticWriteGuard } from './semantic/primary-source-plan.js';
import { finalizeKnowledgeIngestedSource } from './ingest-compile.js';
import { KNOWLEDGE_PROJECT_KEY, knowledgeMakerMetadata, knowledgeProjectOf } from './knowledge-reach.js';
import type { KnowledgeIngestContext, KnowledgeIngestOwnership } from './ingest-context.js';
import {
  inferSourceTypeFromArtifact,
  isHttpUri,
  isSourcePastRefreshWindow,
  mergeTags,
} from './shared.js';

/** One refresh-window table and lookup for the knowledge subsystem (shared.ts); re-exported for ingest.ts. */
export { getSourceRefreshWindowMs, isSourcePastRefreshWindow } from './shared.js';
import type {
  KnowledgeBatchIngestResult,
  KnowledgeBookmarkSeed,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceUpsertInput,
  KnowledgeSourceType,
} from './types.js';

// Remember an allow-private-hosts fetch on the source itself so a later refresh repeats it,
// whichever entry point (API, HTTP route, batch import) made the request.
function withPrivateHostIntent(
  metadata: Record<string, unknown> | undefined,
  allowPrivateHosts: boolean | undefined,
): Record<string, unknown> | undefined {
  if (allowPrivateHosts !== true) return metadata;
  const existing = metadata?.knowledgeIntent;
  return { ...(metadata ?? {}), knowledgeIntent: {
    ...(typeof existing === 'object' && existing !== null ? existing : {}),
    remoteFetchMode: 'allow-private-hosts',
  } };
}

export async function ingestKnowledgeUrl(
  context: KnowledgeIngestContext,
  input: {
    readonly url: string;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    /** A scheduled refresh: identical bytes only update the crawl time. */
    readonly refresh?: boolean | undefined;
  },
  ownership: KnowledgeIngestOwnership = {},
): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[]; unchanged?: boolean }> {
  return withConfiguredDecisionModelPolicy(async () => {
    const signal = ownership.signal && input.signal ? AbortSignal.any([ownership.signal, input.signal]) : ownership.signal ?? input.signal;
    const assertOwned = ingestOwnerCheck(ownership, signal);
    assertOwned();
    await context.store.init();
    assertOwned();
    // Whose it is: the project and maker of the call or turn adding it (knowledge-reach.ts); a scheduled refresh keeps
    // the source's own. Refused here, before anything is fetched, when it would add to the owner's shared knowledge for
    // a caller the owner did not give it.
    const ownMetadata = input.refresh === true ? input.metadata : knowledgeMakerMetadata(input.metadata);
    const uris = createKnowledgeIngestUriCanonicalizer(context, ownership, assertOwned, signal);
    const canonicalUri = await uris.canonicalize(input.url) ?? undefined;
    const sourceId = reserveSourceId(context, canonicalUri, ownMetadata);
    uris.reserveSource(sourceId, canonicalUri);
    const connectorId = input.connectorId ?? (input.sourceType === 'bookmark' ? 'bookmark' : 'url');
    const sourceCurrent = knowledgeIngestGuard(context, sourceId, canonicalUri, signal);
    const assertCurrent = () => { assertOwned(); uris.assertCurrent(); sourceCurrent(); };
    assertCurrent();
    const preparation = await capturePreparation(async () => {
      const artifact = await context.artifactStore.create({
        uri: input.url,
        allowPrivateHosts: input.allowPrivateHosts,
        metadata: { sourceConnector: connectorId, requestedAt: Date.now() },
      }, { signal, assertCurrent });
      assertCurrent();
      uris.attachArtifact(artifact.id);
      return prepareKnowledgeExtraction(context, sourceId, artifact.id, uris, { signal, assertCurrent, skipUnchanged: input.refresh === true });
    });
    if (preparation.ready && preparation.token.kind === 'unchanged') {
      assertCurrent();
      return await recordUnchangedRefresh(context, preparation.token);
    }
    // Remember an allow-private-hosts fetch on the source itself so a later refresh repeats it,
    // whichever entry point (API, HTTP route, batch import) made the request.
    const metadata = withPrivateHostIntent(ownMetadata, input.allowPrivateHosts);
    const pending = stageKnowledgePendingSource(context, {
      id: sourceId,
      connectorId,
      sourceType: input.sourceType ?? 'url',
      title: input.title,
      sourceUri: input.url,
      canonicalUri,
      tags: input.tags,
      folderPath: input.folderPath,
      status: 'pending',
      sessionId: input.sessionId,
      metadata,
    });
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
      sourceId: pending.id,
      connectorId: pending.connectorId,
      sourceType: pending.sourceType,
      uri: eventSafeUri(input.url),
    }), pending.sessionId);
    try {
      if (!preparation.ready) throw preparation.error;
      const prepared = preparation.token as PreparedKnowledgeExtraction;
      const result = await finalizeKnowledgeIngestedSource(context, {
        sourceId: pending.id,
        artifactId: prepared.artifactId,
        preparedExtraction: prepared,
        signal,
        inputTitle: input.title,
        sourceType: input.sourceType ?? pending.sourceType,
        connectorId: pending.connectorId,
        tags: mergeTags(pending.tags, input.tags),
        folderPath: input.folderPath ?? pending.folderPath,
        sessionId: input.sessionId ?? pending.sessionId,
        metadata: {
          ...pending.metadata,
          ...(metadata ?? {}),
        },
      }, uris, { ...ownership, signal, assertCurrent: assertOwned });
      const issues = await lintCommittedIngest(context, result.source.id);
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
        sourceId: result.source.id,
        status: result.source.status,
        artifactId: result.artifactId,
        title: result.source.title,
      }), result.source.sessionId);
      return { ...result, issues };
    } catch (error) {
      const stopped = await settleStoppedIngest(context, pending, error, signal, ownership, 'Knowledge ingest failed.');
      if (stopped) return stopped;
      const store = context.store, artifactStore = context.artifactStore;
      const sourceGuard = createSemanticWriteGuard(store);
      sourceGuard.source(pending.id);
      const assertDiagnosticCurrent = () => {
        assertCurrent(); sourceGuard.assertCurrent();
        if (context.store !== store || context.artifactStore !== artifactStore) throw new KnowledgeIngestStoppedError('changed');
      };
      const diagnostic = await readNormalizedError(error, { site: 'engine.knowledge.ingest-failure', signal, assertCurrent: assertDiagnosticCurrent });
      assertDiagnosticCurrent();
      const failed = await context.store.upsertSource({
        id: pending.id,
        connectorId: pending.connectorId,
        sourceType: pending.sourceType,
        title: pending.title,
        sourceUri: pending.sourceUri,
        canonicalUri: pending.canonicalUri,
        tags: pending.tags,
        folderPath: pending.folderPath,
        crawlError: diagnostic.summary,
        sessionId: pending.sessionId,
        ...failedIngestOutcome(context, pending),
      });
      const issues = await context.lint([failed.id]);
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
        sourceId: failed.id,
        error: failed.crawlError ?? 'Knowledge ingest failed.',
      }), failed.sessionId);
      return { source: failed, issues };
    }
  });
}

export async function ingestKnowledgeArtifact(
  context: KnowledgeIngestContext,
  input: {
    readonly artifactId?: string | undefined;
    readonly path?: string | undefined;
    readonly uri?: string | undefined;
    readonly title?: string | undefined;
    readonly tags?: readonly string[] | undefined;
    readonly folderPath?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly sourceType?: KnowledgeSourceType | undefined;
    readonly connectorId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly allowPrivateHosts?: boolean | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
  ownership: KnowledgeIngestOwnership = {},
): Promise<{ source: KnowledgeSourceRecord; artifactId?: string; extraction?: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[] }> {
  return withConfiguredDecisionModelPolicy(async () => {
    const signal = ownership.signal && input.signal ? AbortSignal.any([ownership.signal, input.signal]) : ownership.signal ?? input.signal;
    const assertOwned = ingestOwnerCheck(ownership, signal);
    assertOwned();
    await context.store.init();
    assertOwned();
    // Whose it is (knowledge-reach.ts); refused before anything is fetched when it would add to the owner's shared
    // knowledge for a caller the owner did not give it.
    const ownMetadata = knowledgeMakerMetadata(input.metadata);
    const uris = createKnowledgeIngestUriCanonicalizer(context, ownership, assertOwned, signal);
    // A URI role must settle before this route performs an external artifact fetch.
    if (input.uri) await uris.canonicalize(input.uri);
    assertOwned(); uris.assertCurrent();
    let artifactId = input.artifactId;
    let sourceUri = input.uri;
    if (!artifactId) {
      if (input.path) {
        const artifact = await context.artifactStore.create({
          path: input.path,
          metadata: {
            sourceConnector: input.connectorId ?? 'artifact',
            requestedAt: Date.now(),
          },
        }, { signal, assertCurrent: () => { assertOwned(); uris.assertCurrent(); } });
        assertOwned(); uris.assertCurrent();
        artifactId = artifact.id;
        sourceUri = input.path;
      } else if (input.uri) {
        const artifact = await context.artifactStore.create({
          uri: input.uri,
          allowPrivateHosts: input.allowPrivateHosts,
          metadata: {
            sourceConnector: input.connectorId ?? 'artifact',
            requestedAt: Date.now(),
          },
        }, { signal, assertCurrent: () => { assertOwned(); uris.assertCurrent(); } });
        assertOwned(); uris.assertCurrent();
        artifactId = artifact.id;
        sourceUri = artifact.sourceUri ?? input.uri;
      }
    }
    if (!artifactId) throw Object.assign(new Error('Artifact ingest requires artifactId, path, or uri.'), { status: 400 });
    const record = context.artifactStore.getRecord(artifactId);
    if (!record) throw Object.assign(new Error(`Unknown artifact: ${artifactId}`), { status: 400 });
    sourceUri ??= record.sourceUri;
    const canonicalUri = await uris.canonicalize(sourceUri ?? '') ?? undefined;
    const sourceId = reserveSourceId(context, canonicalUri, ownMetadata);
    uris.reserveSource(sourceId, canonicalUri);
    const sourceCurrent = knowledgeIngestGuard(context, sourceId, canonicalUri, signal);
    const assertCurrent = () => { assertOwned(); uris.assertCurrent(); sourceCurrent(); };
    assertCurrent();
    uris.attachArtifact(artifactId);
    const preparation = await capturePreparation(() => prepareKnowledgeExtraction(context, sourceId, artifactId, uris, { signal, assertCurrent }));
    const resolvedArtifactId = artifactId;
    const pending = stageKnowledgePendingSource(context, {
      id: sourceId,
      connectorId: input.connectorId ?? 'artifact',
      sourceType: input.sourceType ?? inferSourceTypeFromArtifact(record),
      title: input.title ?? record.filename,
      sourceUri,
      canonicalUri,
      tags: input.tags,
      folderPath: input.folderPath,
      status: 'pending',
      sessionId: input.sessionId,
      metadata: {
        ...(withPrivateHostIntent(ownMetadata, input.uri ? input.allowPrivateHosts : undefined) ?? {}),
        artifactMimeType: record.mimeType,
      },
    });
    context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
      sourceId: pending.id,
      connectorId: pending.connectorId,
      sourceType: pending.sourceType,
      uri: eventSafeUri(sourceUri),
    }), pending.sessionId);
    try {
      if (!preparation.ready) throw preparation.error;
      const result = await finalizeKnowledgeIngestedSource(context, {
        sourceId: pending.id,
        artifactId: resolvedArtifactId,
        preparedExtraction: preparation.token as PreparedKnowledgeExtraction,
        signal,
        inputTitle: input.title,
        sourceType: pending.sourceType,
        connectorId: pending.connectorId,
        tags: mergeTags(pending.tags, input.tags),
        folderPath: pending.folderPath,
        sessionId: input.sessionId ?? pending.sessionId,
        metadata: {
          ...pending.metadata,
          ...(withPrivateHostIntent(ownMetadata, input.uri ? input.allowPrivateHosts : undefined) ?? {}),
        },
      }, uris, { ...ownership, signal, assertCurrent: assertOwned });
      const issues = await lintCommittedIngest(context, result.source.id);
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
        sourceId: result.source.id,
        status: result.source.status,
        artifactId: result.artifactId,
        title: result.source.title,
      }), result.source.sessionId);
      return { ...result, issues };
    } catch (error) {
      const stopped = await settleStoppedIngest(context, pending, error, signal, ownership, 'Artifact ingest failed.');
      if (stopped) return stopped;
      const store = context.store, artifactStore = context.artifactStore;
      const sourceGuard = createSemanticWriteGuard(store);
      sourceGuard.source(pending.id);
      const assertDiagnosticCurrent = () => {
        assertCurrent(); sourceGuard.assertCurrent();
        if (context.store !== store || context.artifactStore !== artifactStore) throw new KnowledgeIngestStoppedError('changed');
      };
      const diagnostic = await readNormalizedError(error, { site: 'engine.knowledge.ingest-failure', signal, assertCurrent: assertDiagnosticCurrent });
      assertDiagnosticCurrent();
      const failed = await context.store.upsertSource({
        id: pending.id,
        connectorId: pending.connectorId,
        sourceType: pending.sourceType,
        title: pending.title,
        sourceUri: pending.sourceUri,
        canonicalUri: pending.canonicalUri,
        tags: pending.tags,
        folderPath: pending.folderPath,
        crawlError: diagnostic.summary,
        sessionId: pending.sessionId,
        ...failedIngestOutcome(context, pending),
      });
      const issues = await context.lint([failed.id]);
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
        sourceId: failed.id,
        error: failed.crawlError ?? 'Artifact ingest failed.',
      }), failed.sessionId);
      return { source: failed, issues };
    }
  });
}

export async function importKnowledgeBookmarksFromFile(
  context: KnowledgeIngestContext,
  input: { readonly path: string; readonly sessionId?: string | undefined; readonly allowPrivateHosts?: boolean | undefined; readonly metadata?: Record<string, unknown> | undefined },
): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'bookmark', content, input.sessionId, input.allowPrivateHosts, input.metadata);
}

export async function importKnowledgeUrlsFromFile(
  context: KnowledgeIngestContext,
  input: { readonly path: string; readonly sessionId?: string | undefined; readonly allowPrivateHosts?: boolean | undefined; readonly metadata?: Record<string, unknown> | undefined },
): Promise<KnowledgeBatchIngestResult> {
  const content = await readFile(input.path, 'utf-8');
  return ingestKnowledgeWithConnector(context, 'url-list', content, input.sessionId, input.allowPrivateHosts, input.metadata);
}

export async function ingestKnowledgeBookmarkSeeds(
  context: KnowledgeIngestContext,
  seeds: readonly KnowledgeBookmarkSeed[],
  sessionId?: string,
  sourceType: KnowledgeSourceType = 'bookmark',
  connectorId = 'bookmark',
  allowPrivateHosts?: boolean,
  metadata?: Record<string, unknown>,
): Promise<KnowledgeBatchIngestResult> {
  const sources: KnowledgeSourceRecord[] = [];
  const errors: string[] = [];
  let imported = 0;
  let failed = 0;
  const batch = deferPostIngestWork(context);
  for (const seed of seeds) {
    try {
      const result = await ingestKnowledgeUrl(batch.context, {
        url: seed.url,
        title: seed.title,
        tags: seed.tags,
        folderPath: seed.folderPath,
        sessionId,
        sourceType,
        connectorId,
        allowPrivateHosts,
        // Request-level provenance rides on every source of the batch; a seed's own keys stay unless the request names them.
        metadata: metadata || seed.metadata ? { ...seed.metadata, ...metadata } : undefined,
      });
      sources.push(result.source);
      const reason = ingestFailureReason(result.source);
      if (reason === undefined) imported += 1;
      else {
        failed += 1;
        errors.push(`${seed.url}: ${reason}`);
      }
    } catch (error) {
      failed += 1;
      errors.push(`${seed.url}: ${summarizeError(error)}`);
    }
  }
  errors.push(...await batch.flush());
  return { imported, failed, sources, errors };
}

export async function ingestKnowledgeWithConnector(
  context: KnowledgeIngestContext,
  connectorId: string,
  input: unknown,
  sessionId?: string,
  allowPrivateHosts?: boolean,
  metadata?: Record<string, unknown>,
): Promise<KnowledgeBatchIngestResult> {
  const resolved = await context.connectorRegistry.resolve(connectorId, input);
  return ingestKnowledgeBookmarkSeeds(
    context,
    resolved.seeds,
    sessionId,
    resolved.sourceType ?? 'other',
    resolved.connectorId ?? connectorId,
    allowPrivateHosts,
    metadata,
  );
}

export async function ingestKnowledgeConnectorInput(context: KnowledgeIngestContext, input: {
  readonly connectorId: string;
  readonly input?: unknown | undefined;
  readonly content?: string | undefined;
  readonly path?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly allowPrivateHosts?: boolean | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}): Promise<KnowledgeBatchIngestResult> {
  const connectorId = input.connectorId.trim();
  if (!connectorId) throw Object.assign(new Error('Missing connectorId'), { status: 400 });
  let resolvedInput: unknown;
  if (Object.hasOwn(input, 'input')) {
    resolvedInput = input.input;
  } else if (typeof input.content === 'string') {
    resolvedInput = input.content;
  } else if (typeof input.path === 'string' && input.path.trim()) {
    resolvedInput = await readFile(input.path, 'utf-8');
  } else {
    throw Object.assign(new Error('Connector ingest requires input, content, or path.'), { status: 400 });
  }
  return ingestKnowledgeWithConnector(context, connectorId, resolvedInput, input.sessionId, input.allowPrivateHosts, input.metadata);
}

/** What one refresh pass did: how many sources it tried, how many it refreshed, and why each failure failed. */
export interface KnowledgeRefreshResult {
  readonly attempted: number;
  readonly refreshed: number;
  readonly failed: readonly { readonly sourceId: string; readonly reason: string }[];
}

export async function refreshKnowledgeSources(context: KnowledgeIngestContext, sources: readonly KnowledgeSourceRecord[]): Promise<KnowledgeRefreshResult> {
  let refreshed = 0;
  const failed: { sourceId: string; reason: string }[] = [];
  const batch = deferPostIngestWork(context);
  for (const source of sources) {
    try {
      const result = await ingestKnowledgeUrl(batch.context, {
        url: source.sourceUri ?? source.canonicalUri ?? '',
        title: source.title,
        tags: source.tags,
        folderPath: source.folderPath,
        sessionId: source.sessionId,
        sourceType: source.sourceType,
        connectorId: source.connectorId,
        allowPrivateHosts: sourceAllowsPrivateHosts(source),
        refresh: true,
        metadata: {
          ...knowledgeRawRepresentation(source.metadata),
          refreshedAt: knowledgeClockIso(Date.now()),
        },
      });
      // A failed refresh keeps an indexed source indexed but records crawlError.
      const reason = ingestFailureReason(result.source);
      if (reason !== undefined) failed.push({ sourceId: source.id, reason });
      else if (result.source.status === 'indexed') refreshed += 1;
    } catch (error) {
      // One held or failing source must not stop the rest of the refresh or discard the count.
      const reason = summarizeError(error);
      logger.warn('Knowledge source refresh failed', { sourceId: source.id, error: reason });
      failed.push({ sourceId: source.id, reason });
    }
  }
  for (const error of await batch.flush()) logger.warn('Knowledge refresh follow-up failed', { error });
  return { attempted: sources.length, refreshed, failed };
}

/**
 * The fetch mode chosen at ingest is a stored intent. The daemon-level remote
 * fetch gate still decides whether a private host is actually reachable.
 */
function sourceAllowsPrivateHosts(source: KnowledgeSourceRecord): boolean | undefined {
  const intent = knowledgeRawRepresentation(source.metadata).knowledgeIntent;
  if (typeof intent !== 'object' || intent === null) return undefined;
  return (intent as Record<string, unknown>).remoteFetchMode === 'allow-private-hosts' ? true : undefined;
}

export function pickKnowledgeRefreshCandidates(
  context: { readonly store: { listSources(limit: number): KnowledgeSourceRecord[] } },
  mode: 'stale' | 'bookmark',
  explicitIds: readonly string[] | undefined,
  limit = 25,
): KnowledgeSourceRecord[] {
  const max = Math.max(1, limit);
  let sources = context.store.listSources(Number.MAX_SAFE_INTEGER);
  if (explicitIds?.length) {
    const wanted = new Set(explicitIds);
    sources = sources.filter((source) => wanted.has(source.id));
  }
  if (mode === 'bookmark') {
    sources = sources.filter((source) => source.connectorId === 'bookmark' || source.connectorId === 'url-list');
  } else {
    sources = sources.filter((source) => (
      !(source.status === 'stale' && !explicitIds?.length && isForgottenSource(source))
      && (source.status === 'stale' || source.status === 'failed' || isHeldIngest(source) || isSourcePastRefreshWindow(source))
    ));
  }
  return sources.filter((source) => isHttpUri(source.sourceUri)).slice(0, max);
}

/** Forgotten by an operator in review; only an explicit refresh may bring it back. */
function isForgottenSource(source: KnowledgeSourceRecord): boolean {
  const review = source.metadata.review;
  return source.metadata.staleReason === 'forgotten'
    || (typeof review === 'object' && review !== null && (review as Record<string, unknown>).action === 'forget');
}

/**
 * A refresh that cannot fetch must not demote a source whose earlier content
 * is still indexed: answers only accept indexed sources, so writing `failed`
 * would drop facts that remain valid. Such a source stays indexed with the
 * crawl error and failure time recorded (lint reports the crawl error); only a
 * source with no indexed content is recorded failed.
 */
function failedIngestOutcome(context: KnowledgeIngestContext, pending: KnowledgeSourceRecord): Pick<KnowledgeSourceUpsertInput, 'status' | 'metadata'> {
  const existing = context.store.getSource(pending.id);
  if (existing?.status !== 'indexed' || !context.store.getExtractionBySourceId(pending.id)) return { status: 'failed', metadata: pending.metadata };
  return { status: 'indexed', metadata: { ...knowledgeRawRepresentation(pending.metadata), lastCrawlFailedAt: knowledgeClockIso(Date.now()) } };
}

/**
 * The source is already published when this runs, so a lint failure must not
 * reach the failure path that stamps a crawl error on committed content.
 */
async function lintCommittedIngest(context: KnowledgeIngestContext, sourceId: string): Promise<readonly KnowledgeIssueRecord[]> {
  try { return await context.lint([sourceId]); }
  catch (error) {
    logger.warn('Knowledge source committed; the post-ingest lint failed.', { sourceId, error: summarizeError(error) });
    return [];
  }
}

/**
 * A batch ingests many sources: the lint of the sources it touched runs once
 * after the loop instead of once per source. `flush` returns one error line per
 * step that failed.
 */
function deferPostIngestWork(context: KnowledgeIngestContext): { readonly context: KnowledgeIngestContext; readonly flush: () => Promise<string[]> } {
  const touched = new Set<string>();
  let wholeStore = false;
  const deferred: KnowledgeIngestContext = {
    ...context,
    lint: async (sourceIds) => {
      if (sourceIds) for (const id of sourceIds) touched.add(id);
      else wholeStore = true;
      return [];
    },
  };
  return {
    context: deferred,
    flush: async () => {
      const errors: string[] = [];
      if (!wholeStore && touched.size === 0) return errors;
      try { await context.lint(wholeStore ? undefined : [...touched]); } catch (error) { errors.push(`lint: ${summarizeError(error)}`); }
      return errors;
    },
  };
}

/** Event streams reach every subscriber: drop credentials, query and fragment (signed links) from a remote URL. */
function eventSafeUri(uri: string | undefined): string | undefined {
  if (!uri || !/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) return uri;
  try {
    const parsed = new URL(uri);
    parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = '';
    return parsed.href;
  } catch { return undefined; }
}

/** Reserve identity without publishing pending or overwriting an existing source. */
/**
 * The source an ingest writes: the one already kept for this address when it is of the same kind of knowledge (the same
 * project, or both the owner's shared knowledge), else a new one. An addition in one project never rewrites, moves or
 * refreshes another project's source or the owner's shared one (knowledge-reach.ts), whoever sends the address.
 */
function reserveSourceId(context: KnowledgeIngestContext, canonicalUri: string | undefined, metadata: Record<string, unknown> | undefined): string {
  if (!canonicalUri) return `source-${crypto.randomUUID()}`;
  const project = typeof metadata?.[KNOWLEDGE_PROJECT_KEY] === 'string' ? String(metadata[KNOWLEDGE_PROJECT_KEY]).trim() || undefined : undefined;
  const first = context.store.getSourceByCanonicalUri(canonicalUri);
  if (first && knowledgeProjectOf(first) === project) return first.id;
  // The address is kept for another kind (or none): this kind's own copy, if it has one (an ingest is rare beside its
  // fetch and extraction; the walk is over the kept sources only).
  const own = first ? context.store.listSources(Number.MAX_SAFE_INTEGER)
    .find((source) => source.canonicalUri === canonicalUri && knowledgeProjectOf(source) === project) : undefined;
  return own?.id ?? `source-${crypto.randomUUID()}`;
}

type ExtractionPreparation =
  | { readonly ready: true; readonly token: PreparedKnowledgeExtraction | UnchangedKnowledgeContent }
  | { readonly ready: false; readonly error: unknown };

/**
 * Every preparation outcome reaches the ingest's one settle step, after the
 * pending source exists, so a stop or failure always gets a record and a
 * terminal event.
 */
async function capturePreparation(read: () => Promise<PreparedKnowledgeExtraction | UnchangedKnowledgeContent>): Promise<ExtractionPreparation> {
  try { return { ready: true, token: await read() }; }
  catch (error) { return { ready: false, error }; }
}

/** The caller's own check and the abort signal, with the reason each stop stands for. */
function ingestOwnerCheck(ownership: KnowledgeIngestOwnership, signal: AbortSignal | undefined): () => void {
  return () => {
    if (signal?.aborted) throw new KnowledgeIngestStoppedError('cancelled', undefined, { cause: signal.reason });
    try { ownership.assertCurrent?.(); }
    catch (error) {
      if (error instanceof KnowledgeIngestStoppedError) throw error;
      throw new KnowledgeIngestStoppedError('changed', undefined, { cause: error });
    }
  };
}

/**
 * Why an ingest of this source did not succeed, or undefined when it did: the
 * crawl error (a failed fetch or a hold, recorded even on a source that stays
 * indexed with its earlier content), `held` for a hold without one, or a
 * generic line for a failed source. A successful indexed write clears the
 * crawl error, so both batch paths count by this one rule.
 */
function ingestFailureReason(source: KnowledgeSourceRecord): string | undefined {
  if (source.crawlError) return source.crawlError;
  if (isHeldIngest(source)) return 'held';
  if (source.status === 'failed') return 'Knowledge ingest failed.';
  return undefined;
}

/** A held ingest: the source kept pending with why, so a refresh reads it again. */
function isHeldIngest(source: KnowledgeSourceRecord): boolean {
  return source.status === 'pending' && typeof source.metadata.ingestHold === 'object' && source.metadata.ingestHold !== null;
}

/**
 * Identical bytes on a scheduled refresh: the crawl time moves and nothing is
 * read, compiled or linted again. The duplicate fetched artifact is dropped.
 */
async function recordUnchangedRefresh(context: KnowledgeIngestContext, unchanged: UnchangedKnowledgeContent): Promise<{
  source: KnowledgeSourceRecord; artifactId: string; extraction: KnowledgeExtractionRecord; issues: readonly KnowledgeIssueRecord[]; unchanged: true;
}> {
  const { source, extraction } = unchanged;
  const updated = await context.store.upsertSource({
    id: source.id, connectorId: source.connectorId, sourceType: source.sourceType, status: 'indexed',
    lastCrawledAt: Date.now(),
    metadata: { ...knowledgeRawRepresentation(source.metadata), lastCrawlUnchangedAt: knowledgeClockIso(Date.now()) },
  });
  if (unchanged.artifactId !== source.artifactId) context.artifactStore.delete(unchanged.artifactId);
  return { source: updated, artifactId: source.artifactId ?? unchanged.artifactId, extraction, issues: [], unchanged: true };
}

/**
 * Settles an ingest that stopped: every started ingest gets a terminal event.
 * A cancellation, a host-owned operation and a refusal of the content rethrow;
 * a hold (model unsure or unavailable, or the source changed) keeps the source
 * pending with the reason. Returns undefined for an ordinary failure.
 */
async function settleStoppedIngest(context: KnowledgeIngestContext, pending: KnowledgeSourceRecord, error: unknown,
  signal: AbortSignal | undefined, ownership: KnowledgeIngestOwnership, failedText: string,
): Promise<{ source: KnowledgeSourceRecord; issues: readonly KnowledgeIssueRecord[] } | undefined> {
  const stop = knowledgeIngestStop(error, signal);
  const emitFailed = (message: string) => context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
    sourceId: pending.id, error: message,
  }), pending.sessionId);
  const refused = error instanceof KnowledgeUriCanonicalizationHeldError || error instanceof KnowledgeNodeActivationHeldError
    || error instanceof KnowledgeNodeMutationHeldError || error instanceof JudgmentInputError;
  // Host-owned operations never turn a revoked/precommit failure into a new
  // failed-source write, or overwrite a committed receipt after bookkeeping fails.
  if (ownership.assertCurrent || ownership.onCommitted || ownership.signal || refused || stop?.reason === 'cancelled') {
    emitFailed(stop?.message ?? (summarizeError(error) || failedText));
    throw stop?.reason === 'cancelled' ? stop : error;
  }
  if (!stop) return undefined;
  const existing = context.store.getSource(pending.id);
  const held = await context.store.upsertSource({
    id: pending.id, connectorId: pending.connectorId, sourceType: pending.sourceType, title: pending.title,
    sourceUri: pending.sourceUri, canonicalUri: pending.canonicalUri, tags: pending.tags, folderPath: pending.folderPath,
    sessionId: pending.sessionId, crawlError: stop.message,
    // Indexed content stays indexed; a source never indexed waits as pending.
    status: existing?.status === 'indexed' ? 'indexed' : 'pending',
    metadata: { ...knowledgeRawRepresentation(pending.metadata),
      ingestHold: { reason: stop.reason, ...(stop.detail ? { detail: stop.detail } : {}), at: knowledgeClockIso(Date.now()) } },
  });
  emitFailed(stop.message);
  return { source: held, issues: [] };
}
