import { describe, expect, test } from 'bun:test';
import { trackDeliveredOutput } from '../platform/src/platform/providers/stream-delivery.js';
import type { StreamDelta } from '../platform/src/platform/providers/interface.js';

describe('trackDeliveredOutput', () => {
  test('retry stays open until answer text reaches the caller', () => {
    const seen: StreamDelta[] = [];
    const tracked = trackDeliveredOutput((delta) => seen.push(delta));
    expect(tracked.canRetry()).toBe(true);
    tracked.onDelta?.({ toolCalls: [{ index: 0, id: 'c', name: 'read' }] });
    expect(tracked.canRetry()).toBe(true);
    tracked.onDelta?.({ content: 'Hello' });
    expect(tracked.canRetry()).toBe(false);
    expect(seen).toHaveLength(2);
  });

  test('reasoning text also closes the retry window', () => {
    const tracked = trackDeliveredOutput(() => {});
    tracked.onDelta?.({ reasoning: 'thinking' });
    expect(tracked.canRetry()).toBe(false);
  });

  test('without a listener nothing is delivered and retry stays open', () => {
    const tracked = trackDeliveredOutput(undefined);
    expect(tracked.onDelta).toBeUndefined();
    expect(tracked.canRetry()).toBe(true);
  });
});
