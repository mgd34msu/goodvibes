/** User- or registration-supplied rates, USD per 1M tokens. */
export interface ManualModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number | undefined;
  readonly cacheWrite?: number | undefined;
}

const MANUAL_MODEL_PRICE_FIELDS: ReadonlySet<string> = new Set(['input', 'output', 'cacheRead', 'cacheWrite']);

export function validManualModelPrice(value: unknown): value is ManualModelPrice {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const rec = value as Record<string, unknown>;
  // Only the four rates: a field of any other name (a key pasted into the wrong
  // place) is refused rather than stored and later printed as a price.
  if (Object.keys(rec).some((key) => !MANUAL_MODEL_PRICE_FIELDS.has(key))) return false;
  const rate = (key: string, required: boolean): boolean => {
    const v = rec[key];
    if (v === undefined) return !required;
    return typeof v === 'number' && Number.isFinite(v) && v >= 0;
  };
  return rate('input', true) && rate('output', true) && rate('cacheRead', false) && rate('cacheWrite', false);
}

/** Validate the whole `pricing.modelPrices` config value (record keyed `provider:model`). */
export function validateManualModelPrices(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, price]) => key.includes(':') && validManualModelPrice(price),
  );
}
