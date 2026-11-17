import { OwnedSelectionObservation } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import { captureConfigSelectedScalars, type ConfigScalarSelection } from '@goodvibes-jev/engine/platform/platform/config';
import { JudgmentAuthorityRetiredError } from '@goodvibes-jev/engine/errors';
import { dirname, relative } from 'node:path';
import { VoiceProviderRegistry, captureVoiceProviderReadSource } from '@goodvibes-jev/engine/platform/platform/voice';
import { MediaProviderRegistry, captureMediaProviderReadSource } from '@goodvibes-jev/engine/platform/platform/media';
import { types as nodeTypes } from 'node:util';
import { constants as fsConstants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { captureAgentExportPath } from './agent-artifact-effect.ts';
import { connectedHostOperatorTokenPath, readConnectedHostOperatorToken } from '../runtime/connected-host-auth.ts';
import { captureCatalogSnapshot } from './agent-harness-catalog-ranking.ts';
import { captureNativeReadModelObservation } from './agent-harness-autonomy-live-records.ts';
import { snapshotJudgmentEvidence, snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { SOURCE_SCREENING_LIMITS, type ProtectedSource, type ProtectedSourceOwner, type SourceScreeningReceipt } from '@goodvibes-jev/engine/platform/platform/security';
import { assertProjectionCurrent, ToolInputProjectionError, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';
import type { ArtifactDescriptor } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { CommandContext } from '../input/command-registry.ts';
import { requireSettledScreeningReceipt } from './agent-harness-screening-result.ts';
import type { ProviderApiLike, ArtifactListLike } from './agent-harness-model-routing-types.ts';
import { contextWindowFor, modelRegistryKey } from './agent-harness-model-catalog.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { RetainedGuards } from './agent-harness-retained-guards.ts';

function assertReadingRestriction(callback: (() => unknown) | undefined): void {
  if (callback === undefined) return;
  if (typeof callback !== 'function') throw new ToolInputProjectionError('held');
  assertProjectionCurrent(callback);
}

export interface ModelReadingOptions {
  readonly signal?: AbortSignal | undefined;
  readonly sourceOwner?: ProtectedSourceOwner | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  /** Backend guards outlive inner receipt cleanup and remain active until publication. */
  readonly retainCurrent?: ((guard: () => void, key?: string) => void) | undefined;
}

/** Capture every field, including ones consumers do not display (hidden fields are data too). */
function captureModelReadingData<T>(value: T): T {
  const budget = { nodes: 0, characters: 0, slots: 0 };
  const ancestors = new Set<object>();
  const copies = new WeakMap<object, object>();
  const getCopy = (entry: object): object | undefined => copies.get(entry);
  const setCopy = (entry: object, copy: object): void => { copies.set(entry, copy); };
  const arrays: { readonly length: number; readonly keys: readonly string[] }[] = [];
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++budget.nodes > 100_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { budget.characters += entry.length; if (budget.characters > 1_000_000) return invalid(); return entry; }
    if (entry === null || entry === undefined || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || ancestors.has(entry)) return invalid();
    const existing = getCopy(entry); if (existing) return existing;
    const array = Array.isArray(entry);
    const prototype: unknown = Object.getPrototypeOf(entry);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const names = Object.getOwnPropertyNames(entry);
    if (Object.getOwnPropertySymbols(entry).length > 0 || Object.hasOwn(entry, 'toJSON')
      || (array && Object.hasOwn(entry, 'constructor'))) return invalid();
    const length = array ? (entry as unknown[]).length : 0;
    if (length > 20_000) return invalid();
    if (array && (budget.slots += length) > 100_000) return invalid();
    if (array) arrays.push({ length, keys: names });
    const record = entry as Record<string, unknown>;
    const result: object = array ? new Array(length) : Object.create(null);
    ancestors.add(entry);
    try {
      for (const key of names) {
        if (array && key === 'length') continue;
        const field = record[key];
        if (typeof field === 'function') return invalid();
        budget.characters += key.length;
        if (budget.characters > 1_000_000) return invalid();
        // Hidden source data is screened through the same final enumerable DTO.
        Object.defineProperty(result, key, { value: capture(field, depth + 1), enumerable: true });
      }
      Object.freeze(result); setCopy(entry, result); return result;
    } finally { ancestors.delete(entry); }
  };
  const data = capture(value, 0);
  // Keep the original array-layout checks after complete source capture. They
  // inspect only the captured key lists, so a second detached tree is unnecessary.
  for (const { length, keys } of arrays) {
    if (keys.length !== length + 1 || keys.some(key => key !== 'length'
      && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length)))
      throw new ToolInputProjectionError('invalid');
  }
  // Bound expanded JSON work as well as unique DAG nodes. An alias added during
  // a late mutation cannot make equality checking expand exponentially.
  let nodes = 0, characters = 0;
  const bound = (entry: unknown): void => {
    if (++nodes > 20_000) throw new ToolInputProjectionError('invalid');
    if (typeof entry === 'string') characters += entry.length;
    else if (entry !== null && typeof entry === 'object') for (const [key, child] of Object.entries(entry)) { characters += key.length; bound(child); }
    if (characters > 1_000_000) throw new ToolInputProjectionError('invalid');
  };
  bound(data);
  return data as T;
}

/** Screen the complete immutable input once; no service acquisition precedes it. */
export function captureModelReadingInput<T>(value: T): T {
  return snapshotJudgmentInput(captureModelReadingData(value)) as T;
}
/** A fresh capture must equal the already-screened bytes. Repeating
 * privacy classification on unchanged bytes at each nested guard adds no proof. */
export function assertModelReadingInputCurrent(value: unknown, serialized: string | undefined): void {
  if (JSON.stringify(captureModelReadingData(value)) !== serialized) throw new ToolInputProjectionError('held');
}

/** Only the retained native ArtifactStore contract declares these top-level
 * fields as generated epoch clocks. Preserve the complete raw descriptor locally
 * and expose the same instant as ISO before privacy screening. Metadata, bodies
 * and every other field retain their original meaning and screening. */
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

/** Validate the complete borrowed list before invoking any array operation. */
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

/** Whole semantic values are batched, never truncated or split inside strings.
 * Large collections retain their complete key path and every entry. */
export function screeningBatches(captured: unknown, serialized: string): readonly (readonly string[])[] {
  if (serialized.length > 1_000_000) throw new ToolInputProjectionError('held');
  const parts: string[] = [];
  const visit = (value: unknown, keys: readonly string[]) => {
    const part = keys.length ? JSON.stringify({ path: keys, value }) : serialized;
    if (part.length <= SOURCE_SCREENING_LIMITS.characters) { parts.push(part); return; }
    if (value === null || typeof value !== 'object') throw new ToolInputProjectionError('held');
    const entries = Object.entries(value);
    if (!entries.length) throw new ToolInputProjectionError('held');
    for (const [key, child] of entries) visit(child, [...keys, key]);
  };
  visit(captured, []);
  // A large structured value can produce thousands of small path/value
  // fragments. Pack adjacent complete fragments into JSON arrays before
  // applying the native part quota; otherwise small fields exhaust source
  // handles even though their complete text fits the character budget.
  const packed: string[] = [];
  // Verification embeds the text in both the original parts and excerpts.
  // Account for JSON escaping while packing, so dense structured text does
  // not exceed Jev's request budget despite fitting the raw character limit.
  const encodedSize = (part: string) => JSON.stringify(part).length;
  let group: string[] = [], groupSize = 4;
  const flush = () => {
    if (group.length) packed.push(group.length === 1 ? group[0]! : `[${group.join(',')}]`);
    group = []; groupSize = 4;
  };
  for (const part of parts) {
    const size = encodedSize(part) - 2;
    if (groupSize + (group.length ? 1 : 0) + size > SOURCE_SCREENING_LIMITS.characters) flush();
    if (size + 4 > SOURCE_SCREENING_LIMITS.characters) { packed.push(part); continue; }
    groupSize += (group.length ? 1 : 0) + size; group.push(part);
  }
  flush();
  const batches: string[][] = [];
  let size = 0, encoded = 0, total = 0;
  for (const part of packed) {
    total += part.length;
    if (total > 1_000_000) throw new ToolInputProjectionError('held');
    let batch = batches.at(-1);
    if (!batch || batch.length >= SOURCE_SCREENING_LIMITS.parts || size + part.length > SOURCE_SCREENING_LIMITS.characters
      || encoded + encodedSize(part) > SOURCE_SCREENING_LIMITS.characters) {
      batch = []; batches.push(batch); size = 0; encoded = 0;
    }
    batch.push(part); size += part.length; encoded += encodedSize(part);
  }
  if (batches.length > SOURCE_SCREENING_LIMITS.sources) throw new ToolInputProjectionError('held');
  return batches;
}

/**
 * A projection is authority to use these exact captured facts, never to
 * rewrite identity. The source is captured once into a frozen copy, screened
 * by the source owner, and handed to `consume`. "Still wanted" is the call's
 * signal plus the caller's check; the screening owner's projection must still
 * equal what it screened. The copy cannot change, so it is not compared again.
 */
export async function withModelReadingSource<T, R>(source: T, options: ModelReadingOptions,
  consume: (captured: T, options: ModelReadingOptions) => Promise<R>): Promise<R> {
  const signal = options.signal, originalAssert = options.assertCurrent, originalRetain = options.retainCurrent;
  const checkSignal = (): void => { signal?.throwIfAborted(); };
  checkSignal(); assertReadingRestriction(originalAssert);
  const captured = snapshotJudgmentEvidence(captureModelReadingData(source)) as T;
  const serialized = JSON.stringify(captured);
  if (typeof serialized !== 'string') throw new ToolInputProjectionError('held');
  const batches = screeningBatches(captured, serialized);
  // One guard per key: a later reading of the same source replaces the earlier one.
  const retained = new RetainedGuards();
  const retainCurrent = (guard: () => void, key?: string) => {
    if (typeof guard !== 'function') throw new ToolInputProjectionError('held');
    retained.add(guard, key);
    assertReadingRestriction(originalRetain ? () => originalRetain(guard, key) : undefined);
  };
  const owner = options.sourceOwner;
  if (!owner) throw new ToolInputProjectionError('unavailable');
  const handles: ProtectedSource[] = [];
  const receipts: { readonly receipt: SourceScreeningReceipt; readonly parts: readonly string[] }[] = [];
  let released = false, releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true; signal?.removeEventListener('abort', abort);
    // Every handle gets its release attempt, and a failed release is logged, never
    // thrown: cleanup failing must not replace a reading that already succeeded
    // or the error that ended it.
    releasing = Promise.resolve().then(async () => {
      const outcomes = await Promise.allSettled(handles.map(handle => Promise.resolve().then(() => owner.release(handle))));
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') logger.warn('A protected model-reading source could not be released', { error: summarizeError(outcome.reason) });
      }
    });
    return releasing;
  };
  const abort = () => { void release().catch(() => {}); };
  const assertPublicationCurrent = () => {
    checkSignal(); assertReadingRestriction(originalAssert);
    for (const guard of retained.values()) assertReadingRestriction(guard);
  };
  const assertCurrent = () => {
    assertPublicationCurrent();
    if (released) throw new ToolInputProjectionError('held');
    // The owner's projection must still be what it screened.
    for (const { receipt, parts } of receipts) {
      const projection = owner.project(receipt);
      if (projection.length !== parts.length || projection.some((part, index) => part !== parts[index])) throw new ToolInputProjectionError('held');
    }
  };
  try {
    signal?.addEventListener('abort', abort, { once: true });
    assertCurrent();
    for (const batch of batches) { checkSignal(); handles.push(owner.capture(batch)); }
    for (const [index, handle] of handles.entries()) {
      const screened = await owner.screen(handle, { signal, assertCurrent }); checkSignal();
      const receipt = requireSettledScreeningReceipt(screened);
      receipts.push({ receipt, parts: batches[index]! });
    }
    assertCurrent();
    const result = await consume(captured, { ...options, assertCurrent, retainCurrent });
    assertCurrent(); return result;
  } finally { await release(); assertPublicationCurrent(); }
}

