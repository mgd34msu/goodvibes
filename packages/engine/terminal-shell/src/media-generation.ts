/**
 * Media generation shared by both terminal programs: find a provider that
 * makes the output asked for, run the job (or collect one a provider was still
 * making), and keep what it made in the artifact store, each artifact stamped
 * with the running program and the path that asked (`MediaOrigin`).
 */
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type {
  MediaArtifact,
  MediaCollectOptions,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaProvider,
  MediaProviderRegistry,
  MediaProviderTask,
} from '@goodvibes/engine/platform/platform/media';
import { mediaOutputKindOf } from '@goodvibes/engine/platform/platform/media';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import { assertDeliveryCurrent, type DeliveryLifetime } from '@goodvibes/engine/platform/platform/utils';

/** Who asked for the media: the running program and the path inside it, kept with every artifact. */
export interface MediaOrigin {
  /** The running program: `goodvibes` (the terminal app) or `goodvibes-agent`. */
  readonly product: string;
  /** The path that asked: `agent-media-generation` (the model's tool), `media-command` (`/media`). */
  readonly source: string;
}

export interface MediaGenerationInput {
  readonly prompt: string;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly outputMimeType?: string | undefined;
  readonly options?: Record<string, unknown> | undefined;
}

export interface GeneratedMediaArtifact {
  readonly artifactId: string;
  readonly mimeType: string;
  readonly filename?: string | undefined;
  readonly sizeBytes: number;
  readonly sourceUri?: string | undefined;
}

export interface MediaGenerationRun {
  readonly providerId: string;
  readonly artifacts: readonly GeneratedMediaArtifact[];
  readonly metadata: Record<string, unknown>;
  /** The job was accepted and is still running: collect it with this task. */
  readonly pending?: MediaProviderTask | undefined;
}

function readText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function ensurePrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error('Media generation prompt is required.');
  return trimmed;
}

async function findGenerationProvider(registry: MediaProviderRegistry, input: MediaGenerationInput): Promise<MediaProvider> {
  const providerId = readText(input.providerId);
  const output = mediaOutputKindOf(readText(input.outputMimeType));
  const provider = await registry.resolveProvider('generate', providerId, { output });
  // Without a named provider, one that says it has no key is not a choice: the refusal below lists those that could serve.
  if (provider?.generate && (providerId || provider.isConfigured?.() !== false)) return provider;
  const generators = registry.list().filter((entry) => entry.capabilities.includes('generate')).map((entry) => registry.get(entry.id)!);
  const makers = generators.filter((entry) => !output || !entry.outputs || entry.outputs.includes(output));
  const named = providerId ? registry.get(providerId) : null;
  const makerIds = makers.map((entry) => entry.id).join(', ');
  // The tool reports the message alone, so the reason carries the state and the way forward.
  if (named && output && named.outputs && !named.outputs.includes(output)) {
    throw new RefusalError(refusal({
      code: 'MEDIA_OUTPUT_UNSUPPORTED',
      state: `${named.label} makes ${named.outputs.join(' and ')}`,
      reason: `${named.label} makes ${named.outputs.join(' and ')}, not ${output}; nothing was sent. ${makerIds ? `Providers that make ${output}: ${makerIds}.` : `No registered provider makes ${output}.`}`,
      next: [makerIds ? `Pass providerId as one of: ${makerIds}` : `Ask for ${named.outputs.join(' or ')}`],
      status: 400,
    }));
  }
  const state = providerId
    ? `${providerId} is not a registered, configured generation provider`
    : `no configured provider makes ${output ?? 'media'}`;
  throw new RefusalError(refusal({
    code: 'PROVIDER_NOT_CONFIGURED',
    state,
    reason: `Nothing was generated: ${state}. ${makerIds ? `Providers that could once configured: ${makerIds}.` : 'No registered provider makes this kind of output.'}`,
    next: [makerIds ? `Configure one of: ${makerIds}` : 'Register a media generation provider'],
    status: 409,
  }));
}

function filenameForArtifact(artifact: MediaArtifact, index: number): string {
  if (readText(artifact.filename)) return artifact.filename as string;
  if (artifact.mimeType.includes('video')) return `generated-${index + 1}.mp4`;
  if (artifact.mimeType.includes('image')) return `generated-${index + 1}.png`;
  return `generated-${index + 1}`;
}

function artifactCreateInput(
  providerId: string,
  artifact: MediaArtifact,
  index: number,
  origin: MediaOrigin,
): ArtifactCreateInput {
  const filename = filenameForArtifact(artifact, index);
  const metadata = {
    ...artifact.metadata,
    product: origin.product,
    source: origin.source,
    providerId,
  };
  const common = {
    mimeType: artifact.mimeType,
    filename,
    metadata,
  };
  if (readText(artifact.dataBase64)) {
    return {
      ...common,
      dataBase64: artifact.dataBase64,
      sourceUri: artifact.uri,
      acquisitionMode: 'inline-data',
    };
  }
  if (readText(artifact.uri)) {
    return {
      ...common,
      uri: artifact.uri,
      sourceUri: artifact.uri,
      acquisitionMode: 'remote-fetch',
      fetchMode: 'public-only',
    };
  }
  throw new Error(`Generated media artifact ${index + 1} did not include inline data or a fetchable URI.`);
}

