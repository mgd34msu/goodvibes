import { ConfigManager, getConfiguredEmbeddingProviderId } from '../config/index.js';
import { createBuiltinMemoryEmbeddingProviders } from './memory-embedding-http.js';
import { MEMORY_VECTOR_DIMS } from './embedding-dims.js';

export const DEFAULT_MEMORY_EMBEDDING_DIMS = MEMORY_VECTOR_DIMS;

export type MemoryEmbeddingProviderState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';
export type MemoryEmbeddingUsage = 'record' | 'query' | 'doctor';

export interface MemoryEmbeddingRequest {
  /** Cancellation and fresh admission for owned embedding dispatch. */
  readonly signal?: AbortSignal | undefined;
  readonly beforeAttempt?: (() => void | Promise<void>) | undefined;
  readonly text: string;
  readonly dimensions: number;
  readonly usage: MemoryEmbeddingUsage;
  readonly recordId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MemoryEmbeddingResult {
  readonly vector: Float32Array | readonly number[];
  readonly dimensions: number;
  readonly modelId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MemoryEmbeddingProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly state: MemoryEmbeddingProviderState;
  readonly dimensions: number;
  readonly configured: boolean;
  readonly deterministic?: boolean | undefined;
  readonly detail?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface MemoryEmbeddingProvider {
  /** Trusted provider implementation guarantees signal handling and awaits beforeAttempt immediately before every transport attempt, including retries. Required only for captured source indexing. */
  readonly capturedInputAdmission?: 'per-attempt' | undefined;
  readonly id: string;
  readonly label: string;
  readonly dimensions: number;
  readonly deterministic?: boolean | undefined;
  readonly local?: boolean | undefined;
  embedSync?(request: MemoryEmbeddingRequest): MemoryEmbeddingResult;
  embed?(request: MemoryEmbeddingRequest): Promise<MemoryEmbeddingResult>;
  status?(): MemoryEmbeddingProviderStatus | Promise<MemoryEmbeddingProviderStatus>;
}

export interface MemoryEmbeddingDoctorReport {
  readonly activeProviderId: string;
  readonly providers: readonly MemoryEmbeddingProviderStatus[];
  readonly asyncProviders: readonly string[];
  readonly syncProviders: readonly string[];
  readonly warnings: readonly string[];
}

export interface MemoryEmbeddingProviderRegistryOptions {
  readonly configManager: ConfigManager;
}

export function embedMemoryText(text: string, dims = DEFAULT_MEMORY_EMBEDDING_DIMS): Float32Array {
  const vector = new Float32Array(dims);
  const normalized = text.toLowerCase();
  const tokens = normalized
    .split(/[^a-z0-9_./-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);

  for (const token of tokens) {
    addHashedFeature(vector, `tok:${token}`, 1.2);
    if (token.includes('/') || token.includes('.') || token.includes('-') || token.includes('_')) {
      for (const part of token.split(/[./_-]+/).filter((entry) => entry.length >= 2)) {
        addHashedFeature(vector, `part:${part}`, 0.8);
      }
    }
  }

  for (let i = 0; i < tokens.length - 1; i++) {
    addHashedFeature(vector, `bigram:${tokens[i]!} ${tokens[i + 1]}`, 0.9);
  }

  const compact = normalized.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < compact.length - 2; i++) {
    const tri = compact.slice(i, i + 3);
    if (/\s{2,}/.test(tri)) continue;
    addHashedFeature(vector, `tri:${tri}`, 0.18);
  }

  normalizeVector(vector);
  return vector;
}

export function normalizeMemoryEmbeddingVector(vector: Float32Array | readonly number[], dimensions: number): Float32Array {
  if (vector instanceof Float32Array && vector.length === dimensions) return vector;
  const normalized = new Float32Array(dimensions);
  const limit = Math.min(vector.length, dimensions);
  for (let i = 0; i < limit; i++) {
    const value = Number(vector[i]);
    normalized[i] = Number.isFinite(value) ? value : 0;
  }
  normalizeVector(normalized);
  return normalized;
}

export class MemoryEmbeddingProviderRegistry {
  private readonly providers = new Map<string, MemoryEmbeddingProvider>();
  private activeProviderId = HASHED_MEMORY_EMBEDDING_PROVIDER.id;
  private readonly configManager: ConfigManager;

  constructor(options: MemoryEmbeddingProviderRegistryOptions) {
    this.configManager = options.configManager;
    this.register(HASHED_MEMORY_EMBEDDING_PROVIDER, { replace: true });
    for (const provider of createBuiltinMemoryEmbeddingProviders()) {
      this.register(provider, { replace: true });
    }
    this.getDefaultProviderId();
  }

  register(provider: MemoryEmbeddingProvider, options: { readonly replace?: boolean; readonly makeDefault?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Memory embedding provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Memory embedding provider already registered: ${id}`);
    }
    const registered = { ...provider, id };
    this.providers.set(id, registered);
    if (options.makeDefault) {
      persistDefaultEmbeddingProviderId(this.configManager, id);
      this.activeProviderId = id;
    }
    return () => {
      if (this.providers.get(id) === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    if (id === HASHED_MEMORY_EMBEDDING_PROVIDER.id) return false;
    return this.providers.delete(id);
  }

  setDefaultProvider(id: string): void {
    if (!this.providers.has(id)) throw Object.assign(new Error(`Unknown memory embedding provider: ${id}`), { status: 400 });
    this.activeProviderId = id;
    persistDefaultEmbeddingProviderId(this.configManager, id);
  }

  /**
   * The provider id in effect. `provider.embeddingProvider` is an ordinary
   * setting a person can change while this registry is live, so it is read on
   * every use rather than copied once at construction; an empty setting means
   * the built-in provider. An id that is not registered stays that id (the
   * doctor and every embed call say so) rather than silently embedding with a
   * different provider.
   */
  getDefaultProviderId(): string {
    const configured = getConfiguredEmbeddingProviderId(this.configManager).trim();
    this.activeProviderId = configured || HASHED_MEMORY_EMBEDDING_PROVIDER.id;
    return this.activeProviderId;
  }

  getDefaultProviderOrNull(): MemoryEmbeddingProvider | null {
    return this.providers.get(this.getDefaultProviderId()) ?? null;
  }

  getDefaultProvider(): MemoryEmbeddingProvider {
    const provider = this.getDefaultProviderOrNull();
    if (!provider) {
      throw new Error(`Active memory embedding provider '${this.activeProviderId}' is not registered.`);
    }
    return provider;
  }

  get(id: string): MemoryEmbeddingProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): MemoryEmbeddingProvider[] {
    return [...this.providers.values()].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  embedSync(request: MemoryEmbeddingRequest): MemoryEmbeddingResult {
    const provider = this.getDefaultProvider();
    if (provider.embedSync) return provider.embedSync(request);
    throw new Error(`Active memory embedding provider '${provider.id}' does not support synchronous embeddings.`);
  }

  async embedAsync(request: MemoryEmbeddingRequest): Promise<MemoryEmbeddingResult> {
    const provider = this.getDefaultProvider();
    if (provider.embed) {
      return await provider.embed(request);
    }
    if (provider.embedSync) {
      return provider.embedSync(request);
    }
    throw new Error(`Active memory embedding provider '${provider.id}' does not provide embeddings.`);
  }

  async status(): Promise<MemoryEmbeddingProviderStatus[]> {
    const statuses: MemoryEmbeddingProviderStatus[] = [];
    for (const provider of this.providers.values()) {
      if (provider.status) {
        statuses.push(await provider.status());
        continue;
      }
      statuses.push({
        id: provider.id,
        label: provider.label,
        state: 'healthy',
        dimensions: provider.dimensions,
        configured: true,
        deterministic: provider.deterministic,
        metadata: {
          local: provider.local === true,
          hasSyncEmbed: typeof provider.embedSync === 'function',
          hasAsyncEmbed: typeof provider.embed === 'function',
        },
      });
    }
    const activeId = this.getDefaultProviderId();
    if (activeId !== HASHED_MEMORY_EMBEDDING_PROVIDER.id && !this.providers.has(activeId)) {
      statuses.push({
        id: activeId,
        label: `Persisted default (${activeId})`,
        state: 'unconfigured',
        dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
        configured: false,
        detail: `Persisted embedding provider '${activeId}' is not registered; embedding operations will fail until it is registered or the default provider is changed.`,
        metadata: {
          local: true,
          hasSyncEmbed: false,
          hasAsyncEmbed: false,
          persistedDefault: true,
        },
      });
    }
    return statuses.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  async doctor(): Promise<MemoryEmbeddingDoctorReport> {
    const providers = await this.status();
    const syncProviders = this.list().filter((provider) => typeof provider.embedSync === 'function').map((provider) => provider.id);
    const asyncProviders = this.list().filter((provider) => typeof provider.embed === 'function').map((provider) => provider.id);
    const active = this.getDefaultProviderOrNull();
    const activeStatus = active ? providers.find((provider) => provider.id === active.id) : undefined;
    const warnings: string[] = [];
    const activeId = this.getDefaultProviderId();
    if (!this.providers.has(activeId)) {
      warnings.push(`Persisted embedding provider '${activeId}' is not currently registered; embedding operations will fail until it is registered or the default provider is changed.`);
    }
    if (active && activeStatus && !activeStatus.configured) {
      warnings.push(`Active embedding provider '${active.id}' is not fully configured: ${activeStatus.detail ?? 'configuration is incomplete'}`);
    }
    if (active && !active.embedSync) {
      if (active.embed) {
        warnings.push(`Active embedding provider '${active.id}' is async-only; sqlite-vec live writes will skip vector updates until an async rebuild completes.`);
      } else {
        warnings.push(`Active embedding provider '${active.id}' has no sync embed path; sqlite-vec live writes cannot update vectors.`);
      }
    }
    if (active && activeStatus?.metadata.supportsDimensionsParam === false) {
      warnings.push(`Active embedding provider '${active.id}' ignores the requested vector size; a longer vector is cut to its first ${DEFAULT_MEMORY_EMBEDDING_DIMS} values, which only suits models trained for truncation, and a shorter one is refused.`);
    }
    const activeDimensions = active?.dimensions;
    if (active && activeDimensions !== DEFAULT_MEMORY_EMBEDDING_DIMS) {
      warnings.push(`Active embedding provider '${active.id}' advertises ${active.dimensions} dimensions; vectors are normalized to ${DEFAULT_MEMORY_EMBEDDING_DIMS} dimensions for sqlite-vec storage.`);
    }
    return {
      activeProviderId: activeId,
      providers,
      asyncProviders,
      syncProviders,
      warnings,
    };
  }
}

function persistDefaultEmbeddingProviderId(configManager: ConfigManager, providerId: string): void {
  configManager.set('provider.embeddingProvider', providerId, { bypassManagedLock: true });
}

export const HASHED_MEMORY_EMBEDDING_PROVIDER: MemoryEmbeddingProvider = {
  id: 'hashed-local',
  label: 'Hashed Local Embeddings',
  dimensions: DEFAULT_MEMORY_EMBEDDING_DIMS,
  deterministic: true,
  local: true,
  embedSync(request) {
    return {
      vector: embedMemoryText(request.text, request.dimensions),
      dimensions: request.dimensions,
      modelId: 'goodvibes-hashed-local',
      metadata: {
        usage: request.usage,
        deterministic: true,
      },
    };
  },
};

function normalizeVector(vector: Float32Array): void {
  let sum = 0;
  for (const value of vector) {
    sum += value * value;
  }
  const norm = Math.sqrt(sum);
  if (norm === 0) return;
  for (let i = 0; i < vector.length; i++) {
    vector[i] = vector[i]! / norm;
  }
}

function addHashedFeature(vector: Float32Array, feature: string, weight: number): void {
  const hash = fnv1a(feature);
  const index = hash % vector.length;
  const sign = (hash & 0x80000000) === 0 ? 1 : -1;
  vector[index]! += sign * weight;
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