/** A service slot of the program's own objects, read as an ordinary property. */
function slot(source: unknown, key: string): unknown {
  if (source == null) return undefined;
  if (typeof source !== 'object') throw new ToolInputProjectionError('held');
  return (source as Record<string, unknown>)[key];
}
function path(source: unknown, keys: readonly string[]): unknown {
  return keys.reduce((value, key) => slot(value, key), source);
}
export { path as modelReadingServicePath };

const READ_MODEL_PATHS = [
  ['platform', 'readModels', 'providerHealth'], ['platform', 'readModels', 'providersHealth'],
  ['platform', 'readModels', 'modelRouteHealth'], ['platform', 'readModels', 'routeHealth'],
  ['platform', 'readModels', 'models', 'providerHealth'], ['platform', 'readModels', 'models', 'routeHealth'],
  ['platform', 'providerHealth'], ['clients', 'operator', 'providerHealth'],
  ['platform', 'readModels', 'localModelServers'], ['platform', 'readModels', 'localModelServing'],
  ['platform', 'readModels', 'localModelDiagnostics'], ['platform', 'readModels', 'models', 'localServers'],
  ['platform', 'readModels', 'models', 'servingDiagnostics'], ['platform', 'readModels', 'localModels', 'servingDiagnostics'],
  ['platform', 'readModels', 'ollama', 'servingDiagnostics'], ['platform', 'readModels', 'llamaCpp', 'servingDiagnostics'],
  ['platform', 'readModels', 'vllm', 'servingDiagnostics'], ['platform', 'readModels', 'localAi', 'servingDiagnostics'],
  ['platform', 'readModels', 'openAiCompatible', 'servingDiagnostics'], ['platform', 'localModelServing'],
  ['clients', 'operator', 'models', 'servingDiagnostics'], ['clients', 'operator', 'localModelServingDiagnostics'],
] as const;
const CONFIG_KEYS = ['provider.reasoningEffort', 'provider.embeddingProvider', 'provider.systemPromptFile',
  'helper.enabled', 'helper.globalProvider', 'helper.globalModel', 'tools.llmEnabled', 'tools.llmProvider', 'tools.llmModel'] as const;
const SNAPSHOT_METHODS = ['getSnapshot', 'snapshot', 'list', 'listProviders', 'listRoutes', 'listHealth'] as const;

