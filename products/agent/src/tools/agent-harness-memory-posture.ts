import { withConfiguredDecisionModelPolicy } from '@goodvibes-jev/engine/platform/platform/runtime';
import {
  MemoryUsageStatsStore,
  type MemoryDoctorReport,
  type MemoryEmbeddingProviderStatus,
  type MemoryVectorStats,
  type MemoryUsageSummary,
} from '@goodvibes-jev/engine/platform/platform/state';
import type { CommandContext } from '../input/command-registry.ts';
import { buildAgentWorkspaceMemorySnapshot, type buildAgentWorkspaceRuntimeSnapshot } from '../input/agent-workspace-snapshot.ts';
import { buildAgentWorkspaceSessionMemoryCount } from '../input/agent-workspace-snapshot-builders.ts';
import { readConfigString } from '../input/agent-workspace-snapshot-config.ts';
import { previewHarnessText } from '@goodvibes-jev/engine/terminal-shell/agent-turn/preview-text';
import { rankHarnessCatalog, type CatalogRankingOptions } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ranking';
import { modelReadingServicePath } from './agent-harness-model-reading-source.ts';
import { capturePersonalOpsSnapshot, protectPersonalOpsData } from './agent-harness-personal-ops-source.ts';
import { assertMemoryCurrent, retainMemoryReadingOptions, selectMemoryProvider } from './agent-harness-memory-provider-readings.ts';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { EXTERNAL_MEMORY_SETUP_STEP, externalMemoryProviders } from './agent-harness-memory-external-providers.ts';
import type { ExternalMemoryProviderRecord, MemoryPostureProvider, MemoryProviderResolution } from './agent-harness-memory-external-providers.ts';
import { clampReadLimit } from '@goodvibes-jev/engine/terminal-shell/agent-turn/read-helpers';
import { readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';

type MemoryPostureStatus = 'ready' | 'needs-review' | 'empty' | 'unavailable';
type MemoryVectorPostureStatus = 'ready' | 'attention' | 'disabled' | 'unavailable';
interface AgentHarnessMemoryPostureArgs {
  readonly providerId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

function readLimit(value: unknown, fallback: number): number {
  return clampReadLimit(value, fallback, 200);
}

type MemoryPostureSnapshot = Pick<ReturnType<typeof buildAgentWorkspaceRuntimeSnapshot>, 'localMemoryCount' | 'localMemoryReviewQueueCount'
  | 'localMemoryPromptActiveCount' | 'localMemoryTemporallyPendingCount' | 'localMemoryTemporallyExpiredCount' | 'sessionMemoryCount' | 'embeddingProvider'>;
function memoryPostureSnapshot(context: CommandContext): MemoryPostureSnapshot {
  const memory = buildAgentWorkspaceMemorySnapshot(context);
  return { localMemoryCount: memory.count, localMemoryReviewQueueCount: memory.reviewQueueCount, localMemoryPromptActiveCount: memory.promptActiveCount,
    localMemoryTemporallyPendingCount: memory.temporallyPendingCount, localMemoryTemporallyExpiredCount: memory.temporallyExpiredCount,
    sessionMemoryCount: buildAgentWorkspaceSessionMemoryCount(context), embeddingProvider: readConfigString(context, 'provider.embeddingProvider', '(provider default)') };
}

function memoryApi(context: CommandContext): {
  readonly vectorStats?: () => MemoryVectorStats;
  readonly doctor?: () => Promise<MemoryDoctorReport>;
} | null {
  // Admit every enclosing service descriptor before the typed interface is read.
  modelReadingServicePath(context, ['clients', 'agentKnowledgeApi', 'memory']);
  return context.clients?.agentKnowledgeApi?.memory ?? null;
}

/**
 * The call's own check (its signal and admission) is the only currentness
 * test for a posture read: the memory counts are read once, and a count a
 * moment old is corrected by the next read.
 */
function memoryReadingOptions(originalOptions: CatalogRankingOptions): CatalogRankingOptions {
  return retainMemoryReadingOptions(originalOptions);
}

async function awaitMemoryRead<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    work.then(value => { signal.removeEventListener('abort', abort); signal.aborted ? reject(signal.reason) : resolve(value); },
      (error: unknown) => { signal.removeEventListener('abort', abort); reject(signal.aborted ? signal.reason : error); });
    if (signal.aborted) abort();
  });
}

function protectedRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ToolInputProjectionError('held');
  return Object.fromEntries(Object.entries(value));
}
function protectedText(value: unknown): string {
  if (typeof value !== 'string') throw new ToolInputProjectionError('held');
  return value;
}
function protectedStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new ToolInputProjectionError('held');
  return value.map(protectedText);
}
function preserveNative(record: Record<string, unknown>, native: Readonly<Record<string, unknown>>, keys: readonly string[]): void {
  for (const key of keys) if (!Object.is(record[key], native[key])) throw new ToolInputProjectionError('held');
}
function protectedVector(native: MemoryVectorStats, value: unknown): MemoryVectorStats {
  const record = protectedRecord(value);
  preserveNative(record, { ...native }, ['backend', 'enabled', 'available', 'dimensions', 'indexedRecords', 'embeddingProviderId']);
  return { backend: native.backend, enabled: native.enabled, available: native.available, dimensions: native.dimensions,
    indexedRecords: native.indexedRecords, embeddingProviderId: native.embeddingProviderId,
    embeddingProviderLabel: protectedText(record.embeddingProviderLabel), path: protectedText(record.path),
    ...(native.error !== undefined ? { error: protectedText(record.error) } : {}),
    ...(native.platformLimitReason !== undefined ? { platformLimitReason: protectedText(record.platformLimitReason) } : {}) };
}

async function protectMemoryVector(value: MemoryVectorStats, options: CatalogRankingOptions): Promise<MemoryVectorStats> {
  const source = capturePersonalOpsSnapshot(value);
  const sourceCurrent = () => { options.signal?.throwIfAborted(); source.assertCurrent(value); };
  options.retainCurrent?.(sourceCurrent);
  const protectedValue = await protectPersonalOpsData(value, { ...options, assertCurrent: () => { assertMemoryCurrent(options); sourceCurrent(); } });
  const result = protectedVector(value, protectedValue); assertMemoryCurrent(options); sourceCurrent(); return result;
}

async function protectMemoryDoctor(value: MemoryDoctorReport, options: CatalogRankingOptions): Promise<MemoryDoctorReport> {
  const source = capturePersonalOpsSnapshot(value);
  const sourceCurrent = () => { options.signal?.throwIfAborted(); source.assertCurrent(value); };
  options.retainCurrent?.(sourceCurrent);
  const protectedValue = await protectPersonalOpsData(value, { ...options, assertCurrent: () => { assertMemoryCurrent(options); sourceCurrent(); } });
  const record = protectedRecord(protectedValue), embeddings = protectedRecord(record.embeddings);
  if (record.checkedAt !== value.checkedAt || embeddings.activeProviderId !== value.embeddings.activeProviderId
    || !Array.isArray(embeddings.providers) || embeddings.providers.length !== value.embeddings.providers.length) throw new ToolInputProjectionError('held');
  const protectedProviders = embeddings.providers;
  const providers = value.embeddings.providers.map((native, index): MemoryEmbeddingProviderStatus => {
    const provider = protectedRecord(protectedProviders[index]);
    preserveNative(provider, { ...native }, ['id', 'state', 'configured', 'dimensions', 'deterministic']);
    return { id: native.id, state: native.state, configured: native.configured, dimensions: native.dimensions,
      label: protectedText(provider.label), metadata: protectedRecord(provider.metadata),
      ...(native.deterministic !== undefined ? { deterministic: native.deterministic } : {}),
      ...(native.detail !== undefined ? { detail: protectedText(provider.detail) } : {}) };
  });
  const asyncProviders = protectedStrings(embeddings.asyncProviders), syncProviders = protectedStrings(embeddings.syncProviders);
  if (asyncProviders.length !== value.embeddings.asyncProviders.length || asyncProviders.some((id, index) => id !== value.embeddings.asyncProviders[index])
    || syncProviders.length !== value.embeddings.syncProviders.length || syncProviders.some((id, index) => id !== value.embeddings.syncProviders[index])) throw new ToolInputProjectionError('held');
  const result = { checkedAt: value.checkedAt, vector: protectedVector(value.vector, record.vector), embeddings: {
    activeProviderId: value.embeddings.activeProviderId, providers, asyncProviders, syncProviders, warnings: protectedStrings(embeddings.warnings) } };
  assertMemoryCurrent(options); sourceCurrent(); return result;
}

