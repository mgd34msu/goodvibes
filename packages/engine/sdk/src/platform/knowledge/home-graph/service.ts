import { notifyKnowledgeCommitted } from '../commit-notification.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { createHomeGraphSourceIdentityPlanner, type HomeGraphSourceIdentity } from './source-identity-plan.js';
import { isClassicOperation, requireDecisionFeature, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import { snapshotNodeInput } from '../activation/projection.js';
import { KnowledgeScopeSelectionHeldError } from '../scope-selection.js';
import { HomeGraphPagePriorityHeldError } from './page-priority.js';
import { createKnowledgeExtractionOwner } from '../extraction-ownership.js';
import type { KnowledgeIngestOwnership } from '../ingest-context.js';
import { KnowledgeWebGapRepairHeldError } from '../semantic/web-gap-repair/types.js';
import { registerGeneratedKnowledgeExtractionReferences } from '../source-structural-references.js';
import { captureStrictRepairJson } from '../semantic/web-gap-repair/admission.js';
import { knowledgeSourceCrawledNow, sameKnowledgeRecord } from '../store-record-representation.js';
import { registerGeneratedKnowledgeSourceReferences } from '../source-structural-references.js';
import { ConfigurationError, GoodVibesSdkError } from '@goodvibes-jev/engine/errors';
import { acquireArtifactPublication, type ArtifactStore } from '../../artifacts/index.js';
import type { ArtifactOriginalObservation, ArtifactDescriptor } from '../../artifacts/types.js';
import { logger } from '../../utils/logger.js';
import { scheduleBackground, yieldEvery, yieldToEventLoop } from '../cooperative.js';
import type { KnowledgeStore } from '../store.js';
import type {
  KnowledgeEdgeRecord,
  KnowledgeExtractionRecord,
  KnowledgeIssueRecord,
  KnowledgeNodeRecord,
  KnowledgeSourceRecord,
  KnowledgeSourceType,
} from '../types.js';
import {
  HOME_GRAPH_CONNECTOR_ID,
  buildHomeGraphMetadata,
  belongsToSpace,
  isGeneratedPageSource,
  readRecord,
  resolveHomeGraphSpace,
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
} from './auto-link.js';
import {
  generateHomeGraphPacket,
  generateHomeGraphRoomPage,
  refreshHomeGraphDevicePassport,
} from './generated-pages.js';
import { refreshDevicePagesForHomeGraphAsk } from './ask-page-refresh.js';
import { coalescedHomeGraphReindexResult, runHomeGraphReindex } from './reindex.js';
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
import { isUnusableHomeGraphExtractionText } from './extraction-quality.js';
import {
  readHomeGraphSearchState,
  selectHomeGraphExtractionRepairCandidates,
} from './search.js';
import {
  enrichAndImproveHomeGraphSource,
  enrichHomeGraphSpaceSources,
  HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS,
  runHomeGraphSyncSelfImprovementPump,
} from './sync-self-improvement.js';
import { readHomeGraphSearchSelection } from './search-judgments.js';
import { resolveReadableHomeGraphSpace } from './space-selection.js';
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

export class HomeGraphService {
  private readonly autoLinkController = new AbortController();
  private activeReindex: Promise<HomeGraphReindexResult> | null = null;
  private pendingSyncSelfImprove = new Set<string>();
  private syncSelfImproveControllers = new Map<string, AbortController>();
  private syncSelfImproveRuns = new Map<string, Promise<void>>();
  private foregroundOperations = new Map<string, number>();
  private resumeSyncSelfImprove = new Set<string>();
  private pendingAnswerEnrichment = new Map<string, Set<string>>();
  private scheduledAnswerEnrichment = new Set<string>();
  private pendingIngestEnrichment = new Map<string, Set<string>>();
  private scheduledIngestEnrichment = new Set<string>();
  private ingestEnrichmentRuns = new Map<string, { readonly sourceId: string; readonly controller: AbortController; readonly run: Promise<void> }>();
  private answerEnrichmentRuns = new Map<string, {
    readonly controller: AbortController;
    readonly sourceIds: readonly string[];
    readonly run: Promise<void>;
  }>();
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
  }

  /** Refuse expensive work at the critical memory tier (see MemoryGovernor). */
  private requireAdmission(label: string): void {
    const decision = this.options.admitExpensiveWork?.(label);
    if (decision && !decision.allowed) {
      throw new Error(decision.reason ?? `${label} refused: daemon is under critical memory pressure.`);
    }
  }

  async dispose(): Promise<void> {
    this.autoLinkController.abort();
    this.cancelSyncSelfImprovement();
    this.cancelAnswerEnrichment();
    this.pendingIngestEnrichment.clear(); this.scheduledIngestEnrichment.clear();
    await Promise.all([...this.syncSelfImproveRuns.values(), ...[...this.answerEnrichmentRuns.values()].map(tail => tail.run),
      ...[...this.ingestEnrichmentRuns.values()].map(tail => tail.run)]);
  }

  async status(input: { readonly installationId?: string; readonly knowledgeSpaceId?: string } = {}): Promise<HomeGraphStatus> {
    return getHomeGraphStatus(this.store, input);
  }

  async syncSnapshot(input: HomeGraphSnapshotInput): Promise<HomeGraphSyncResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      await this.store.init();
      const result = await runHomeGraphSnapshotSync({
        store: this.store,
        artifactStore: this.artifactStore,
        snapshot: input,
        signal: this.autoLinkController.signal,
      });
      this.scheduleSyncSelfImprovement(result.spaceId, result.installationId);
      return result;
    });
  }

  async ingestUrl(input: HomeGraphIngestUrlInput, ownership: KnowledgeIngestOwnership = {}): Promise<HomeGraphIngestResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      const { signal, assertCurrent, onCommitted, deferSemanticEnrichment } = ownership;
      const owned = !!(signal || assertCurrent || onCommitted || deferSemanticEnrichment);
      const current = () => {
        if (ownership.signal !== signal || ownership.assertCurrent !== assertCurrent || ownership.onCommitted !== onCommitted
          || ownership.deferSemanticEnrichment !== deferSemanticEnrichment) throw new KnowledgeWebGapRepairHeldError('stale');
        signal?.throwIfAborted(); const result: unknown = assertCurrent?.(); if (result !== undefined) { drainOwned(result); throw new KnowledgeWebGapRepairHeldError('malformed'); }
      };
      current();
      this.requireAdmission('home-graph url ingestion');
      const { spaceId, installationId } = resolveHomeGraphSpace(input), url = input.url;
      await this.store.init(); current();
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
        },
      }, owned ? { ...ownership, signal, assertCurrent: current } : ownership, identity, assertArtifactCurrent));
    });
  }

  async ingestNote(input: HomeGraphIngestNoteInput): Promise<HomeGraphIngestResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      this.requireAdmission('home-graph note ingestion');
      const { spaceId, installationId } = resolveHomeGraphSpace(input);
      const title = input.title ?? `Home Assistant note ${new Date().toISOString()}`;
      await this.store.init();
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
        },
      }, {}, undefined, assertArtifactCurrent));
    });
  }

  async ingestArtifact(input: HomeGraphIngestArtifactInput): Promise<HomeGraphIngestResult> {
    return withConfiguredDecisionModelPolicy(async () => {
      this.requireAdmission('home-graph artifact ingestion');
      const { spaceId, installationId } = resolveHomeGraphSpace(input);
      const artifactId = input.artifactId, uri = input.uri, path = input.path;
      await this.store.init();
      const knownUri = uri ?? path;
      const identity = knownUri ? createHomeGraphSourceIdentityPlanner(this.store).prepare({ spaceId, role: 'artifact', locator: 'uri', value: knownUri }) : undefined;
      const publication = artifactId ? await (async () => {
        const artifact = this.artifactStore.get(artifactId);
        if (!artifact) throw new GoodVibesSdkError('Unknown Home Graph artifact.', { category: 'not_found', source: 'runtime', recoverable: false });
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
        },
      }, {}, identity, assertArtifactCurrent));
    });
  }

  async linkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphLinkResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return linkHomeGraphKnowledge(this.store, { ...input, spaceId, installationId });
  }

  async unlinkKnowledge(input: HomeGraphLinkInput): Promise<HomeGraphUnlinkResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return unlinkHomeGraphKnowledge(this.store, { ...input, spaceId, installationId });
  }

  async ask(input: HomeGraphAskInput): Promise<HomeGraphAskResult> {
    requireDecisionFeature('verified Home Graph answers; use browse or local knowledge search during Classic');
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    return this.runForegroundOperation(spaceId, installationId, async () => {
      const initialState = readHomeGraphSearchState(this.store, spaceId);
      const repairedExtractions = await this.repairStaleExtractionsForAsk(spaceId, installationId, input.query, initialState);
      const state = repairedExtractions > 0 ? readHomeGraphSearchState(this.store, spaceId) : initialState;
      const selection = await readHomeGraphSearchSelection({ store: this.store, spaceId, query: input, state });
      const answer = await answerHomeGraphQuery({ store: this.store, semanticService: this.options.semanticService,
        spaceId, query: input, state, results: selection.results });
      const pageRefresh = await refreshDevicePagesForHomeGraphAsk({
        store: this.store,
        artifactStore: this.artifactStore,
        spaceId,
        installationId,
        answer,
      });
      this.queueAnswerEnrichment(spaceId, answer);
      return withHomeGraphAskPageRefresh(answer, pageRefresh);
    });
  }

  async reindex(input: HomeGraphReindexInput = {}): Promise<HomeGraphReindexResult> {
    requireDecisionFeature('semantic Home Graph reindexing');
    await this.store.init();
    if (this.activeReindex) return coalescedHomeGraphReindexResult(this.store, input);
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    const run = this.runForegroundOperation(spaceId, installationId, () => runHomeGraphReindex({
      store: this.store,
      artifactStore: this.artifactStore,
      semanticService: this.options.semanticService,
      extract: (source, artifact, spaceId, installationId) => this.extractArtifact(source, artifact, spaceId, installationId),
      autoLinkExistingSources: (spaceId, installationId, sourceIds) => this.autoLinkExistingSources(spaceId, installationId, sourceIds),
      refreshQualityIssues: (spaceId, installationId) => this.refreshQualityIssues(spaceId, installationId),
    }, input));
    this.activeReindex = run;
    try {
      return await run;
    } finally {
      if (this.activeReindex === run) this.activeReindex = null;
    }
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
    );
    let repaired = 0;
    for (const [index, source] of candidates.entries()) {
      await yieldEvery(index, 2);
      const artifactId = typeof source.artifactId === 'string' ? source.artifactId : undefined;
      if (!artifactId) continue;
      const artifact = this.artifactStore.get(artifactId);
      if (!artifact) continue;
      const prepared = await prepareHomeGraphArtifactExtraction({
        store: this.store,
        artifactStore: this.artifactStore,
        reportBackgroundError: this.reportBackgroundError.bind(this),
      }, source.id, artifact, spaceId);
      const searchable = prepared ? await extractionHasSearchableText(prepared) : false;
      const extraction = await storeHomeGraphArtifactExtraction(this.store, source, artifact, spaceId, installationId, prepared);
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
    requireDecisionFeature('verified Home Graph device passports');
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return this.runForegroundOperation(spaceId, installationId, async () => {
      await this.enrichSpaceSources(spaceId);
      return refreshHomeGraphDevicePassport({
        store: this.store,
        artifactStore: this.artifactStore,
        spaceId,
        installationId,
        input,
      });
    });
  }

  async generateRoomPage(input: HomeGraphProjectionInput): Promise<HomeGraphProjectionResult> {
    requireDecisionFeature('verified Home Graph room pages');
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return this.runForegroundOperation(spaceId, installationId, async () => {
      await this.enrichSpaceSources(spaceId);
      return generateHomeGraphRoomPage({
        store: this.store,
        artifactStore: this.artifactStore,
        spaceId,
        installationId,
        input,
      });
    });
  }

  async generatePacket(input: HomeGraphProjectionInput): Promise<HomeGraphProjectionResult> {
    requireDecisionFeature('verified Home Graph sharing packets');
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return this.runForegroundOperation(spaceId, installationId, async () => {
      await this.enrichSpaceSources(spaceId);
      return generateHomeGraphPacket({
        store: this.store,
        artifactStore: this.artifactStore,
        spaceId,
        installationId,
        input,
      });
    });
  }

  async listIssues(input: HomeGraphSpaceInput & {
    readonly status?: string | undefined;
    readonly severity?: string | undefined;
    readonly code?: string | undefined;
    readonly limit?: number | undefined;
  }): Promise<{ readonly ok: true; readonly spaceId: string; readonly issues: readonly KnowledgeIssueRecord[] }> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    const limit = Math.max(1, input.limit ?? 100);
    const issues = readHomeGraphState(this.store, spaceId).issues
      .filter((issue) => !input.status || issue.status === input.status)
      .filter((issue) => !input.severity || issue.severity === input.severity)
      .filter((issue) => !input.code || issue.code === input.code)
      .slice(0, limit);
    return { ok: true, spaceId, issues };
  }

  async reviewFact(input: HomeGraphReviewInput): Promise<HomeGraphReviewResult> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return reviewHomeGraphFact(this.store, spaceId, installationId, input);
  }

  async listSources(input: HomeGraphSpaceInput & { readonly limit?: number } = {}): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly sources: readonly KnowledgeSourceRecord[];
  }> {
    return listHomeGraphSources({ ...input, store: this.store });
  }

  async listPages(input: HomeGraphSpaceInput & { readonly limit?: number; readonly includeMarkdown?: boolean } = {}): Promise<HomeGraphPageListResult> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    const state = readHomeGraphState(this.store, spaceId);
    const observedSources = state.sources.filter(isGeneratedPageSource);
    const observedNodes = state.nodes.filter(node => !node.metadata.semanticKind && !['fact', 'knowledge_gap', 'wiki_page'].includes(node.kind));
    const ids = new Set([...observedSources, ...observedNodes].map(record => record.id));
    const observedEdges = state.edges.filter(edge => ids.has(edge.fromId) && ids.has(edge.toId));
    const original = JSON.stringify({ sources: observedSources, nodes: observedNodes, edges: observedEdges });
    const assertCurrent = () => {
      const edges = new Map(this.store.listEdges().map(edge => [edge.id, edge]));
      const current = JSON.stringify({ sources: observedSources.map(source => this.store.getSource(source.id)),
        nodes: observedNodes.map(node => this.store.getNode(node.id)), edges: observedEdges.map(edge => edges.get(edge.id)) });
      if (current !== original) throw new HomeGraphPagePriorityHeldError('stale');
    };
    return listHomeGraphPages({
      artifactStore: this.artifactStore,
      store: this.store,
      assertCurrent,
      spaceId,
      sources: state.sources,
      nodes: state.nodes,
      edges: state.edges,
      limit: Math.max(1, input.limit ?? 100),
      includeMarkdown: input.includeMarkdown !== false,
    });
  }

  async listRefinementTasks(input: HomeGraphSpaceInput & {
    readonly limit?: number | undefined;
    readonly state?: string | undefined;
    readonly subjectId?: string | undefined;
    readonly gapId?: string | undefined;
  } = {}) {
    return listHomeGraphRefinementTasks({ ...input, store: this.store });
  }

  async getRefinementTask(input: HomeGraphSpaceInput & { readonly taskId: string }) {
    return getHomeGraphRefinementTask({ ...input, store: this.store });
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
    return runHomeGraphRefinement({ ...input, store: this.store, semanticService: this.options.semanticService });
  }

  async cancelRefinementTask(input: HomeGraphSpaceInput & { readonly taskId: string }) {
    return cancelHomeGraphRefinementTask({ ...input, store: this.store });
  }

  async browse(input: HomeGraphSpaceInput & { readonly limit?: number } = {}): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly nodes: readonly KnowledgeNodeRecord[];
    readonly edges: readonly KnowledgeEdgeRecord[];
    readonly sources: readonly KnowledgeSourceRecord[];
    readonly issues: readonly KnowledgeIssueRecord[];
  }> {
    return browseHomeGraph({ ...input, store: this.store });
  }

  async map(input: HomeGraphMapInput = {}): Promise<HomeGraphMapResult> {
    const request = snapshotNodeInput(input);
    const assertCurrent = () => { if (!sameKnowledgeRecord(input, request)) throw new KnowledgeScopeSelectionHeldError('stale'); };
    assertCurrent();
    return mapHomeGraph({ ...request, store: this.store, assertCurrent });
  }

  async exportSpace(input: HomeGraphSpaceInput = {}): Promise<HomeGraphExport> {
    await this.store.init();
    const { spaceId, installationId } = resolveReadableHomeGraphSpace(this.store, input);
    return exportHomeGraphSpace(this.store, { spaceId, installationId });
  }

  async importSpace(input: HomeGraphSpaceInput & { readonly data: HomeGraphExport }): Promise<{
    readonly ok: true;
    readonly spaceId: string;
    readonly imported: { readonly sources: number; readonly nodes: number; readonly edges: number; readonly issues: number; readonly extractions: number };
  }> {
    await this.store.init();
    const { spaceId, installationId } = resolveHomeGraphSpace(input);
    return importHomeGraphSpace(this.store, { spaceId, installationId, data: input.data });
  }

  async resetSpace(input: HomeGraphResetInput): Promise<HomeGraphResetResult> {
    await this.store.init();
    const { spaceId } = resolveReadableHomeGraphSpace(this.store, input);
    if (input.dryRun !== true) {
      const sync = this.syncSelfImproveRuns.get(spaceId);
      this.cancelSyncSelfImprovement(spaceId);
      const tail = this.answerEnrichmentRuns.get(spaceId)?.run;
      this.cancelAnswerEnrichment(spaceId);
      const ingest = this.ingestEnrichmentRuns.get(spaceId);
      this.pendingIngestEnrichment.delete(spaceId); this.scheduledIngestEnrichment.delete(spaceId);
      ingest?.controller.abort();
      await Promise.all([sync, tail, ingest?.run]);
    }
    return resetHomeGraphSpace(this.store, this.artifactStore, input);
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
        registerGeneratedKnowledgeSourceReferences(this.store, source, { id: sourceId, canonicalUri,
          ...(!input.sourceUri && !input.artifact.sourceUri && source.sourceUri === canonicalUri ? { sourceUri: canonicalUri } : {}) });
        if (extraction?.id === generatedId) registerGeneratedKnowledgeExtractionReferences(this.store, source, extraction, generatedId);
      } else { source = await this.store.upsertSource(sourceInput, assertOwned); published = true; }
      registerGeneratedKnowledgeSourceReferences(this.store, source, { id: sourceId, canonicalUri,
        ...(!input.sourceUri && !input.artifact.sourceUri && source.sourceUri === canonicalUri ? { sourceUri: canonicalUri } : {}) });
      if (!atomic) extraction = await storeHomeGraphArtifactExtraction(this.store, source, input.artifact, input.spaceId, input.installationId, prepared);
      assertOwned();
      const linked = input.target
        ? (await this.linkKnowledge({ knowledgeSpaceId: input.spaceId, sourceId: source.id, target: input.target })).edge
        : (await autoLinkHomeGraphSource({
            signal: ownership.signal ? AbortSignal.any([this.autoLinkController.signal, ownership.signal]) : this.autoLinkController.signal,
            ...(owned ? { shouldStop: () => { assertOwned(); return false; } } : {}),
            store: this.store,
            spaceId: input.spaceId,
            installationId: input.installationId,
            source,
            ...(extraction ? { extraction } : {}),
            state: readHomeGraphState(this.store, input.spaceId),
          }))?.edge;
      assertOwned();
      // Owned repairs already run enrichment/promotion in their guarded caller.
      // Do not detach a second publisher from the owner when returning its receipt.
      if (!ownership.deferSemanticEnrichment) this.queueIngestEnrichment(input.spaceId, source.id);
      return {
        ok: true,
        spaceId: input.spaceId,
        ...(isClassicOperation() ? { provenance: 'classic' as const, ...(!input.target ? { autoLinkAssessment: 'not-evaluated' as const } : {}) } : {}),
        source,
        artifactId: input.artifact.id,
        extraction,
        ...(linked ? { linked } : {}),
      };
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
    }, source, artifact, spaceId, installationId);
  }

  private async autoLinkExistingSources(
    spaceId: string,
    installationId: string,
    sourceIds?: readonly string[],
  ) {
    return autoLinkExistingHomeGraphSources(this.store, spaceId, installationId, sourceIds, this.autoLinkController.signal);
  }

  private async refreshQualityIssues(spaceId: string, installationId: string): Promise<readonly KnowledgeIssueRecord[]> {
    return refreshHomeGraphQualityIssues(this.store, spaceId, installationId);
  }

  private async runForegroundOperation<T>(spaceId: string, installationId: string, operation: () => Promise<T>): Promise<T> {
    this.foregroundOperations.set(spaceId, (this.foregroundOperations.get(spaceId) ?? 0) + 1);
    if (this.syncSelfImproveControllers.has(spaceId)) this.resumeSyncSelfImprove.add(spaceId);
    const background = this.syncSelfImproveRuns.get(spaceId);
    this.cancelSyncSelfImprovement(spaceId);
    const tail = this.answerEnrichmentRuns.get(spaceId);
    if (tail) {
      const pending = this.pendingAnswerEnrichment.get(spaceId) ?? new Set<string>();
      for (const sourceId of tail.sourceIds) pending.add(sourceId);
      this.pendingAnswerEnrichment.set(spaceId, pending);
      tail.controller.abort();
    }
    const ingest = this.ingestEnrichmentRuns.get(spaceId);
    if (ingest) {
      this.queueIngestEnrichment(spaceId, ingest.sourceId);
      ingest.controller.abort();
    }
    try {
      // Capture answer and page inputs only after the cancelled same-space
      // repair pump has finished its owned writes and cleanup.
      await background;
      await tail?.run;
      await ingest?.run;
      return await operation();
    } finally {
      const remaining = (this.foregroundOperations.get(spaceId) ?? 1) - 1;
      if (remaining > 0) this.foregroundOperations.set(spaceId, remaining);
      else {
        this.foregroundOperations.delete(spaceId);
        if (this.resumeSyncSelfImprove.delete(spaceId)) this.scheduleSyncSelfImprovement(spaceId, installationId);
        this.scheduleAnswerEnrichment(spaceId);
        this.scheduleIngestEnrichment(spaceId);
      }
    }
  }

  private queueAnswerEnrichment(spaceId: string, answer: HomeGraphAskResult): void {
    if (isClassicOperation()) return;
    if (!this.options.semanticService || this.autoLinkController.signal.aborted) return;
    const pending = this.pendingAnswerEnrichment.get(spaceId) ?? new Set<string>();
    const selected = new Set(answer.results.flatMap(result => result.source ? [result.source.id] : []));
    for (const sourceId of [...selected].slice(0, 3)) pending.add(sourceId);
    if (pending.size > 0) this.pendingAnswerEnrichment.set(spaceId, pending);
    this.scheduleAnswerEnrichment(spaceId);
  }

  private scheduleAnswerEnrichment(spaceId: string): void {
    if (isClassicOperation()) return;
    const semantic = this.options.semanticService;
    if (!semantic || this.autoLinkController.signal.aborted || this.foregroundOperations.has(spaceId)
      || this.answerEnrichmentRuns.has(spaceId) || this.scheduledAnswerEnrichment.has(spaceId)
      || !this.pendingAnswerEnrichment.has(spaceId)) return;
    this.scheduledAnswerEnrichment.add(spaceId);
    scheduleBackground(() => {
      this.scheduledAnswerEnrichment.delete(spaceId);
      if (this.foregroundOperations.has(spaceId) || this.answerEnrichmentRuns.has(spaceId)) return;
      const pending = this.pendingAnswerEnrichment.get(spaceId);
      if (!pending) return;
      // Preserve governor backpressure for the selected-source background tail.
      if (semantic.isBackgroundWorkPaused()) { this.pendingAnswerEnrichment.delete(spaceId); return; }
      const sourceIds = [...pending].slice(0, 3);
      for (const sourceId of sourceIds) pending.delete(sourceId);
      if (pending.size === 0) this.pendingAnswerEnrichment.delete(spaceId);
      const sources = sourceIds.flatMap(id => { const source = this.store.getSource(id); return source ? [source] : []; });
      const controller = new AbortController();
      const signal = AbortSignal.any([controller.signal, this.autoLinkController.signal]);
      const run = semantic.enrichSources(sources, { knowledgeSpaceId: spaceId, limit: 3, signal,
        shouldStop: () => signal.aborted || this.foregroundOperations.has(spaceId),
      }).then(() => {}, (error: unknown) => {
        if (!signal.aborted) this.reportBackgroundError('homegraph-post-answer-enrich', error, { spaceId });
      }).finally(() => {
        if (this.answerEnrichmentRuns.get(spaceId)?.run === run) this.answerEnrichmentRuns.delete(spaceId);
        this.scheduleAnswerEnrichment(spaceId);
      });
      this.answerEnrichmentRuns.set(spaceId, { controller, sourceIds, run });
    }, 0, this.autoLinkController.signal);
  }

  private cancelAnswerEnrichment(spaceId?: string): void {
    const entries = spaceId ? [...this.answerEnrichmentRuns].filter(([id]) => id === spaceId) : [...this.answerEnrichmentRuns];
    for (const [, tail] of entries) tail.controller.abort();
    if (spaceId) {
      this.pendingAnswerEnrichment.delete(spaceId);
      this.scheduledAnswerEnrichment.delete(spaceId);
    } else {
      this.pendingAnswerEnrichment.clear();
      this.scheduledAnswerEnrichment.clear();
    }
  }

  /**
   * Start the post-sync self-improvement pump for a Home Graph space.
   * The pump is intentionally delayed so the foreground sync response can
   * return before source search, semantic repair, and page refresh work begins.
   */
  private scheduleSyncSelfImprovement(spaceId: string, installationId: string): void {
    if (isClassicOperation()) return;
    if (!this.options.semanticService || this.autoLinkController.signal.aborted || this.pendingSyncSelfImprove.has(spaceId)) return;
    if (this.foregroundOperations.has(spaceId)) { this.resumeSyncSelfImprove.add(spaceId); return; }
    this.pendingSyncSelfImprove.add(spaceId);
    const controller = new AbortController();
    this.syncSelfImproveControllers.set(spaceId, controller);
    scheduleBackground(() => {
      const run = this.runSyncSelfImprovementPump(spaceId, installationId, controller.signal).catch((error: unknown) => {
        if (controller.signal.aborted) return;
        this.reportBackgroundError('homegraph-sync-self-improvement', error, { spaceId, installationId });
      }).finally(() => {
        if (this.syncSelfImproveRuns.get(spaceId) === run) this.syncSelfImproveRuns.delete(spaceId);
        if (this.syncSelfImproveControllers.get(spaceId) === controller) {
          this.pendingSyncSelfImprove.delete(spaceId);
          this.syncSelfImproveControllers.delete(spaceId);
        }
      });
      this.syncSelfImproveRuns.set(spaceId, run);
    // Tie the delayed task to the controller so a space reset can cancel work
    // before it starts or cooperatively stop it while it is running.
    }, HOME_GRAPH_SYNC_SELF_IMPROVEMENT_START_DELAY_MS, controller.signal);
  }

  /** Cancel pending or active post-sync improvement work for one space or all spaces. */
  private cancelSyncSelfImprovement(spaceId?: string): void {
    const entries = spaceId
      ? [...this.syncSelfImproveControllers.entries()].filter(([key]) => key === spaceId)
      : [...this.syncSelfImproveControllers.entries()];
    for (const [key, controller] of entries) {
      controller.abort();
      this.syncSelfImproveControllers.delete(key);
      this.pendingSyncSelfImprove.delete(key);
    }
  }

  /**
   * Relentlessly repairs gaps discovered during sync until the run budget,
   * task budget, or cooperative abort signal says to stop.
   */
  private async runSyncSelfImprovementPump(spaceId: string, installationId: string, signal: AbortSignal): Promise<void> {
    const runtime = this.requireSelfImprovementRuntime();
    await runHomeGraphSyncSelfImprovementPump(runtime, spaceId, installationId, signal);
  }

  private async enrichSpaceSources(spaceId: string): Promise<void> {
    if (!this.options.semanticService) return;
    await enrichHomeGraphSpaceSources(this.requireSelfImprovementRuntime(), spaceId);
  }

  private queueIngestEnrichment(spaceId: string, sourceId: string): void {
    if (isClassicOperation()) return;
    if (!this.options.semanticService || this.autoLinkController.signal.aborted) return;
    const pending = this.pendingIngestEnrichment.get(spaceId) ?? new Set<string>();
    pending.add(sourceId); this.pendingIngestEnrichment.set(spaceId, pending);
    this.scheduleIngestEnrichment(spaceId);
  }

  private scheduleIngestEnrichment(spaceId: string): void {
    if (isClassicOperation()) return;
    if (!this.options.semanticService || this.autoLinkController.signal.aborted || this.foregroundOperations.has(spaceId)
      || this.ingestEnrichmentRuns.has(spaceId) || this.scheduledIngestEnrichment.has(spaceId)
      || !this.pendingIngestEnrichment.has(spaceId)) return;
    this.scheduledIngestEnrichment.add(spaceId);
    scheduleBackground(() => {
      this.scheduledIngestEnrichment.delete(spaceId);
      if (isClassicOperation()) { this.pendingIngestEnrichment.delete(spaceId); return; }
      if (this.foregroundOperations.has(spaceId) || this.ingestEnrichmentRuns.has(spaceId)) return;
      const pending = this.pendingIngestEnrichment.get(spaceId), sourceId = pending?.values().next().value;
      if (sourceId === undefined) return;
      pending!.delete(sourceId); if (pending!.size === 0) this.pendingIngestEnrichment.delete(spaceId);
      const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.autoLinkController.signal]);
      const run = enrichAndImproveHomeGraphSource(this.requireSelfImprovementRuntime(), sourceId, spaceId, signal)
        .catch((error: unknown) => {
          if (!signal.aborted) this.reportBackgroundError('homegraph-ingest-enrich', error, { spaceId, sourceId });
        }).finally(() => {
          if (this.ingestEnrichmentRuns.get(spaceId)?.run === run) this.ingestEnrichmentRuns.delete(spaceId);
          this.scheduleIngestEnrichment(spaceId);
        });
      this.ingestEnrichmentRuns.set(spaceId, { sourceId, controller, run });
    }, 0, this.autoLinkController.signal);
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
  pageRefresh: { readonly requested: boolean; readonly refreshed: number },
): HomeGraphAskResult {
  if (!answer.answer.refinement && !pageRefresh.requested) return answer;
  const refinement = answer.answer.refinement;
  return {
    ...answer,
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
        pageRefreshed: pageRefresh.refreshed > 0,
      },
    },
  };
}

async function extractionHasSearchableText(extraction: Pick<KnowledgeExtractionRecord, 'structure'>): Promise<boolean> {
  const structure = readRecord(extraction.structure);
  return typeof structure.searchText === 'string' && !(await isUnusableHomeGraphExtractionText(structure.searchText));
}
