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
 * owner (`agent/protected-research-report.ts`). What leaves for a model is
 * still checked once by `snapshotJudgmentEvidence` (card data, attached
 * secrets, malformed input).
 */
import { snapshotJudgmentEvidence, snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { assertProjectionCurrent, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { ProtectedSourceOwner } from '@goodvibes-jev/engine/platform/platform/security';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import type { CommandContext } from '../input/command-registry.ts';
import type { ProviderApiLike, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import { contextWindowFor, modelRegistryKey } from './agent-harness-model-catalog.ts';

function assertReadingRestriction(callback: (() => unknown) | undefined): void {
  if (callback === undefined) return;
  if (typeof callback !== 'function') throw new ToolInputProjectionError('held');
  assertProjectionCurrent(callback);
}

export interface ModelReadingOptions {
  readonly signal?: AbortSignal | undefined;
  /** The research screening owner, for readers of research content only; local readings need none. */
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  /** The caller's own check (the call is still wanted); cheap, never a re-read of a source. */
  readonly assertCurrent?: (() => void) | undefined;
  /** Checks a reading hands to the publication boundary of the tool call (a judgment port's restriction). */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

/** A bounded plain copy of every field, including ones consumers do not display (hidden fields are data too). */
function captureModelReadingData<T>(value: T): T {
  const budget = { nodes: 0, characters: 0, slots: 0 };
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++budget.nodes > 100_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { budget.characters += entry.length; if (budget.characters > 1_000_000) return invalid(); return entry; }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || ancestors.has(entry)) return invalid();
    const existing = copies.get(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const length = array ? (entry as unknown[]).length : 0;
    if (length > 20_000) return invalid();
    if (array && (budget.slots += length) > 100_000) return invalid();
    const record = entry as Record<string, unknown>;
    const result: object = array ? new Array(length) : Object.create(null);
    ancestors.add(entry);
    try {
      for (const key of Object.getOwnPropertyNames(entry)) {
        if (array && key === 'length') continue;
        const field = record[key];
        if (typeof field === 'function') return invalid();
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        Object.defineProperty(result, key, { value: capture(field, depth + 1), enumerable: true });
      }
      Object.freeze(result); copies.set(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  return capture(value, 0) as T;
}

/** The complete immutable input, checked once at the boundary where it leaves for a model. */
export function captureModelReadingInput<T>(value: T): T {
  return snapshotJudgmentInput(captureModelReadingData(value)) as T;
}
/** A fresh capture must equal the bytes captured at the start of the call. */
export function assertModelReadingInputCurrent(value: unknown, serialized: string | undefined): void {
  if (JSON.stringify(captureModelReadingData(value)) !== serialized) throw new ToolInputProjectionError('held');
}

/** Only the ArtifactStore contract declares these top-level fields as epoch
 * clocks. Keep the native record and expose the same instant as ISO for a
 * reading. Metadata, bodies and every other field keep their meaning. */
export function captureModelArtifactClockSource<T extends Pick<ArtifactDescriptor, 'createdAt' | 'expiresAt'>>(value: T) {
  const native = captureModelReadingData(value);
  const instant = (clock: number): string => {
    if (!Number.isSafeInteger(clock) || Math.abs(clock) > 8_640_000_000_000_000) throw new ToolInputProjectionError('invalid');
    return new Date(clock).toISOString();
  };
  const reading = { ...native, createdAt: instant(native.createdAt),
    ...(Object.hasOwn(native, 'expiresAt') ? { expiresAt: native.expiresAt === undefined ? undefined : instant(native.expiresAt) } : {}) };
  return { native, reading };
}

export function captureModelArtifactClockSources(value: readonly ArtifactDescriptor[]) {
  const native = captureModelReadingData(value);
  return { native, reading: native.map(artifact => captureModelArtifactClockSource(artifact).reading) };
}

/**
 * A check that plain data still equals what it was when captured: the same
 * keys and equal values. The data is copied at capture, so a later change to
 * the original is seen; a frozen value that matched once is not compared
 * again. It compares data, not the program's own built-ins or descriptors.
 */
export function captureModelReadingSnapshotGuard(captured: unknown, _exactDescriptors = false): (value: unknown) => void {
  const original = copyPlainData(captured, 0);
  const matchedFrozen = new WeakSet<object>();
  return value => {
    if (value !== null && typeof value === 'object' && matchedFrozen.has(value)) return;
    if (!samePlainData(original, value, 0)) throw new ToolInputProjectionError('held');
    if (value !== null && typeof value === 'object' && Object.isFrozen(value)) matchedFrozen.add(value);
  };
}

function copyPlainData(value: unknown, depth: number): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth > 64) throw new ToolInputProjectionError('held');
  if (Array.isArray(value)) return value.map(entry => copyPlainData(entry, depth + 1));
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(value)) copy[key] = copyPlainData((value as Record<string, unknown>)[key], depth + 1);
  return copy;
}

function samePlainData(expected: unknown, current: unknown, depth: number): boolean {
  if (Object.is(expected, current)) return true;
  if (expected === null || current === null || typeof expected !== 'object' || typeof current !== 'object' || depth > 64) return false;
  if (Array.isArray(expected) !== Array.isArray(current)) return false;
  const keys = Object.keys(expected);
  if (keys.length !== Object.keys(current).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(current, key)) return false;
    if (!samePlainData((expected as Record<string, unknown>)[key], (current as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

/**
 * One reading: the source is copied once into a frozen plain value (checked
 * once for what may not leave for a model) and handed to `consume`. "Still
 * wanted" is the call's signal plus the caller's own check; the copy cannot
 * change, so it is not compared again.
 */
export async function withModelReadingSource<T, R>(source: T, options: ModelReadingOptions,
  consume: (captured: T, options: ModelReadingOptions) => Promise<R>): Promise<R> {
  options.signal?.throwIfAborted(); assertReadingRestriction(options.assertCurrent);
  const captured = snapshotJudgmentEvidence(captureModelReadingData(source)) as T;
  return consume(captured, options);
}

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