/** An output the provider already streamed into the artifact store. */
function storedArtifact(artifact: MediaArtifact): GeneratedMediaArtifact | undefined {
  const artifactId = readText(artifact.artifactId);
  if (!artifactId || typeof artifact.sizeBytes !== 'number') return undefined;
  return {
    artifactId,
    mimeType: artifact.mimeType,
    ...(readText(artifact.filename) ? { filename: artifact.filename as string } : {}),
    sizeBytes: artifact.sizeBytes,
    ...(readText(artifact.uri) ? { sourceUri: artifact.uri as string } : {}),
  };
}

function toGeneratedArtifact(descriptor: ArtifactDescriptor): GeneratedMediaArtifact {
  return {
    artifactId: descriptor.id,
    mimeType: descriptor.mimeType,
    ...(descriptor.filename ? { filename: descriptor.filename } : {}),
    sizeBytes: descriptor.sizeBytes,
    ...(descriptor.sourceUri ? { sourceUri: descriptor.sourceUri } : {}),
  };
}

function buildProviderRequest(input: MediaGenerationInput, origin: MediaOrigin): MediaGenerationRequest {
  return {
    prompt: ensurePrompt(input.prompt),
    ...(readText(input.outputMimeType) ? { outputMimeType: readText(input.outputMimeType) } : {}),
    ...(readText(input.modelId) ? { modelId: readText(input.modelId) } : {}),
    ...(input.options ? { options: input.options } : {}),
    metadata: {
      product: origin.product,
      source: origin.source,
    },
  };
}

export async function generateMedia(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
  input: MediaGenerationInput,
  origin: MediaOrigin,
  lifetime: DeliveryLifetime = {},
): Promise<MediaGenerationRun> {
  assertDeliveryCurrent(lifetime);
  const provider = await findGenerationProvider(registry, input);
  const generate = provider.generate;
  if (!generate) throw new Error(`Media generation provider is unavailable or not configured for generation: ${provider.id}.`);
  return runAndStore(registry, provider, artifactStore, origin, lifetime, (ownership) => generate.call(provider, buildProviderRequest(input, origin), ownership));
}

/** Finishes a job an earlier generation answered as pending, and stores its outputs. */
export async function collectMedia(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
  task: MediaProviderTask,
  origin: MediaOrigin,
  options: MediaCollectOptions = {},
  lifetime: DeliveryLifetime = {},
): Promise<MediaGenerationRun> {
  assertDeliveryCurrent(lifetime);
  const provider = registry.get(task.providerId);
  const collect = provider?.collect;
  if (!provider || !collect) {
    throw new RefusalError(refusal({
      code: 'MEDIA_TASK_PROVIDER_UNKNOWN',
      state: provider ? `${provider.label} cannot resume a job` : `no media provider is registered as ${task.providerId}`,
      reason: `Generation job ${task.taskId} cannot be collected through ${task.providerId}`,
      next: ['Use the providerId the pending result named'],
      status: 404,
    }));
  }
  return runAndStore(registry, provider, artifactStore, origin, lifetime, (ownership) => collect.call(provider, task, options, ownership));
}

async function runAndStore(
  registry: MediaProviderRegistry,
  provider: MediaProvider,
  artifactStore: Pick<ArtifactStore, 'create'>,
  origin: MediaOrigin,
  lifetime: DeliveryLifetime,
  run: (ownership: DeliveryLifetime) => Promise<MediaGenerationResult>,
): Promise<MediaGenerationRun> {
  const incarnation = registry.getIncarnation();
  const assertCurrent = () => {
    assertDeliveryCurrent(lifetime);
    if (registry.getIncarnation() !== incarnation || registry.get(provider.id) !== provider) throw new ToolInputProjectionError('stale');
  };
  assertCurrent();
  const ownership = { signal: lifetime.signal, assertCurrent };
  const generated = await run(ownership);
  assertCurrent();
  if (generated.providerId !== provider.id) throw new Error('The generation response belongs to a different provider.');
  if (generated.pending) {
    return { providerId: generated.providerId, artifacts: [], metadata: generated.metadata, pending: generated.pending };
  }
  const artifacts: GeneratedMediaArtifact[] = [];
  try {
    for (const [index, artifact] of generated.artifacts.entries()) {
      assertCurrent();
      const stored = storedArtifact(artifact);
      if (stored) { artifacts.push(stored); continue; }
      const descriptor = await artifactStore.create(artifactCreateInput(generated.providerId, artifact, index, origin), ownership);
      artifacts.push(toGeneratedArtifact(descriptor));
      assertCurrent();
    }
  } catch (error) {
    // A cancellation or a changed owner is not a failed write: callers branch on these.
    lifetime.signal?.throwIfAborted();
    if (error instanceof ToolInputProjectionError) throw error;
    // The reason a write was refused (non-public URI, mime, size, disk) tells a
    // permanent refusal from a transient one; without it the caller regenerates
    // and pays for a second provider call.
    const reason = (error instanceof Error ? error.message : String(error)).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300);
    throw new Error(`Media generation stopped after ${artifacts.length} confirmed artifact writes${reason ? ` (${reason})` : ''}. The provider request completed; any interrupted write may also have completed. Inspect stored artifacts before retrying.`, { cause: error });
  }
  if (artifacts.length === 0) throw new Error(`Media provider ${generated.providerId} did not return artifacts.`);
  return {
    providerId: generated.providerId,
    artifacts,
    metadata: generated.metadata,
  };
}