/**
 * Per-memory usage counters (injected, assessed, referenced). The turn tracker
 * writes them as columns on the memory records, so the store this runtime
 * composed is the one to read; they cover exactly the memories that exist.
 */
function readMemoryUsageSummary(context: CommandContext): MemoryUsageRead {
  const registry = context.extensions?.memoryRegistry;
  if (registry) {
    try {
      return { summary: new MemoryUsageStatsStore(registry).summary() };
    } catch (error) {
      logger.warn('Memory usage counters could not be read', { error: summarizeError(error) });
      return { summary: null, readError: previewHarnessText(summarizeError(error), 160) };
    }
  }
  return { summary: null };
}

interface MemoryUsageRead {
  readonly summary: MemoryUsageSummary | null;
  /** Set when the counters could not be read, as opposed to there being none. */
  readonly readError?: string;
}

function buildUsageSection(read: MemoryUsageRead): Record<string, unknown> {
  const summary = read.summary;
  if (!summary) {
    return read.readError
      ? { status: 'unavailable', signal: 'jev-reading', note: 'Usage counters exist but could not be read.', readError: read.readError }
      : { status: 'unavailable', signal: 'jev-reading', note: 'No usage instrumentation available in this runtime.' };
  }
  return {
    status: summary.everInjected > 0 ? 'tracked' : 'empty',
    signal: 'jev-reading',
    signalNote: summary.signalNote,
    totalTracked: summary.totalTracked,
    everInjected: summary.everInjected,
    everReferenced: summary.everReferenced,
    neverReferenced: summary.neverReferenced,
    mostReferenced: summary.mostReferenced.map((entry) => ({ id: entry.id, injectedCount: entry.injectedCount, referencedCount: entry.referencedCount, lastReferencedAt: entry.lastReferencedAt })),
    neverReferencedSample: summary.neverReferencedSample.map((entry) => ({ id: entry.id, injectedCount: entry.injectedCount, lastInjectedAt: entry.lastInjectedAt })),
    policy: 'Referenced means the model output overlapped this memory\'s distinctive content (heuristic, not ground truth). Never-referenced injected memories decay first during idle consolidation. Counts cover memories that still exist.',
  };
}

/** A status source that throws is logged and named in `errors`, so a failing dependency is not shown as an absent one. */
function noteMemoryReadFailure(errors: string[] | undefined, source: string, error: unknown): void {
  logger.warn('Memory posture source could not be read', { source, error: summarizeError(error) });
  errors?.push(`${source}: ${previewHarnessText(summarizeError(error), 120)}`);
}

async function readMemoryDoctor(context: CommandContext, options: CatalogRankingOptions, errors?: string[]): Promise<MemoryDoctorReport | null> {
  assertMemoryCurrent(options);
  const memory = memoryApi(context);
  if (!memory || typeof memory.doctor !== 'function') return null;
  let report: MemoryDoctorReport;
  try { report = await awaitMemoryRead(memory.doctor(), options.signal); }
  catch (error: unknown) { assertMemoryCurrent(options); if (error instanceof ToolInputProjectionError) throw error; noteMemoryReadFailure(errors, 'memory.doctor', error); return null; }
  assertMemoryCurrent(options);
  return protectedMemoryRead(() => protectMemoryDoctor(report, options), options, errors, 'memory.doctor');
}

/**
 * A value the redaction layer would not return unchanged is that read's own
 * unavailable state. A held outcome while the sources moved is still the
 * call's retry-able outcome and is rethrown.
 */
async function protectedMemoryRead<T>(read: () => Promise<T>, options: CatalogRankingOptions, errors: string[] | undefined, source: string): Promise<T | null> {
  try { return await read(); }
  catch (error: unknown) {
    if (!(error instanceof ToolInputProjectionError) || error.problem !== 'held') throw error;
    assertMemoryCurrent(options); options.assertCurrent?.();
    noteMemoryReadFailure(errors, source, error);
    return null;
  }
}

async function readVectorStats(context: CommandContext, doctor: MemoryDoctorReport | null, options: CatalogRankingOptions, errors?: string[]): Promise<MemoryVectorStats | null> {
  assertMemoryCurrent(options);
  if (doctor?.vector) return doctor.vector;
  const memory = memoryApi(context);
  if (!memory || typeof memory.vectorStats !== 'function') return null;
  let vector: MemoryVectorStats;
  try { vector = memory.vectorStats(); }
  catch (error: unknown) { assertMemoryCurrent(options); if (error instanceof ToolInputProjectionError) throw error; noteMemoryReadFailure(errors, 'memory.vectorStats', error); return null; }
  options.assertCurrent?.(); return protectedMemoryRead(() => protectMemoryVector(vector, options), options, errors, 'memory.vectorStats');
}

