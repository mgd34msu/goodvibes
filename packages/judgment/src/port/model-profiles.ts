/** Wire adapters describe a protocol, independently of where a model runs. */
export type JudgmentAdapterKind = 'system-one' | 'cloudflare-workers-ai' | 'laya';

export interface DecisionModelProfile {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly adapter: JudgmentAdapterKind;
  readonly responseModels?: readonly string[];
  readonly documentation: string;
}

/** Starting configurations, not a closed model allowlist or an accuracy claim. */
export const DECISION_MODEL_PROFILES: readonly DecisionModelProfile[] = Object.freeze([
  { id: 'jev', name: 'Jev', model: 'jev-latest', adapter: 'system-one', documentation: 'https://docs.typesafe.ai/api' },
  { id: 'clef', name: 'Clef', model: 'clef', adapter: 'cloudflare-workers-ai', documentation: 'https://developers.cloudflare.com/workers-ai/models/clef/' },
  { id: 'clef-flash', name: 'Clef-flash', model: 'clef-flash', adapter: 'cloudflare-workers-ai', documentation: 'https://developers.cloudflare.com/workers-ai/models/clef-flash/' },
  { id: 'diffusiongemma-jev', name: 'DiffusionGemma Jev', model: 'dgemma', adapter: 'system-one', documentation: 'https://github.com/mmastrac/djev' },
  { id: 'kev-9b', name: 'Kev-9B', model: 'kev-latest', adapter: 'system-one', documentation: 'https://github.com/jaredpalmer/kev' },
  { id: 'laya', name: 'Laya', model: 'english', adapter: 'laya', responseModels: Object.freeze(['laya-rl-agent']), documentation: 'https://github.com/NandhaKishorM/laya' },
].map(profile => Object.freeze(profile as DecisionModelProfile)));