/** Normalize native Maps mechanically into plain records. */
function captureReadModelData(value: unknown, initial = true): unknown {
  const ancestors = new Set<object>();
  let nodes = 0, characters = 0;
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const walk = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { characters += entry.length; if (characters > 1_000_000) return invalid(); return entry; }
    if (entry == null || typeof entry === 'boolean' || typeof entry === 'number') return entry;
    if (typeof entry !== 'object' || ancestors.has(entry)) return invalid();
    const prototype = Object.getPrototypeOf(entry);
    ancestors.add(entry);
    try {
      if (entry instanceof Map) {
        if (Reflect.ownKeys(entry).length) return invalid();
        const rows: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
        for (const [key, child] of entry as Map<unknown, unknown>) {
          if (typeof key !== 'string') return invalid();
          characters += key.length; if (characters > 1_000_000) return invalid();
          Object.defineProperty(rows, key, { value: walk(child, depth + 1), enumerable: true });
        }
        return rows;
      }
      const array = Array.isArray(entry);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
      if (Object.getOwnPropertySymbols(entry).length > 0 || Object.hasOwn(entry, 'toJSON')) return invalid();
      const length = array ? (entry as unknown[]).length : 0;
      if (length > 20_000) return invalid();
      const record = entry as Record<string, unknown>;
      const result: object = array ? new Array(length) : Object.create(null) as object;
      for (const key of Object.getOwnPropertyNames(entry)) {
        if (array && key === 'length') continue;
        const field = record[key];
        if (typeof field === 'function') return invalid();
        characters += key.length; if (characters > 1_000_000) return invalid();
        Object.defineProperty(result, key, { value: walk(field, depth + 1), enumerable: Object.prototype.propertyIsEnumerable.call(entry, key) });
      }
      return result;
    } finally { ancestors.delete(entry); }
  };
  const normalized = walk(value, 0);
  // Existing readers distinguish a keyed record collection from a single record.
  const rootMap = value instanceof Map;
  const data = rootMap ? { records: normalized } : normalized;
  return initial ? captureModelReadingInput(data) : captureModelReadingData(data);
}
function snapshotReadModel(source: unknown, initial = true): unknown {
  if (source == null) return source;
  for (const key of SNAPSHOT_METHODS) {
    const method = slot(source, key);
    if (typeof method === 'function') {
      const result: unknown = method.call(source);
      if (nodeTypes.isPromise(result)) throw new ToolInputProjectionError('held');
      return captureReadModelData(result, initial);
    }
  }
  return captureReadModelData(source, initial);
}
function setPath(target: Record<string, unknown>, keys: readonly string[], value: unknown): void {
  let current = target;
  for (const key of keys.slice(0, -1)) {
    if (!current[key]) current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keys.at(-1)!] = value;
}

const modelReadingSources = new WeakMap<ModelReadingOptions, { readonly context: CommandContext; readonly source: ReturnType<typeof captureCatalogProducerSources> }>();
const getModelReadingSources = modelReadingSources.get.bind(modelReadingSources);
const setModelReadingSources = modelReadingSources.set.bind(modelReadingSources);

/** Captures the complete original invocation before adapters can omit fields. */
export function modelReadingOptions(context: CommandContext, registry?: ToolRegistry, signal?: AbortSignal,
  assertExecution?: () => void, retainCurrent?: (guard: () => void, key?: string) => void): ModelReadingOptions {
  const holderGuards: Array<() => void> = [];
  const acquire = (keys: readonly string[]): unknown => {
    let current: unknown = context;
    for (const key of keys) {
      if (current === null || current === undefined) return undefined;
      if (typeof current !== 'object') throw new ToolInputProjectionError('held');
      const owner = current;
      const original = slot(owner, key);
      holderGuards.push(() => { if (!Object.is(slot(owner, key), original)) throw new ToolInputProjectionError('held'); });
      current = original;
    }
    return current;
  };
  for (const keys of [['session', 'runtime'], ['clients', 'providerApi'], ['provider', 'providerRegistry'],
    ['platform', 'config'], ['platform', 'configManager'], ['platform', 'artifactStore'], ['platform', 'readModels'], ...READ_MODEL_PATHS]) acquire(keys);
  const readSources = captureCatalogProducerSources(context, READ_MODEL_PATHS.map(keys => `context.${keys.join('.')}`), SNAPSHOT_METHODS);
  const sourceOwner = agentResearchSourceOwner(registry);
  const session = path(context, ['session', 'runtime']), sessionId = slot(session, 'sessionId');
  const api = path(context, ['clients', 'providerApi']), provider = path(context, ['provider', 'providerRegistry']);
  const config = path(context, ['platform', 'config']), manager = path(context, ['platform', 'configManager']);
  const artifact = path(context, ['platform', 'artifactStore']);
  const readModels = path(context, ['platform', 'readModels']);
  const identities = [api, provider, manager, artifact].map(object => ({ object,
    methods: ['getFavorites', 'getCurrentModel', 'listModels', 'listProviderIds', 'listProviders', 'get', 'list', 'readContent', 'getKnownContextWindowForModel', 'getContextWindowForModel', 'getAutonomousPermissionSnapshot']
      .map(key => ({ key, value: slot(object, key) })) }));
  const sources = READ_MODEL_PATHS.map(keys => ({ keys, source: path(context, keys),
    methods: SNAPSHOT_METHODS.map(key => ({ key, value: slot(path(context, keys), key) })) }));
  for (const identity of identities) if (identity.object !== null && typeof identity.object === 'object')
    {}
  const configRevisionMethod = slot(manager, 'getAutonomousPermissionSnapshot');
  const configIncarnation = (): unknown => {
    if (typeof configRevisionMethod !== 'function') return undefined;
    const value = slot(configRevisionMethod.call(manager), 'incarnation');
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ToolInputProjectionError('held');
    return value;
  };
  const configRevision = configIncarnation();
  const assertSourceCurrent = () => {
    if (signal) signal.throwIfAborted(); for (const guard of holderGuards) guard(); readSources.assertCurrent();
    if (agentResearchSourceOwner(registry) !== sourceOwner || path(context, ['session', 'runtime']) !== session || slot(session, 'sessionId') !== sessionId
      || path(context, ['clients', 'providerApi']) !== api || path(context, ['provider', 'providerRegistry']) !== provider || path(context, ['platform', 'config']) !== config
      || path(context, ['platform', 'configManager']) !== manager || path(context, ['platform', 'artifactStore']) !== artifact || path(context, ['platform', 'readModels']) !== readModels)
      throw new ToolInputProjectionError('held');
    for (const identity of identities) for (const method of identity.methods)
      if (slot(identity.object, method.key) !== method.value) throw new ToolInputProjectionError('held');
    if (configIncarnation() !== configRevision) throw new ToolInputProjectionError('held');
    for (const source of sources) {
      if (path(context, source.keys) !== source.source) throw new ToolInputProjectionError('held');
      for (const method of source.methods) if (slot(source.source, method.key) !== method.value) throw new ToolInputProjectionError('held');
    }
  };
  assertSourceCurrent();
  if (retainCurrent !== undefined && typeof retainCurrent !== 'function') throw new ToolInputProjectionError('held');
  assertReadingRestriction(retainCurrent ? () => retainCurrent(assertSourceCurrent, 'model-reading.native-source') : undefined);
  const options = { sourceOwner, signal, retainCurrent, assertCurrent() {
    if (signal) signal.throwIfAborted(); assertReadingRestriction(assertExecution); assertSourceCurrent();
  } };
  setModelReadingSources(options, { context, source: readSources });
  return options;
}

/** Registry services hold adapters, not JSON metadata. This explicit in-process
 * DTO boundary reads only routing/display facts; credential/client internals and
 * transport functions never enter a reading. Plain published DTOs are captured
 * completely, including undisplayed and hidden fields. */