function memoryStatus(snapshot: MemoryPostureSnapshot, memoryAvailable: boolean): MemoryPostureStatus {
  if (!memoryAvailable) return 'unavailable';
  if (snapshot.localMemoryCount === 0) return 'empty';
  if (snapshot.localMemoryPromptActiveCount > 0) return 'ready';
  return 'needs-review';
}

function vectorStatus(vector: MemoryVectorStats | null): MemoryVectorPostureStatus {
  if (!vector) return 'unavailable';
  if (!vector.enabled) return 'disabled';
  if (vector.available && !vector.error) return 'ready';
  return 'attention';
}

function describeEmbeddingProvider(
  provider: MemoryEmbeddingProviderStatus,
  activeProviderId: string | undefined,
  includeParameters: boolean,
): MemoryPostureProvider {
  return {
    id: provider.id,
    label: provider.label,
    kind: 'embedding',
    status: provider.state,
    summary: previewHarnessText(provider.detail ?? `${provider.configured ? 'configured' : 'not configured'} memory embedding provider`, includeParameters ? 180 : 96),
    modelRoute: `memory action:"provider" providerId:${JSON.stringify(provider.id)}`,
    setupRoute: `settings action:"set" key:"provider.embeddingProvider" value:"${provider.id}" explicitUserRequest:"<the user request, in their own words>"`,
    configured: provider.configured,
    active: provider.id === activeProviderId,
    dimensions: provider.dimensions,
    ...(typeof provider.deterministic === 'boolean' ? { deterministic: provider.deterministic } : {}),
    ...(includeParameters ? { metadata: provider.metadata } : {}),
  };
}

function describeExternalProvider(provider: ExternalMemoryProviderRecord, includeParameters: boolean): MemoryPostureProvider {
  return {
    id: provider.id,
    label: provider.label,
    kind: 'external-memory',
    status: provider.status,
    summary: previewHarnessText(provider.summary, includeParameters ? 180 : 96),
    modelRoute: `memory action:"provider" providerId:${JSON.stringify(provider.id)}`,
    setupRoute: `agent_harness mode:"mcp_server" mcpServerId:${JSON.stringify(provider.serverName)}`,
    configured: provider.connected,
    external: provider,
  };
}

function providerSearchText(provider: MemoryPostureProvider): string {
  return [
    provider.id, provider.label, provider.kind, provider.status, provider.summary, provider.modelRoute, provider.setupRoute ?? '',
    provider.external ? [provider.external.serverName, ...Object.values(provider.external.routes).map(route => route?.toolName ?? ''), provider.external.nextStep].join('\n') : '',
  ].join('\n').toLowerCase();
}

function compactProvider(provider: MemoryPostureProvider, includeParameters: boolean): Record<string, unknown> {
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    status: provider.status,
    summary: provider.summary,
    modelRoute: provider.modelRoute,
    ...(provider.setupRoute ? { setupRoute: provider.setupRoute } : {}),
    ...(includeParameters && typeof provider.configured === 'boolean' ? { configured: provider.configured } : {}),
    ...(includeParameters && typeof provider.active === 'boolean' ? { active: provider.active } : {}),
    ...(includeParameters && typeof provider.dimensions === 'number' ? { dimensions: provider.dimensions } : {}),
    ...(includeParameters && typeof provider.deterministic === 'boolean' ? { deterministic: provider.deterministic } : {}),
    ...(includeParameters && provider.metadata ? { metadata: provider.metadata } : {}),
    ...(provider.external ? { routes: provider.external.routes, promptEligible: false, nextStep: provider.external.nextStep } : {}),
  };
}

