import { ArtifactStore } from '../artifacts/index.js';
import type { ContentPart, LLMProvider, ProviderMessage } from '../providers/interface.js';
import type { ModelDefinition, ProviderRegistry } from '../providers/registry.js';
import { callWithFailover, type FailoverTarget } from '../providers/failover.js';
import type {
  MediaAnalysisRequest,
  MediaAnalysisResult,
  MediaProvider,
  MediaProviderStatus,
} from './provider-registry.js';
import { toRecord } from '../utils/record-coerce.js';
import { resolveModelReference } from '../providers/model-id-resolution.js';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';

interface StructuredImageAnalysis {
  description?: string | undefined;
  text?: string | undefined;
  labels?: string[] | undefined;
  [key: string]: unknown;
}

interface ImageUnderstandingScope {
  readonly providerId: string;
  readonly label: string;
  readonly allowProviderIds?: readonly string[] | undefined;
  readonly requireLocal?: boolean | undefined;
  /**
   * The unscoped default reads images with the session's current model only;
   * this names the model it may use instead (a setting the owner chose).
   */
  readonly visionFallbackModel?: (() => string | undefined) | undefined;
}

/** Scoped variants name a vendor or local runtime the caller chose; the default names none. */
function isUnscoped(scope: ImageUnderstandingScope): boolean {
  return (scope.allowProviderIds?.length ?? 0) === 0 && !scope.requireLocal;
}

type ImageModelRegistry = Pick<ProviderRegistry, 'getCurrentModel' | 'getForModel' | 'listModels' | 'describeRuntime'
  | 'tryGet' | 'resolveProviderReference' | 'fallbackOrder'>;

function buildAnalysisPrompt(prompt?: string): string {
  const task = prompt?.trim().length
    ? prompt.trim()
    : 'Describe the image, extract visible text, and identify the main labels or objects.';
  return [
    'Analyze the attached image.',
    `Task: ${task}`,
    'Return valid JSON only with this shape:',
    '{"description":"string","text":"string","labels":["string"],"observations":{}}',
    'Use an empty string or empty array when a field is not available.',
  ].join('\n');
}