export const MODEL_PROVIDER_READING_FACT_FIELDS = Object.freeze(['name', 'id', 'providerId', 'label', 'displayName', 'description', 'baseURL', 'baseUrl', 'endpoint', 'api',
    'hosting', 'documentation', 'setupDescription', 'anonymousDetail', 'capabilities', 'adapterKind', 'modelSource', 'serviceNames', 'envVars', 'metadata', 'available', 'isAvailable'] as const);

function providerReadingFacts(provider: unknown, initial = true): unknown {
  if (provider === null || typeof provider !== 'object') throw new ToolInputProjectionError('invalid');
  const prototype = Object.getPrototypeOf(provider);
  if (prototype === Object.prototype || prototype === null) return initial ? captureModelReadingInput(provider) : captureModelReadingData(provider);
  const facts: Record<string, unknown> = {};
  for (const key of MODEL_PROVIDER_READING_FACT_FIELDS) {
    const value = slot(provider, key);
    if (value !== undefined) facts[key] = value;
  }
  // Built-in providers can expose models through a getter. Do not invoke it:
  // the registry's captured model catalog supplies the actual model facts.
  const modelField = Object.getOwnPropertyDescriptor(provider, 'models');
  if (modelField) {
    if (!('value' in modelField)) throw new ToolInputProjectionError('invalid');
    facts.models = modelField.value;
  }
  const configured = slot(provider, 'isConfigured');
  if (typeof configured === 'function') {
    const result: unknown = configured.call(provider);
    if (typeof result !== 'boolean') throw new ToolInputProjectionError('held');
    facts.isConfigured = result;
  } else if (configured !== undefined) facts.isConfigured = configured;
  // Follow-up facts are consumed immediately by the complete snapshot guard.
  // Cloning the same provider metadata first adds no evidence.
  return initial ? captureModelReadingInput(facts) : facts;
}
function providerFactsList(value: unknown, expected?: { readonly identities: readonly unknown[]; readonly configuredMethods: readonly unknown[] }): { readonly identities: readonly unknown[]; readonly facts: readonly unknown[]; readonly configuredMethods: readonly unknown[] } {
  if (!Array.isArray(value) || value.length > 20_000) throw new ToolInputProjectionError('invalid');
  const length = value.length;
  if (expected && length !== expected.identities.length) throw new ToolInputProjectionError('held');
  const identities: unknown[] = [], facts: unknown[] = [], configuredMethods: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const provider: unknown = value[index];
    const method = slot(provider, 'isConfigured');
    if (expected && (provider !== expected.identities[index] || method !== expected.configuredMethods[index])) throw new ToolInputProjectionError('held');
    identities.push(provider); configuredMethods.push(method);
  }
  // All identities are checked before any trusted adapter method is invoked.
  for (const provider of identities) {
    facts.push(providerReadingFacts(provider, expected === undefined));
  }
  return { identities, facts, configuredMethods };
}

/** The newest saved benchmark artifacts the readers look at. */
const BENCHMARK_ARTIFACT_WINDOW = 100;
const BENCHMARK_ARTIFACT_PURPOSES = new Set(['agent-model-compare', 'agent-model-compare-judgment']);

/**
 * Benchmark comparisons and their judgments, newest first. The window applies after
 * the filter: a saved benchmark older than the newest hundred unrelated artifacts is
 * still found. Slots are read without invoking accessors, like every source read here.
 */
export function listBenchmarkArtifacts(store: ArtifactListLike | undefined): ReturnType<NonNullable<ArtifactListLike['list']>> {
  const all = store?.list?.(Number.MAX_SAFE_INTEGER) ?? [];
  return all.filter(artifact => {
    const purpose = slot(slot(artifact, 'metadata'), 'purpose');
    return typeof purpose === 'string' && BENCHMARK_ARTIFACT_PURPOSES.has(purpose.trim());
  }).slice(0, BENCHMARK_ARTIFACT_WINDOW);
}

/** All asynchronous readers consume a single screened snapshot of the sources.
 * The synchronous cookbook remains a separate facts-only startup snapshot. */