async function buildProviderRecords(
  context: CommandContext,
  args: AgentHarnessMemoryPostureArgs,
  options: CatalogRankingOptions,
): Promise<{
  readonly doctor: MemoryDoctorReport | null;
  readonly vector: MemoryVectorStats | null;
  readonly providers: readonly MemoryPostureProvider[];
  readonly external: readonly ExternalMemoryProviderRecord[];
  readonly readErrors: readonly string[];
}> {
  const includeParameters = args.includeParameters === true;
  const readErrors: string[] = [];
  const doctor = await readMemoryDoctor(context, options, readErrors);
  const vector = await readVectorStats(context, doctor, options, readErrors);
  const external = await externalMemoryProviders(context, options);
  const embeddingProviders = (doctor?.embeddings.providers ?? []).map((provider) => (
    describeEmbeddingProvider(provider, doctor?.embeddings.activeProviderId, includeParameters)
  ));
  return {
    doctor,
    vector,
    providers: [...embeddingProviders, ...external.map(provider => describeExternalProvider(provider, includeParameters))],
    external,
    readErrors,
  };
}

function nextActions(
  snapshot: MemoryPostureSnapshot,
  memoryStatusValue: MemoryPostureStatus,
  vectorStatusValue: MemoryVectorPostureStatus,
  doctor: MemoryDoctorReport | null,
  externalCount: number,
): readonly string[] {
  const actions: string[] = [];
  if (memoryStatusValue === 'empty') actions.push('Create one durable non-secret Agent memory only after the user asks to remember it.');
  if (memoryStatusValue === 'needs-review') actions.push('Review or stale memory candidates before relying on them in the prompt.');
  if (snapshot.localMemoryReviewQueueCount > 0) actions.push('Use learning_curator or memory review routes to clear the memory review queue.');
  if (vectorStatusValue === 'attention') actions.push('Run memory vector doctor, then rebuild the vector index if the reported issue is fixed.');
  if (doctor?.embeddings.warnings.length) actions.push('Inspect the active embedding provider warning before semantic recall or rebuild work.');
  if (externalCount === 0) actions.push(EXTERNAL_MEMORY_SETUP_STEP);
  return actions.slice(0, 6);
}

function compactVector(vector: MemoryVectorStats | null): Record<string, unknown> {
  if (!vector) {
    return {
      status: 'unavailable',
      summary: 'Memory vector stats are not exposed in this runtime.',
      modelRoute: 'memory action:"status"',
    };
  }
  return {
    status: vectorStatus(vector),
    backend: vector.backend,
    enabled: vector.enabled,
    available: vector.available,
    indexedRecords: vector.indexedRecords,
    dimensions: vector.dimensions,
    embeddingProviderId: vector.embeddingProviderId,
    embeddingProviderLabel: vector.embeddingProviderLabel,
    ...(vector.error ? { error: previewHarnessText(vector.error, 160) } : {}),
    modelRoute: 'agent_harness mode:"workspace_action" actionId:"memory-vector-status"',
    doctorRoute: 'agent_harness mode:"workspace_action" actionId:"memory-vector-doctor"',
    rebuildRoute: 'agent_harness mode:"run_workspace_action" actionId:"memory-vector-rebuild" explicitUserRequest:"<the user request, in their own words>"',
  };
}

export async function memoryPostureSummary(context: CommandContext, args: AgentHarnessMemoryPostureArgs, reading: CatalogRankingOptions = {}): Promise<Record<string, unknown>> {
  return withConfiguredDecisionModelPolicy(() => ownedMemoryPostureSummary(context, args, reading));
}

