import { types as nodeTypes } from 'node:util';
import type { ResearchReferenceOperation } from './types.js';
const invalid = (): never => { throw new Error('Protected source owner is unavailable or the handle is not current'); };
const apply = Reflect.apply;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
const throwIfAborted = AbortSignal.prototype.throwIfAborted;
export function captureScreeningOperation(value: ResearchReferenceOperation | undefined): ResearchReferenceOperation | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || nodeTypes.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
  const fields = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(fields).some(key => key !== 'signal' && key !== 'assertCurrent')
    || Object.values(fields).some(field => !('value' in field))) return invalid();
  const signal = fields.signal?.value as unknown;
  const assertCurrent = fields.assertCurrent?.value as unknown;
  if (signal !== undefined) {
    if (!signal || typeof signal !== 'object' || nodeTypes.isProxy(signal)) return invalid();
    try { apply(signalAborted, signal, []); } catch { return invalid(); }
  }
  if (assertCurrent !== undefined && (typeof assertCurrent !== 'function' || nodeTypes.isProxy(assertCurrent))) return invalid();
  return Object.freeze({ signal: signal as AbortSignal | undefined, assertCurrent: assertCurrent as (() => void) | undefined });
}

/** Synchronous caller restriction shared by semantic and Classic source owners. */
export function assertScreeningOperation(operation: ResearchReferenceOperation | undefined): void {
  if (operation?.signal) apply(throwIfAborted, operation.signal, []);
  const result: unknown = operation?.assertCurrent?.();
  if (result !== undefined) {
    if (nodeTypes.isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
    return invalid();
  }
  if (operation?.signal) apply(throwIfAborted, operation.signal, []);
}
