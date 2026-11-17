import { assertSynchronousJudgmentGuard } from '@goodvibes-jev/judgment/decisions';

/**
 * The caller's own cancellation and currentness check, captured once. The
 * options object is the caller's, so its slots are read once here and not
 * re-checked per call.
 */
export function captureNativeReadRestrictions(options: {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}): () => void {
  const signal = options.signal, current = options.assertCurrent;
  return () => {
    signal?.throwIfAborted();
    assertSynchronousJudgmentGuard(() => current?.(), () => new Error('Native read currentness must be synchronous.'));
    signal?.throwIfAborted();
  };
}