export async function withModelReadingContext<T>(context: CommandContext, invocation: unknown, options: ModelReadingOptions,
  consume: (context: CommandContext, options: ModelReadingOptions) => Promise<T>): Promise<T> {
  const signal = options.signal, callerCurrent = options.assertCurrent;
  const assertCurrent = () => { if (signal) signal.throwIfAborted(); assertReadingRestriction(callerCurrent); if (signal) signal.throwIfAborted(); };
  assertCurrent();
  const originalInvocation = captureModelReadingInput(invocation);
  const originalSources = getModelReadingSources(options);
  if (originalSources && originalSources.context !== context) throw new ToolInputProjectionError('held');
  const native = originalSources?.source ?? captureCatalogProducerSources(context, READ_MODEL_PATHS.map(keys => `context.${keys.join('.')}`), SNAPSHOT_METHODS);
  const retain = options.retainCurrent;
  if (retain !== undefined && typeof retain !== 'function') throw new ToolInputProjectionError('held');
  assertReadingRestriction(retain ? () => retain(native.assertCurrent, 'model-reading.complete-producer-source') : undefined);
  native.assertCurrent(); assertCurrent();
  const api = path(context, ['clients', 'providerApi']) as ProviderApiLike | undefined;
  const registry = path(context, ['provider', 'providerRegistry']);
  const store = path(context, ['platform', 'artifactStore']) as ArtifactListLike | undefined;
  const manager = path(context, ['platform', 'configManager']);
  const session = path(context, ['session', 'runtime']);
  const sourceContext = { provider: { providerRegistry: registry } } as unknown as CommandContext;
  const runtimeFacts = () => ({ sessionId: slot(session, 'sessionId'), model: slot(session, 'model'), provider: slot(session, 'provider'), reasoningEffort: slot(session, 'reasoningEffort') });
  for (const method of ['listModels', 'getFavorites', 'getCurrentModel', 'listProviderIds']) slot(api, method);
  const artifactList = slot(store, 'list'), artifactReadContent = slot(store, 'readContent');
  const readContent = store?.readContent;
  const tracked: { readonly raw: unknown; readonly assertCurrent: (value: unknown) => void }[] = [];
  const capture = <V>(raw: V): V => { const copy = captureModelReadingInput(raw); tracked.push({ raw, assertCurrent: captureModelReadingSnapshotGuard(copy) }); return copy; };
  const models = api ? capture(await api.listModels({ selectableOnly: true })) : [];
  assertCurrent();
  const favorites = api ? capture(await api.getFavorites()) : null;
  assertCurrent();
  const currentModel = api ? capture(await api.getCurrentModel()) : null;
  assertCurrent();
  const providerIds = capture(api?.listProviderIds() ?? []);
  const registryModelsMethod = slot(registry, 'listModels'), providersMethod = slot(registry, 'listProviders');
  const registryModels = capture(typeof registryModelsMethod === 'function' ? registryModelsMethod.call(registry) : []);
  const providerSnapshot = providerFactsList(typeof providersMethod === 'function' ? providersMethod.call(registry) : []);
  const providers = providerSnapshot.facts;
  const originalArtifacts = listBenchmarkArtifacts(store);
  const artifactSources = captureModelArtifactClockSources(originalArtifacts);
  const nativeArtifacts = artifactSources.native;
  tracked.push({ raw: originalArtifacts, assertCurrent: captureModelReadingSnapshotGuard(nativeArtifacts) });
  const artifacts = captureModelReadingInput(artifactSources.reading);
  const windowSubjects = [...models, ...(currentModel ? [currentModel] : [])];
  const contextWindows = windowSubjects.map(model => ({ registryKey: modelRegistryKey(model), value: contextWindowFor(sourceContext, model) }));
  const readModels = READ_MODEL_PATHS.map(keys => ({ keys, data: snapshotReadModel(native.source(`context.${keys.join('.')}`)) }));
  const configGet = slot(manager, 'get');
  const readConfig = (key: string): unknown => typeof configGet === 'function' ? configGet.call(manager, key) : undefined;
  const config = Object.fromEntries(CONFIG_KEYS.map(key => [key, capture(readConfig(key))]));
  const runtime = captureModelReadingInput(runtimeFacts());
  const assertRuntime = captureModelReadingSnapshotGuard(runtime);
  const assertRegistryModels = captureModelReadingSnapshotGuard(registryModels);
  const assertProviders = captureModelReadingSnapshotGuard(providers);
  const assertArtifacts = captureModelReadingSnapshotGuard(nativeArtifacts);
  const configGuards = CONFIG_KEYS.map(key => ({ key, assertCurrent: captureModelReadingSnapshotGuard(config[key]) }));
  const readModelGuards = readModels.map(entry => ({ ...entry, assertCurrent: captureModelReadingSnapshotGuard(entry.data) }));
  const source = { invocation: originalInvocation, models, favorites, currentModel, providerIds, registryModels, providers, artifacts, contextWindows, readModels, config, runtime, producerSource: native.evidence() };
  const stateGuard = () => {
    assertCurrent();
    if (path(context, ['platform', 'artifactStore']) !== store
      || slot(store, 'list') !== artifactList || slot(store, 'readContent') !== artifactReadContent) throw new ToolInputProjectionError('held');
    for (const [index, model] of windowSubjects.entries()) if (contextWindowFor(sourceContext, model) !== contextWindows[index]?.value) throw new ToolInputProjectionError('held');
    for (const entry of tracked) entry.assertCurrent(entry.raw);
    assertRuntime(runtimeFacts());
    if (typeof registryModelsMethod === 'function') assertRegistryModels(registryModelsMethod.call(registry));
    if (typeof providersMethod === 'function') {
      // Compare trusted method identities before invoking any replacement.
      for (const [index, provider] of providerSnapshot.identities.entries())
        if (slot(provider, 'isConfigured') !== providerSnapshot.configuredMethods[index]) throw new ToolInputProjectionError('held');
      const current = providerFactsList(providersMethod.call(registry), providerSnapshot);
      if (current.identities.length !== providerSnapshot.identities.length || current.identities.some((provider, index) => provider !== providerSnapshot.identities[index])) throw new ToolInputProjectionError('held');
      assertProviders(current.facts);
    }
    if (store?.list) assertArtifacts(listBenchmarkArtifacts(store));
    for (const entry of configGuards) entry.assertCurrent(readConfig(entry.key));
    for (const entry of readModelGuards) entry.assertCurrent(snapshotReadModel(path(context, entry.keys), false));
  };
  return withModelReadingSource(source, { ...options, assertCurrent: stateGuard }, async (captured, scoped) => {
    const projected: Record<string, unknown> = { session: { runtime: captured.runtime },
      provider: { providerRegistry: { listModels: () => captured.registryModels, listProviders: () => captured.providers,
        getKnownContextWindowForModel: (model: unknown) => captured.contextWindows.find(entry => entry.registryKey === modelRegistryKey(model))?.value ?? null,
        getContextWindowForModel: (model: unknown) => captured.contextWindows.find(entry => entry.registryKey === modelRegistryKey(model))?.value ?? null } },
      platform: { readModels: {}, artifactStore: store ? { list: () => nativeArtifacts, ...(readContent ? { readContent: async (id: string) => {
          if (scoped.signal) scoped.signal.throwIfAborted(); assertProjectionCurrent(scoped.assertCurrent);
          if (!captured.artifacts.some(artifact => artifact.id === id)) throw new ToolInputProjectionError('held');
          const content = await readContent.call(store, id);
          if (scoped.signal) scoped.signal.throwIfAborted(); assertProjectionCurrent(scoped.assertCurrent); return content;
        } } : {}) } : undefined,
        configManager: { get: (key: string) => captured.config[key] } }, clients: { operator: {} } };
    for (const entry of captured.readModels) setPath(projected, entry.keys, entry.data);
    // Preserve the provider API's actual structural location for requireProviderApi.
    const providerApi = api ? { listModels: async () => captured.models, getFavorites: async () => captured.favorites,
      getCurrentModel: async () => captured.currentModel, listProviderIds: () => captured.providerIds } : undefined;
    (projected.clients as Record<string, unknown>).providerApi = providerApi;
    const result = await consume(projected as unknown as CommandContext, scoped);
    assertProjectionCurrent(scoped.assertCurrent); return result;
  });
}

export { captureReadModelData as captureModelReadModelData, providerReadingFacts as captureModelProviderReadingFacts };

/** Capture selected producer paths before collectors touch any wrapper or method.
 * The private views preserve the collector's call order. Complete native results
 * enter the same screening input as the collected records, including hidden data. */
