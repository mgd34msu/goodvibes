import { isDeepStrictEqual } from 'node:util';
import { captureStrictJudgmentJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';

const surfaceMethodsUnchanged = (): void => {};

/**
 * Check once that the surface offers these methods. They are the program's
 * own methods, so nothing about them is re-checked per call; the returned
 * guard is kept for callers that retain one.
 */
export function retainSurfaceMethods(owner: object, keys: readonly string[]): () => void {
  for (const key of keys) {
    if (typeof (owner as Record<string, unknown>)[key] !== 'function') throw new ToolInputProjectionError('held');
  }
  return surfaceMethodsUnchanged;
}

/** Private complete readset; these values are never judgment evidence. */
export function retainSurfaceRead(owner: object, keys: readonly string[], read: () => unknown): () => void {
  const methods = retainSurfaceMethods(owner, keys);
  const snapshot = captureStrictJudgmentJson(read());
  const assertCurrent = () => {
    methods();
    if (!isDeepStrictEqual(captureStrictJudgmentJson(read()), snapshot)) throw new ToolInputProjectionError('stale');
    methods();
  };
  assertCurrent();
  return assertCurrent;
}