function parseStructuredAnalysis(content: string): StructuredImageAnalysis | null {
  const candidates = [
    content.trim(),
    ...[...content.matchAll(/```json\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim() ?? ''),
    ...[...content.matchAll(/(\{[\s\S]*\})/g)].map((match) => match[1]?.trim() ?? ''),
  ].filter((candidate, index, values) => candidate.length > 0 && values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as StructuredImageAnalysis;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim());
}

async function modelMatchesScope(
  providerRegistry: ImageModelRegistry,
  model: Record<string, unknown>,
  scope: ImageUnderstandingScope,
): Promise<boolean> {
  const providerId = typeof model.provider === 'string' ? model.provider : '';
  if ((scope.allowProviderIds?.length ?? 0) > 0 && !scope.allowProviderIds?.includes(providerId)) {
    return false;
  }
  if (!scope.requireLocal) return true;
  try {
    const runtime = await providerRegistry.describeRuntime(providerId);
    return runtime?.policy?.local === true;
  } catch {
    return false;
  }
}

async function resolveModel(
  providerRegistry: ImageModelRegistry,
  scope: ImageUnderstandingScope,
  modelId?: string,
): Promise<{
  providerId: string;
  provider: LLMProvider;
  modelId: string;
  target: FailoverTarget;
}> {
  const models: readonly ModelDefinition[] = providerRegistry.listModels();
  const named = async (requested: string) => {
    // Accepts either a provider-qualified registryKey or a bare model id,
    // bare ids resolve via the shared resolver (unique -> auto-qualify;
    // ambiguous or unknown -> a rich error naming real candidates).
    const registryKey = resolveModelReference(requested, models);
    const explicit = models.find((model) => model.registryKey === registryKey);
    if (!explicit) {
      throw new Error(`Unknown model for media analysis: ${requested}`);
    }
    if (!explicit.capabilities.multimodal) {
      throw new Error(`Model does not support image input: ${explicit.displayName}`);
    }
    if (!await modelMatchesScope(providerRegistry, toRecord(explicit), scope)) {
      throw new Error(`Model does not match media provider scope ${scope.label}: ${explicit.displayName}`);
    }
    return explicit;
  };
  const resolveCandidate = async () => {
    if (modelId) return named(modelId);
    const current = providerRegistry.getCurrentModel();
    if (current.capabilities.multimodal && await modelMatchesScope(providerRegistry, toRecord(current), scope)) {
      return current;
    }
    if (isUnscoped(scope)) {
      // The image goes only where the owner pointed: the current model, or the fallback he set.
      const fallback = scope.visionFallbackModel?.()?.trim();
      if (fallback) return named(fallback);
      const choices = models.filter((model) => model.selectable && model.capabilities.multimodal).map((model) => model.registryKey);
      throw new RefusalError(refusal({
        code: 'MEDIA_MODEL_CANNOT_READ_IMAGES',
        state: `the current model (${current.displayName}) does not accept images`,
        reason: choices.length > 0
          ? `The current model cannot read images; choose one of: ${choices.join(', ')}. The image was not sent anywhere`
          : 'The current model cannot read images, and no registered model can; the image was not sent anywhere',
        next: choices.length > 0
          ? ['Pass modelId naming one of them, switch the session to one with /model, or name one in the provider.visionFallbackModel setting']
          : ['Add a provider whose models accept images, then switch to one with /model'],
        status: 409,
      }));
    }
    for (const candidate of models) {
      if (!candidate.selectable || !candidate.capabilities.multimodal) continue;
      if (await modelMatchesScope(providerRegistry, toRecord(candidate), scope)) {
        return candidate;
      }
    }
    throw new Error(`No multimodal model is available for image understanding in scope ${scope.label}`);
  };

  const selected = await resolveCandidate();
  const provider = providerRegistry.getForModel(selected.registryKey, selected.provider);
  return {
    providerId: selected.provider,
    provider,
    modelId: selected.id,
    target: {
      model: { registryKey: selected.registryKey, provider: selected.provider, displayName: selected.displayName },
      modelId: selected.id,
      provider,
    },
  };
}

async function resolveArtifactInput(
  artifactStore: Pick<ArtifactStore, 'readContent'>,
  request: MediaAnalysisRequest,
): Promise<{
  mimeType: string;
  dataBase64: string;
  metadata: Record<string, unknown>;
}> {
  if (request.artifact.dataBase64) {
    return {
      mimeType: request.artifact.mimeType,
      dataBase64: request.artifact.dataBase64,
      metadata: request.artifact.metadata,
    };
  }
  const artifactId = request.artifact.artifactId ?? request.artifact.id;
  if (artifactId) {
    const { record, buffer } = await artifactStore.readContent(artifactId);
    return {
      mimeType: record.mimeType,
      dataBase64: buffer.toString('base64'),
      metadata: record.metadata,
    };
  }
  throw new Error('Media analysis requires dataBase64 or artifactId');
}

async function analyzeWithScope(
  providerRegistry: ImageModelRegistry,
  scope: ImageUnderstandingScope,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
  request: MediaAnalysisRequest,
): Promise<MediaAnalysisResult> {
  const artifact = await resolveArtifactInput(artifactStore, request);
  if (!artifact.mimeType.toLowerCase().startsWith('image/')) {
    throw new Error(`Unsupported media type for image understanding: ${artifact.mimeType}`);
  }

  const selected = await resolveModel(providerRegistry, scope, request.modelId);
  const content: ContentPart[] = [
    { type: 'text', text: buildAnalysisPrompt(request.prompt) },
    { type: 'image', data: artifact.dataBase64, mediaType: artifact.mimeType },
  ];
  const messages: ProviderMessage[] = [
    {
      role: 'user',
      content,
    },
  ];
  // The model fails over like a turn (its other sign-ins, then
  // provider.fallbackModels), but only to a model that reads images and stays
  // in this scope: an image never goes to a model the scope does not allow.
  const { response, answered } = await callWithFailover({
    registry: providerRegistry,
    first: selected.target,
    purpose: 'Image understanding',
    signal: request.signal,
    admit: async (target) => {
      const listed = providerRegistry.listModels().find((model) => model.registryKey === target.model.registryKey);
      if (!listed?.capabilities.multimodal) return 'it does not read images';
      return await modelMatchesScope(providerRegistry, toRecord(listed), scope) ? undefined : `it is outside the ${scope.label} scope`;
    },
  }, async (target) => ({
    response: await target.provider.chat({ model: target.modelId, messages, signal: request.signal }),
    answered: { providerId: target.model.provider, modelId: target.modelId },
  }));

  const structured = parseStructuredAnalysis(response.content);
  if (structured) {
    const { description, text, labels, ...rest } = structured;
    return {
      providerId: scope.providerId,
      description: typeof description === 'string' ? description.trim() : undefined,
      text: typeof text === 'string' ? text.trim() : undefined,
      labels: normalizeLabels(labels),
      metadata: {
        ...request.metadata,
        ...artifact.metadata,
        llmProviderId: answered.providerId,
        modelId: answered.modelId,
        structured: rest,
      },
    };
  }

  return {
    providerId: scope.providerId,
    description: response.content.trim() || undefined,
    metadata: {
      ...request.metadata,
      ...artifact.metadata,
      llmProviderId: answered.providerId,
      modelId: answered.modelId,
      format: 'plain-text-response',
    },
  };
}

function createScopedImageUnderstandingProvider(
  providerRegistry: ImageModelRegistry,
  scope: ImageUnderstandingScope,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
): MediaProvider {
  return {
    id: scope.providerId,
    label: scope.label,
    capabilities: ['understand'],
    async status(): Promise<MediaProviderStatus> {
      let available = false;
      if (isUnscoped(scope)) {
        const current = providerRegistry.getCurrentModel();
        const fallback = scope.visionFallbackModel?.()?.trim();
        available = current.capabilities.multimodal || Boolean(fallback);
        return {
          id: scope.providerId,
          label: scope.label,
          state: available ? 'healthy' : 'unconfigured',
          capabilities: ['understand'],
          configured: available,
          detail: current.capabilities.multimodal
            ? `Reads images with the current model (${current.displayName}).`
            : fallback
              ? `The current model cannot read images; reads them with the configured fallback ${fallback}.`
              : `The current model (${current.displayName}) cannot read images; switch to one that can, or name a model per request.`,
          metadata: {},
        };
      }
      for (const model of providerRegistry.listModels()) {
        if (!model.selectable || !model.capabilities.multimodal) continue;
        if (await modelMatchesScope(providerRegistry, toRecord(model), scope)) {
          available = true;
          break;
        }
      }
      return {
        id: scope.providerId,
        label: scope.label,
        state: available ? 'healthy' : 'unconfigured',
        capabilities: ['understand'],
        configured: available,
        detail: available
          ? `Uses ${scope.label} model routing for image understanding.`
          : `Register a matching multimodal model to enable ${scope.label}.`,
        metadata: {},
      };
    },
    analyze: (request) => analyzeWithScope(providerRegistry, scope, artifactStore, request),
  };
}

export function createBuiltinImageUnderstandingProvider(
  providerRegistry: ImageModelRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
  options: { readonly visionFallbackModel?: (() => string | undefined) | undefined } = {},
): MediaProvider {
  return createScopedImageUnderstandingProvider(providerRegistry, {
    providerId: 'builtin:image-understanding',
    label: 'Built-in Image Understanding',
    visionFallbackModel: options.visionFallbackModel,
  }, artifactStore);
}

export function createOpenAIImageUnderstandingProvider(
  providerRegistry: ImageModelRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
): MediaProvider {
  return createScopedImageUnderstandingProvider(providerRegistry, {
    providerId: 'builtin:image-openai',
    label: 'OpenAI Image Understanding',
    allowProviderIds: ['openai'],
  }, artifactStore);
}

export function createGeminiImageUnderstandingProvider(
  providerRegistry: ImageModelRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
): MediaProvider {
  return createScopedImageUnderstandingProvider(providerRegistry, {
    providerId: 'builtin:image-gemini',
    label: 'Gemini Image Understanding',
    allowProviderIds: ['gemini'],
  }, artifactStore);
}

export function createAnthropicImageUnderstandingProvider(
  providerRegistry: ImageModelRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
): MediaProvider {
  return createScopedImageUnderstandingProvider(providerRegistry, {
    providerId: 'builtin:image-anthropic',
    label: 'Anthropic Image Understanding',
    allowProviderIds: ['anthropic'],
  }, artifactStore);
}

export function createLocalImageUnderstandingProvider(
  providerRegistry: ImageModelRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'>,
): MediaProvider {
  return createScopedImageUnderstandingProvider(providerRegistry, {
    providerId: 'builtin:image-local',
    label: 'Local OpenAI-Compatible Image Understanding',
    requireLocal: true,
  }, artifactStore);
}