export function captureCatalogProducerSources(context: unknown, paths: readonly string[], methodNames: readonly string[], allowFunctionSources = false) {
  const guards: Array<() => void> = [];
  const results: Array<{ readonly path: string; readonly data: unknown }> = [];
  const views = new Map<string, unknown>();
  const observers: Array<{ readonly owner: object }> = [];
  const evidence: Array<{ readonly path: string; readonly data: unknown }> = [];
  const ancestors = new Set<object>();
  type ProducerCopy = { readonly view: object; readonly data: unknown };
  const copies = new WeakMap<object, ProducerCopy>();
  const getCopy = (entry: object): ProducerCopy | undefined => copies.get(entry);
  const setCopy = (entry: object, copy: ProducerCopy): void => { copies.set(entry, copy); };
  let nodes = 0;
  const held = (): never => { throw new ToolInputProjectionError('held'); };
  const invalid = (): never => { throw new ToolInputProjectionError('invalid'); };
  const assertBindings = (): void => { for (const guard of guards) guard(); };
  const assertCurrent = (): void => { assertBindings(); };
  const readPath = (name: string): unknown => {
    let current: unknown = context;
    for (const key of name.replace(/^context\./, '').split('.')) {
      if (current === undefined || current === null) return undefined;
      if (typeof current !== 'object') return invalid();
      const owner = current;
      const original = slot(owner, key);
      guards.push(() => { if (!Object.is(slot(owner, key), original)) held(); });
      current = original;
    }
    return current;
  };
  // Every selected path is bound before the first producer callback is invoked.
  const roots = paths.map(name => ({ name, value: readPath(name) }));
  const capture = (value: unknown, sourcePath: string, depth: number): { readonly view: unknown; readonly data: unknown } => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (value === null || typeof value !== 'object') {
      if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
        || (typeof value === 'number' && !Number.isFinite(value))) return invalid();
      return { view: value, data: value };
    }
    if (ancestors.has(value)) return invalid();
    const prior = getCopy(value); if (prior) return prior;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype === Map.prototype) {
      const map = value as Map<unknown, unknown>;
      if (Reflect.ownKeys(value).length) return invalid();
      const original = [...map.entries()];
      const view = new Map<string, unknown>();
      const rows: Array<{ readonly key: string; readonly value: unknown }> = [];
      ancestors.add(value);
      try {
        for (const [key, child] of original) {
          if (typeof key !== 'string') return invalid();
          const captured = capture(child, `${sourcePath}.${key}`, depth + 1);
          view.set(key, captured.view); rows.push({ key, value: captured.data });
        }
      } finally { ancestors.delete(value); }
      const captured = { view, data: { nativeMap: rows } }; setCopy(value, captured);
      guards.push(() => {
        if (Object.getPrototypeOf(value) !== prototype || Reflect.ownKeys(value).length) held();
        const current = [...map.entries()];
        if (current.length !== original.length || current.some((entry, index) => {
          const old = original[index]; return !old || !Object.is(entry[0], old[0]) || !Object.is(entry[1], old[1]);
        })) held();
      });
      return captured;
    }
    const array = Array.isArray(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return invalid();
    const keys = Object.getOwnPropertyNames(value);
    if (Object.getOwnPropertySymbols(value).length > 0 || (array && Object.hasOwn(value, 'constructor'))) return invalid();
    const length = array ? (value as unknown[]).length : 0;
    if (length > 20_000) return invalid();
    const record = value as Record<string, unknown>;
    const originals = new Map<string, unknown>();
    const view: object = array ? new Array(length) : Object.create(null);
    const data: object = array ? new Array(length) : Object.create(null);
    const nativeMethods: string[] = [];
    ancestors.add(value);
    try {
      for (const key of keys) {
        if (array && key === 'length') continue;
        const child: unknown = record[key];
        originals.set(key, child);
        const enumerable = Object.prototype.propertyIsEnumerable.call(value, key);
        if (typeof child === 'function') {
          if (array || !methodNames.includes(key) && key !== 'subscribe') return invalid();
          nativeMethods.push(key);
          if (key === 'subscribe') continue;
          Object.defineProperty(view, key, { enumerable, value: () => {
            assertCurrent();
            const original: unknown = child.call(value);
            if (nodeTypes.isPromise(original)) {
              void (original as Promise<unknown>).then(undefined, () => {}); return held();
            }
            const captured = capture(original, `${sourcePath}.${key}()`, depth + 1);
            results.push({ path: `${sourcePath}.${key}()`, data: captured.data });
            // Complete native rows and fresh detached DTOs are checked separately.
            const baseline = captureReadModelData(original, false);
            const matches = captureModelReadingSnapshotGuard(baseline);
            guards.push(() => {
              matches(captureReadModelData(original, false));
              const current: unknown = child.call(value);
              if (nodeTypes.isPromise(current)) {
                void (current as Promise<unknown>).then(undefined, () => {}); held();
              }
              matches(captureReadModelData(current, false));
            });
            assertCurrent(); return captured.view;
          } });
          continue;
        }
        const captured = capture(child, `${sourcePath}.${key}`, depth + 1);
        Object.defineProperty(view, key, { value: captured.view, enumerable });
        Object.defineProperty(data, key, { value: captured.data, enumerable: true });
      }
    } finally { ancestors.delete(value); }
    if (array && (keys.length !== length + 1 || keys.some(key => key !== 'length'
      && (!Number.isSafeInteger(Number(key)) || String(Number(key)) !== key || Number(key) < 0 || Number(key) >= length)))) return invalid();
    if (typeof slot(value, 'getSnapshot') === 'function' && typeof slot(value, 'subscribe') === 'function') {
      observers.push({ owner: value });
    }
    const captured = { view, data: nativeMethods.length ? { data, nativeMethods } : data };
    setCopy(value, captured);
    // The producer's own slots: the same names, each holding the same value.
    guards.push(() => {
      const current = Object.getOwnPropertyNames(value);
      if (current.length !== keys.length || current.some((key, index) => key !== keys[index])) held();
      for (const [key, original] of originals) if (!Object.is(record[key], original)) held();
    });
    return captured;
  };
  for (const root of roots) {
    if (typeof root.value === 'function') {
      if (!allowFunctionSources) return invalid();
      const read = root.value as () => unknown, keys = Object.getOwnPropertyNames(read);
      if (Object.getOwnPropertySymbols(read).length > 0) return invalid();
      const fn = read as unknown as Record<string, unknown>;
      const metadata: Record<string, unknown> = Object.create(null);
      for (const key of keys) {
        if (key === 'prototype') {
          const prototype: unknown = fn[key];
          if (prototype === null || typeof prototype !== 'object' || Object.getPrototypeOf(prototype) !== Object.prototype) return invalid();
          const names = Object.getOwnPropertyNames(prototype);
          if (Object.getOwnPropertySymbols(prototype).length > 0) return invalid();
          guards.push(() => { const current = Object.getOwnPropertyNames(prototype); if (current.length !== names.length || current.some((name, index) => name !== names[index])) held(); });
          const fields = prototype as Record<string, unknown>;
          const data: Record<string, unknown> = Object.create(null);
          for (const name of names) {
            const field = fields[name];
            if (name === 'constructor' && field === read) continue;
            data[name] = capture(field, `${root.name}.prototype.${name}`, 1).data;
          }
          metadata.prototype = data;
        } else metadata[key] = capture(fn[key], `${root.name}.${key}`, 1).data;
      }
      guards.push(() => { const current = Object.getOwnPropertyNames(read); if (current.length !== keys.length || current.some((key, index) => key !== keys[index])) held(); });
      views.set(root.name, () => {
        assertCurrent(); const original: unknown = read();
        if (nodeTypes.isPromise(original)) { void (original as Promise<unknown>).then(undefined, () => {}); return held(); }
        const captured = capture(original, `${root.name}()`, 0);
        results.push({ path: `${root.name}()`, data: captured.data });
        const matches = captureModelReadingSnapshotGuard(captureReadModelData(original, false));
        guards.push(() => {
          matches(captureReadModelData(original, false));
          const current: unknown = read();
          if (nodeTypes.isPromise(current)) { void (current as Promise<unknown>).then(undefined, () => {}); held(); }
          matches(captureReadModelData(current, false));
        });
        assertCurrent(); return captured.view;
      });
      evidence.push({ path: root.name, data: { nativeSourceMethod: true, metadata } });
      continue;
    }
    const captured = capture(root.value, root.name, 0);
    views.set(root.name, captured.view); evidence.push({ path: root.name, data: captured.data });
  }
  captureModelReadingInput({ sources: evidence });
  for (const { owner } of observers) {
    assertCurrent(); guards.push(captureNativeReadModelObservation(owner)); assertCurrent();
  }
  assertCurrent();
  return {
    source(name: string): unknown { assertCurrent(); if (!views.has(name)) return invalid(); return views.get(name); },
    evidence(): unknown { assertCurrent(); return captureModelReadingInput({ sources: evidence, results }); },
    assertCurrent,
  };
}

