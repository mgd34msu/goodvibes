import { declaredClassicModelStack } from '@goodvibes/engine/platform/platform/routing';
import { assertProjectionCurrent } from '@goodvibes/engine/platform/platform/tools/input-projection';
import type { ArtifactDescriptor } from '@goodvibes/engine/platform/platform/artifacts';
import { hasPurpose, PURPOSE_MODEL_COMPARE_JUDGMENT } from '@goodvibes/engine/terminal-shell/agent-turn/review-packet-presets-core';
import { previewHarnessText } from '@goodvibes/engine/terminal-shell/agent-turn/preview-text';
import { localStackForProvider } from './agent-harness-local-model-url.ts';
import type { LocalModelBenchmarkEvidence, LocalModelBenchmarkPlan, LocalModelBenchmarkRouteLatency, LocalModelBenchmarkWinner, LocalModelRecipe, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import type { ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import { readRecord, readString } from './agent-harness-model-routing-utils.ts';

export interface BenchmarkArtifactContext {
  readonly platform: { readonly artifactStore?: ArtifactListLike | null | undefined };
}

export function isLocalModelBenchmarkArtifact(artifact: ArtifactDescriptor): boolean {
  const purpose = readString(artifact.metadata.purpose);
  if (purpose !== 'agent-model-compare') return false;
  return readString(artifact.metadata.benchmarkKind) === 'local-model-route';
}

export function isModelCompareJudgmentArtifact(artifact: ArtifactDescriptor): boolean {
  return hasPurpose(artifact, PURPOSE_MODEL_COMPARE_JUDGMENT);
}

export function benchmarkCreatedAt(artifact: ArtifactDescriptor): string | null {
  const timestamp = typeof artifact.createdAt === 'number' ? artifact.createdAt : null;
  return timestamp == null ? null : new Date(timestamp).toISOString();
}

export function describeLocalBenchmarkArtifact(artifact: ArtifactDescriptor): Record<string, unknown> {
  const routeLatencies = localBenchmarkRouteLatenciesForArtifact(artifact);
  return {
    artifactId: artifact.id,
    ...(artifact.filename ? { filename: artifact.filename } : {}),
    createdAt: benchmarkCreatedAt(artifact),
    comparisonId: readString(artifact.metadata.comparisonId) || null,
    promptPreview: previewHarnessText(readString(artifact.metadata.promptPreview) || 'local model benchmark', 120),
    candidateCount: artifact.metadata.candidateCount ?? null,
    completedCandidates: artifact.metadata.completedCandidates ?? null,
    ...(routeLatencies.length > 0 ? {
      routeLatencies: routeLatencies.map((entry) => ({
        registryKey: entry.registryKey,
        latencyMs: entry.latencyMs,
        status: entry.status,
        blindId: entry.blindId,
      })),
    } : {}),
    benchmarkKind: readString(artifact.metadata.benchmarkKind) || 'local-model-route',
    reviewRoute: `agent_model_compare review artifactId:"${artifact.id}"`,
    revealRoute: `agent_model_compare reveal artifactId:"${artifact.id}"`,
  };
}

export function describeLocalBenchmarkJudgment(artifact: ArtifactDescriptor, winnerStack: string | null = null): Record<string, unknown> {
  const winnerModel = readString(artifact.metadata.winnerModel);
  const sourceArtifactId = readString(artifact.metadata.sourceArtifactId);
  return {
    artifactId: artifact.id,
    ...(artifact.filename ? { filename: artifact.filename } : {}),
    createdAt: benchmarkCreatedAt(artifact),
    judgmentId: readString(artifact.metadata.judgmentId) || null,
    comparisonId: readString(artifact.metadata.comparisonId) || null,
    sourceArtifactId: sourceArtifactId || null,
    winnerBlindId: readString(artifact.metadata.winnerBlindId) || null,
    revealIncludedInJudgment: artifact.metadata.revealIncludedInJudgment === true,
    winnerModel: winnerModel || null,
    winnerStack,
    promptPreview: previewHarnessText(readString(artifact.metadata.promptPreview) || 'local model benchmark judgment', 120),
    analyticsRoute: 'agent_model_compare analytics benchmarkKind:"local-model-route" includeReasons:true',
    exportRoute: `agent_model_compare export artifactId:"${artifact.id}" explicitUserRequest:"<the user request, in their own words>"`,
    applyRoute: winnerModel
      ? `agent_model_compare apply artifactId:"${artifact.id}" explicitUserRequest:"<the user request, in their own words>"`
      : null,
  };
}

function readLatencyMs(value: unknown): number | null {
  const numberValue = typeof value === 'number' ? value : Number.NaN;
  return Number.isFinite(numberValue) && numberValue >= 0 ? Math.round(numberValue) : null;
}

export function localBenchmarkRouteLatenciesForArtifact(artifact: ArtifactDescriptor): readonly LocalModelBenchmarkRouteLatency[] {
  const evidence = artifact.metadata.candidateLatencyEvidence;
  if (!Array.isArray(evidence)) return [];
  const comparisonId = readString(artifact.metadata.comparisonId) || null;
  const createdAt = benchmarkCreatedAt(artifact);
  return evidence.map((entry, index) => {
    const record = readRecord(entry);
    const registryKey = readString(record.registryKey);
    const latencyMs = readLatencyMs(record.latencyMs);
    if (!registryKey || latencyMs == null) return null;
    const blindId = readString(record.blindId) || String.fromCharCode(65 + index);
    return {
      registryKey,
      providerId: readString(record.providerId),
      modelId: readString(record.modelId) || registryKey,
      displayName: readString(record.displayName) || registryKey,
      blindId,
      latencyMs,
      status: readString(record.status) || 'unknown',
      artifactId: artifact.id,
      comparisonId,
      createdAt,
      reviewRoute: `agent_model_compare review artifactId:"${artifact.id}"`,
    };
  }).filter((entry): entry is LocalModelBenchmarkRouteLatency => entry !== null);
}

export function localBenchmarkRouteLatencies(artifacts: readonly ArtifactDescriptor[]): readonly LocalModelBenchmarkRouteLatency[] {
  const byRoute = new Map<string, LocalModelBenchmarkRouteLatency>();
  for (const artifact of artifacts) {
    for (const latency of localBenchmarkRouteLatenciesForArtifact(artifact)) {
      const current = byRoute.get(latency.registryKey);
      if (!current) {
        byRoute.set(latency.registryKey, latency);
        continue;
      }
      const currentTime = current.createdAt ? Date.parse(current.createdAt) : 0;
      const candidateTime = latency.createdAt ? Date.parse(latency.createdAt) : 0;
      if (candidateTime > currentTime || (candidateTime === currentTime && latency.latencyMs < current.latencyMs)) {
        byRoute.set(latency.registryKey, latency);
      }
    }
  }
  return [...byRoute.values()].sort((left, right) => left.registryKey.localeCompare(right.registryKey));
}

export function localBenchmarkRouteLatencyMap(context: BenchmarkArtifactContext): ReadonlyMap<string, LocalModelBenchmarkRouteLatency> {
  const store = context.platform.artifactStore ?? null;
  if (!store?.list) return new Map();
  const artifacts = store.list(ARTIFACT_WINDOW).filter(isLocalModelBenchmarkArtifact);
  return new Map(localBenchmarkRouteLatencies(artifacts).map((entry) => [entry.registryKey, entry]));
}

/** How many of the newest saved artifacts a benchmark read looks at. */
const ARTIFACT_WINDOW = 100;

export function localBenchmarkEvidence(
  comparisons: readonly ArtifactDescriptor[],
  judgments: readonly ArtifactDescriptor[],
  storeAvailable: boolean,
  stacks: ReadonlyMap<string, string | null> = new Map(),
): LocalModelBenchmarkEvidence {
  if (!storeAvailable) {
    return {
      status: 'unavailable',
      comparisonCount: 0,
      completedCandidateCount: 0,
      revealedJudgmentCount: 0,
      hiddenJudgmentCount: 0,
      winnerStacks: [],
      winnerModels: [],
      routeLatencies: [],
      summary: 'Artifact history is unavailable in this runtime.',
      confidence: 'estimated',
    };
  }
  const winnerModels: LocalModelBenchmarkWinner[] = [];
  let hiddenJudgmentCount = 0;
  for (const judgment of judgments) {
    const winnerModel = readString(judgment.metadata.winnerModel);
    if (!winnerModel) {
      hiddenJudgmentCount += 1;
      continue;
    }
    const sourceArtifactId = readString(judgment.metadata.sourceArtifactId);
    winnerModels.push({
      judgmentArtifactId: judgment.id,
      sourceArtifactId: sourceArtifactId || null,
      registryKey: winnerModel,
      stack: stacks.get(judgment.id) ?? null,
      promptPreview: previewHarnessText(readString(judgment.metadata.promptPreview) || 'local model benchmark judgment', 120),
      reviewRoute: sourceArtifactId
        ? `agent_model_compare review artifactId:"${sourceArtifactId}"`
        : 'agent_model_compare review',
      exportRoute: `agent_model_compare export artifactId:"${judgment.id}" explicitUserRequest:"<the user request, in their own words>"`,
      applyRoute: `agent_model_compare apply artifactId:"${judgment.id}" explicitUserRequest:"<the user request, in their own words>"`,
    });
  }
  const winnerStacks = [...new Set(winnerModels.map((winner) => winner.stack).filter((stack): stack is string => Boolean(stack)))].sort((a, b) => a.localeCompare(b));
  const completedCandidateCount = comparisons.reduce((total, artifact) => {
    const value = artifact.metadata.completedCandidates;
    return total + (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  }, 0);
  const routeLatencies = localBenchmarkRouteLatencies(comparisons);
  const status: LocalModelBenchmarkEvidence['status'] = winnerModels.length > 0
    ? 'reviewed-winner'
    : comparisons.length > 0
      ? 'comparison-saved'
      : 'unmeasured';
  return {
    status,
    comparisonCount: comparisons.length,
    completedCandidateCount,
    revealedJudgmentCount: winnerModels.length,
    hiddenJudgmentCount,
    winnerStacks,
    winnerModels,
    routeLatencies,
    summary: winnerModels.length > 0
      ? `Reviewed benchmark winner(s): ${winnerModels.map((winner) => winner.registryKey).join(', ')}.`
      : comparisons.length > 0
        ? 'Saved local benchmark comparison exists; save a revealed judgment before route recommendations.'
        : 'No saved local benchmark comparison has been recorded yet.',
    confidence: winnerModels.length > 0 ? 'measured' : 'estimated',
  };
}

export interface LocalModelBenchmarkSnapshot {
  readonly storeAvailable: boolean;
  /** True when the store returned a full page, so older artifacts may exist that were never read. */
  readonly windowFull?: boolean;
  readonly comparisons: readonly ArtifactDescriptor[];
  readonly judgments: readonly ArtifactDescriptor[];
  readonly stacks: readonly { readonly artifactId: string; readonly stack: string | null }[];
}
export interface LocalModelBenchmarkHistory extends Record<string, unknown> {
  readonly evidence: LocalModelBenchmarkEvidence;
}

/**
 * Local benchmark evidence. The producer's tag is the one owner of "this
 * comparison is a local benchmark" (`metadata.benchmarkKind`), and a judgment
 * belongs to it by its source link; an untagged comparison is not a local
 * benchmark. A winner's stack is its declared stack or its provider's, in code.
 * One listing, no content loads, no model.
 */
export function localModelBenchmarkSnapshot(context: BenchmarkArtifactContext): LocalModelBenchmarkSnapshot {
  const store = context.platform.artifactStore ?? null;
  if (!store?.list) return { storeAvailable: false, comparisons: [], judgments: [], stacks: [] };
  const allArtifacts = store.list(ARTIFACT_WINDOW);
  const comparisons = allArtifacts.filter(isLocalModelBenchmarkArtifact);
  const ids = new Set(comparisons.map(artifact => artifact.id));
  const judgments = allArtifacts.filter(artifact => isModelCompareJudgmentArtifact(artifact)
    && ids.has(readString(artifact.metadata.sourceArtifactId)));
  const stacks = judgments.flatMap(artifact => {
    const winnerModel = readString(artifact.metadata.winnerModel);
    return winnerModel ? [{ artifactId: artifact.id, stack: declaredClassicModelStack(readString(artifact.metadata.winnerStack)) ?? localStackForProvider(winnerModel) }] : [];
  });
  return { storeAvailable: true, windowFull: allArtifacts.length >= ARTIFACT_WINDOW, comparisons, judgments, stacks };
}

export function localBenchmarkRouteLatencyMapFor(snapshot: LocalModelBenchmarkSnapshot): ReadonlyMap<string, LocalModelBenchmarkRouteLatency> {
  return new Map(localBenchmarkRouteLatencies(snapshot.comparisons).map(entry => [entry.registryKey, entry]));
}

export function localModelBenchmarkHistoryFrom(snapshot: LocalModelBenchmarkSnapshot, includeParameters: boolean): LocalModelBenchmarkHistory {
  if (!snapshot.storeAvailable) return {
    status: 'unavailable', count: 0, reason: 'Artifact history is unavailable in this runtime.',
    saveRoute: 'agent_model_compare run benchmarkKind:"local-model-route" taskType:"local-model-route" explicitUserRequest:"<the user request, in their own words>"',
    evidence: localBenchmarkEvidence([], [], false),
  };
  const artifacts = snapshot.comparisons.slice(0, includeParameters ? 10 : 3);
  const judgments = snapshot.judgments.slice(0, includeParameters ? 10 : 3);
  const stacks = new Map(snapshot.stacks.map(entry => [entry.artifactId, entry.stack]));
  // Counts and the winner come from everything that was read; only the listed entries are shortened.
  const fullEvidence = localBenchmarkEvidence(snapshot.comparisons, snapshot.judgments, true, stacks);
  const windowNote = snapshot.windowFull
    ? ` Only the newest ${ARTIFACT_WINDOW} saved artifacts were searched; an older benchmark would not appear here.`
    : '';
  const evidence = windowNote ? { ...fullEvidence, summary: fullEvidence.summary + windowNote } : fullEvidence;
  return {
    status: artifacts.length > 0 ? 'history-found' : 'no-history', count: artifacts.length,
    total: snapshot.comparisons.length, totalJudgments: snapshot.judgments.length, truncated: snapshot.windowFull === true,
    artifacts: artifacts.map(describeLocalBenchmarkArtifact),
    judgments: judgments.map(artifact => describeLocalBenchmarkJudgment(artifact, stacks.get(artifact.id) ?? null)),
    evidence,
    nextAction: artifacts.length > 0
      ? evidence.status === 'reviewed-winner'
        ? 'Use the revealed saved judgment as evidence only; apply/update still needs a separate confirmed user request.'
        : `Review saved local benchmark ${artifacts[0]!.id}, then save a revealed judgment before recommending any default-model change.`
      : 'Run the setupPlan benchmark prompt and save the comparison artifact before recommending any default-model change.',
    analyticsRoute: 'agent_model_compare analytics benchmarkKind:"local-model-route" includeReasons:true',
    saveRoute: 'agent_model_compare run benchmarkKind:"local-model-route" taskType:"local-model-route" explicitUserRequest:"<the user request, in their own words>"',
    policy: 'Benchmark history is read-only evidence. A comparison counts as a local benchmark only when it was saved with benchmarkKind:"local-model-route"; untagged comparisons are not credited. Route changes still require a separate revealed judgment and confirmed apply/update action.',
  };
}

export function localModelBenchmarkHistory(context: BenchmarkArtifactContext, includeParameters: boolean): LocalModelBenchmarkHistory {
  return localModelBenchmarkHistoryFrom(localModelBenchmarkSnapshot(context), includeParameters);
}

/** The explicit reader is the same one listing as the startup snapshot; it only honours the call's signal. */
export async function readLocalModelBenchmarkSnapshot(context: BenchmarkArtifactContext, options: ModelReadingOptions): Promise<LocalModelBenchmarkSnapshot> {
  options.signal?.throwIfAborted(); assertProjectionCurrent(options.assertCurrent);
  return localModelBenchmarkSnapshot(context);
}

export async function readLocalModelBenchmarkHistory(context: BenchmarkArtifactContext, includeParameters: boolean, options: ModelReadingOptions): Promise<LocalModelBenchmarkHistory> {
  const snapshot = await readLocalModelBenchmarkSnapshot(context, options);
  options.signal?.throwIfAborted(); assertProjectionCurrent(options.assertCurrent);
  return localModelBenchmarkHistoryFrom(snapshot, includeParameters);
}

export function localModelBenchmarkPlan(recipe: LocalModelRecipe): LocalModelBenchmarkPlan {
  return {
    status: 'plan-ready',
    prompt: [
      'Benchmark this local route on one practical task:',
      '1. summarize the current project goal in five bullets,',
      '2. identify one likely setup risk,',
      '3. propose one next action with a command or route.',
    ].join(' '),
    measurements: [
      'time to first useful token',
      'total response latency',
      'whether the answer followed the requested structure',
      'whether the model handled project-specific nouns without hallucinating',
      'whether the route supports the needed context window and tool workflow',
    ],
    capabilityRoute: 'capability_find need:"benchmark a local model against a baseline", then capability_run with the routes to compare',
    compareRoute: `agent_model_compare run prompt:"local model benchmark: ${recipe.label}" benchmarkKind:"local-model-route" taskType:"local-model-route" explicitUserRequest:"<the user request, in their own words>"`,
    refreshRoute: 'agent_harness mode:"run_command" command:"/model refresh" explicitUserRequest:"<the user request, in their own words>"',
    notes: [
      'Use capabilityRoute when the user wants a form with benchmark defaults; use compareRoute when the model already has exact modelRefs.',
      'Run the same prompt against the local route and a baseline route before selecting a winner.',
      'Keep benchmark notes in the saved comparison artifact before changing the default model.',
      'Do not treat cached public benchmark scores as a substitute for this local latency and fit check.',
    ],
  };
}
