import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type {
  MediaArtifact,
  MediaCollectOptions,
  MediaGenerationRequest,
  MediaGenerationResult,
  MediaProvider,
  MediaProviderRegistry,
  MediaProviderTask,
} from '@goodvibes-jev/engine/platform/platform/media';
import { mediaOutputKindOf } from '@goodvibes-jev/engine/platform/platform/media';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { assertDeliveryCurrent, type DeliveryLifetime } from '@goodvibes-jev/engine/platform/platform/utils';

export interface AgentMediaGenerationInput {
  readonly prompt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly outputMimeType?: string;
  readonly options?: Record<string, unknown>;
}

export interface AgentGeneratedMediaArtifact {
  readonly artifactId: string;
  readonly mimeType: string;
  readonly filename?: string;
  readonly sizeBytes: number;
  readonly sourceUri?: string;
}

export interface AgentMediaGenerationResult {
  readonly providerId: string;
  readonly artifacts: readonly AgentGeneratedMediaArtifact[];
  readonly metadata: Record<string, unknown>;
  /** The job was accepted and is still running: collect it with this task. */
  readonly pending?: MediaProviderTask;
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

async function findGenerationProvider(registry: MediaProviderRegistry, input: AgentMediaGenerationInput): Promise<MediaProvider> {
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
  if (artifact.mimeType.includes('video')) return `agent-generated-${index + 1}.mp4`;
  if (artifact.mimeType.includes('image')) return `agent-generated-${index + 1}.png`;
  return `agent-generated-${index + 1}`;
}

function artifactCreateInput(
  providerId: string,
  artifact: MediaArtifact,
  index: number,
): ArtifactCreateInput {
  const filename = filenameForArtifact(artifact, index);
  const metadata = {
    ...artifact.metadata,
    product: 'goodvibes-agent',
    source: 'agent-media-generation',
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
function storedArtifact(artifact: MediaArtifact): AgentGeneratedMediaArtifact | undefined {
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

function toGeneratedArtifact(descriptor: ArtifactDescriptor): AgentGeneratedMediaArtifact {
  return {
    artifactId: descriptor.id,
    mimeType: descriptor.mimeType,
    ...(descriptor.filename ? { filename: descriptor.filename } : {}),
    sizeBytes: descriptor.sizeBytes,
    ...(descriptor.sourceUri ? { sourceUri: descriptor.sourceUri } : {}),
  };
}

function buildProviderRequest(input: AgentMediaGenerationInput): MediaGenerationRequest {
  return {
    prompt: ensurePrompt(input.prompt),
    ...(readText(input.outputMimeType) ? { outputMimeType: readText(input.outputMimeType) } : {}),
    ...(readText(input.modelId) ? { modelId: readText(input.modelId) } : {}),
    ...(input.options ? { options: input.options } : {}),
    metadata: {
      product: 'goodvibes-agent',
      source: 'agent-media-generation',
    },
  };
}

export async function generateAgentMedia(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
  input: AgentMediaGenerationInput,
  lifetime: DeliveryLifetime = {},
): Promise<AgentMediaGenerationResult> {
  assertDeliveryCurrent(lifetime);
  const provider = await findGenerationProvider(registry, input);
  const generate = provider.generate;
  if (!generate) throw new Error(`Media generation provider is unavailable or not configured for generation: ${provider.id}.`);
  return runAndStore(registry, provider, artifactStore, lifetime, (ownership) => generate.call(provider, buildProviderRequest(input), ownership));
}

/** Finishes a job an earlier generation answered as pending, and stores its outputs. */
export async function collectAgentMedia(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'create'>,
  task: MediaProviderTask,
  options: MediaCollectOptions = {},
  lifetime: DeliveryLifetime = {},
): Promise<AgentMediaGenerationResult> {
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
  return runAndStore(registry, provider, artifactStore, lifetime, (ownership) => collect.call(provider, task, options, ownership));
}

async function runAndStore(
  registry: MediaProviderRegistry,
  provider: MediaProvider,
  artifactStore: Pick<ArtifactStore, 'create'>,
  lifetime: DeliveryLifetime,
  run: (ownership: DeliveryLifetime) => Promise<MediaGenerationResult>,
): Promise<AgentMediaGenerationResult> {
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
  const artifacts: AgentGeneratedMediaArtifact[] = [];
  try {
    for (const [index, artifact] of generated.artifacts.entries()) {
      assertCurrent();
      const stored = storedArtifact(artifact);
      if (stored) { artifacts.push(stored); continue; }
      const descriptor = await artifactStore.create(artifactCreateInput(generated.providerId, artifact, index), ownership);
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

export function formatAgentMediaGenerationResult(result: AgentMediaGenerationResult): string {
  if (result.pending) {
    return [
      'Agent media still generating',
      `  provider ${result.pending.providerId}`,
      `  task ${result.pending.taskId}`,
      '  the provider accepted (and charged for) the job; it had not finished when the wait ended',
      `  collect with ${JSON.stringify(result.pending)}`,
    ].join('\n');
  }
  return [
    'Agent media generated',
    `  provider ${result.providerId}`,
    `  artifacts ${result.artifacts.length}`,
    ...result.artifacts.map((artifact, index) => [
      `  ${index + 1}. ${artifact.artifactId}`,
      `     type ${artifact.mimeType}`,
      `     size ${artifact.sizeBytes} bytes`,
      ...(artifact.filename ? [`     filename ${artifact.filename}`] : []),
      ...(artifact.sourceUri ? [`     source ${artifact.sourceUri}`] : []),
    ].join('\n')),
  ].join('\n');
}
