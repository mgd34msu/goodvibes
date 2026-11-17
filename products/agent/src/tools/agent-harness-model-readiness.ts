import { decisionOrClassic, isClassicOperation } from '@goodvibes-jev/engine/platform/platform/runtime';
import { arch, cpus, freemem, platform, totalmem } from 'node:os';
import { captureJudgmentPort } from '@goodvibes-jev/engine/errors';
import { prepareJudgmentResult } from '@goodvibes-jev/engine/platform/platform/gate';
import { routingRegistry, routeReadiness, localRecipeFit, routeReadinessFrom, localRecipeFitFrom } from '@goodvibes-jev/engine/platform/platform/routing';
import { assertProjectionCurrent, ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { readProviderHealthSignal } from './agent-harness-model-provider-health.ts';
import { listProviderRegistryProviders } from './agent-harness-model-catalog.ts';
import { modelReadingServicePath, withModelReadingSource, type ModelReadingOptions } from './agent-harness-model-reading-source.ts';
import type { LocalModelBenchmarkEvidence, LocalModelDetection, LocalModelHardwareProfile, LocalModelRecipe, LocalModelRecipeFit, ModelCandidate, ModelReadinessDimension, ModelReadinessScore, ModelRouteReadinessScore } from './agent-harness-model-routing-types.ts';
import { readRecord } from './agent-harness-model-routing-utils.ts';

export function localRecipeStackId(recipe: LocalModelRecipe): string {
  return recipe.id === 'openai-compatible-local' ? 'openai-compatible' : recipe.id === 'llama-cpp' ? 'llama.cpp' : recipe.id;
}
export function roundGb(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.max(0, Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10);
}
/** Raw local facts. Adequacy belongs to the recipe-specific reading. */
export function localHardwareProfile(): LocalModelHardwareProfile {
  const cpuList = cpus(), runtimePlatform = platform(), runtimeArch = arch();
  return {
    platform: runtimePlatform, arch: runtimeArch, cpuModel: cpuList[0]?.model ?? 'unknown CPU', cpuThreads: cpuList.length,
    ramGb: roundGb(totalmem()), freeRamGb: roundGb(freemem()),
    acceleratorHint: runtimePlatform === 'darwin' && runtimeArch === 'arm64' ? 'apple-silicon'
      : (process.env.CUDA_VISIBLE_DEVICES || process.env.NVIDIA_VISIBLE_DEVICES) ? 'cuda-env' : 'none-detected',
    privacy: 'local-only',
    caveat: 'Hardware scan uses local OS memory/CPU data and safe accelerator hints only; it does not probe drivers, download models, or benchmark live inference.',
  };
}
export function capabilityEnabled(capabilities: unknown, key: 'toolCalling' | 'multimodal'): boolean | null {
  const value = readRecord(capabilities)[key];
  return typeof value === 'boolean' ? value : null;
}
const RUBRIC = 'General Agent work: sustained interactive assistance with project context, reliable tool use, occasional image input, tolerable observed response latency and cost, and accurately disclosed prompt-data transfer. Readiness is advisory only and cannot override route availability, model limits, private-address checks, permissions, or confirmed apply actions.';
const NEXT_STEP = 'Inspect missing evidence and run a separately confirmed task-specific benchmark before changing any model route.';

export function deferredModelReadiness(reason = 'Readiness enrichment has not run.'): ModelReadinessScore {
  return { score: null, level: null, outcome: 'deferred', confidence: null, decisionId: null, provenance: null,
    cloudTransfer: null, dimensions: [], missingSignals: [reason], nextStep: NEXT_STEP };
}
export function deferredRecipeFit(): LocalModelRecipeFit {
  return { score: null, level: null, outcome: 'deferred', confidence: null, decisionId: null, memoryTier: null,
    provenance: null, reasons: ['Recipe-fit enrichment has not run.'] };
}

function classicReadiness(options: ModelReadingOptions): ModelReadinessScore {
  const nativeCurrent = () => { options.signal?.throwIfAborted(); };
  nativeCurrent(); assertProjectionCurrent(options.assertCurrent);
  options.retainCurrent?.(nativeCurrent); nativeCurrent();
  return { ...deferredModelReadiness('Classic does not perform semantic model-readiness assessment.'),
    provenance: { policy: 'classic', assessment: 'not-evaluated' } };
}
function classicFit(options: ModelReadingOptions): LocalModelRecipeFit {
  classicReadiness(options);
  return { ...deferredRecipeFit(), provenance: { policy: 'classic', assessment: 'not-evaluated' },
    reasons: ['Classic does not assess semantic hardware/recipe suitability.'] };
}

/** Batteries checked once against the routing registry. */
const registeredBatteries = new WeakSet<object>();
const batteryRegistered = (): void => {};

/**
 * The batteries are module constants registered when the routing module
 * loads; whether the registry serves this one is checked once, and nothing
 * about the program's own definition is re-checked per call.
 */
function batteryDefinitionGuard(battery: typeof routeReadiness | typeof localRecipeFit): () => void {
  if (registeredBatteries.has(battery)) return batteryRegistered;
  if (routingRegistry.get(battery.name) !== battery) throw new ToolInputProjectionError('held');
  registeredBatteries.add(battery);
  return batteryRegistered;
}

function readinessAuthority(battery: typeof routeReadiness | typeof localRecipeFit, scoped: ModelReadingOptions) {
  const assertDefinition = batteryDefinitionGuard(battery);
  scoped.retainCurrent?.(assertDefinition, battery.name);
  return captureJudgmentPort(battery.name, {
    signal: scoped.signal, prepareResultCapture: prepareJudgmentResult,
    assertCurrent: () => { scoped.assertCurrent?.(); assertDefinition(); },
  });
}
function retainReadinessAuthority(authority: ReturnType<typeof captureJudgmentPort>, scoped: ModelReadingOptions) {
  assertProjectionCurrent(scoped.assertCurrent);
  if (isClassicOperation()) return;
  const restriction = authority.consumeObservation();
  const semanticCurrent = () => { if (!isClassicOperation()) restriction.assertCurrent(); };
  scoped.retainCurrent?.(semanticCurrent);
  semanticCurrent();
}

/** The judged dimensions of a route: latency adequacy, privacy and cloud transfer. Every other dimension is a typed fact. */
async function readRoute(source: unknown, options: ModelReadingOptions) {
  return withModelReadingSource(source, options, async (state, scoped) => {
    scoped.assertCurrent?.();
    return decisionOrClassic(async () => {
      const decision = routingRegistry.get('agent.models.route-readiness');
      if (!decision || typeof modelReadingServicePath(decision, ['run']) !== 'function') return routeReadinessFrom(null);
      const battery = decision as typeof routeReadiness;
      const authority = readinessAuthority(battery, scoped);
      try {
        const run = await battery.run(authority.port, state as unknown as Parameters<typeof battery.run>[1], {
          site: battery.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
          only: ['latency', 'privacy', 'cloudTransfer'],
        });
        authority.assertCurrent();
        const result = routeReadinessFrom(run);
        authority.assertCurrent(); return result;
      } finally { retainReadinessAuthority(authority, scoped); }
    }, () => { assertProjectionCurrent(scoped.assertCurrent); return routeReadinessFrom(null); });
  });
}

type FactDimension = Exclude<ModelReadinessDimension['id'], 'latency' | 'privacy'>;
interface FactScore { readonly normalized: number; readonly summary: string }

/** Context window on the rubric's scale: sustained interactive work with project context. */
function contextWindowScore(tokens: number): FactScore {
  const normalized = tokens >= 200_000 ? 1 : tokens >= 128_000 ? 0.9 : tokens >= 64_000 ? 0.75 : tokens >= 32_000 ? 0.6 : tokens >= 16_000 ? 0.4 : 0.2;
  return { normalized, summary: `Context window ${tokens.toLocaleString('en-US')} tokens.` };
}
/** Cost from the registry's tier: what the owner pays per request on this route. */
const TIER_COST: Readonly<Record<string, number>> = { free: 1, subscription: 0.85, standard: 0.6, paid: 0.5, premium: 0.35 };

/** The four dimensions the model record states, scored by code; null when the record does not state it. */
function factDimensions(model: ModelCandidate): ReadonlyMap<FactDimension, FactScore | null> {
  const tools = capabilityEnabled(model.capabilities, 'toolCalling');
  const vision = capabilityEnabled(model.capabilities, 'multimodal');
  const cost = model.tier ? TIER_COST[model.tier] : undefined;
  return new Map<FactDimension, FactScore | null>([
    ['context-window', model.contextWindow != null && model.contextWindow > 0 ? contextWindowScore(model.contextWindow) : null],
    ['tool-support', tools === null ? null : { normalized: tools ? 1 : 0, summary: tools ? 'Tool calling is supported.' : 'Tool calling is not supported.' }],
    // Image input is occasional in the rubric, so a text-only model keeps half the weight.
    ['vision', vision === null ? null : { normalized: vision ? 1 : 0.5, summary: vision ? 'Image input is supported.' : 'Text input only.' }],
    ['cost', cost === undefined ? null : { normalized: cost, summary: `Cost tier ${model.tier}.` }],
  ]);
}

/** The composite over all six dimensions: code-scored facts plus the judged latency and privacy. */
function composed(reading: ReturnType<typeof routeReadinessFrom>, facts: ReadonlyMap<FactDimension, FactScore | null>): ModelReadinessScore {
  const dimensions: ModelReadinessDimension[] = routeReadiness.composite.dimensions.map(({ id, label, weight }) => {
    const fact = id === 'latency' || id === 'privacy' ? undefined : facts.get(id);
    if (fact) return { id, label, weight, score: Math.round(fact.normalized * 100), normalized: fact.normalized, confidence: 1, outcome: 'ready' as const, summary: fact.summary };
    const judged = reading.dimensions.find(dimension => dimension.id === id);
    return { ...judged, id, label, weight, score: judged?.score ?? null, confidence: judged?.confidence ?? null,
      outcome: judged?.outcome ?? 'unavailable', summary: judged?.reason ?? 'Settled rubric reading.' };
  });
  const unsettled = dimensions.find(dimension => dimension.outcome !== 'ready');
  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const normalized = unsettled ? null : dimensions.reduce((sum, dimension) => sum + dimension.weight * (dimension.score ?? 0) / 100, 0) / totalWeight;
  const judgedConfidence = dimensions.filter(dimension => dimension.id === 'latency' || dimension.id === 'privacy').map(dimension => dimension.confidence);
  const confidence = normalized === null || judgedConfidence.some(value => value === null) ? null : Math.min(...judgedConfidence as number[]);
  return {
    score: normalized === null ? null : Math.round(normalized * 100), normalized,
    level: normalized === null ? null : routeReadiness.composite.levels.find(entry => normalized >= entry.at)!.level,
    outcome: unsettled?.outcome ?? 'ready', confidence, decisionId: reading.decisionId, provenance: reading.provenance,
    cloudTransfer: reading.cloudTransfer, dimensions, missingSignals: unsettled ? [unsettled.summary] : [], nextStep: NEXT_STEP,
  };
}

export async function modelReadinessScore(context: CommandContext, model: ModelCandidate, options: ModelReadingOptions = {}): Promise<ModelRouteReadinessScore> {
  const providerHealth = readProviderHealthSignal(model.providerId, model.registryKey, model.modelId);
  const provider = listProviderRegistryProviders(context).find(value => {
    const facts = readRecord(value); return facts.id === model.providerId || facts.providerId === model.providerId || facts.name === model.providerId;
  }) ?? null;
  const healthLatency = providerHealth.status === 'measured' && providerHealth.measuredRouteId === model.registryKey
    && typeof providerHealth.avgLatencyMs === 'number' && providerHealth.measurementRecordedAt
    ? { milliseconds: providerHealth.avgLatencyMs, routeId: providerHealth.measuredRouteId, recordedAt: providerHealth.measurementRecordedAt,
      calls: (providerHealth.successCalls ?? 0) + (providerHealth.errorCalls ?? 0), errorRate: providerHealth.errorRate ?? null, source: 'agent-provider-calls' } : null;
  const benchmark = model.localBenchmarkLatency;
  const benchmarkLatency = benchmark && benchmark.registryKey === model.registryKey && benchmark.providerId === model.providerId
    && benchmark.status === 'completed' && Number.isFinite(benchmark.latencyMs) && benchmark.latencyMs >= 0
    && benchmark.createdAt && Number.isFinite(Date.parse(benchmark.createdAt)) ? benchmark : null;
  const latency = healthLatency ?? benchmarkLatency;
  const facts = factDimensions(model);
  const missing = new Map<ModelReadinessDimension['id'], string>();
  if (!latency) missing.set('latency', 'No latency measurement for this exact route: neither a call in this session nor a saved local benchmark. One turn on the route, or a model comparison, measures it.');
  if (!facts.get('context-window')) missing.set('context-window', 'Context-window metadata is missing.');
  if (!facts.get('tool-support')) missing.set('tool-support', 'Tool-calling capability is unknown.');
  if (!facts.get('vision')) missing.set('vision', 'Vision capability is unknown.');
  if (!facts.get('cost')) missing.set('cost', model.tier ? `Cost tier "${model.tier}" is not one the rubric scores.` : 'Cost evidence is missing.');
  const providerFacts = readRecord(provider);
  const providerConfig = readRecord(providerFacts.config);
  const hasEndpointFacts = [providerFacts.baseUrl, providerFacts.baseURL, providerFacts.api, providerFacts.endpoint, providerConfig.baseUrl, providerConfig.baseURL].some(value => {
    if (typeof value !== 'string' || !value.trim()) return false;
    try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
  });
  const hasHostingFacts = hasEndpointFacts || [providerFacts.hosting, providerFacts.documentation, providerFacts.setupDescription, providerFacts.anonymousDetail].some(value => typeof value === 'string' && value.trim().length > 0);
  if (!hasHostingFacts) missing.set('privacy', 'Provider and endpoint facts are missing; a route name is not hosting evidence.');
  const explicitlyUnavailable = model.available === false || model.configured === false
    || providerFacts.available === false || providerFacts.isAvailable === false || providerFacts.configured === false || providerFacts.isConfigured === false;
  const unavailable = (score: ModelReadinessScore): ModelRouteReadinessScore => explicitlyUnavailable
    ? { ...score, score: null, normalized: null, level: null, confidence: null, outcome: 'unavailable',
      missingSignals: [...score.missingSignals, 'This provider or model is unavailable or unconfigured.'], providerHealth }
    : { ...score, providerHealth };
  if (isClassicOperation()) return unavailable(classicReadiness(options));
  // A score needs all six dimensions; with any evidence missing nothing is asked.
  if (missing.size > 0) return unavailable({ ...deferredModelReadiness(), missingSignals: [...missing.values()] });
  const reading = await readRoute({ subject: model, rubric: RUBRIC, provider, measuredLatency: latency, benchmarkQuality: model.benchmarkCompositeScore ?? null,
    providerHealth }, options);
  if (isClassicOperation()) return unavailable(classicReadiness(options));
  return unavailable(composed(reading, facts));
}

/**
 * Recipe examples are names: no exact route, measured latency, context window,
 * tool support, cost or endpoint exists for them, so a recipe's route
 * readiness is stated as deferred with the evidence each dimension needs.
 */
export function localRecipeReadinessScore(recipe: LocalModelRecipe): ModelReadinessScore {
  const exampleVision = recipe.modelExamples.map(example => ({
    example, value: null, probability: null, confidence: null, decisionId: null, provenance: null, outcome: 'deferred',
    reason: 'No advertised capability or documentation is supplied for this example.',
  }));
  return { ...deferredModelReadiness(), exampleVision, missingSignals: [
    'Recipe examples have no measured latency for an exact configured route.',
    'Verify the context window of the exact model served.',
    'Verify tool calling on the exact model and server.',
    'Example names do not establish advertised vision capability.',
    'Recipe identity does not establish the cost of a configured route.',
    'Recipe identity does not establish the endpoint or prompt-data transfer policy.',
  ] };
}

export async function scoreLocalModelRecipe(recipe: LocalModelRecipe, hardware: LocalModelHardwareProfile, detection: LocalModelDetection,
  options: ModelReadingOptions = {}): Promise<LocalModelRecipeFit> {
  if (isClassicOperation()) return classicFit(options);
  return withModelReadingSource({ recipe, hardware, detection, rubric: RUBRIC }, options, async (state, scoped) => {
    return decisionOrClassic(async () => {
      const decision = routingRegistry.get('agent.models.local-recipe-fit');
      if (!decision || typeof modelReadingServicePath(decision, ['run']) !== 'function') return { ...deferredRecipeFit(), outcome: 'unavailable' };
      const battery = decision as typeof localRecipeFit;
      const authority = readinessAuthority(battery, scoped);
      try {
        const run = await battery.run(authority.port, state as unknown as Parameters<typeof battery.run>[1], {
          site: battery.name, signal: authority.signal, beforeAttempt: authority.assertCurrent,
        });
        authority.assertCurrent(); const reading = localRecipeFitFrom(run);
        return { ...reading, reasons: reading.outcome === 'ready' ? ['Settled hardware and recipe-requirements reading.'] : ['Hardware fit is unsettled.'] };
      } finally { retainReadinessAuthority(authority, scoped); }
    }, () => { assertProjectionCurrent(scoped.assertCurrent); return classicFit(scoped); });
  });
}
