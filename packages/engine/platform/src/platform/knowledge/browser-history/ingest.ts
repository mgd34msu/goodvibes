import { prepareObservedKnowledgeNodeInput } from '../store-node-observation.js';
import { createKnowledgeIngestUriCanonicalizer } from '../uri-canonicalization/ingest-owner.js';
import { KnowledgeUriCanonicalizationHeldError, type KnowledgeUriCanonicalizer } from '../uri-canonicalization/reader.js';
import {
  emitKnowledgeIngestCompleted,
  emitKnowledgeIngestFailed,
  emitKnowledgeIngestStarted,
} from '../../runtime/emitters/index.js';
import { summarizeError } from '../../utils/error-display.js';
import { compileKnowledgeSource } from '../ingest-compile.js';
import { KnowledgeIngestStoppedError } from '../ingest-stopped.js';
import { KnowledgeNodeActivationHeldError } from '../activation/types.js';
import { KnowledgeNodeMutationHeldError } from '../store-node-authority.js';
import { JudgmentInputError } from '../../gate/judgment-input.js';
import type { KnowledgeIngestContext } from '../ingest-context.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import { estimateTokens, isHttpUri, mergeTags, slugify } from '../shared.js';
import { discoverBrowserKnowledgeProfiles } from './discover.js';
import { readBrowserKnowledgeProfile } from './readers.js';
import type {
  BrowserKnowledgeCollectResult,
  BrowserKnowledgeEntry,
  BrowserKnowledgeFilter,
  BrowserKnowledgeIngestOutcome,
  BrowserKnowledgeIngestResult,
  BrowserKnowledgeSourceKind,
} from './types.js';

