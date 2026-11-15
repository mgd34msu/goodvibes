import { notifyKnowledgeCommitted } from '../commit-notification.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { createHomeGraphSourceIdentityPlanner, type HomeGraphSourceIdentity } from './source-identity-plan.js';
import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { KnowledgeScopeSelectionHeldError } from '../scope-selection.js';
import { createKnowledgeExtractionOwner } from '../extraction-ownership.js';
import type { KnowledgeIngestOwnership } from '../ingest-context.js';
import { KnowledgeWebGapRepairHeldError } from '../semantic/web-gap-repair/types.js';
import { registerGeneratedKnowledgeExtractionReferences } from '../source-structural-references.js';
import { captureStrictRepairJson } from '../semantic/web-gap-repair/admission.js';
import { knowledgeSourceCrawledNow, sameKnowledgeRecord } from '../store-record-representation.js';
import { registerGeneratedKnowledgeSourceReferences } from '../source-structural-references.js';
import { ConfigurationError, GoodVibesError, RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { acquireArtifactPublication, type ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactOriginalObservation, ArtifactDescriptor } from '../../artifacts/types.js';
import { logger } from '../../utils/logger.js';
import { yieldEvery, yieldToEventLoop } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  belongsToSpace,
  readRecord,
  uniqueStrings,
} from './helpers.js';
import { refreshHomeGraphQualityIssues } from './quality.js';
import { reviewHomeGraphFact, type HomeGraphReviewResult } from './review.js';
import {
  inferHomeGraphSourceType,
  readHomeGraphState,
  safeHomeGraphFilename,
} from './state.js';
import { answerHomeGraphQuery } from './ask.js';
import type { KnowledgeSemanticService } from '../semantic/index.js';
import {
  autoLinkHomeGraphSource,
  autoLinkHomeGraphSourceWithOutcome,
} from './auto-link.js';
import {
  devicePassportSourceIds,
  generateHomeGraphPacket,
  generateHomeGraphRoomPage,
  refreshHomeGraphDevicePassport,
} from './generated-pages.js';
import { HomeGraphSpaceWork } from './space-work.js';
import { refreshDevicePagesForHomeGraphAsk } from './ask-page-refresh.js';
import { runHomeGraphReindex } from './reindex.js';
import { listHomeGraphPages } from './pages.js';
import { browseHomeGraph, listHomeGraphSources } from './inventory.js';
import { mapHomeGraph } from './map-view.js';
import { getHomeGraphStatus } from './status.js';
import { resetHomeGraphSpace } from './reset.js';
import { linkHomeGraphKnowledge, unlinkHomeGraphKnowledge } from './link.js';
import { exportHomeGraphSpace, importHomeGraphSpace } from './import-export.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from './extension.js';
import {
  cancelHomeGraphRefinementTask,
  getHomeGraphRefinementTask,
  listHomeGraphRefinementTasks,
  runHomeGraphRefinement,
} from './refinement.js';
import type { HomeGraphTriageOptions } from './triage.js';
import { knowledgeExtractionIsReadable } from '../extraction-policy.js';
import {
  readHomeGraphSearchState,
  selectHomeGraphExtractionRepairCandidates,
} from './search.js';
import {
  enrichAndImproveHomeGraphSource,
  enrichUnenrichedHomeGraphSources,
  HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS,
  runHomeGraphSyncSelfImprovementRound,
} from './sync-self-improvement.js';
import { readHomeGraphSearchSelection } from './search-judgments.js';
import { resolveHomeGraphResetSpace, resolveReadableHomeGraphSpace, resolveWritableHomeGraphSpace } from './space-selection.js';
import { runHomeGraphSnapshotSync } from './sync.js';
import { autoLinkExistingHomeGraphSources, extractHomeGraphArtifact, prepareHomeGraphArtifactExtraction, storeHomeGraphArtifactExtraction } from './extraction.js';
import type {
  HomeGraphAskInput, HomeGraphAskResult, HomeGraphDevicePassportResult, HomeGraphExport,
  HomeGraphIngestArtifactInput, HomeGraphIngestNoteInput, HomeGraphIngestResult, HomeGraphIngestUrlInput,
  HomeGraphKnowledgeTarget, HomeGraphLinkInput, HomeGraphLinkResult, HomeGraphUnlinkResult,
  HomeGraphMapInput, HomeGraphMapResult, HomeGraphProjectionInput, HomeGraphProjectionResult,
  HomeGraphPageListResult, HomeGraphReindexInput, HomeGraphReindexResult, HomeGraphResetInput, HomeGraphResetResult, HomeGraphReviewInput, HomeGraphSpaceInput,
  HomeGraphSnapshotInput, HomeGraphStatus, HomeGraphSyncResult,
} from './types.js';

/** Queue item of the post-sync improvement rounds of a space. */
const SYNC_IMPROVE_ITEM = 'sync-improve';
/** How long a device passport request may spend enriching its own linked sources that were never enriched. */
const PASSPORT_ENRICHMENT_BUDGET_MS = 20_000;

export class HomeGraphService {
  private readonly autoLinkController = new AbortController();
  private readonly activeReindex = new Map<string, { readonly key: string; readonly run: Promise<HomeGraphReindexResult> }>();
  private readonly syncTails = new Map<string, Promise<void>>();
  private readonly resettingSpaces = new Set<string>();
  private readonly spaceWrites = new Map<string, Set<Promise<unknown>>>();
  private readonly foregroundRuns = new Set<Promise<unknown>>();
  /** What each space is doing: foreground verbs first, background items when the space is idle. */
  private readonly work: HomeGraphSpaceWork;
  constructor(
    private readonly store: KnowledgeStore,
    private readonly artifactStore: ArtifactStore,
    private readonly options: {
      readonly semanticService?: KnowledgeSemanticService;
      /**
       * MemoryGovernor admission gate: the HTTP-exposed ingest verbs run the
       * whole ingestion pipeline (artifact writes, extraction, enrichment),
       * at the critical tier they refuse with an honest structured reason.
       */
      readonly admitExpensiveWork?: ((label: string) => { allowed: boolean; reason?: string | undefined }) | undefined;
    } = {},
  ) {
    this.options.semanticService?.addObjectProfiles(HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles);
    this.work = new HomeGraphSpaceWork({
      signal: this.autoLinkController.signal,
      paused: () => this.options.semanticService?.isBackgroundWorkPaused() ?? false,
      report: (event, error, metadata) => this.reportBackgroundError(event, error, metadata),
    });
  }

