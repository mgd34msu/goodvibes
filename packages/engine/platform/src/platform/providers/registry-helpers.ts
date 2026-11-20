import type { ModelDefinition } from './registry-types.js';

export function withRegistryKey(model: ModelDefinition): ModelDefinition {
  return model.registryKey ? model : { ...model, registryKey: `${model.provider}:${model.id}` };
}

export function splitModelRegistryKey(modelId: string): { providerId: string; resolvedModelId: string } {
  const separatorIndex = modelId.indexOf(':');
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
    throw new Error(`Model registry keys must be provider-qualified; received '${modelId}'.`);
  }

  return {
    providerId: modelId.slice(0, separatorIndex),
    resolvedModelId: modelId.slice(separatorIndex + 1),
  };
}

