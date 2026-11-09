/** Native transport attribution, distinct from forgeable JSON lineage. No authority is conveyed. */
export interface JudgmentModelObservation {
  readonly requestedModel: string;
  readonly model: string;
  readonly targetModel: string;
  readonly endpointIndex: number;
}
const applyObservation = Reflect.apply, getObservation = WeakMap.prototype.get, setObservation = WeakMap.prototype.set, hasObservation = WeakMap.prototype.has;
const hasImmutable = WeakSet.prototype.has, addImmutable = WeakSet.prototype.add, freezeObservation = Object.freeze;
const observations = new WeakMap<object, JudgmentModelObservation>();
// A genuine recorder-owned immutable response is reusable without claiming
// that its borrowed/custom port came from a native model adapter.
const immutableRecordedResults = new WeakSet<object>();

/** Read-only: borrowed responses cannot acquire provenance by copying public fields. */
export function observeJudgmentModel(value: unknown): JudgmentModelObservation | undefined {
  return value !== null && typeof value === 'object' ? applyObservation(getObservation, observations, [value]) as JudgmentModelObservation | undefined : undefined;
}
function freezeData(value: unknown): void {
  const pending: unknown[] = [value], visited = new Set<object>(), freeze: object[] = [];
  while (pending.length) {
    const node = pending.pop();
    if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') throw new TypeError('Invalid native judgment data');
    if (!node || typeof node !== 'object' || visited.has(node)) continue;
    const prototype: unknown = Object.getPrototypeOf(node);
    if (Array.isArray(node) ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError('Invalid native judgment data');
    visited.add(node); freeze.push(node);
    for (const key of Reflect.ownKeys(node)) {
      const slot = Object.getOwnPropertyDescriptor(node, key);
      if (typeof key !== 'string' || !slot || !('value' in slot)) throw new TypeError('Invalid native judgment data');
      pending.push(slot.value);
    }
  }
  for (const node of freeze.reverse()) freezeObservation(node);
}
/** SDK-internal recorder admission only; not exported from package entrypoints.
 * This proves immutable data ownership, never native model attribution. */
export function recordImmutableJudgmentResult<T extends object>(result: T): T {
  if (!applyObservation(hasObservation, observations, [result])) { freezeData(result); applyObservation(addImmutable, immutableRecordedResults, [result]); }
  return result;
}
/** SDK-internal only. Called after actual native adapter envelope/model validation. */
export function recordNativeModelObservation<T extends object>(result: T, observation: JudgmentModelObservation): T {
  freezeData(result);
  applyObservation(setObservation, observations, [result, freezeObservation({ ...observation })]);
  return result;
}
/** SDK-internal log projection; never exported from a package entry point. */
export function retainNativeModelObservation<T extends object>(source: unknown, result: T): T {
  const observation = observeJudgmentModel(source);
  if (!observation) return result;
  const requested = Object.getOwnPropertyDescriptor(result, 'requestedModel');
  const model = Object.getOwnPropertyDescriptor(result, 'model');
  if (!requested || !model || !('value' in requested) || !('value' in model)
    || requested.value !== observation.requestedModel || model.value !== observation.model) return result;
  return recordNativeModelObservation(result, observation);
}
/**
 * Preserve an already immutable native or recorder-owned result through complete, unchanged data
 * admission. A projection/redaction remains the projection; no proof is copied.
 */
export function reuseObservedJudgmentResult<T>(original: T, admitted: T): T {
  if (!original || typeof original !== 'object' || (!applyObservation(hasObservation, observations, [original]) && !applyObservation(hasImmutable, immutableRecordedResults, [original]))) return admitted;
  const pending: [unknown, unknown][] = [[original, admitted]], visited = new WeakMap<object, WeakSet<object>>();
  while (pending.length) {
    const pair = pending.pop(); if (!pair) break;
    const [a, b] = pair;
    if (Object.is(a, b)) continue;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return admitted;
    const known = applyObservation(getObservation, visited, [a]) as WeakSet<object> | undefined; if (known && applyObservation(hasImmutable, known, [b])) continue;
    const partners = known ?? new WeakSet<object>(); applyObservation(addImmutable, partners, [b]); applyObservation(setObservation, visited, [a, partners]);
    const keys = Reflect.ownKeys(a), others = Reflect.ownKeys(b);
    if (keys.length !== others.length) return admitted;
    for (const key of keys) {
      const left = Object.getOwnPropertyDescriptor(a, key), right = Object.getOwnPropertyDescriptor(b, key);
      if (!left || !right || !('value' in left) || !('value' in right) || left.enumerable !== right.enumerable) return admitted;
      pending.push([left.value, right.value]);
    }
  }
  return original;
}
