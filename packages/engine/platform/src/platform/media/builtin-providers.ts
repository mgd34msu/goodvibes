import { MediaProviderRegistry } from './provider-registry.js';
import {
  createAnthropicImageUnderstandingProvider,
  createBuiltinImageUnderstandingProvider,
  createGeminiImageUnderstandingProvider,
  createLocalImageUnderstandingProvider,
  createOpenAIImageUnderstandingProvider,
} from './builtin-image-understanding.js';
import { builtinGenerationProviders } from './builtin-generation-providers.js';
import type { ArtifactStore } from '../artifacts/index.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { SecretsManager } from '../config/secrets.js';

export interface BuiltinMediaProviderOptions {
  /** Media generation keys saved in the secret store are read through this when the environment has none. */
  readonly secrets?: Pick<SecretsManager, 'get' | 'revisionSource'> | undefined;
  /** The model the default image reader may use when the session's model cannot read images. */
  readonly visionFallbackModel?: (() => string | undefined) | undefined;
}

export function ensureBuiltinMediaProviders(
  registry: MediaProviderRegistry,
  artifactStore: Pick<ArtifactStore, 'readContent'> & Partial<Pick<ArtifactStore, 'createFromStream'>>,
  providerRegistry: Pick<ProviderRegistry, 'describeRuntime' | 'getCurrentModel' | 'getForModel' | 'listModels' | 'tryGet' | 'resolveProviderReference' | 'fallbackOrder'>,
  options: BuiltinMediaProviderOptions = {},
): void {
  // First, so an unscoped lookup lands on the default reader, which uses the session's own model and sends an image nowhere else.
  registry.register(createBuiltinImageUnderstandingProvider(providerRegistry, artifactStore, {
    visionFallbackModel: options.visionFallbackModel,
  }), { replace: true });
  registry.register(createOpenAIImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createGeminiImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createAnthropicImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  registry.register(createLocalImageUnderstandingProvider(providerRegistry, artifactStore), { replace: true });
  // Generated outputs are streamed into the same store the products read artifacts from.
  const generationStore = artifactStore.createFromStream ? { createFromStream: artifactStore.createFromStream.bind(artifactStore) } : undefined;
  for (const provider of builtinGenerationProviders({ secrets: options.secrets, artifactStore: generationStore })) {
    registry.register(provider, { replace: true });
  }
}
