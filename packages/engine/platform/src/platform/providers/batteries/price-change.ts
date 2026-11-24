/**
 * `providers.keep-paid-model`: whether to keep sending to a model that stopped
 * being free since the person chose it (providers/model-price-changes.ts),
 * decided in the person's place when their mode lets the decision model
 * decide (Jev decides, Just vibes). Under Ask me the person is asked; under
 * YOLO it is kept, as every action is. Read from facts the catalog and the
 * settings hold: the new price, whether the person set any spending limit,
 * and the free models they already have.
 *
 * High bands: a wrong yes spends money on every following message; a wrong
 * no stops a turn that would have been cheap.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes/judgment';

export interface PriceChangeFacts {
  readonly model: string;
  readonly provider: string;
  /** "paid" | "subscription" */
  readonly nowTier: string;
  /** "$0.5 in and $1.5 out per 1M tokens", or "not listed". */
  readonly price: string;
  /** Free models from providers the person has set up, by name. */
  readonly freeAlternatives: readonly string[];
}

/** The decision's state as plain JSON (a fresh array, so it is a JSON value). */
export const priceChangeState = (facts: PriceChangeFacts) => ({
  change: { model: facts.model, provider: facts.provider, nowTier: facts.nowTier, price: facts.price, freeAlternatives: [...facts.freeAlternatives] },
});

export const keepPaidModel = defineBattery({
  name: 'providers.keep-paid-model',
  version: 1,
  description: 'Whether to keep sending to a model that stopped being free, rather than send nothing until another model is chosen.',
  accuracyFloor: 0.9,
  items: {
    keep: yesNo(
      'The model in `change` was free when the person chose it and is now charged as `change.price`. Should GoodVibes keep sending this person\'s messages to it? Say yes only when the price is a small fraction of a dollar per million tokens or no free model is listed in `change.freeAlternatives`; say no when a free alternative exists and the price is more than that, so nothing is charged that the person did not choose.',
      STAKES_BANDS.high.yesNo,
    ),
  },
  fixtures: [
    { name: 'cheap with no free alternative', state: priceChangeState({ model: 'Small Coder', provider: 'openrouter', nowTier: 'paid', price: '$0.02 in and $0.05 out per 1M tokens', freeAlternatives: [] }), expect: { keep: 'yes' } },
    { name: 'costly with a free alternative', state: priceChangeState({ model: 'Big Reasoner', provider: 'openrouter', nowTier: 'paid', price: '$3 in and $15 out per 1M tokens', freeAlternatives: ['Llama Free', 'Qwen Free'] }), expect: { keep: 'no' } },
  ],
});
