import { captureRevisionReadSource } from '../security/read-source.js';
import type { DeliveryLifetime } from '../utils/delivery-lifetime.js';
import { RefusalError, refusal } from '@goodvibes/engine/errors';

export type MediaProviderCapability = 'metadata' | 'understand' | 'transform' | 'generate' | 'attachment-store';
export type MediaProviderState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';
/** The kind of media a generation provider makes. */
export type MediaOutputKind = 'image' | 'video' | 'audio';

/** The kind a MIME type names, or undefined for one that names no media kind. */
export function mediaOutputKindOf(mimeType: string | undefined): MediaOutputKind | undefined {
  const major = mimeType?.trim().toLowerCase().split('/')[0];
  return major === 'image' || major === 'video' || major === 'audio' ? major : undefined;
}

export interface MediaArtifact {
  readonly id?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly mimeType: string;
  readonly dataBase64?: string | undefined;
  readonly uri?: string | undefined;
  readonly filename?: string | undefined;
  readonly sizeBytes?: number | undefined;
  readonly sha256?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface MediaProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly state: MediaProviderState;
  readonly capabilities: readonly MediaProviderCapability[];
  readonly configured: boolean;
  readonly detail?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface MediaAnalysisRequest {
  readonly artifact: MediaArtifact;
  readonly prompt?: string | undefined;
  readonly modelId?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  /** Cancels the model request when the caller stops waiting. */
  readonly signal?: AbortSignal | undefined;
}

export interface MediaAnalysisResult {
  readonly providerId: string;
  readonly description?: string | undefined;
  readonly labels?: readonly string[] | undefined;
  readonly text?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface MediaTransformRequest {
  readonly artifact: MediaArtifact;
  readonly operation: string;
  readonly outputMimeType?: string | undefined;
  readonly options?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface MediaTransformResult {
  readonly providerId: string;
  readonly artifact: MediaArtifact;
  readonly metadata: Record<string, unknown>;
}

export interface MediaGenerationRequest {
  readonly prompt: string;
  readonly outputMimeType?: string | undefined;
  readonly modelId?: string | undefined;
  readonly options?: Record<string, unknown> | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * A job a provider accepted. `resume` holds what the provider needs to find it
 * again (its endpoint, queue addresses, the output kind); it never holds a key.
 */
export interface MediaProviderTask {
  readonly providerId: string;
  readonly taskId: string;
  readonly resume?: Readonly<Record<string, string>> | undefined;
}

export interface MediaGenerationResult {
  readonly providerId: string;
  /** Empty while `pending` is set. */
  readonly artifacts: readonly MediaArtifact[];
  readonly metadata: Record<string, unknown>;
  /**
   * Set when the job was accepted and paid for but had not finished when the
   * wait ended: `collect` with this task returns the outputs once it has.
   */
  readonly pending?: MediaProviderTask | undefined;
}

export interface MediaCollectOptions {
  /** How long to wait for the job before answering `pending` again; 0 checks once. */
  readonly waitSeconds?: number | undefined;
}

export interface MediaProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly MediaProviderCapability[];
  /** For display; may contact a backend. Lookups use `isConfigured`. */
  status?(): Promise<MediaProviderStatus> | MediaProviderStatus;
  analyze?(request: MediaAnalysisRequest): Promise<MediaAnalysisResult>;
  transform?(request: MediaTransformRequest): Promise<MediaTransformResult>;
  generate?(request: MediaGenerationRequest, lifetime?: DeliveryLifetime): Promise<MediaGenerationResult>;
}

/** What the registry also reads from a provider when it offers it. Every member is optional, so any MediaProvider is one. */
export interface MediaGenerationProvider extends MediaProvider {
  /** What a generation provider makes; a request for another kind is refused before anything is sent. */
  readonly outputs?: readonly MediaOutputKind[] | undefined;
  /** Whether the provider can serve a request now, from what is already known: no I/O. */
  isConfigured?(): boolean;
  /** Reads credentials that are not yet known (the secret store), then answers like `isConfigured`. */
  resolveConfigured?(): Promise<boolean>;
  /** Finishes a job a `generate` answered as `pending`. */
  collect?(task: MediaProviderTask, options?: MediaCollectOptions, lifetime?: DeliveryLifetime): Promise<MediaGenerationResult>;
}

/** Narrows a lookup to providers that make one kind of output. */
export interface MediaProviderFilter {
  readonly output?: MediaOutputKind | undefined;
}

export interface MediaProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly MediaProviderCapability[];
  /** What a generation provider makes, when it says. */
  readonly outputs?: readonly MediaOutputKind[] | undefined;
}

// A provider without a synchronous answer keeps registration order; its status() is for display only.
function isConfiguredNow(provider: MediaGenerationProvider): boolean {
  if (!provider.isConfigured) return true;
  try {
    return provider.isConfigured();
  } catch {
    return false;
  }
}

function makesOutput(provider: MediaGenerationProvider, filter: MediaProviderFilter): boolean {
  return !filter.output || !provider.outputs || provider.outputs.includes(filter.output);
}

/** A check that the media provider list did not change while a status read ran. */
export function captureMediaProviderReadSource(registry: MediaProviderRegistry): () => void {
  return registry.captureReadSource();
}

export class MediaProviderRegistry {
  private readonly providers = new Map<string, MediaGenerationProvider>();
  private incarnation = 0;

