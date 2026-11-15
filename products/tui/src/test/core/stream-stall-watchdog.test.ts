/**
 * Tests for StreamStallWatchdog, driven by a virtual clock through the
 * watchdog's timer seam so no test depends on real scheduling latency.
 */
import { describe, test, expect } from 'bun:test';
import { createStreamStallWatchdog, type StallTimers, type WatchdogTurnEvents } from '../../core/stream-stall-watchdog.ts';

// ---------------------------------------------------------------------------
// Minimal event surface stub
// ---------------------------------------------------------------------------

type SupportedEvent =
  | 'STREAM_START'
  | 'STREAM_DELTA'
  | 'STREAM_END'
  | 'TURN_COMPLETED'
  | 'TURN_ERROR'
  | 'TURN_CANCEL';

type EventMap = { [K in SupportedEvent]: Array<() => void> };

function makeEvents(): WatchdogTurnEvents & { emit: (event: SupportedEvent) => void } {
  const listeners: EventMap = {
    STREAM_START: [],
    STREAM_DELTA: [],
    STREAM_END: [],
    TURN_COMPLETED: [],
    TURN_ERROR: [],
    TURN_CANCEL: [],
  };

  return {
    on(event: SupportedEvent, handler: () => void) {
      listeners[event].push(handler);
      return () => {
        const idx = listeners[event].indexOf(handler);
        if (idx !== -1) listeners[event].splice(idx, 1);
      };
    },
    emit(event: SupportedEvent) {
      for (const h of listeners[event].slice()) h();
    },
  };
}

/** A virtual clock: timers fire, in order, only when `advance` moves time past them. */
class VirtualClock implements StallTimers {
  private now = 0;
  private nextId = 1;
  private readonly pending = new Map<number, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.pending.set(id, { at: this.now + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  get armed(): number {
    return this.pending.size;
  }

  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const due = [...this.pending.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.pending.delete(due[0]);
      this.now = due[1].at;
      due[1].callback();
    }
    this.now = target;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_THRESHOLD_MS = 20;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('StreamStallWatchdog', () => {

  test('fires onStall exactly once after STREAM_START with no delta', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: (provider) => stallCalls.push(provider),
      getProviderName: () => 'anthropic',
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0]).toBe('anthropic');

    watchdog.dispose();
  });

  test('does NOT fire when the gap after STREAM_DELTA stays under threshold', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: (provider) => stallCalls.push(provider),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    // Delta arrives well before threshold, and nothing exceeds the
    // (re-armed) threshold afterwards either.
    clock.advance(5);
    events.emit('STREAM_DELTA');
    clock.advance(TEST_THRESHOLD_MS - 1);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('DOES fire on a mid-stream stall; silence after a delta re-arms the watchdog', () => {
    // Regression test for the reported multi-minute mid-turn stall: tokens
    // were already flowing (so a delta had arrived), then the stream went
    // silent for longer than the threshold. The watchdog must still fire,
    // it must NOT be permanently disarmed by the first delta.
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: Array<{ provider: string; episode: number }> = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: (provider, episode) => stallCalls.push({ provider, episode }),
      getProviderName: () => 'anthropic',
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(5);
    events.emit('STREAM_DELTA');
    // No further deltas, silence exceeds the threshold from this point on.
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0]).toEqual({ provider: 'anthropic', episode: 1 });
    watchdog.dispose();
  });

  test('fires again for a second stall episode after a recovery', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: Array<{ provider: string; episode: number }> = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: (provider, episode) => stallCalls.push({ provider, episode }),
      getProviderName: () => 'anthropic',
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(TEST_THRESHOLD_MS);
    expect(stallCalls).toHaveLength(1);
    expect(stallCalls[0].episode).toBe(1);

    // Stream recovers (a delta arrives), then stalls again.
    events.emit('STREAM_DELTA');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(2);
    expect(stallCalls[1].episode).toBe(2);
    watchdog.dispose();
  });

  test('fires only ONCE per turn even if threshold elapses multiple times', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    // Wait for the stall to fire
    clock.advance(TEST_THRESHOLD_MS);
    // Wait again well past the threshold, should not fire again
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(1);
    watchdog.dispose();
  });

  test('re-arms on next STREAM_START after a stall', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    // First turn stalls
    events.emit('STREAM_START');
    clock.advance(TEST_THRESHOLD_MS);
    expect(stallCalls).toHaveLength(1);

    // Second turn also stalls, should fire again (re-armed)
    events.emit('STREAM_START');
    clock.advance(TEST_THRESHOLD_MS);
    expect(stallCalls).toHaveLength(2);

    watchdog.dispose();
  });

  test('disarms on TURN_COMPLETED: no stall fires after turn ends', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(5);
    events.emit('TURN_COMPLETED');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('disarms on TURN_ERROR: no stall fires after error', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(5);
    events.emit('TURN_ERROR');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('disarms on TURN_CANCEL', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(5);
    events.emit('TURN_CANCEL');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('disarms on STREAM_END', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(5);
    events.emit('STREAM_END');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(0);
    watchdog.dispose();
  });

  test('dispose() cancels pending timer: no stall fires after dispose', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });

    events.emit('STREAM_START');
    clock.advance(5);
    expect(clock.armed).toBe(1);
    watchdog.dispose();
    expect(clock.armed).toBe(0);
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(0);
  });

  test('dispose() removes all event subscriptions', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: () => stallCalls.push('fired'),
      thresholdMs: TEST_THRESHOLD_MS,
    });
    watchdog.dispose();

    // Emitting after dispose should not trigger anything
    events.emit('STREAM_START');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls).toHaveLength(0);
  });

  test('uses default provider name when getProviderName not supplied', () => {
    const events = makeEvents();
    const clock = new VirtualClock();
    const stallCalls: string[] = [];
    const watchdog = createStreamStallWatchdog({
      events,
      timers: clock,
      onStall: (name) => stallCalls.push(name),
      thresholdMs: TEST_THRESHOLD_MS,
      // No getProviderName
    });

    events.emit('STREAM_START');
    clock.advance(TEST_THRESHOLD_MS);

    expect(stallCalls[0]).toBe('provider');
    watchdog.dispose();
  });
});