export interface BrowserKnowledgeIngestOptions extends BrowserKnowledgeFilter {
  readonly sessionId?: string | undefined;
  readonly connectorId?: string | undefined;
  /** Request-level provenance recorded on every source this run writes; the browser observations the run derives itself win on a clash. */
  readonly metadata?: Record<string, unknown> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

interface BrowserKnowledgeAggregate {
  readonly canonicalUri: string;
  readonly entries: BrowserKnowledgeEntry[];
  readonly sourceKinds: readonly BrowserKnowledgeSourceKind[];
  readonly browsers: readonly string[];
  readonly profileKeys: readonly string[];
  readonly folders: readonly string[];
  readonly firstRecordedAt?: number | undefined;
  readonly lastRecordedAt?: number | undefined;
  readonly visitCount: number;
}

function timestampForEntry(entry: BrowserKnowledgeEntry): number | undefined {
  return entry.sourceKind === 'history' ? entry.visitedAtMs : entry.addedAtMs;
}

function sourceTypeForAggregate(aggregate: BrowserKnowledgeAggregate): KnowledgeSourceType {
  return aggregate.sourceKinds.includes('bookmark') ? 'bookmark' : 'history';
}

function titleForAggregate(aggregate: BrowserKnowledgeAggregate): string {
  return aggregate.entries.find((entry) => entry.title)?.title
    ?? aggregate.entries[0]?.url
    ?? aggregate.canonicalUri;
}

function folderForAggregate(aggregate: BrowserKnowledgeAggregate): string {
  return aggregate.folders[0] ?? `/browser/${aggregate.browsers[0] ?? 'local'}`;
}

function tagsForAggregate(aggregate: BrowserKnowledgeAggregate): string[] {
  return mergeTags([
    'browser',
    ...aggregate.browsers,
    ...aggregate.sourceKinds.map((kind) => kind === 'history' ? 'browser-history' : 'browser-bookmark'),
  ]);
}

function metadataForAggregate(aggregate: BrowserKnowledgeAggregate): Record<string, unknown> {
  return {
    browserKnowledge: true,
    browserSourceKinds: [...aggregate.sourceKinds],
    browserKinds: [...aggregate.browsers],
    browserProfiles: [...aggregate.profileKeys],
    browserFolders: [...aggregate.folders],
    browserObservationCount: aggregate.entries.length,
    browserVisitCount: aggregate.visitCount,
    ...(typeof aggregate.firstRecordedAt === 'number' ? { browserFirstRecordedAt: aggregate.firstRecordedAt } : {}),
    ...(typeof aggregate.lastRecordedAt === 'number' ? { browserLastRecordedAt: aggregate.lastRecordedAt } : {}),
    browserObservations: aggregate.entries.slice(0, 32).map((entry) => ({
      sourceKind: entry.sourceKind,
      browser: entry.browser,
      browserFamily: entry.family,
      profileName: entry.profileName,
      profilePath: entry.profilePath,
      title: entry.title,
      rawId: entry.rawId,
      recordedAt: timestampForEntry(entry),
      ...(entry.sourceKind === 'history' ? {
        visitCount: entry.visitCount,
        transition: entry.transition,
      } : {
        folderPath: entry.folderPath,
      }),
    })),
  };
}

function describeAggregate(aggregate: BrowserKnowledgeAggregate): string {
  const parts = [
    aggregate.sourceKinds.includes('bookmark') && aggregate.sourceKinds.includes('history')
      ? 'Browser-local page observed in bookmarks and history.'
      : aggregate.sourceKinds.includes('bookmark')
        ? 'Browser-local page observed in bookmarks.'
        : 'Browser-local page observed in browsing history.',
    `Browsers: ${aggregate.browsers.join(', ')}.`,
    `Profiles: ${aggregate.profileKeys.join(', ')}.`,
    aggregate.visitCount > 0 ? `Visit count: ${aggregate.visitCount}.` : '',
    typeof aggregate.lastRecordedAt === 'number' ? `Last recorded: ${new Date(aggregate.lastRecordedAt).toISOString()}.` : '',
    aggregate.folders.length ? `Folders: ${aggregate.folders.slice(0, 4).join(', ')}.` : '',
    `URL: ${aggregate.canonicalUri}`,
  ].filter(Boolean);
  return parts.join(' ');
}

function extractionForAggregate(
  aggregate: BrowserKnowledgeAggregate,
  source: KnowledgeSourceRecord,
): Omit<KnowledgeExtractionRecord, 'id' | 'sourceId' | 'createdAt' | 'updatedAt'> {
  const summary = describeAggregate(aggregate);
  return {
    extractorId: 'browser-history',
    format: 'text',
    title: titleForAggregate(aggregate),
    summary,
    excerpt: summary,
    sections: mergeTags([
      ...aggregate.sourceKinds.map((kind) => `browser ${kind}`),
      ...aggregate.browsers,
      ...aggregate.folders,
    ]).slice(0, 24),
    links: [aggregate.canonicalUri],
    estimatedTokens: estimateTokens(summary, aggregate.canonicalUri, titleForAggregate(aggregate)),
    structure: {
      sourceKinds: [...aggregate.sourceKinds],
      browsers: [...aggregate.browsers],
      profiles: [...aggregate.profileKeys],
      canonicalUri: source.canonicalUri,
    },
    metadata: metadataForAggregate(aggregate),
  };
}

async function aggregateBrowserEntries(entries: readonly BrowserKnowledgeEntry[], uris: KnowledgeUriCanonicalizer): Promise<BrowserKnowledgeAggregate[]> {
  const buckets = new Map<string, BrowserKnowledgeEntry[]>();
  // Settle the complete URI batch before aggregation can collapse any entry.
  const canonical = await uris.canonicalizeAll(entries.map((entry) => entry.url));
  uris.assertCurrent();
  for (const [index, entry] of entries.entries()) {
    if (!isHttpUri(entry.url)) continue;
    const canonicalUri = canonical[index] ?? entry.url;
    const bucket = buckets.get(canonicalUri) ?? [];
    bucket.push(entry);
    buckets.set(canonicalUri, bucket);
  }

  return [...buckets.entries()].map(([canonicalUri, bucket]) => {
    const sorted = [...bucket].sort((a, b) => (timestampForEntry(b) ?? 0) - (timestampForEntry(a) ?? 0));
    const timestamps = sorted.map(timestampForEntry).filter((value): value is number => typeof value === 'number');
    const kinds = new Set(sorted.map((entry) => entry.sourceKind));
    const sourceKinds = (['history', 'bookmark'] as const).filter((kind) => kinds.has(kind));
    const browsers = mergeTags(sorted.map((entry) => entry.browser));
    const profileKeys = mergeTags(sorted.map((entry) => `${entry.browser}:${entry.profileName}`));
    const folders = mergeTags(sorted.flatMap((entry) => entry.sourceKind === 'bookmark' && entry.folderPath ? [entry.folderPath] : []));
    const visitCount = sorted.reduce((sum, entry) => (
      entry.sourceKind === 'history' ? sum + Math.max(1, entry.visitCount ?? 1) : sum
    ), 0);
    return {
      canonicalUri,
      entries: sorted,
      sourceKinds,
      browsers,
      profileKeys,
      folders,
      ...(timestamps.length ? { firstRecordedAt: Math.min(...timestamps), lastRecordedAt: Math.max(...timestamps) } : {}),
      visitCount,
    };
  }).sort((a, b) => (b.lastRecordedAt ?? 0) - (a.lastRecordedAt ?? 0));
}

async function captureAggregate(
  context: KnowledgeIngestContext,
  aggregate: BrowserKnowledgeAggregate,
  options: Pick<BrowserKnowledgeIngestOptions, 'connectorId' | 'sessionId' | 'metadata'>,
  onSourceStored: (source: KnowledgeSourceRecord) => void,
  uris: KnowledgeUriCanonicalizer,
  sourceId: string,
  profileNodes: Map<string, string>,
): Promise<{ source: KnowledgeSourceRecord; extraction: KnowledgeExtractionRecord }> {
  uris.assertCurrent();
  const existing = context.store.getSourceByCanonicalUri(aggregate.canonicalUri);
  const sourceType = existing?.sourceType ?? sourceTypeForAggregate(aggregate);
  const connectorId = existing?.connectorId ?? options.connectorId ?? 'browser-local';
  const summary = describeAggregate(aggregate);
  const source = await context.store.upsertSource({
    id: existing?.id ?? sourceId,
    connectorId,
    sourceType,
    title: existing?.title ?? titleForAggregate(aggregate),
    sourceUri: existing?.sourceUri ?? aggregate.canonicalUri,
    canonicalUri: aggregate.canonicalUri,
    summary: existing?.summary ?? summary,
    description: existing?.description ?? summary,
    tags: mergeTags(existing?.tags, tagsForAggregate(aggregate)),
    folderPath: existing?.folderPath ?? folderForAggregate(aggregate),
    status: 'indexed',
    artifactId: existing?.artifactId,
    // Browser observations are source metadata, not the fetched page bytes.
    // Keep a real existing content pin, but don't invent one from visit IDs.
    contentHash: existing?.contentHash,
    lastCrawledAt: existing?.lastCrawledAt ?? Date.now(),
    sessionId: options.sessionId ?? existing?.sessionId,
    metadata: {
      ...(existing?.metadata ?? {}),
      ...(options.metadata ?? {}),
      ...metadataForAggregate(aggregate),
    },
  }, uris.assertCurrent);

  onSourceStored(source);
  uris.assertCurrent();

  // The browser-history extraction text carries the visit count and last-recorded time, so it is
  // rewritten when those change rather than frozen at the first import. An extraction from any other
  // extractor (a fetched page, say) is richer than this summary and is never replaced by it.
  const existingExtraction = context.store.getExtractionBySourceId(source.id);
  const nextExtraction = extractionForAggregate(aggregate, source);
  const extraction = existingExtraction && (existingExtraction.extractorId !== 'browser-history'
    || (existingExtraction.summary === nextExtraction.summary && existingExtraction.title === nextExtraction.title))
    ? existingExtraction
    : await context.store.upsertExtraction({
      ...(existingExtraction ? { id: existingExtraction.id } : {}),
      sourceId: source.id,
      ...nextExtraction,
    }, uris.assertCurrent);
  uris.assertCurrent();

  // One write per profile and kind: a URL visited many times would otherwise
  // rewrite the same node and edge once per visit. Entries are newest first,
  // so the first one kept is the latest observation the edge should record.
  const observed = new Map<string, BrowserKnowledgeEntry>();
  for (const entry of aggregate.entries) {
    const key = JSON.stringify([entry.browser, entry.profilePath, entry.profileName, entry.sourceKind]);
    if (!observed.has(key)) observed.set(key, entry);
  }
  for (const entry of observed.values()) {
    // Each browser profile's node is written once per run; later URLs of the
    // same profile only add their edge to it.
    const profileKey = JSON.stringify([entry.browser, entry.profilePath, entry.profileName]);
    let browserNodeId = profileNodes.get(profileKey);
    if (!browserNodeId) {
      const browserInput = prepareObservedKnowledgeNodeInput(context.store, {
        kind: 'source_group',
        slug: slugify(`browser-${entry.browser}-${entry.profileName}`),
        title: `${entry.browser} ${entry.profileName}`,
        summary: `Local ${entry.browser} browser profile imported from ${entry.profilePath}.`,
        aliases: [entry.browser, entry.profileName],
        status: 'active',
        confidence: 85,
        metadata: {
          browser: entry.browser,
          browserFamily: entry.family,
          browserProfilePath: entry.profilePath,
        },
      }, 'browser-profile', source, () => context.store.getSource(source.id));
      const nodes = await context.store.prepareNodeWrites([browserInput], { assertCurrent: uris.assertCurrent });
      browserNodeId = (await context.store.upsertPreparedNode(nodes, 0)).id;
      profileNodes.set(profileKey, browserNodeId);
    }
    await context.store.upsertEdge({
      fromKind: 'source',
      fromId: source.id,
      toKind: 'node',
      toId: browserNodeId,
      relation: entry.sourceKind === 'history' ? 'visited_in_browser_profile' : 'bookmarked_in_browser_profile',
      weight: timestampForEntry(entry) ? 1.2 : 1,
      metadata: {
        sourceKind: entry.sourceKind,
        recordedAt: timestampForEntry(entry),
        browser: entry.browser,
        profileName: entry.profileName,
        ...(entry.sourceKind === 'bookmark' && entry.folderPath ? { folderPath: entry.folderPath } : {}),
      },
    }, uris.assertCurrent);
  }

  return { source, extraction };
}

export async function collectBrowserKnowledge(
  filter: BrowserKnowledgeFilter = {},
): Promise<BrowserKnowledgeCollectResult> {
  const profiles = await discoverBrowserKnowledgeProfiles(filter);
  const entries: BrowserKnowledgeEntry[] = [];
  const errors: string[] = [];
  const perProfileLimit = Math.max(1, Math.ceil((filter.limit ?? 1000) / Math.max(1, profiles.length)));
  const selected = filter.sourceKinds ?? { kind: 'default' as const };
  const sourceKinds: readonly BrowserKnowledgeSourceKind[] = selected.kind === 'default' ? ['history', 'bookmark']
    : selected.kind === 'none' ? [] : selected.values;

  for (const profile of profiles) {
    try {
      const found = await readBrowserKnowledgeProfile(profile, {
        limit: perProfileLimit,
        sinceMs: filter.sinceMs,
        sourceKinds,
      });
      entries.push(...found);
    } catch (error) {
      errors.push(`${profile.browser}/${profile.profileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  entries.sort((a, b) => (timestampForEntry(b) ?? 0) - (timestampForEntry(a) ?? 0));
  // Recency is not comparable across kinds: bookmarks are old by nature, so a
  // shared cut would drop them first. Each kind keeps its own newest `limit`.
  const limit = filter.limit ?? entries.length;
  const history = entries.filter((entry) => entry.sourceKind === 'history').slice(0, limit);
  const bookmarks = entries.filter((entry) => entry.sourceKind === 'bookmark').slice(0, limit);
  return {
    profiles,
    entries: [...history, ...bookmarks],
    errors,
  };
}

export async function ingestBrowserKnowledge(
  context: KnowledgeIngestContext,
  options: BrowserKnowledgeIngestOptions = {},
): Promise<BrowserKnowledgeIngestResult> {
  await context.store.init();
  const uris = createKnowledgeIngestUriCanonicalizer(context, options);
  const { signal: _signal, assertCurrent: _assertCurrent, ...filter } = options;
  // The collected entries are this run's own values; nothing else holds them,
  // so they are not re-checked per URL. The signal and the URI owner are.
  const collected = await collectBrowserKnowledge(filter);
  uris.assertCurrent();
  const aggregates = await aggregateBrowserEntries(collected.entries, uris);
  uris.assertCurrent();
  const profileNodes = new Map<string, string>();
  const sources: KnowledgeSourceRecord[] = [];
  const capturedSources: KnowledgeSourceRecord[] = [];
  const outcomes: BrowserKnowledgeIngestOutcome[] = [];
  const errors = [...collected.errors];
  let imported = 0;
  let failed = 0;

  for (const aggregate of aggregates) {
    options.signal?.throwIfAborted();
    uris.assertCurrent();
    let sourceId: string | undefined;
    let captureCompleted = false;
    // One id names the operation in STARTED, COMPLETED and FAILED, so a
    // subscriber can correlate them; a new source is created under it.
    const operationId = context.store.getSourceByCanonicalUri(aggregate.canonicalUri)?.id ?? `source-${crypto.randomUUID()}`;
    try {
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestStarted(bus, ctx, {
        sourceId: operationId,
        connectorId: options.connectorId ?? 'browser-local',
        sourceType: sourceTypeForAggregate(aggregate),
        uri: aggregate.canonicalUri,
      }), options.sessionId);
      const { source, extraction } = await captureAggregate(context, aggregate, options, (stored) => { sourceId = stored.id; }, uris, operationId, profileNodes);
      captureCompleted = true;
      capturedSources.push(source);
      await compileKnowledgeSource(context, source, extraction, { signal: options.signal, assertCurrent: uris.assertCurrent });
      sources.push(source);
      imported += 1;
      outcomes.push({ canonicalUri: aggregate.canonicalUri, sourceId: source.id, capture: 'completed', compilation: 'completed' });
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestCompleted(bus, ctx, {
        sourceId: source.id,
        status: source.status,
        title: source.title,
      }), source.sessionId);
    } catch (error) {
      if (error instanceof KnowledgeUriCanonicalizationHeldError || options.signal?.aborted) throw error;
      uris.assertCurrent();
      const diagnostic = { summary: summarizeError(error) };
      failed += 1;
      const held = error instanceof KnowledgeIngestStoppedError || error instanceof KnowledgeNodeActivationHeldError
        || error instanceof KnowledgeNodeMutationHeldError || error instanceof JudgmentInputError;
      const capture = captureCompleted ? 'completed' : sourceId ? 'partial' : 'failed';
      const compilation = captureCompleted ? held ? 'held' : 'failed' : 'not-attempted';
      const message = captureCompleted
        ? `Browser capture retained; compilation ${compilation}: ${diagnostic.summary}`
        : `Browser capture ${capture === 'partial' ? 'partially retained' : 'failed'}; compilation not attempted: ${diagnostic.summary}`;
      outcomes.push({ canonicalUri: aggregate.canonicalUri, ...(sourceId ? { sourceId } : {}), capture, compilation, error: message });
      errors.push(`${aggregate.canonicalUri}: ${message}`);
      context.emitIfReady((bus, ctx) => emitKnowledgeIngestFailed(bus, ctx, {
        sourceId: sourceId ?? operationId,
        error: message,
      }), options.sessionId);
    }
  }

  await context.syncReviewedMemory();
  await context.lint();

  return {
    imported,
    failed,
    sources,
    captured: capturedSources.length,
    capturedSources,
    outcomes,
    errors,
    profiles: collected.profiles,
  };
}
