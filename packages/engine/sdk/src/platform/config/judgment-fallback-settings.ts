import { captureJudgmentBackendSettings, validEndpointURL } from '@goodvibes-jev/judgment/decisions';
import type { JudgmentFallbackSettings } from './schema-types-judgment.js';

const FIELDS = ['endpoint', 'model', 'keySource', 'keyName'];
const fail = (): never => { throw new Error('Invalid judgment fallback settings'); };

function captureFallback(value: unknown): JudgmentFallbackSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length < FIELDS.length || keys.length > FIELDS.length + 1
    || keys.some(key => typeof key !== 'string' || ![...FIELDS, 'backend'].includes(key))
    || FIELDS.some(key => !keys.includes(key))) return fail();
  const captured: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor)) return fail();
    captured[key] = descriptor.value;
  }
  const { endpoint, model, keySource, keyName } = captured;
  if (typeof endpoint !== 'string' || !validEndpointURL(endpoint)
    || typeof model !== 'string' || !model.trim() || model.length > 200 || /\s/.test(model)
    || (keySource !== 'env' && keySource !== 'secret' && keySource !== 'none')
    || typeof keyName !== 'string') return fail();
  const validKeyName = keySource === 'none' ? keyName === ''
    : keySource === 'env' ? /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(keyName)
    : /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(keyName);
  if (!validKeyName) return fail();
  const backend = captureJudgmentBackendSettings(captured['backend']);
  return Object.freeze({ endpoint, model, keySource, keyName,
    ...(captured['backend'] === undefined ? {} : { backend }) });
}

/** Validate and detach persisted inputs without invoking getters or toJSON. */
export function captureJudgmentFallbackSettings(value: unknown): readonly JudgmentFallbackSettings[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const length: unknown = Object.getOwnPropertyDescriptor(value, 'length')?.value;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0
    || Reflect.ownKeys(value).length !== length + 1) return fail();
  const result: JudgmentFallbackSettings[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index);
    if (!descriptor?.enumerable || !('value' in descriptor)) return fail();
    result.push(captureFallback(descriptor.value));
  }
  return Object.freeze(result);
}

export function validJudgmentFallbackSettings(value: unknown): boolean {
  if (value === undefined) return false;
  try { captureJudgmentFallbackSettings(value); return true; }
  catch { return false; }
}

/** A name identifying separately stored material, never an inline credential. */
export function validJudgmentCredentialName(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_./:-]{0,255}$/.test(value);
}
