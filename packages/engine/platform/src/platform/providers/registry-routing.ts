/** Provider routing tier readings. */
import { join } from 'node:path';
import { ModelTierStore } from '../routing/model-tiers.js';

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