const CATALOG_NATIVE_CONFIG_KEYS = {
  "media": [
    "tts.provider",
    "tts.voice",
    "tts.llmProvider",
    "tts.llmModel",
    "ui.voiceEnabled",
    "web.enabled",
    "web.publicBaseUrl",
    "voice.wake.enabled",
    "voice.wake.surfaces.agent",
    "voice.wake.models",
    "voice.wake.noiseSuppression",
    "voice.wake.vadThreshold",
    "voice.wake.retainAudio",
    "voice.wake.activationSound",
    "voice.wake.activationSoundPath",
    "voice.wake.threshold",
    "voice.wake.patienceFrames",
    "voice.wake.cooldownMs",
    "voice.wake.inputDevice",
    "voice.wake.captureCommand",
    "voice.wake.indicator",
    "voice.wake.preRollMs",
    "voice.wake.captureMaxSeconds",
    "voice.wake.silenceStopMs",
    "voice.wake.silenceFloorRms",
    "voice.wake.speechRetriggerMs",
    "voice.wake.autoSubmit",
    "voice.wake.customModelDir",
    "voice.wake.maxRestarts",
    "voice.wake.restartBackoffMs",
    "voice.wake.crashWindowSeconds",
    "voice.wake.browserBackend"
  ],
  "pairing": [
    "controlPlane.enabled",
    "controlPlane.hostMode",
    "controlPlane.host",
    "controlPlane.port",
    "web.enabled",
    "web.hostMode",
    "web.host",
    "web.port",
    "ui.voiceEnabled",
    "notifications.webhookUrls",
    "tts.provider",
    "tts.voice",
    "tts.llmProvider",
    "tts.llmModel",
    "surfaces.slack.enabled",
    "surfaces.slack.botToken",
    "surfaces.slack.signingSecret",
    "surfaces.slack.defaultChannel",
    "surfaces.discord.enabled",
    "surfaces.discord.botToken",
    "surfaces.discord.publicKey",
    "surfaces.discord.applicationId",
    "surfaces.discord.defaultChannelId",
    "surfaces.telegram.enabled",
    "surfaces.telegram.botToken",
    "surfaces.telegram.defaultChatId",
    "surfaces.ntfy.enabled",
    "surfaces.ntfy.baseUrl",
    "surfaces.ntfy.chatTopic",
    "surfaces.ntfy.agentTopic",
    "surfaces.ntfy.topic",
    "surfaces.googleChat.enabled",
    "surfaces.googleChat.webhookUrl",
    "surfaces.googleChat.verificationToken",
    "surfaces.googleChat.spaceId",
    "surfaces.signal.enabled",
    "surfaces.signal.bridgeUrl",
    "surfaces.signal.account",
    "surfaces.signal.defaultRecipient",
    "surfaces.whatsapp.enabled",
    "surfaces.whatsapp.accessToken",
    "surfaces.whatsapp.verifyToken",
    "surfaces.whatsapp.phoneNumberId",
    "surfaces.whatsapp.defaultRecipient",
    "surfaces.telephony.enabled",
    "surfaces.telephony.bridgeUrl",
    "surfaces.telephony.accountSid",
    "surfaces.telephony.authToken",
    "surfaces.telephony.fromNumber",
    "surfaces.telephony.defaultRecipient",
    "surfaces.imessage.enabled",
    "surfaces.imessage.bridgeUrl",
    "surfaces.imessage.account",
    "surfaces.imessage.defaultChatId",
    "surfaces.bluebubbles.enabled",
    "surfaces.bluebubbles.serverUrl",
    "surfaces.bluebubbles.password",
    "surfaces.bluebubbles.defaultChatGuid",
    "surfaces.msteams.enabled",
    "surfaces.msteams.appId",
    "surfaces.msteams.appPassword",
    "surfaces.msteams.defaultConversationId",
    "surfaces.msteams.defaultChannelId",
    "surfaces.mattermost.enabled",
    "surfaces.mattermost.baseUrl",
    "surfaces.mattermost.botToken",
    "surfaces.mattermost.defaultChannelId",
    "surfaces.matrix.enabled",
    "surfaces.matrix.homeserverUrl",
    "surfaces.matrix.accessToken",
    "surfaces.matrix.defaultRoomId",
    "surfaces.webhook.enabled",
    "surfaces.webhook.defaultTarget"
  ],
  "cockpit": [
    "web.enabled",
    "web.hostMode",
    "web.host",
    "web.port",
    "web.publicBaseUrl"
  ]
} as const;


/** Bind private native facts before the leaf's first awaited acquisition. Raw
 * credential/file values remain local; complete provider metadata is screened. */
