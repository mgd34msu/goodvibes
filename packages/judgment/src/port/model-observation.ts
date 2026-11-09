/** Native transport attribution, distinct from forgeable JSON lineage. No authority is conveyed. */
export interface JudgmentModelObservation {
  readonly requestedModel: string;
  readonly model: string;
  readonly targetModel: string;
  readonly endpointIndex: number;
}
const observations = new WeakMap<object, JudgmentModelObservation>();

/** Read-only: borrowed responses cannot acquire provenance by copying public fields. */
export function observeJudgmentModel(value: unknown): JudgmentModelObservation | undefined {
  return value !== null && typeof value === 'object' ? observations.get(value) : undefined;
}
function freezeData(value: unknown, seen = new Set<object>()): void {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) throw new TypeError('Invalid native judgment data');
  for (const key of Reflect.ownKeys(value)) {
    const slot = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !slot || !('value' in slot)) throw new TypeError('Invalid native judgment data');
    freezeData(slot.value, seen);
  }
  Object.freeze(value);
}
/** SDK-internal only. Called after actual native adapter envelope/model validation. */
export function recordNativeModelObservation<T extends object>(result: T, observation: JudgmentModelObservation): T {
  freezeData(result);
  observations.set(result, Object.freeze({ ...observation }));
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
 * Preserve an already immutable native result through complete, unchanged data
 * admission. A projection/redaction remains the projection; no proof is copied.
 */
export function reuseObservedJudgmentResult<T>(original: T, admitted: T): T {
  if (!observeJudgmentModel(original)) return admitted;
  const same = (a: unknown, b: unknown): boolean => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
    const keys = Reflect.ownKeys(a), others = Reflect.ownKeys(b);
    return keys.length === others.length && keys.every(key => {
      const left = Object.getOwnPropertyDescriptor(a, key), right = Object.getOwnPropertyDescriptor(b, key);
      return left && right && 'value' in left && 'value' in right && same(left.value, right.value);
    });
  };
  return same(original, admitted) ? original : admitted;
}
