import type { JudgmentAdapterKind } from './backends.ts';

/** Public deployment capabilities and model aliases; never credential values. */
export interface JudgmentBackendSettings {
  readonly adapter?: JudgmentAdapterKind;
  readonly maxInputBytes?: number;
  readonly maxQuestions?: number;
  readonly responseModels?: readonly string[];
}

/** Detached data-only configuration, usable by browser-safe config surfaces. */
export function captureJudgmentBackendSettings(value: unknown): JudgmentBackendSettings {
  if (value === undefined) return Object.freeze({});
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Invalid judgment backend settings');
  const fields = new Set(['adapter', 'maxInputBytes', 'maxQuestions', 'responseModels']);
  const captured: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !fields.has(key) || !descriptor?.enumerable || !('value' in descriptor)) throw new Error('Invalid judgment backend settings');
    captured[key] = descriptor.value;
  }
  const { adapter, maxInputBytes, maxQuestions, responseModels } = captured;
  if (adapter !== undefined && adapter !== 'system-one' && adapter !== 'cloudflare-workers-ai' && adapter !== 'laya'
    || [maxInputBytes, maxQuestions].some(number => number !== undefined && (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1))) {
    throw new Error('Invalid judgment backend capabilities');
  }
  let models: readonly string[] | undefined;
  if (responseModels !== undefined) {
    if (!Array.isArray(responseModels) || Object.getPrototypeOf(responseModels) !== Array.prototype) throw new Error('Invalid judgment model aliases');
    const length: unknown = Object.getOwnPropertyDescriptor(responseModels, 'length')?.value;
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > 64
      || Reflect.ownKeys(responseModels).length !== length + 1) throw new Error('Invalid judgment model aliases');
    const entries: string[] = [];
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(responseModels, index);
      const model: unknown = descriptor && 'value' in descriptor ? descriptor.value : undefined;
      if (!descriptor?.enumerable || typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,255}$/.test(model)) throw new Error('Invalid judgment model alias');
      entries.push(model);
    }
    models = Object.freeze(entries);
  }
  return Object.freeze({
    ...(adapter === undefined ? {} : { adapter }),
    ...(maxInputBytes === undefined ? {} : { maxInputBytes: maxInputBytes as number }),
    ...(maxQuestions === undefined ? {} : { maxQuestions: maxQuestions as number }),
    ...(models === undefined ? {} : { responseModels: models }),
  });
}
