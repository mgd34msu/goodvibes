/**
 * Readings of the owner's own state for a decision model.
 *
 * Trust boundary, stated once: objects on `CommandContext` (the provider
 * registry, the config manager, the artifact store, the provider API) are the
 * Agent's own in-process services and are read as ordinary properties. A tool
 * call reads each source once into a plain value and passes that value down;
 * a value cannot change, so nothing compares it again between steps. Data that
 * is copied for a reading is bounded here (node and character budgets) and
 * nowhere else.
 *
 * First-party local reads are not privacy-screened: they are the owner's own
 * state read by his own session. Research content keeps its own screening
 * owner (the engine's agent-turn protected-research-report.ts). What leaves for a model is
 * still checked once by `snapshotJudgmentEvidence` (card data, attached
 * secrets, malformed input).
 */
import { ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import {
  agentResearchSourceOwner,
  assertModelReadingRestriction as assertReadingRestriction,
  captureModelArtifactClockSources,
  captureModelReadingInput,
  type ModelReadingOptions,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { CommandContext } from '../input/command-registry.ts';
import type { ProviderApiLike, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import { contextWindowFor, modelRegistryKey } from './agent-harness-model-catalog.ts';

// The plain-data capture is shared with the Agent tools a daemon-hosted turn runs.
export {
  assertModelReadingInputCurrent,
  captureModelArtifactClockSource,
  captureModelArtifactClockSources,
  captureModelReadingInput,
  captureModelReadingSnapshotGuard,
  withModelReadingSource,
  type ModelReadingOptions,
} from '@goodvibes-jev/engine/terminal-shell/agent-turn';

/** A service slot of the program's own objects, read as an ordinary property. */
function slot(source: unknown, key: string): unknown {
  if (source == null) return undefined;
  if (typeof source !== 'object' && typeof source !== 'function') throw new ToolInputProjectionError('held');
  return (source as Record<string, unknown>)[key];
}
function path(source: unknown, keys: readonly string[]): unknown {
  return keys.reduce((value, key) => slot(value, key), source);
}
export { path as modelReadingServicePath };

const CONFIG_KEYS = ['provider.reasoningEffort', 'provider.embeddingProvider', 'provider.systemPromptFile',
  'helper.enabled', 'helper.globalProvider', 'helper.globalModel', 'tools.llmEnabled', 'tools.llmProvider', 'tools.llmModel'] as const;

/** The options of one model-routing tool call: its signal, its own check and, for research readers, the screening owner. */
export function modelReadingOptions(_context: CommandContext, registry?: ToolRegistry, signal?: AbortSignal,
  assertExecution?: () => void, retainCurrent?: (guard: () => void, key?: string) => void): ModelReadingOptions {
  return { sourceOwner: agentResearchSourceOwner(registry), signal, retainCurrent, assertCurrent() {
    signal?.throwIfAborted(); assertReadingRestriction(assertExecution);
  } };
}

/** Registry services hold adapters, not JSON metadata. Only routing and display
 * facts are read; credential and client internals and transport functions never
 * enter a reading. Plain published records are taken whole. */
export const MODEL_PROVIDER_READING_FACT_FIELDS = Object.freeze(['name', 'id', 'providerId', 'label', 'displayName', 'description', 'baseURL', 'baseUrl', 'endpoint', 'api',
    'hosting', 'documentation', 'setupDescription', 'anonymousDetail', 'capabilities', 'adapterKind', 'modelSource', 'serviceNames', 'envVars', 'metadata', 'available', 'isAvailable'] as const);

/** The reading facts of one registered provider adapter. */
export function providerReadingFacts(provider: unknown): Record<string, unknown> {
  if (provider === null || typeof provider !== 'object') return {};
  const prototype = Object.getPrototypeOf(provider);
  if (prototype === Object.prototype || prototype === null) return provider as Record<string, unknown>;
  const facts: Record<string, unknown> = {};
  for (const key of MODEL_PROVIDER_READING_FACT_FIELDS) {
    const value = slot(provider, key);
    if (value !== undefined && typeof value !== 'function') facts[key] = value;
  }
  // A built-in provider may compute `models` in a getter that builds its whole
  // catalog; only a stored list is taken, the registry's own model list
  // supplies the rest.
  const modelField = Object.getOwnPropertyDescriptor(provider, 'models');
  if (modelField && 'value' in modelField) facts.models = modelField.value;
  const configured = slot(provider, 'isConfigured');
  if (typeof configured === 'function') {
    const result: unknown = configured.call(provider);
    if (typeof result === 'boolean') facts.isConfigured = result;
  } else if (typeof configured === 'boolean') facts.isConfigured = configured;
  return facts;
}

/** The newest saved benchmark artifacts the readers look at. */
const BENCHMARK_ARTIFACT_WINDOW = 100;
const BENCHMARK_ARTIFACT_PURPOSES = new Set(['agent-model-compare', 'agent-model-compare-judgment']);

/**
 * Benchmark comparisons and their judgments, newest first. The window applies after
 * the filter: a saved benchmark older than the newest hundred unrelated artifacts is
 * still found.
 */
export function listBenchmarkArtifacts(store: ArtifactListLike | undefined): ReturnType<NonNullable<ArtifactListLike['list']>> {
  const all = store?.list?.(Number.MAX_SAFE_INTEGER) ?? [];
  return all.filter(artifact => {
    const purpose = slot(slot(artifact, 'metadata'), 'purpose');
    return typeof purpose === 'string' && BENCHMARK_ARTIFACT_PURPOSES.has(purpose.trim());
  }).slice(0, BENCHMARK_ARTIFACT_WINDOW);
}

/**
 * Every source a model-routing tool call needs, read once at the top of the
 * call: the provider API's model list, favorites and current model, the
 * provider registry's models and providers, the saved benchmark artifacts,
 * the context window of each listed model, nine config keys and the session's
 * runtime facts. `consume` receives a context that serves those values, so
 * every reader in the call agrees and no source is listed twice.
 */
export async function withModelReadingContext<T>(context: CommandContext, _invocation: unknown, options: ModelReadingOptions,
  consume: (context: CommandContext, options: ModelReadingOptions) => Promise<T>): Promise<T> {
  const signal = options.signal;
  signal?.throwIfAborted(); assertReadingRestriction(options.assertCurrent);
  const api = path(context, ['clients', 'providerApi']) as ProviderApiLike | undefined;
  const registry = path(context, ['provider', 'providerRegistry']) as {
    readonly listModels?: () => readonly unknown[]; readonly listProviders?: () => readonly unknown[];
  } | undefined;
  const store = path(context, ['platform', 'artifactStore']) as ArtifactListLike | undefined;
  const manager = path(context, ['platform', 'configManager']) as { readonly get?: (key: string) => unknown } | undefined;
  const session = path(context, ['session', 'runtime']);
  const [models, favorites, currentModel] = api
    ? await Promise.all([api.listModels({ selectableOnly: true }), api.getFavorites(), api.getCurrentModel()])
    : [[] as readonly unknown[], null, null];
  signal?.throwIfAborted();
  const providerIds = api?.listProviderIds() ?? [];
  const registryModels = typeof registry?.listModels === 'function' ? registry.listModels() : [];
  const providers = (typeof registry?.listProviders === 'function' ? registry.listProviders() : []).map(providerReadingFacts);
  const nativeArtifacts = captureModelArtifactClockSources(listBenchmarkArtifacts(store)).native;
  const benchmarkIds = new Set(nativeArtifacts.map(artifact => artifact.id));
  const sourceContext = { provider: { providerRegistry: registry } } as unknown as CommandContext;
  const contextWindows = new Map<string, number | null>();
  for (const model of [...models, ...(currentModel ? [currentModel] : [])]) {
    const key = modelRegistryKey(model);
    if (!contextWindows.has(key)) contextWindows.set(key, contextWindowFor(sourceContext, model));
  }
  const config = new Map<string, unknown>(CONFIG_KEYS.map(key => [key, typeof manager?.get === 'function' ? manager.get(key) : undefined]));
  const runtime = { sessionId: slot(session, 'sessionId'), model: slot(session, 'model'), provider: slot(session, 'provider'), reasoningEffort: slot(session, 'reasoningEffort') };
  const readContent = store?.readContent;
  const windowFor = (model: unknown) => contextWindows.get(modelRegistryKey(model)) ?? null;
  const projected = {
    session: { runtime },
    provider: { providerRegistry: { listModels: () => registryModels, listProviders: () => providers,
      getKnownContextWindowForModel: windowFor, getContextWindowForModel: windowFor } },
    platform: {
      readModels: {},
      artifactStore: store ? { list: () => nativeArtifacts, ...(readContent ? { readContent: async (id: string) => {
        signal?.throwIfAborted();
        // The call reads the benchmark artifacts it listed, nothing else in the store.
        if (!benchmarkIds.has(id)) throw new ToolInputProjectionError('held');
        return readContent.call(store, id);
      } } : {}) } : undefined,
      configManager: { get: (key: string) => config.get(key) },
    },
    clients: {
      operator: {},
      // Kept at the provider API's own location for requireProviderApi.
      providerApi: api ? { listModels: async () => models, getFavorites: async () => favorites,
        getCurrentModel: async () => currentModel, listProviderIds: () => providerIds } : undefined,
    },
  };
  return consume(projected as unknown as CommandContext, options);
}

/** The voice and media provider descriptors a media or pairing reading includes, read once. */
export function captureCatalogNativeFacts(context: unknown, family: 'media' | 'pairing' | 'cockpit') {
  const providerDescriptors = family === 'cockpit' ? [] : (['voiceProviderRegistry', 'mediaProviderRegistry'] as const).flatMap(key => {
    const registry = path(context, ['platform', key]) as { readonly list?: () => unknown } | undefined;
    return typeof registry?.list === 'function' ? [{ domain: key, data: registry.list() }] : [];
  });
  return { providerEvidence: captureModelReadingInput({ providerDescriptors }) };
}

/** The options of one catalog tool call: its signal, its own check and the research screening owner. */
export function catalogReadingOptions(_context: CommandContext, registry: ToolRegistry | undefined, signal: AbortSignal | undefined,
  assertExecution: () => void, retainCurrent: (guard: () => void, key?: string) => void) {
  return { signal, sourceOwner: agentResearchSourceOwner(registry), retainCurrent, assertCurrent() {
    signal?.throwIfAborted(); assertReadingRestriction(assertExecution);
  } };
}