  /** Refuse expensive work at the critical memory tier (see MemoryGovernor), with one typed refusal on every costly verb. */
  private requireAdmission(label: string): void {
    const decision = this.options.admitExpensiveWork?.(label);
    if (decision && !decision.allowed) {
      throw new RefusalError(refusal({
        code: 'HOMEGRAPH_MEMORY_PRESSURE', status: 503, retryable: true, retryAfterMs: 30_000,
        state: `${label} did not start`,
        reason: decision.reason ?? 'The daemon is under critical memory pressure',
        next: ['Retry once memory pressure eases, or free memory by closing idle sessions'],
      }), { category: 'service', source: 'runtime' });
    }
  }

  async dispose(): Promise<void> {
    this.autoLinkController.abort();
    // Accepted foreground work owns this store until its cancelled work has
    // drained. Its caller retains the outcome; disposal only waits for release.
    await Promise.all([...this.foregroundRuns].map(run => run.then(() => undefined, () => undefined)));
    await this.work.cancel();
  }

  async status(input: { readonly installationId?: string; readonly knowledgeSpaceId?: string } = {}): Promise<HomeGraphStatus> {
    return this.ownForegroundOperation(async () => {
      return getHomeGraphStatus(this.store, input);
    });
  }

  async syncSnapshot(input: HomeGraphSnapshotInput): Promise<HomeGraphSyncResult> {
    return this.ownForegroundOperation((writes) => withConfiguredDecisionModelPolicy(async () => {
      this.autoLinkController.signal.throwIfAborted();
      this.requireAdmission('home-graph sync');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const target = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(target.spaceId);
      // One snapshot per space at a time: a retried sync waits for the first
      // instead of racing it through half-written identities.
      const previous = this.syncTails.get(target.spaceId) ?? Promise.resolve();
      const turn = previous.then(async () => {
        this.autoLinkController.signal.throwIfAborted();
        return runHomeGraphSnapshotSync({
          store: this.store,
          artifactStore: this.artifactStore,
          snapshot: { ...input, knowledgeSpaceId: target.spaceId },
          signal: this.autoLinkController.signal,
        });
      });
      const tail = turn.then(() => undefined, () => undefined);
      this.syncTails.set(target.spaceId, tail);
      let result: HomeGraphSyncResult;
      try { result = await turn; }
      finally { if (this.syncTails.get(target.spaceId) === tail) this.syncTails.delete(target.spaceId); }
      this.autoLinkController.signal.throwIfAborted();
      this.scheduleSyncSelfImprovement(result.spaceId, result.installationId);
      return result;
    }));
  }

