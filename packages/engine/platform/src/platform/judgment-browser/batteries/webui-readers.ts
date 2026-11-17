import { snapshotJudgmentInput } from '../../gate/judgment-input.js';

class Hold extends Error {
  constructor(readonly reason: 'budget' | 'unsupported-input') { super('WebUI reading held.'); }
}
const unsupported = (): never => { throw new Hold('unsupported-input'); };
const budget = (): never => { throw new Hold('budget'); };

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return unsupported();
  if (Object.keys(value).some((key) => !keys.includes(key))) return unsupported();
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number, empty = false): string {
  if (typeof value !== 'string' || (!empty && !value.trim())) return unsupported();
  if (value.length > limit) return budget();
  return value;
}

/** Screen every complete name before narrowing; credential values are not in this input contract. */
export function snapshotWebuiCredentialNames(input: unknown): { readonly providerId: string; readonly keys: readonly string[] } {
  const source = object(snapshotJudgmentInput(input), ['providerId', 'keys']);
  const names = source['keys'];
  if (!Array.isArray(names) || names.length < 1 || names.length > 64) return unsupported();
  const keys = names.map(name => text(name, 256));
  if (new Set(keys).size !== keys.length) return unsupported();
  return { providerId: text(source['providerId'], 128), keys };
}