async function ownedMemoryPostureSummary(context: CommandContext, args: AgentHarnessMemoryPostureArgs, reading: CatalogRankingOptions): Promise<Record<string, unknown>> {
  const options = memoryReadingOptions(reading);
  const includeParameters = args.includeParameters === true;
  const limit = readLimit(args.limit, 100);
  const query = readString(args.query);
  const snapshot = memoryPostureSnapshot(context);
  const { doctor, vector, providers, external, readErrors } = await buildProviderRecords(context, args, options);
  const status = memoryStatus(snapshot, Boolean(memoryApi(context)));
  const vectorState = vectorStatus(vector);
  const ranked = query ? await rankHarnessCatalog(providers, query, provider => ({ id: `${provider.kind}:${provider.id}`,
    description: providerSearchText(provider), evidence: provider }), 'agent.memory.providers', { ...options, requirePreservedSource: true }) : undefined;
  if (ranked?.judgments.some(({ reading }) => reading.outcome !== 'act' || reading.verdict === 'uncertain')) throw new ToolInputProjectionError('held');
  assertMemoryCurrent(options);
  const filteredProviders = (ranked ? ranked.matches.map(({ entry }) => entry) : providers).slice(0, limit)
    .map(provider => compactProvider(provider, includeParameters));
  return {
    status,
    localMemory: {
      total: snapshot.localMemoryCount,
      reviewQueue: snapshot.localMemoryReviewQueueCount,
      promptActive: snapshot.localMemoryPromptActiveCount,
      // Visible expiry (temporal validity window): still stored and counted in
      // `total`, never deleted, but outside [validFrom, validUntil) so not
      // prompt-injected, see memoryRecordTemporalStatus.
      temporallyPending: snapshot.localMemoryTemporallyPendingCount,
      temporallyExpired: snapshot.localMemoryTemporallyExpiredCount,
      sessionMemory: snapshot.sessionMemoryCount,
      policy: 'Only reviewed, high-confidence, temporally-active Agent-local memories are prompt-active. Fresh/stale/setup-blocked/pending/expired behavior stays visible for review.',
      routes: {
        list: 'memory action:"list"',
        search: 'memory action:"search" query:"..."',
        reviewQueue: 'memory action:"curator" query:"memory review"',
        create: 'memory action:"create" summary:"..." explicitUserRequest:"..."',
        curator: 'memory action:"curator"',
      },
    },
    usage: buildUsageSection(readMemoryUsageSummary(context)),
    vector: compactVector(vector),
    embeddings: {
      activeProviderId: doctor?.embeddings.activeProviderId ?? vector?.embeddingProviderId ?? snapshot.embeddingProvider,
      warnings: doctor?.embeddings.warnings.map((warning) => previewHarnessText(warning, includeParameters ? 180 : 96)) ?? [],
      syncProviders: doctor?.embeddings.syncProviders ?? [],
      asyncProviders: doctor?.embeddings.asyncProviders ?? [],
    },
    ...(readErrors.length > 0 ? { readErrors } : {}),
    providers: filteredProviders,
    returned: filteredProviders.length,
    totalProviders: providers.length,
    externalMemory: external.length === 0
      ? { status: 'none-connected', summary: 'No external memory provider is connected; memory is stored locally.', next: EXTERNAL_MEMORY_SETUP_STEP }
      : {
        status: external.some(provider => provider.status === 'available') ? 'available' : 'attention',
        providers: external.map(provider => ({ id: provider.id, label: provider.label, status: provider.status, nextStep: provider.nextStep })),
        policy: 'External memory is read through the provider\'s MCP read tool when a task needs it and never enters the prompt on its own; writes, forgets and syncs are outward effects that keep their admission.',
      },
    nextActions: nextActions(snapshot, status, vectorState, doctor, external.length),
    policy: 'Memory posture is read-only. Memory edits, vector rebuilds, and embedding-provider changes stay on existing confirmed Agent-local routes.',
    ...(includeParameters ? {
      checkedAt: doctor?.checkedAt ?? null,
      providerLookup: 'memory action:"provider" providerId:"<id>"',
    } : {}),
  };
}

export async function describeMemoryProvider(context: CommandContext, args: AgentHarnessMemoryPostureArgs, reading: CatalogRankingOptions = {}): Promise<MemoryProviderResolution> {
  return withConfiguredDecisionModelPolicy(() => ownedDescribeMemoryProvider(context, args, reading));
}

async function ownedDescribeMemoryProvider(context: CommandContext, args: AgentHarnessMemoryPostureArgs, reading: CatalogRankingOptions): Promise<MemoryProviderResolution> {
  const options = memoryReadingOptions(reading);
  const input = readString(args.providerId) || readString(args.target) || readString(args.query);
  if (!input) {
    return {
      status: 'missing_lookup',
      usage: 'memory action:"provider" requires providerId, target, or query. Use memory action:"status" to inspect available provider ids.',
    };
  }
  const includeParameters = args.includeParameters !== false;
  const { providers } = await buildProviderRecords(context, { ...args, includeParameters }, options);
  const exact = providers.find(provider => provider.id === input);
  assertMemoryCurrent(options);
  if (exact) return { status: 'found', provider: compactProvider(exact, true) };
  if (readString(args.providerId)) return { status: 'missing_lookup', usage: `Unknown memory provider ${input}. Use memory action:"status" to inspect available provider ids.` };
  const selected = await selectMemoryProvider(providers, input, options);
  assertMemoryCurrent(options);
  if (selected) return { status: 'found', provider: compactProvider(selected, true) };
  return {
    status: 'missing_lookup',
    usage: `Unknown memory provider ${input}. Use memory action:"status" to inspect available provider ids.`,
  };
}
