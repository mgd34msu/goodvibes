import type { StreamDelta } from './interface.js';

/**
 * Wraps a caller's `onDelta` and remembers whether any answer or reasoning text
 * has reached it. A retry after that point would deliver the whole answer a
 * second time behind the first attempt's text, so `canRetry` goes false and the
 * provider's error becomes final. Tool-call previews do not count: the turn
 * loop rebuilds those from the attempt's final result.
 */
export function trackDeliveredOutput(onDelta: ((delta: StreamDelta) => void) | undefined): {
  readonly onDelta: ((delta: StreamDelta) => void) | undefined;
  readonly canRetry: () => boolean;
} {
  let delivered = false;
  return {
    onDelta: onDelta
      ? (delta) => {
          if (delta.content || delta.reasoning) delivered = true;
          onDelta(delta);
        }
      : undefined,
    canRetry: () => !delivered,
  };
}
