import { describe, expect, test } from 'bun:test';
import { UIFactory } from '../../renderer/ui-factory.ts';

describe('UIFactory.computeRenderStallInfo reconnect counter', () => {
  test('carries a provider reconnect attempt into the stall info, and the busy phrase names it', () => {
    const info = UIFactory.computeRenderStallInfo({ toolActive: false, lastDeltaAtMs: 1000, nowMs: 9000, reconnectAttempt: 2, reconnectMaxAttempts: 5 });
    expect(info?.reconnect).toEqual({ attempt: 2, maxAttempts: 5 });
    expect(UIFactory.busyPhrase(0, 0, info)).toContain('2');
  });

  test('without a reconnect there is no counter, and an active tool suppresses the stall entirely', () => {
    expect(UIFactory.computeRenderStallInfo({ toolActive: false, lastDeltaAtMs: 1000, nowMs: 9000 })?.reconnect).toBeUndefined();
    expect(UIFactory.computeRenderStallInfo({ toolActive: true, lastDeltaAtMs: 1000, nowMs: 9000, reconnectAttempt: 1, reconnectMaxAttempts: 3 })).toBeUndefined();
  });
});
