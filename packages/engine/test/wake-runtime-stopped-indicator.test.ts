/**
 * wake-runtime-stopped-indicator.test.ts
 *
 * A wake listener that stopped itself while the feature is still enabled shows
 * the stopped chip, rather than no chip at all (which reads as "wake is off").
 */
import { describe, expect, test } from 'bun:test';
import { liveWakeIndicator, phaseWakeIndicator } from '../terminal-shell/src/audio/wake-runtime.ts';
import type { WakeListenerState } from '../platform/src/platform/voice/wake/listener-types.js';

function state(overrides: Partial<WakeListenerState>): WakeListenerState {
  return {
    phase: 'idle', deviceLabel: null, latchReason: null, restarts: 0, modelIds: [], lastWakeAt: null,
    lastError: null, deviceBinding: null, captureOpen: false, framesFlowing: false, framesSeen: 0, lastFrameAt: null,
    ...overrides,
  };
}

describe('a wake listener that stopped itself', () => {
  test('shows the stopped indicator on both surfaces', () => {
    const stopped = state({ lastError: 'The recorder failure could not be safely determined.' });
    expect(phaseWakeIndicator(stopped, 'idle')).toBe('wake-latched');
    expect(liveWakeIndicator(stopped)).toBe('wake-latched');
  });

  test('an idle listener with no failure still shows nothing', () => {
    expect(phaseWakeIndicator(state({}), 'idle')).toBeNull();
    expect(liveWakeIndicator(state({}))).toBeNull();
  });
});
