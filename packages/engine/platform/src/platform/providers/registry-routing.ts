/** Provider routing tiers and failover alternatives. */
import { join } from 'node:path';
import { ModelTierStore } from '../routing/model-tiers.js';
import type { ModelDefinition } from './registry-types.js';
import type { CanonicalModel } from './synthetic.js';

export class RegistryRoutingReadings {
  readonly #root: () => string;
  #tiers: ModelTierStore | undefined;

  constructor(options: { readonly root: () => string }) {
    this.#root = options.root;
  }

  /** Model tier readings, persisted as model-tiers.json. */
  get tiers(): ModelTierStore {
    this.#tiers ??= new ModelTierStore({ path: join(this.#root(), 'model-tiers.json') });
    return this.#tiers;
  }
}

/**
 * An alternative when the current model's provider fails non-transiently:
 * the failover group the model belongs to (exact group membership), else a
 * selectable model of the same tier on another provider.
 */
export function findAlternativeModel(
  current: ModelDefinition | undefined,
  registry: readonly ModelDefinition[],
  groups: readonly CanonicalModel[],
): ModelDefinition | null {
  if (!current || current.provider === 'synthetic') return null;
  const group = groups.find((canonical) => canonical.backends.some((backend) => backend.registryKey === current.registryKey));
  const groupModel = group ? registry.find((model) => model.provider === 'synthetic' && model.id === group.id) : undefined;
  if (groupModel) return groupModel;
  // An unlabelled tier is not a tier: matching undefined against undefined would offer any unrelated model as an equivalent.
  if (current.tier === undefined) return null;
  return registry.find((model) => model.registryKey !== current.registryKey && model.provider !== current.provider && model.tier === current.tier && model.selectable) ?? null;
}