  async ingestUrl(input: HomeGraphIngestUrlInput, ownership: KnowledgeIngestOwnership = {}): Promise<HomeGraphIngestResult> {
    return this.ownForegroundOperation(async (writes) => {
      return withConfiguredDecisionModelPolicy(async () => {
        const { signal: callerSignal, assertCurrent, onCommitted, deferSemanticEnrichment } = ownership;
        const signal = callerSignal ? AbortSignal.any([this.autoLinkController.signal, callerSignal]) : this.autoLinkController.signal;
        const owned = !!(callerSignal || assertCurrent || onCommitted || deferSemanticEnrichment);
        const current = () => {
          if (ownership.signal !== callerSignal || ownership.assertCurrent !== assertCurrent || ownership.onCommitted !== onCommitted
            || ownership.deferSemanticEnrichment !== deferSemanticEnrichment) throw new KnowledgeWebGapRepairHeldError('stale');
          signal?.throwIfAborted(); const result: unknown = assertCurrent?.(); if (result !== undefined) { drainOwned(result); throw new KnowledgeWebGapRepairHeldError('malformed'); }
        };
        current();
        this.requireAdmission('home-graph url ingestion');
        await this.store.init(); current();
        const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input), url = input.url;
        writes.begin(spaceId);
        this.assertIngestTarget(spaceId, input.target);
        const identity = createHomeGraphSourceIdentityPlanner(this.store).prepare({ spaceId, role: 'url', locator: 'uri', value: url });
        const publication = await this.artifactStore.createForPublication({
          uri: url,
          allowPrivateHosts: input.allowPrivateHosts,
          metadata: buildHomeGraphMetadata(spaceId, installationId, {
            homeGraphSourceKind: 'url',
            requestedAt: Date.now(),
          }),
        }, { signal, assertCurrent: current });
        return this.withIngestArtifactPublication(publication, true, (artifact, assertArtifactCurrent) => this.ingestCreatedArtifact({
          spaceId,
          installationId,
          artifact,
          title: input.title,
          sourceUri: url,
          sourceType: inferHomeGraphSourceType(input.tags, 'url'),
          tags: ['homeassistant', 'home-graph', ...(input.tags ?? [])],
          target: input.target,
          metadata: {
            ...(input.metadata ?? {}),
            homeGraphSourceKind: 'url',
            homeGraphArtifactOwned: true,
          },
        }, owned ? { ...ownership, signal, assertCurrent: current } : ownership, identity, assertArtifactCurrent));
      });
    });
  }

  async ingestNote(input: HomeGraphIngestNoteInput): Promise<HomeGraphIngestResult> {
    return this.ownForegroundOperation(async (writes) => {
      return withConfiguredDecisionModelPolicy(async () => {
        this.requireAdmission('home-graph note ingestion');
        await this.store.init();
        const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
        writes.begin(spaceId);
        this.assertIngestTarget(spaceId, input.target);
        const title = input.title ?? `Home Assistant note ${new Date().toISOString()}`;
        this.autoLinkController.signal.throwIfAborted();
        const publication = await this.artifactStore.createForPublication({
          kind: 'document',
          mimeType: 'text/markdown',
          filename: `${safeHomeGraphFilename(title)}.md`,
          text: input.body,
          metadata: buildHomeGraphMetadata(spaceId, installationId, {
            homeGraphSourceKind: 'note',
            category: input.category ?? 'note',
          }),
        }, { signal: this.autoLinkController.signal });
        return this.withIngestArtifactPublication(publication, true, (artifact, assertArtifactCurrent) => this.ingestCreatedArtifact({
          spaceId,
          installationId,
          artifact,
          title,
          sourceType: 'document',
          tags: uniqueStrings(['homeassistant', 'home-graph', 'note', input.category, ...(input.tags ?? [])]),
          target: input.target,
          metadata: {
            ...(input.metadata ?? {}),
            homeGraphSourceKind: 'note',
            category: input.category ?? 'note',
            homeGraphArtifactOwned: true,
          },
        }, {}, undefined, assertArtifactCurrent));
      });
    });
  }

  async ingestArtifact(input: HomeGraphIngestArtifactInput): Promise<HomeGraphIngestResult> {
    return this.ownForegroundOperation(async (writes) => {
      return withConfiguredDecisionModelPolicy(async () => {
        this.requireAdmission('home-graph artifact ingestion');
        await this.store.init();
        const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
        writes.begin(spaceId);
        this.assertIngestTarget(spaceId, input.target);
        const artifactId = input.artifactId, uri = input.uri, path = input.path;
        this.autoLinkController.signal.throwIfAborted();
        const knownUri = uri ?? path;
        const identity = knownUri ? createHomeGraphSourceIdentityPlanner(this.store).prepare({ spaceId, role: 'artifact', locator: 'uri', value: knownUri }) : undefined;
        const publication = artifactId ? await (async () => {
          const artifact = this.artifactStore.get(artifactId);
          if (!artifact) throw new GoodVibesError('Unknown Home Graph artifact.', { category: 'not_found', source: 'runtime', recoverable: false });
          const original = this.artifactStore.captureOriginal(artifactId), lease = await acquireArtifactPublication(original, this.autoLinkController.signal);
          try { original.assertCurrent(); lease.assertCurrent(); return { artifact, original, lease }; }
          catch (error) { try { lease.release(); } catch { logger.warn('Home Graph failed original artifact claim could not be released.'); } throw error; }
        })() : await this.artifactStore.createForPublication({
          path, uri, allowPrivateHosts: input.allowPrivateHosts,
          metadata: buildHomeGraphMetadata(spaceId, installationId, { homeGraphSourceKind: 'artifact', requestedAt: Date.now() }),
        }, { signal: this.autoLinkController.signal });
        return this.withIngestArtifactPublication(publication, !artifactId, (artifact, assertArtifactCurrent) => this.ingestCreatedArtifact({
          spaceId,
          installationId,
          artifact,
          title: input.title,
          sourceUri: knownUri ?? artifact.sourceUri,
          sourceType: inferHomeGraphSourceType(input.tags, 'document'),
          tags: ['homeassistant', 'home-graph', 'artifact', ...(input.tags ?? [])],
          target: input.target,
          metadata: {
            ...(input.metadata ?? {}),
            homeGraphSourceKind: 'artifact',
            // A caller-supplied artifact id is borrowed: a reset never removes it.
            homeGraphArtifactOwned: !artifactId,
          },
        }, {}, identity, assertArtifactCurrent));
      });
    });
  }

  async linkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphLinkResult> {
    return this.ownForegroundOperation(async (writes) => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return linkHomeGraphKnowledge(this.store, { ...input, spaceId, installationId });
    });
  }

  async unlinkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphUnlinkResult> {
    return this.ownForegroundOperation(async (writes) => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return unlinkHomeGraphKnowledge(this.store, { ...input, spaceId, installationId });
    });
  }

  async ask(input: HomeGraphAskInput): Promise<HomeGraphAskResult> {
    return this.ownForegroundOperation(async (writes) => {
      requireDecisionFeature('verified Home Graph answers; use browse or local knowledge search during Classic');
      this.requireAdmission('home-graph ask');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
      // A read-only ask writes nothing and takes no lane. Any other ask may
      // repair a stale extraction first, so a reset waits for it, and
      // background work does not start while it runs.
      if (!input.readOnly) writes.begin(spaceId);
      const initialState = readHomeGraphSearchState(this.store, spaceId);
      const repairedExtractions = input.readOnly ? 0 : await this.repairStaleExtractionsForAsk(spaceId, installationId, input.query, initialState);
      this.autoLinkController.signal.throwIfAborted();
      const state = repairedExtractions > 0 ? readHomeGraphSearchState(this.store, spaceId) : initialState;
      const selection = await readHomeGraphSearchSelection({ store: this.store, spaceId, query: input, state, signal: this.autoLinkController.signal });
      const answer = await answerHomeGraphQuery({ store: this.store, semanticService: this.options.semanticService,
        spaceId, query: input, state, results: selection.results, selection, signal: this.autoLinkController.signal });
      // The answer returns now; device pages and enrichment run in the background queue.
      const queued = input.readOnly ? 0 : this.queueAskPageRefresh(spaceId, installationId, answer);
      if (!input.readOnly) this.queueAnswerEnrichment(spaceId, answer);
      return withHomeGraphAskPageRefresh(answer, { requested: queued > 0, queued });
    });
  }

  async reindex(input: HomeGraphReindexInput = {}): Promise<HomeGraphReindexResult> {
    return this.ownForegroundOperation(async (writes) => {
      requireDecisionFeature('semantic Home Graph reindexing');
      this.requireAdmission('home-graph reindex');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      const key = JSON.stringify([input.limit, input.maxRunMs, input.semanticLimit, input.semanticMaxRunMs, input.generatedPageLimit, input.force === true, input.refreshPages]);
      // One run per space. An identical request joins it and returns that run's
      // result; a different one (another limit, force, refreshPages) waits its
      // turn and then runs.
      for (let active = this.activeReindex.get(spaceId); active; active = this.activeReindex.get(spaceId)) {
        if (active.key === key) return { ...(await active.run), coalesced: true };
        await active.run.then(() => undefined, () => undefined);
        this.autoLinkController.signal.throwIfAborted();
      }
      const run = this.runForegroundOperation(spaceId, () => runHomeGraphReindex({
        store: this.store,
        artifactStore: this.artifactStore,
        semanticService: this.options.semanticService,
        signal: this.autoLinkController.signal,
        extract: (source, artifact, spaceId, installationId) => this.extractArtifact(source, artifact, spaceId, installationId),
        autoLinkExistingSources: (spaceId, installationId, sourceIds) => this.autoLinkExistingSources(spaceId, installationId, sourceIds),
        refreshQualityIssues: (spaceId, installationId) => this.refreshQualityIssues(spaceId, installationId),
      }, { ...input, knowledgeSpaceId: spaceId }));
      this.activeReindex.set(spaceId, { key, run });
      try {
        return await run;
      } finally {
        if (this.activeReindex.get(spaceId)?.run === run) this.activeReindex.delete(spaceId);
      }
    });
  }

  private async repairStaleExtractionsForAsk(
    spaceId: string,
    installationId: string,
    query: string,
    state: ReturnType<typeof readHomeGraphSearchState>,
  ): Promise<number> {
    const candidates = await selectHomeGraphExtractionRepairCandidates(
      query,
      state.sources,
      state.nodes,
      state.edges,
      (sourceId) => state.extractionBySourceId.get(sourceId),
      2,
      this.autoLinkController.signal,
    );
    let repaired = 0;
    for (const [index, source] of candidates.entries()) {
      await yieldEvery(index, 2);
      this.autoLinkController.signal.throwIfAborted();
      const artifactId = typeof source.artifactId === 'string' ? source.artifactId : undefined;
      if (!artifactId) continue;
      const artifact = this.artifactStore.get(artifactId);
      if (!artifact) continue;
      const owner = createKnowledgeExtractionOwner({ signal: this.autoLinkController.signal });
      const prepared = await prepareHomeGraphArtifactExtraction({
        store: this.store,
        artifactStore: this.artifactStore,
        reportBackgroundError: this.reportBackgroundError.bind(this),
      }, source.id, artifact, spaceId, owner);
      const searchable = prepared ? extractionHasSearchableText(prepared) : false;
      owner.assertCurrent();
      const extraction = await storeHomeGraphArtifactExtraction(this.store, source, artifact, spaceId, installationId, prepared, owner);
      if (extraction) {
        await autoLinkHomeGraphSource({
          signal: this.autoLinkController.signal,
          store: this.store,
          spaceId,
          installationId,
          source,
          extraction,
          state: readHomeGraphState(this.store, spaceId),
        });
      }
      if (extraction && searchable) repaired += 1;
      await yieldToEventLoop();
    }
    return repaired;
  }

  async refreshDevicePassport(input: HomeGraphProjectionInput): Promise<HomeGraphDevicePassportResult> {
    return this.ownForegroundOperation(async (writes) => {
      requireDecisionFeature('verified Home Graph device passports');
      this.requireAdmission('home-graph device passport');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return this.runForegroundOperation(spaceId, async () => {
        // Only this passport's own linked sources that were never enriched, within a bound;
        // the rest of the home is enriched by the ingest tail, the sync pump and reindex.
        if (this.options.semanticService && input.deviceId) {
          await enrichUnenrichedHomeGraphSources(this.requireSelfImprovementRuntime(), spaceId,
            devicePassportSourceIds(this.store, spaceId, input.deviceId), Date.now() + PASSPORT_ENRICHMENT_BUDGET_MS, this.autoLinkController.signal);
        }
        this.autoLinkController.signal.throwIfAborted();
        return refreshHomeGraphDevicePassport({
          store: this.store,
          artifactStore: this.artifactStore,
          spaceId,
          installationId,
          input,
          signal: this.autoLinkController.signal,
        });
      });
    });
  }

  async generateRoomPage(input: HomeGraphProjectionInput): Promise<HomeGraphProjectionResult> {
    return this.ownForegroundOperation(async (writes) => {
      requireDecisionFeature('verified Home Graph room pages');
      this.requireAdmission('home-graph room page');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return this.runForegroundOperation(spaceId, async () => {
        return generateHomeGraphRoomPage({
          store: this.store,
          artifactStore: this.artifactStore,
          spaceId,
          installationId,
          input,
          signal: this.autoLinkController.signal,
        });
      });
    });
  }

  async generatePacket(input: HomeGraphProjectionInput): Promise<HomeGraphProjectionResult> {
    return this.ownForegroundOperation(async (writes) => {
      requireDecisionFeature('verified Home Graph sharing packets');
      this.requireAdmission('home-graph sharing packet');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return this.runForegroundOperation(spaceId, async () => {
        return generateHomeGraphPacket({
          store: this.store,
          artifactStore: this.artifactStore,
          spaceId,
          installationId,
          input,
          signal: this.autoLinkController.signal,
        });
      });
    });
  }

  async listIssues(input: HomeGraphSpaceInput & {
    readonly status?: string | undefined;
    readonly severity?: string | undefined;
    readonly code?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ readonly ok: true; readonly spaceId: string; readonly issues: readonly KnowledgeIssueRecord[] }> {
    return this.ownForegroundOperation(async () => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
      const limit = Math.max(1, input.limit ?? 100);
      const issues = readHomeGraphState(this.store, spaceId).issues
        .filter((issue) => !input.status || issue.status === input.status)
        .filter((issue) => !input.severity || issue.severity === input.severity)
        .filter((issue) => !input.code || issue.code === input.code)
        .slice(0, limit);
      return { ok: true, spaceId, issues };
    });
  }

  async reviewFact(input: HomeGraphReviewInput): Promise<HomeGraphReviewResult> {
    return this.ownForegroundOperation(async (writes) => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return reviewHomeGraphFact(this.store, spaceId, installationId, input);
    });
  }

  async listSources(input: HomeGraphSpaceInput & { readonly limit?: number; readonly cursor?: string } = {}): Promise<Awaited<ReturnType<typeof listHomeGraphSources>>> {
    return this.ownForegroundOperation(async () => {
      return listHomeGraphSources({ ...input, store: this.store });
    });
  }

  async listPages(input: HomeGraphSpaceInput & { readonly limit?: number; readonly includeMarkdown?: boolean } = {}): Promise<HomeGraphPageListResult> {
    return this.ownForegroundOperation(async () => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
      const state = readHomeGraphState(this.store, spaceId);
      return listHomeGraphPages({
        artifactStore: this.artifactStore,
        spaceId,
        sources: state.sources,
        nodes: state.nodes,
        edges: state.edges,
        limit: Math.max(1, input.limit ?? 100),
        includeMarkdown: input.includeMarkdown !== false,
      });
    });
  }

  async listRefinementTasks(input: HomeGraphSpaceInput & {
    readonly limit?: number | undefined;
    readonly state?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly gapId?: string | undefined;
  } = {}) {
    return this.ownForegroundOperation(async () => {
      return listHomeGraphRefinementTasks({ ...input, store: this.store });
    });
  }

  async getRefinementTask(input: HomeGraphSpaceInput & { readonly taskId: string }) {
    return this.ownForegroundOperation(async () => {
      return getHomeGraphRefinementTask({ ...input, store: this.store });
    });
  }

  async runRefinement(input: HomeGraphSpaceInput & {
    readonly gapIds?: readonly string[] | undefined;
    readonly sourceIds?: readonly string[] | undefined;
    readonly limit?: number | undefined;
    readonly maxRunMs?: number | undefined;
    readonly force?: boolean | undefined;
    readonly triage?: HomeGraphTriageOptions | boolean | undefined;
    readonly skipGapRefinement?: boolean | undefined;
  } = {}) {
    return this.ownForegroundOperation(async (writes) => {
      requireDecisionFeature('automatic Home Graph refinement and triage');
      this.requireAdmission('home-graph refinement');
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      // Refinement and triage write issues, tasks and pages: claim the space so a reset waits for the run.
      const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return this.runForegroundOperation(spaceId, () => runHomeGraphRefinement({ ...input, knowledgeSpaceId: spaceId, store: this.store,
        semanticService: this.options.semanticService, signal: this.autoLinkController.signal }));
    });
  }

  async cancelRefinementTask(input: HomeGraphSpaceInput & { readonly taskId: string }) {
    return this.ownForegroundOperation(async () => {
      return cancelHomeGraphRefinementTask({ ...input, store: this.store });
    });
  }

  async browse(input: HomeGraphSpaceInput & { readonly limit?: number; readonly cursor?: string } = {}): Promise<Awaited<ReturnType<typeof browseHomeGraph>>> {
    return this.ownForegroundOperation(async () => {
      return browseHomeGraph({ ...input, store: this.store });
    });
  }

  async map(input: HomeGraphMapInput = {}): Promise<HomeGraphMapResult> {
    return this.ownForegroundOperation(async () => {
      const request = snapshotNodeInput(input);
      const assertCurrent = () => { this.autoLinkController.signal.throwIfAborted(); if (!sameKnowledgeRecord(input, request)) throw new KnowledgeScopeSelectionHeldError('stale'); };
      assertCurrent();
      return mapHomeGraph({ ...request, store: this.store, assertCurrent, signal: this.autoLinkController.signal });
    });
  }

  async exportSpace(input: HomeGraphSpaceInput = {}): Promise<HomeGraphExport> {
    return this.ownForegroundOperation(async () => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
      return exportHomeGraphSpace(this.store, { spaceId, installationId });
    });
  }

  async importSpace(input: HomeGraphSpaceInput & { readonly data: HomeGraphExport }): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
  }> {
    return this.ownForegroundOperation(async (writes) => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      const { spaceId, installationId } = resolveWritableHomeGraphSpace(this.store, input);
      writes.begin(spaceId);
      return importHomeGraphSpace(this.store, { spaceId, installationId, data: input.data });
    });
  }

  async resetSpace(input: HomeGraphResetInput): Promise<HomeGraphResetResult> {
    return this.ownForegroundOperation(async () => {
      await this.store.init();
      this.autoLinkController.signal.throwIfAborted();
      // Resolved once: the space whose work is cancelled is the space deleted.
      const { spaceId, installationId } = resolveHomeGraphResetSpace(this.store, input);
      const target = { spaceId, installationId, dryRun: input.dryRun, preserveArtifacts: input.preserveArtifacts };
      if (input.dryRun === true) return resetHomeGraphSpace(this.store, this.artifactStore, target);
      if (this.resettingSpaces.has(spaceId)) {
        throw new GoodVibesError(`Home Graph space ${spaceId} is already being reset.`, {
          category: 'bad_request', source: 'runtime', operation: 'homegraph.reset', recoverable: true,
        });
      }
      this.resettingSpaces.add(spaceId);
      try {
        await Promise.all([...(this.spaceWrites.get(spaceId) ?? [])].map(run => run.then(() => undefined, () => undefined)));
        await this.work.cancel(spaceId);
        this.autoLinkController.signal.throwIfAborted();
        return await resetHomeGraphSpace(this.store, this.artifactStore, target);
      } finally {
        this.resettingSpaces.delete(spaceId);
        // Nothing is left to enrich or repair in a space that was just deleted.
        await this.work.cancel(spaceId);
      }
    });
  }

  /** A bad link target must refuse the ingest before anything is published, not after the source exists. */
  private assertIngestTarget(spaceId: string, target: HomeGraphKnowledgeTarget | undefined): void {
    if (!target) return;
    if (target.kind === 'source') {
      const source = this.store.getSource(target.id);
      if (!source || !belongsToSpace(source, spaceId)) {
        throw new GoodVibesError(`Unknown Home Graph source target: ${target.id}`, { category: 'not_found', source: 'runtime', recoverable: false });
      }
      return;
    }
    const node = this.store.getNode(target.id);
    if (node && !belongsToSpace(node, spaceId)) {
      throw new GoodVibesError('Home Graph link target belongs to another knowledge space.', { category: 'not_found', source: 'runtime', recoverable: false });
    }
  }

  private async withIngestArtifactPublication<T>(publication: Awaited<ReturnType<ArtifactStore['createForPublication']>>, created: boolean,
    operation: (artifact: ArtifactDescriptor, assertCurrent: () => void) => Promise<T>): Promise<T> {
    let failed = false;
    const assertCurrent = () => { this.autoLinkController.signal.throwIfAborted(); publication.original.assertCurrent(); publication.lease.assertCurrent(); };
    try { assertCurrent(); const result = await operation(publication.artifact, assertCurrent); assertCurrent(); return result; }
    catch (error) { failed = true; throw error; }
    finally {
      try { publication.lease.release(); }
      catch (error) { if (!failed) throw error; logger.warn('Home Graph artifact publication ownership changed during failed ingest.'); }
      if (failed && created) {
        try {
          const result = await this.store.cleanupUnreferencedArtifact(publication.original);
          if (result === 'held' || result === 'unavailable') logger.debug('Home Graph failed-ingest artifact preserved for inspection.', { status: result });
        } catch { logger.warn('Home Graph failed-ingest artifact cleanup did not settle; the original failure was retained.'); }
      }
    }
  }

  private async ingestCreatedArtifact(input: {
    readonly spaceId: string;
    readonly installationId: string;
    readonly artifact: ArtifactDescriptor;
    readonly title?: string | undefined;
    readonly sourceUri?: string | undefined;
    readonly sourceType: KnowledgeSourceType;
    readonly tags: readonly string[];
    readonly target?: HomeGraphKnowledgeTarget | undefined;
    readonly metadata: Record<string, unknown>;
  }, ownership: KnowledgeIngestOwnership = {}, selectedIdentity?: HomeGraphSourceIdentity, assertArtifactCurrent?: () => void): Promise<HomeGraphIngestResult> {
    const owned = !!(ownership.signal || ownership.assertCurrent || ownership.onCommitted);
    const extractionOwner = createKnowledgeExtractionOwner({ ...ownership, signal: ownership.signal
      ? AbortSignal.any([ownership.signal, this.autoLinkController.signal]) : this.autoLinkController.signal });
    if (assertArtifactCurrent) extractionOwner.retain(assertArtifactCurrent);
    const assertOwned = extractionOwner.assertCurrent;
    assertOwned();
    // The repair consumer has no explicit target. Targeted linking requires its own
    // edge-publication ownership and must not borrow this source receipt.
    if (owned && input.target) throw new KnowledgeWebGapRepairHeldError('malformed');
    const identity = selectedIdentity ?? createHomeGraphSourceIdentityPlanner(this.store).prepare({ spaceId: input.spaceId, role: input.metadata.homeGraphSourceKind as 'url'|'note'|'artifact', locator: input.sourceUri ? 'uri' : 'artifact', value: input.sourceUri ?? input.artifact.id });
    const { id: sourceId, canonicalUri } = identity;
    extractionOwner.retain(identity.assertCurrent);
    let supersededOriginal: ArtifactOriginalObservation | undefined;
    const previousArtifactId = this.store.getSource(sourceId)?.artifactId;
    if (previousArtifactId && previousArtifactId !== input.artifact.id) {
      const previousArtifact = this.artifactStore.get(previousArtifactId);
      // Retention candidate classification, not producer authentication. External
      // artifacts stay in the library; actual deletion still requires the exact
      // original and fresh zero references across every configured family.
      const previousKind = previousArtifact?.metadata.homeGraphSourceKind;
      if (previousArtifact?.metadata.homeGraph === true && belongsToSpace(previousArtifact, input.spaceId)
        && typeof previousKind === 'string' && ['url','artifact','note'].includes(previousKind)) {
        try { supersededOriginal = this.artifactStore.captureOriginal(previousArtifactId); }
        catch { logger.warn('Home Graph previous artifact changed; automatic cleanup preserved it.'); }
      }
    }
    let published = false;
    try {
      {
        const originalSource = this.store.getSource(sourceId), originalExtraction = this.store.getExtractionBySourceId(sourceId);
        const original = captureStrictRepairJson({ source: originalSource, extraction: originalExtraction });
        extractionOwner.retain(() => {
          if (!published && (this.store.getSource(sourceId) !== originalSource || this.store.getExtractionBySourceId(sourceId) !== originalExtraction
            || !sameKnowledgeRecord(captureStrictRepairJson({ source: this.store.getSource(sourceId), extraction: this.store.getExtractionBySourceId(sourceId) }), original))) throw new KnowledgeWebGapRepairHeldError('stale');
        });
      }
      const prepared = await prepareHomeGraphArtifactExtraction({
        store: this.store,
        artifactStore: this.artifactStore,
        reportBackgroundError: this.reportBackgroundError.bind(this),
      }, sourceId, input.artifact, input.spaceId, extractionOwner);
      assertOwned();
      const sourceInput = knowledgeSourceCrawledNow({
        id: sourceId,
        connectorId: HOME_GRAPH_CONNECTOR_ID,
        sourceType: input.sourceType,
        title: input.title ?? input.artifact.filename,
        sourceUri: input.sourceUri ?? input.artifact.sourceUri,
        canonicalUri,
        tags: uniqueStrings(input.tags),
        status: 'indexed' as const,
        artifactId: input.artifact.id,
        metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, {
          ...input.metadata,
          artifactMimeType: input.artifact.mimeType,
          ...identity.metadata,
          ...(isClassicOperation() ? { provenance: 'classic', semanticAssessment: 'not-evaluated' } : {}),
        }),
      });
      let source: KnowledgeSourceRecord;
      let extraction: KnowledgeExtractionRecord | undefined;
      const atomic = owned || isClassicOperation();
      if (atomic) {
        const existing = this.store.getExtractionBySourceId(sourceId);
        const generatedId = `hg-extract-${sourceId.replace(/^hg-src-/, '')}`;
        const extractionId = existing?.id ?? generatedId;
        await this.store.applyPreparedIngest({ sources: [sourceInput], extractions: prepared ? [{
          id: extractionId, sourceId, artifactId: input.artifact.id, extractorId: prepared.extractorId,
          format: prepared.format, title: prepared.title, summary: prepared.summary, excerpt: prepared.excerpt,
          sections: prepared.sections, links: prepared.links, estimatedTokens: prepared.estimatedTokens, structure: prepared.structure,
          metadata: buildHomeGraphMetadata(input.spaceId, input.installationId, prepared.metadata),
        }] : [], nodes: [], edges: [], issues: [] }, async () => {
          assertOwned(); return { nodes: [], edges: [], issues: [], assertCurrent: assertOwned };
        }, { signal: extractionOwner.signal }, () => { published = true; notifyKnowledgeCommitted(() => ownership.onCommitted?.(sourceId)); });
        source = this.store.getSource(sourceId)!;
        extraction = this.store.getExtractionBySourceId(sourceId) ?? undefined;
        assertOwned();
      } else { source = await this.store.upsertSource(sourceInput, assertOwned); published = true; }
      // Registered once on either path; the extraction's references need the source's first.
      registerGeneratedKnowledgeSourceReferences(this.store, source, { id: sourceId, canonicalUri,
        ...(!input.sourceUri && !input.artifact.sourceUri && source.sourceUri === canonicalUri ? { sourceUri: canonicalUri } : {}) });
      if (atomic && extraction?.id === `hg-extract-${sourceId.replace(/^hg-src-/, '')}`) {
        registerGeneratedKnowledgeExtractionReferences(this.store, source, extraction, extraction.id);
      }
      if (!atomic) extraction = await storeHomeGraphArtifactExtraction(this.store, source, input.artifact, input.spaceId, input.installationId, prepared);
      assertOwned();
      // A document with no named target is linked when its subject settles; any
      // other outcome (none, ambiguous, unread) is reported here and recorded on
      // the source, and the ingest still succeeds.
      const autoLink = input.target ? undefined : await autoLinkHomeGraphSourceWithOutcome({
        signal: ownership.signal ? AbortSignal.any([this.autoLinkController.signal, ownership.signal]) : this.autoLinkController.signal,
        ...(owned ? { shouldStop: () => { assertOwned(); return false; } } : {}),
        store: this.store,
        spaceId: input.spaceId,
        installationId: input.installationId,
        source,
        ...(extraction ? { extraction } : {}),
        state: readHomeGraphState(this.store, input.spaceId),
      });
      const linked = input.target
        ? (await this.linkKnowledge({ knowledgeSpaceId: input.spaceId, sourceId: source.id, target: input.target })).edge
        : autoLink?.linked[0]?.edge;
      assertOwned();
      // Owned repairs already run enrichment/promotion in their guarded caller.
      // Do not detach a second publisher from the owner when returning its receipt.
      if (!ownership.deferSemanticEnrichment) this.queueIngestEnrichment(input.spaceId, source.id);
      const outcome = autoLink?.outcomes[0];
      const result = {
        ok: true as const,
        spaceId: input.spaceId,
        ...(isClassicOperation() ? { provenance: 'classic' as const, ...(!input.target ? { autoLinkAssessment: 'not-evaluated' as const } : {}) } : {}),
        source,
        artifactId: input.artifact.id,
        extraction,
        ...(linked ? { linked } : {}),
        ...(outcome ? { autoLink: { status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}), shortlisted: outcome.shortlisted } } : {}),
      };
      return result;
    } finally {
      if (published && supersededOriginal) {
        try {
          const result = await this.store.cleanupUnreferencedArtifact(supersededOriginal);
          if (result === 'held' || result === 'unavailable') logger.debug('Home Graph superseded artifact preserved for inspection.', { status: result });
        } catch { logger.warn('Home Graph superseded artifact cleanup did not settle; the publication outcome was retained.'); }
      }
    }
  }


  private async extractArtifact(
    source: KnowledgeSourceRecord,
    artifact: ArtifactDescriptor,
    spaceId: string,
    installationId: string,
  ): Promise<KnowledgeExtractionRecord | undefined> {
    return extractHomeGraphArtifact({
      store: this.store,
      artifactStore: this.artifactStore,
      reportBackgroundError: this.reportBackgroundError.bind(this),
    }, source, artifact, spaceId, installationId, createKnowledgeExtractionOwner({ signal: this.autoLinkController.signal }));
  }

  private async autoLinkExistingSources(
    spaceId: string,
    installationId: string,
    sourceIds?: readonly string[],
  ) {
    return autoLinkExistingHomeGraphSources(this.store, spaceId, installationId, sourceIds, this.autoLinkController.signal);
  }

  private async refreshQualityIssues(spaceId: string, installationId: string): Promise<readonly KnowledgeIssueRecord[]> {
    return refreshHomeGraphQualityIssues(this.store, spaceId, installationId, { signal: this.autoLinkController.signal });
  }

  private async ownForegroundOperation<T>(operation: (writes: { begin(spaceId: string): void }) => Promise<T>): Promise<T> {
    this.autoLinkController.signal.throwIfAborted();
    const writtenSpaces = new Set<string>();
    const releases: (() => void)[] = [];
    // A write claims its space: a reset refuses new writers and waits for the
    // ones already running, and background work of the space does not start
    // while it runs.
    const writes = {
      begin: (spaceId: string): void => {
        if (this.resettingSpaces.has(spaceId)) {
          throw new GoodVibesError(`Home Graph space ${spaceId} is being reset; retry after the reset finishes.`, {
            category: 'bad_request', source: 'runtime', operation: 'homegraph.write', recoverable: true,
          });
        }
        if (writtenSpaces.has(spaceId)) return;
        writtenSpaces.add(spaceId);
        releases.push(this.work.enterForeground(spaceId));
        const runs = this.spaceWrites.get(spaceId) ?? new Set<Promise<unknown>>();
        runs.add(run); this.spaceWrites.set(spaceId, runs);
      },
    };
    // Publish ownership before invoking even the first borrowed dependency: an
    // init hook may synchronously start shutdown while it still owns work.
    const run = Promise.resolve().then(() => {
      this.autoLinkController.signal.throwIfAborted();
      return operation(writes);
    });
    this.foregroundRuns.add(run);
    try {
      // A result that was produced is returned even if shutdown began meanwhile.
      return await run;
    } finally {
      this.foregroundRuns.delete(run);
      for (const release of releases) release();
      for (const spaceId of writtenSpaces) {
        const runs = this.spaceWrites.get(spaceId);
        runs?.delete(run);
        if (runs?.size === 0) this.spaceWrites.delete(spaceId);
      }
    }
  }

  /**
   * A verb that rewrites pages, quality or extractions across the space: it
   * waits for the background item running in the space to reach its next
   * boundary (the item is asked to yield, never aborted), then runs.
   */
  private async runForegroundOperation<T>(spaceId: string, operation: () => Promise<T>): Promise<T> {
    this.autoLinkController.signal.throwIfAborted();
    const release = this.work.enterForeground(spaceId);
    try {
      await this.work.settleRunning(spaceId);
      this.autoLinkController.signal.throwIfAborted();
      return await operation();
    } finally {
      release();
    }
  }

  /** Queues the refresh of the device pages an answer named; returns how many devices it covers. */
  private queueAskPageRefresh(spaceId: string, installationId: string, answer: HomeGraphAskResult): number {
    if (isClassicOperation() || this.autoLinkController.signal.aborted) return 0;
    if ((answer.answer.facts?.length ?? 0) === 0 && answer.answer.sources.length === 0) return 0;
    const devices = answer.answer.linkedObjects.filter((node) => node.kind === 'ha_device').map((node) => node.id).sort();
    if (devices.length === 0) return 0;
    this.work.enqueue(spaceId, {
      key: `ask-pages:${devices.join(',')}`,
      run: async (signal) => {
        await refreshDevicePagesForHomeGraphAsk({ store: this.store, artifactStore: this.artifactStore, spaceId, installationId, answer, signal });
      },
    });
    return Math.min(devices.length, 3);
  }

  /** Queues enrichment of up to three sources an answer used, one item per source. */
  private queueAnswerEnrichment(spaceId: string, answer: HomeGraphAskResult): void {
    const semantic = this.options.semanticService;
    if (isClassicOperation() || !semantic || this.autoLinkController.signal.aborted) return;
    const selected = [...new Set(answer.results.flatMap(result => result.source ? [result.source.id] : []))].slice(0, 3);
    for (const sourceId of selected) {
      this.work.enqueue(spaceId, {
        key: `answer-enrich:${sourceId}`,
        run: async (signal) => {
          const source = this.store.getSource(sourceId);
          if (!source || isClassicOperation()) return;
          await semantic.enrichSources([source], { knowledgeSpaceId: spaceId, limit: 1, signal });
        },
      });
    }
  }

  /**
   * Post-sync gap repair, one round per background item. A round that leaves
   * work queues the next one after a pause, so a question or a page request
   * between rounds goes first and the repair resumes where it was.
   */
  private scheduleSyncSelfImprovement(spaceId: string, installationId: string, round = 0,
    delayMs = HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS): void {
    if (isClassicOperation() || !this.options.semanticService || this.autoLinkController.signal.aborted) return;
    if (round === 0 && this.work.has(spaceId, SYNC_IMPROVE_ITEM)) return;
    this.work.enqueue(spaceId, {
      key: SYNC_IMPROVE_ITEM,
      run: async (signal) => {
        const next = await runHomeGraphSyncSelfImprovementRound(this.requireSelfImprovementRuntime(), spaceId, installationId, round, signal);
        if (next !== undefined && !signal.aborted) this.scheduleSyncSelfImprovement(spaceId, installationId, round + 1, next);
      },
    }, delayMs);
  }

  private queueIngestEnrichment(spaceId: string, sourceId: string): void {
    if (isClassicOperation() || !this.options.semanticService || this.autoLinkController.signal.aborted) return;
    this.work.enqueue(spaceId, {
      key: `ingest-enrich:${sourceId}`,
      run: async (signal) => {
        if (isClassicOperation()) return;
        await enrichAndImproveHomeGraphSource(this.requireSelfImprovementRuntime(), sourceId, spaceId, signal);
      },
    });
  }

  private requireSelfImprovementRuntime() {
    const semanticService = this.options.semanticService;
    if (!semanticService) {
      throw new ConfigurationError('Home Graph semantic self-improvement is not configured.', {
        source: 'config',
        hint: 'Configure KnowledgeSemanticService before running Home Graph semantic enrichment.',
      });
    }
    return {
      store: this.store,
      artifactStore: this.artifactStore,
      semanticService,
      reportBackgroundError: this.reportBackgroundError.bind(this),
    };
  }

  private reportBackgroundError(event: string, error: unknown, metadata: Record<string, unknown>): void {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Home Graph background work failed', {
      event,
      error: message,
      ...metadata,
    });
  }

}