export function captureCatalogNativeFacts(context: unknown, family: 'media' | 'pairing' | 'cockpit') {
  const bindings: Array<() => void> = [], observations: Array<() => void> = [];
  function held(): never { throw new ToolInputProjectionError('held'); }
  const acquire = (keys: readonly string[]): unknown => {
    let value: unknown = context;
    for (const key of keys) {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'object') return held();
      const owner = value;
      const original = slot(owner, key);
      bindings.push(() => { if (!Object.is(slot(owner, key), original)) held(); });
      value = original;
    }
    return value;
  };
  const manager = acquire(['platform', 'configManager']), config = acquire(['platform', 'config']);
  acquire(['session', 'runtime']);
  const registries = family === 'cockpit' ? [] : ['voiceProviderRegistry', 'mediaProviderRegistry']
    .map(key => ({ key, registry: acquire(['platform', key]) }));
  const paths = family === 'pairing' ? acquire(['workspace', 'shellPaths']) : undefined;
  const wakeService = family === 'media' ? acquire(['platform', 'voiceSetup']) : undefined;
  if (family === 'media') for (const keys of [['platform', 'voiceService'], ['submitSpokenInput'], ['stopSpokenOutput']]) acquire(keys);
  if (wakeService !== null && wakeService !== undefined) {
    if (typeof wakeService !== 'object') held();
  }
  if (manager !== null && manager !== undefined) {
    if (typeof manager !== 'object') held();
  }
  for (const { registry } of registries) if (registry !== null && registry !== undefined) {
    if (typeof registry !== 'object') held();
  }
  if (paths !== undefined && paths !== null) {
    if (typeof paths !== 'object') held();
  }
  const env = process.env;
  bindings.push(() => { if (process.env !== env) held(); });
  const assertBindings = (): void => { for (const binding of bindings) binding(); };
  assertBindings();
  // File identity, ancestry and complete original bytes are private custody,
  // not semantic evidence or permission to publish the selected credential.
  if (paths !== null && typeof paths === 'object') {
    const home = slot(paths, 'homeDirectory'); if (typeof home !== 'string') held();
    const file = connectedHostOperatorTokenPath(home), physical = captureAgentExportPath(relative(home, file).startsWith('..') ? nearestExistingDirectory(dirname(file)) : home, file);
    bindings.push(() => { physical.assertCurrent(); });
    type FileObservation = { readonly kind: 'file'; readonly stat: string; readonly bytes: Buffer } | { readonly kind: 'absent'; readonly ancestor: string; readonly stat: string };
    const read = (): FileObservation => {
      assertBindings(); const before = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (!before) {
        let ancestor = dirname(file);
        while (true) {
          const parent = lstatSync(ancestor, { bigint: true, throwIfNoEntry: false });
          if (parent) {
            if (!parent.isDirectory() || parent.isSymbolicLink()) held();
            assertBindings();
            return { kind: 'absent', ancestor, stat: `${parent.dev}:${parent.ino}:${parent.size}:${parent.mtimeNs}:${parent.ctimeNs}` };
          }
          const next = dirname(ancestor); if (next === ancestor) held(); ancestor = next;
        }
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) held();
      const fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const opened = fstatSync(fd, { bigint: true });
        if (opened.dev !== before.dev || opened.ino !== before.ino) held();
        const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true });
        const key = (stat: typeof opened) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        if (key(opened) !== key(after)) held();
        assertBindings(); return { kind: 'file', stat: key(after), bytes };
      } finally { closeSync(fd); }
    };
    const original = read();
    const assertFile = (): void => {
      const current = read();
      if (original.kind !== current.kind || original.stat !== current.stat) held();
      if (original.kind === 'file' && current.kind === 'file' && !current.bytes.equals(original.bytes)) held();
      if (original.kind === 'absent' && current.kind === 'absent' && original.ancestor !== current.ancestor) held();
    };
    observations.push(assertFile);
    const credentialObservation = new OwnedSelectionObservation();
    const sourceOwner = manager !== null && typeof manager === 'object' ? manager : undefined;
    assertBindings(); assertFile(); const selected = readConnectedHostOperatorToken(home, undefined, credentialObservation, sourceOwner); assertFile(); assertBindings();
    const selection = captureCatalogSnapshot(selected);
    observations.push(() => {
      assertBindings(); assertFile(); const current = readConnectedHostOperatorToken(home, undefined, credentialObservation, sourceOwner); assertFile(); assertBindings(); selection.assertCurrent(current);
    });
  }
  if (manager !== null && typeof manager === 'object') {
    const get = slot(manager, 'get'), revision = slot(manager, 'getConfigurationIncarnation');
    if (typeof get !== 'function' || typeof revision !== 'function') held();
    assertBindings(); const before: unknown = revision.call(manager); assertBindings();
    if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) held();
    observations.push(() => { assertBindings(); if (revision.call(manager) !== before) held(); assertBindings(); });
    let selectedScalars: ConfigScalarSelection[] = [], selectedChecks: Array<() => void> = [];
    const flushScalars = (): void => {
      if (selectedChecks.length === 0) return;
      const originals = selectedChecks;
      const group = captureConfigSelectedScalars(manager, selectedScalars);
      selectedScalars = []; selectedChecks = [];
      observations.push(() => {
        if (group) {
          try {
            if (group(() => { assertBindings(); })) return;
          } catch (error) { if (error instanceof JudgmentAuthorityRetiredError) held(); throw error; }
        }
        for (const check of originals) check();
      });
    };
    for (const key of CATALOG_NATIVE_CONFIG_KEYS[family]) {
      assertBindings(); const original: unknown = get.call(manager, key); assertBindings();
      const capture = captureCatalogSnapshot(original);
      const check = () => { assertBindings(); capture.assertCurrent(original); const current: unknown = get.call(manager, key); assertBindings(); capture.assertCurrent(current); };
      if (original === null || original === undefined || typeof original === 'string' || typeof original === 'number' || typeof original === 'boolean') {
        selectedScalars.push({ key, value: original });
        selectedChecks.push(check);
      } else {
        flushScalars(); observations.push(check);
      }
    }
    flushScalars();
  }
  const providerDescriptors: Array<{ readonly domain: string; readonly data: unknown }> = [];
  const providerFacts: Array<{ readonly domain: string; readonly id: string; readonly data: unknown; readonly methods: readonly string[] }> = [];
  for (const { key, registry } of registries) {
    if (registry === null || registry === undefined) continue;
    if (typeof registry !== 'object') held();
    const list = slot(registry, 'list'), get = slot(registry, 'get'), revision = slot(registry, 'getIncarnation');
    if (typeof list !== 'function' || typeof get !== 'function' || typeof revision !== 'function') held();
    assertBindings();
    const nativeGuard = key === 'voiceProviderRegistry'
      ? registry instanceof VoiceProviderRegistry ? captureVoiceProviderReadSource(registry) : held()
      : registry instanceof MediaProviderRegistry ? captureMediaProviderReadSource(registry) : held();
    assertBindings();
    observations.push(() => { assertBindings(); nativeGuard(); assertBindings(); });
    assertBindings(); const incarnation: unknown = revision.call(registry); assertBindings();
    if (typeof incarnation !== 'number' || !Number.isSafeInteger(incarnation) || incarnation < 0) held();
    assertBindings(); const original: unknown = list.call(registry); assertBindings();
    const capture = captureCatalogSnapshot(original); providerDescriptors.push({ domain: key, data: capture.captured });
    if (!Array.isArray(capture.captured)) held();
    for (const descriptor of capture.captured) {
      const id = slot(descriptor, 'id'); if (typeof id !== 'string') held();
      assertBindings(); const provider: unknown = get.call(registry, id); assertBindings();
      if (provider === null || typeof provider !== 'object') held();
      if (Object.getOwnPropertySymbols(provider).length > 0) held();
      const keys = Object.getOwnPropertyNames(provider);
      const fields = provider as Record<string, unknown>;
      const facts: Record<string, unknown> = Object.create(null), methods: string[] = [];
      for (const name of keys) {
        const field = fields[name];
        if (typeof field === 'function') methods.push(name); else facts[name] = field;
      }
      const data = captureCatalogSnapshot(facts);
      providerFacts.push({ domain: key, id, data: data.captured, methods });
      observations.push(() => {
        assertBindings(); if (get.call(registry, id) !== provider) held(); assertBindings();
        const currentKeys = Object.getOwnPropertyNames(provider);
        if (currentKeys.length !== keys.length || currentKeys.some((key, index) => key !== keys[index])) held();
        const current: Record<string, unknown> = Object.create(null);
        for (const name of currentKeys) {
          const field = fields[name];
          if (typeof field !== 'function') current[name] = field;
        }
        data.assertCurrent(current);
      });
    }
    observations.push(() => {
      assertBindings(); capture.assertCurrent(original);
      if (revision.call(registry) !== incarnation) held(); assertBindings();
      const current: unknown = list.call(registry); assertBindings(); capture.assertCurrent(current);
    });
  }
  const assertCurrent = (): void => { assertBindings(); for (const observation of observations) observation(); assertBindings(); void config; };
  assertCurrent();
  return { assertCurrent, providerEvidence: captureModelReadingInput({ providerDescriptors, providerFacts }) };
}

/** General catalogs bind original invocation source slots before direct reads.
 * Only the pure native restriction is retained by the parent publication guard. */
export function catalogReadingOptions(context: CommandContext, registry: ToolRegistry | undefined, signal: AbortSignal | undefined,
  assertExecution: () => void, retainCurrent: (guard: () => void, key?: string) => void) {
  const paths = [['session', 'runtime'], ['session', 'runtime', 'sessionId'], ['clients', 'mcpApi'], ['extensions', 'mcpRegistry']];
  const guards: Array<() => void> = [];
  for (const keys of paths) {
    let current: unknown = context;
    for (const key of keys) {
      if (current === undefined || current === null) break;
      if (typeof current !== 'object') throw new ToolInputProjectionError('held');
      const owner = current;
      const original = slot(owner, key);
      guards.push(() => { if (!Object.is(slot(owner, key), original)) throw new ToolInputProjectionError('held'); });
      current = original;
    }
  }
  const sourceOwner = agentResearchSourceOwner(registry);
  const assertSourceCurrent = (): void => {
    if (signal) signal.throwIfAborted(); for (const guard of guards) guard();
    if (agentResearchSourceOwner(registry) !== sourceOwner) throw new ToolInputProjectionError('held');
  };
  if (typeof retainCurrent !== 'function') throw new ToolInputProjectionError('held');
  assertSourceCurrent(); assertReadingRestriction(() => retainCurrent(assertSourceCurrent, 'agent.catalog.native-invocation-source')); assertSourceCurrent();
  return { signal, sourceOwner, retainCurrent, assertCurrent() { if (signal) signal.throwIfAborted(); assertReadingRestriction(assertExecution); assertSourceCurrent(); } };
}

// A daemon home override outside the home may not exist yet; the capture root must, so an absent token stays an observation.
function nearestExistingDirectory(start: string): string {
  let candidate = start;
  while (!lstatSync(candidate, { throwIfNoEntry: false })) {
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return candidate;
}
