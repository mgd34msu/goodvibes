/**
 * Spawn-time model reference normalization for AgentManager. Extracted from
 * manager.ts to keep that file under its line-cap ceiling.
 *
 * When `modelCandidates` (the live registry's model list) is supplied, a
 * bare id resolves via the shared resolver (model-id-resolution.ts): unique
 * across the registry -> auto-qualify; ambiguous/unknown -> a rich error
 * naming real candidates. Storage stays provider-qualified either way.
 * When `modelCandidates` is omitted, the input must already be a
 * provider-qualified key; format validation checks it without registry resolution.
 */

import { splitModelRegistryKey } from '../../providers/registry-helpers.js';
import { ModelReferenceError, resolveModelReference, type ModelIdCandidate } from '../../providers/model-id-resolution.js';
import { sameProviderCatalog } from '../../providers/provider-aliases.js';

export function requireProviderQualifiedModel(
  modelId: string | undefined,
  label: string,
  modelCandidates?: readonly ModelIdCandidate[],
  contextProviderId?: string | undefined,
): string | undefined {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  if (!trimmed) return undefined;
  if (modelCandidates) {
    let resolved: string;
    try {
      resolved = resolveModelReference(trimmed, modelCandidates, { contextProviderId });
    } catch (err) {
      if (err instanceof ModelReferenceError) throw new ModelReferenceError(err.code, `${label}: ${err.message}`);
      throw new Error(`${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
    // A provider-qualified key passes the resolver unchanged; one no registered
    // model answers to (under its provider or a catalog alias of it) is refused
    // here, before any work starts, instead of failing at the first model call.
    if (modelCandidates.length > 0 && !isRegisteredModelKey(resolved, modelCandidates)) {
      throw new ModelReferenceError('MODEL_NOT_FOUND', `${label}: Unknown model '${trimmed}'; no registered provider serves it.`);
    }
    return resolved;
  }
  try {
    splitModelRegistryKey(trimmed);
  } catch {
    throw new Error(`${label} must be a provider-qualified registry key; received '${modelId}'.`);
  }
  return trimmed;
}

export function normalizeProviderQualifiedModelList(
  models: readonly string[] | undefined,
  label: string,
  modelCandidates?: readonly ModelIdCandidate[],
): string[] | undefined {
  const normalized = models
    ?.filter((model) => typeof model === 'string' && model.trim().length > 0)
    .map((model) => requireProviderQualifiedModel(model, label, modelCandidates)!);
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/** Whether a provider-qualified key names a registered model, under its provider or a catalog alias of it. */
function isRegisteredModelKey(registryKey: string, candidates: readonly ModelIdCandidate[]): boolean {
  if (candidates.some((candidate) => candidate.registryKey === registryKey)) return true;
  const separator = registryKey.indexOf(':');
  if (separator <= 0) return false;
  const providerId = registryKey.slice(0, separator);
  const modelId = registryKey.slice(separator + 1);
  return candidates.some((candidate) => candidate.id === modelId && sameProviderCatalog(candidate.provider, providerId));
}

/** A spawn request whose model routing contradicts itself: the caller's input error, refused before any work starts. */
export class AgentSpawnInputError extends Error {
  readonly code = 'INVALID_ARGUMENT';
  readonly status = 400;
  readonly recoverable = false;
  constructor(message: string) {
    super(message);
    this.name = 'AgentSpawnInputError';
  }
}