function withHomeGraphAskPageRefresh(
  answer: HomeGraphAskResult,
  pageRefresh: { readonly requested: boolean; readonly queued: number },
): HomeGraphAskResult {
  if (!answer.answer.refinement && !pageRefresh.requested) return answer;
  const refinement = answer.answer.refinement;
  return {
    ...answer,
    pageRefresh,
    answer: {
      ...answer.answer,
      refinement: {
        status: refinement?.status ?? 'not_needed',
        ...(refinement?.repairStatus ? { repairStatus: refinement.repairStatus } : {}),
        ...(refinement?.reason ? { reason: refinement.reason } : {}),
        refinementTaskIds: refinement?.refinementTaskIds ?? answer.answer.refinementTaskIds ?? [],
        acceptedSourceIds: refinement?.acceptedSourceIds ?? [],
        promotedFactCount: refinement?.promotedFactCount ?? (answer.answer.facts?.length ?? 0),
        ...(refinement?.nextRepairAttemptAt ? { nextRepairAttemptAt: refinement.nextRepairAttemptAt } : {}),
        ...(typeof refinement?.waitedMs === 'number' ? { waitedMs: refinement.waitedMs } : {}),
        ...(refinement?.answerCacheInvalidated ? { answerCacheInvalidated: true } : {}),
        pageRefreshRequested: pageRefresh.requested,
        // Refreshed after the answer returns, in the background queue.
        pageRefreshed: false,
      },
    },
  };
}

function extractionHasSearchableText(extraction: Pick<KnowledgeExtractionRecord, 'excerpt' | 'summary' | 'sections' | 'structure' | 'metadata'>): boolean {
  const structure = readRecord(extraction.structure);
  return typeof structure.searchText === 'string' && structure.searchText.trim().length > 0 && knowledgeExtractionIsReadable(extraction);
}