  getIncarnation(): number { return this.incarnation; }

  /** One integer compare per check: the incarnation moves on every register and unregister. */
  captureReadSource(): () => void { return captureRevisionReadSource('media provider list', () => this.incarnation); }


  register(provider: MediaGenerationProvider, options: { readonly replace?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Media provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Media provider already registered: ${id}`);
    }
    const registered: MediaGenerationProvider =
      id === provider.id
        ? provider
        : Object.assign(Object.create(Object.getPrototypeOf(provider)), provider, { id });
    this.providers.set(id, registered);
    this.incarnation++;
    return () => {
      if (this.providers.get(id) === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    const removed = this.providers.delete(id);
    if (removed) this.incarnation++;
    return removed;
  }

  get(id: string): MediaGenerationProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): MediaProviderDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
        ...(provider.outputs ? { outputs: [...provider.outputs] } : {}),
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  findProvider(capability: MediaProviderCapability, providerId?: string, filter: MediaProviderFilter = {}): MediaGenerationProvider | null {
    if (providerId) {
      const provider = this.get(providerId);
      return provider?.capabilities.includes(capability) && makesOutput(provider, filter) ? provider : null;
    }
    const candidates = [...this.providers.values()]
      .filter((provider) => provider.capabilities.includes(capability) && makesOutput(provider, filter));
    // A configured provider beats one that merely registered first. With an
    // output kind asked for, an unconfigured provider is not a fallback: it
    // would only fail after the caller waited for it.
    const configured = candidates.find((provider) => isConfiguredNow(provider));
    if (configured) return configured;
    return filter.output ? null : candidates[0] ?? null;
  }

  /**
   * findProvider after each candidate has read the credentials it does not yet
   * know (a key saved in the secret store), so the first request after start-up
   * finds a provider configured that way. A known credential costs nothing.
   */
  async resolveProvider(capability: MediaProviderCapability, providerId?: string, filter: MediaProviderFilter = {}): Promise<MediaGenerationProvider | null> {
    const candidates = providerId
      ? [this.get(providerId)].filter((provider): provider is MediaGenerationProvider => provider !== null)
      : [...this.providers.values()].filter((provider) => provider.capabilities.includes(capability) && makesOutput(provider, filter));
    await Promise.all(candidates.map(async (provider) => {
      if (provider.isConfigured?.() !== false) return;
      try { await provider.resolveConfigured?.(); } catch { /* reported by the provider's own status */ }
    }));
    return this.findProvider(capability, providerId, filter);
  }

  /** Finishes a generation job that an earlier request answered as pending. */
  collect(task: MediaProviderTask, options?: MediaCollectOptions, lifetime?: DeliveryLifetime): Promise<MediaGenerationResult> {
    const provider = this.get(task.providerId);
    if (!provider?.collect) {
      return Promise.reject(new RefusalError(refusal({
        code: 'MEDIA_TASK_PROVIDER_UNKNOWN',
        state: provider ? `${provider.label} cannot resume a job` : `no media provider is registered as ${task.providerId}`,
        reason: `Generation job ${task.taskId} cannot be collected through ${task.providerId}`,
        next: ['Use the providerId the pending result named'],
        status: 404,
      })));
    }
    return provider.collect(task, options, lifetime);
  }

  async status(): Promise<MediaProviderStatus[]> {
    const statuses: MediaProviderStatus[] = [];
    for (const provider of this.providers.values()) {
      if (provider.status) {
        statuses.push(await provider.status());
        continue;
      }
      statuses.push({
        id: provider.id,
        label: provider.label,
        state: 'healthy',
        capabilities: [...provider.capabilities],
        configured: true,
        metadata: {},
      });
    }
    return statuses.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
}
