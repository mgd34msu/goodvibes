/**
 * spoken-turn-wiring.test.ts
 *
 * Integration smoke test for wireSpokenTurnRuntime. Verifies the full wiring
 * seam: TURN_SUBMITTED → STREAM_DELTA → TURN_COMPLETED with a fake
 * voiceService and injected player factory. Asserts audio bytes reach the
 * player without spawning any real subprocess.
 */
import { describe, expect, test } from 'bun:test';
import type { VoiceAudioChunk, VoiceSynthesisRequest, VoiceSynthesisStreamResult } from '@goodvibes-jev/engine/platform/platform/voice';
import type { StreamingAudioPlayer } from '../../audio/player.ts';
import { wireSpokenTurnRuntime } from '../../audio/spoken-turn-wiring.ts';

// ---------------------------------------------------------------------------
// Minimal fake events surface
// ---------------------------------------------------------------------------

type Handler<E> = (event: E) => void;

function makeFakeEvents() {
  const listeners = new Map<string, Handler<unknown>[]>();

  function on(type: string, handler: Handler<unknown>): () => void {
    const existing = listeners.get(type) ?? [];
    existing.push(handler);
    listeners.set(type, existing);
    return () => {
      const arr = listeners.get(type);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  function emit(type: string, event: unknown): void {
    for (const handler of listeners.get(type) ?? []) handler(event);
  }

  const turns = {
    on: (type: string, handler: Handler<unknown>) => on(type, handler),
  };

  return { turns: turns as never, emit };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function* audioChunks(text: string): AsyncIterable<VoiceAudioChunk> {
  yield {
    data: new TextEncoder().encode(text),
    sequence: 1,
    format: 'mp3',
  };
}

function makeFakeVoiceService() {
  const synthesized: string[] = [];
  const voiceService = {
    async synthesizeStream(_providerId: string | undefined, request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
      synthesized.push(request.text);
      return {
        providerId: 'fake',
        mimeType: 'audio/mpeg',
        format: 'mp3',
        chunks: audioChunks(request.text),
        metadata: {},
      };
    },
  };
  return { voiceService, synthesized };
}

function makeFakePlayer(): { player: StreamingAudioPlayer; played: string[] } {
  const played: string[] = [];
  const player: StreamingAudioPlayer = {
    label: 'fake-player',
    available: true,
    async play(chunks) {
      for await (const chunk of chunks) {
        played.push(new TextDecoder().decode(chunk.data));
      }
    },
    stop() {},
    async waitForDrain() {},
  };
  return { player, played };
}

async function drain(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Retry backoff timers the test fires by hand, so no test waits in real time. */
function manualTimers() {
  const scheduled = new Map<number, { readonly run: () => void; readonly delay: number }>();
  let next = 1;
  return {
    setTimeout: ((run: () => void, delay: number) => { const id = next++; scheduled.set(id, { run, delay }); return id; }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => { scheduled.delete(id); }) as unknown as typeof clearTimeout,
    pendingDelays: () => [...scheduled.values()].map((timer) => timer.delay),
    fireAll: () => { const due = [...scheduled.values()]; scheduled.clear(); for (const timer of due) timer.run(); },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('wireSpokenTurnRuntime integration seam', () => {
  test('TURN_SUBMITTED → STREAM_DELTA → TURN_COMPLETED delivers audio bytes to player', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();
    const messages: string[] = [];

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return false;
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: (msg) => messages.push(msg),
      playerFactory: () => player,
    });

    // Always-speak is off; the turn's own origin asks for speech, as a /tts prompt does.
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-wiring-1', prompt: 'hello world', origin: { source: 'tts' } });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-wiring-1', content: 'Hello, world.', accumulated: 'Hello, world.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-wiring-1', response: 'Hello, world.', stopReason: 'completed' });

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Hello, world.');

    // Clean up subscriptions
    for (const unsub of runtime.unsubs) unsub();
  });

  test('always-speak mode arms turns automatically on TURN_SUBMITTED when ui.voiceEnabled is true', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return true; // always-speak ON
          if (key === 'tts.provider') return 'fake';
          if (key === 'tts.voice') return '';
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    // No spoken origin on the turn: always-speak mode is what makes it spoken
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-auto', prompt: 'auto spoken' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-auto', content: 'Auto response.', accumulated: 'Auto response.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-auto', response: 'Auto response.', stopReason: 'completed' });

    await drain();

    expect(synthesized.length).toBeGreaterThan(0);
    expect(played.join('')).toContain('Auto response.');

    for (const unsub of runtime.unsubs) unsub();
  });

  test('always-speak off does not auto-arm turns', async () => {
    const { voiceService, synthesized } = makeFakeVoiceService();
    const { player, played } = makeFakePlayer();
    const events = makeFakeEvents();

    wireSpokenTurnRuntime({
      voiceService,
      configManager: {
        get(key: string) {
          if (key === 'ui.voiceEnabled') return false; // always-speak OFF
          return '';
        },
      } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    // No spoken origin and always-speak off: nothing should synthesize
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'turn-silent', prompt: 'silent' });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'turn-silent', content: 'Silent.', accumulated: 'Silent.' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'turn-silent', response: 'Silent.', stopReason: 'completed' });

    await drain();

    expect(synthesized).toHaveLength(0);
    expect(played).toHaveLength(0);
  });

  test('unsubs unregister all event handlers', () => {
    const { voiceService } = makeFakeVoiceService();
    const { player } = makeFakePlayer();
    const events = makeFakeEvents();

    const runtime = wireSpokenTurnRuntime({
      voiceService,
      configManager: { get: () => false } as never,
      events: { turns: events.turns } as never,
      notify: () => {},
      playerFactory: () => player,
    });

    expect(runtime.unsubs.length).toBeGreaterThan(0);
    for (const unsub of runtime.unsubs) unsub();
    // After unsubscribing no throws should occur from emitting events
    expect(() => {
      events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'x', prompt: 'x' });
    }).not.toThrow();
  });
});

function failingRuntime(error: unknown) {
  const timers = manualTimers();
  const requests: VoiceSynthesisRequest[] = [];
  const { player, played } = makeFakePlayer();
  const events = makeFakeEvents();
  const messages: string[] = [];
  const runtime = wireSpokenTurnRuntime({
    voiceService: { async synthesizeStream(_provider: string | undefined, request: VoiceSynthesisRequest) {
      requests.push(request);
      if (requests.length === 1) throw error;
      return { providerId: 'fake', mimeType: 'audio/mpeg', format: 'mp3', chunks: audioChunks(request.text), metadata: {} };
    } } as never,
    configManager: { get(key: string) { return key === 'ui.voiceEnabled' ? true : ''; } } as never,
    events: { turns: events.turns } as never,
    notify: (message) => messages.push(message), playerFactory: () => player,
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout,
  });
  return { runtime, requests, events, played, messages, timers,
    speak(id = 'old') {
      events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: id, prompt: id });
      events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: id, content: `${id} answer.`, accumulated: `${id} answer.` });
      events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: id, response: `${id} answer.`, stopReason: 'completed' });
    },
    close() { runtime.stop(); for (const unsub of runtime.unsubs) unsub(); },
  };
}

describe('actual spoken wiring retry decided by the failure table', () => {
  test.each([
    ['503', Object.assign(new Error('credentials'), { status: 503 }), true],
    ['errno', Object.assign(new Error('credentials'), { code: 'ECONNRESET' }), true],
    ['429', Object.assign(new Error('account details'), { status: 429 }), true],
    ['401', Object.assign(new Error('network timeout'), { status: 401 }), false],
    ['no structure', new Error('network timeout socket 429 concurrent'), false],
  ] as const)('%s follows the shared controller through actual wiring', async (_label, error, retry) => {
    const h = failingRuntime(error);
    try {
      h.speak(); await drain();
      // A retryable failure waits on exactly one backoff timer; a terminal one schedules none.
      expect(h.timers.pendingDelays()).toHaveLength(retry ? 1 : 0);
      h.timers.fireAll();
      await drain();
      expect(h.requests).toHaveLength(retry ? 2 : 1);
      expect(h.played).toEqual(retry ? ['old answer.'] : []);
      expect(h.messages.filter((message) => message.includes('Skipping'))).toHaveLength(retry ? 0 : 1);
      if (retry) {
        expect(h.requests[1]?.signal).toBe(h.requests[0]?.signal);
        expect(h.requests[1]?.metadata).toEqual(h.requests[0]?.metadata);
      }
    } finally { h.close(); }
  });

  test('stop during backoff prevents a late retry', async () => {
    const h = failingRuntime(Object.assign(new Error('unavailable'), { status: 503 }));
    try {
      h.speak(); await drain();
      expect(h.timers.pendingDelays()).toHaveLength(1);
      h.runtime.stop();
      // Stopping cancels the backoff timer itself, so nothing is left to fire a retry.
      expect(h.timers.pendingDelays()).toEqual([]);
      h.timers.fireAll(); await drain();
      expect(h.requests).toHaveLength(1); expect(h.played).toEqual([]);
      expect(h.messages.filter((message) => message.includes('Skipping'))).toEqual([]);
    } finally { h.close(); }
  });
});


test('live consumer cuts speech at sentence ends locally and honors cancellation', async () => {
  const source = 'Dr. Rivera paid 3.14 dollars. Next fragment';
  const events = makeFakeEvents();
  const { voiceService, synthesized } = makeFakeVoiceService();
  const { player, played } = makeFakePlayer();
  const runtime = wireSpokenTurnRuntime({ voiceService: voiceService as never, configManager: { get: () => false } as never,
    events: { turns: events.turns } as never, notify() {}, playerFactory: () => player });
  try {
    events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'seams', prompt: 'prompt', origin: { source: 'tts' } });
    events.emit('STREAM_DELTA', { type: 'STREAM_DELTA', turnId: 'seams', content: source, accumulated: source });
    await drain();
    expect(synthesized).toEqual(['Dr. Rivera paid 3.14 dollars.']);
    expect(played).toEqual(['Dr. Rivera paid 3.14 dollars.']);
    events.emit('TURN_CANCEL', { type: 'TURN_CANCEL', turnId: 'seams', stopReason: 'cancelled' });
    events.emit('TURN_COMPLETED', { type: 'TURN_COMPLETED', turnId: 'seams', response: source, stopReason: 'completed' });
    await drain();
    expect(synthesized).toHaveLength(1);
  } finally { runtime.stop(); runtime.unsubs.forEach(unsub => unsub()); }
});


test.each(['startup', 'notification'] as const)('consumer contains throwing %s callback without rejected event work', async mode => {
  const { voiceService } = makeFakeVoiceService(); const { player } = makeFakePlayer(); const events = makeFakeEvents();
  const runtime = wireSpokenTurnRuntime({ voiceService: voiceService as never,
    configManager: { get(key: string) {
      if (key === 'ui.voiceEnabled') return false;
      if (mode === 'startup') throw new Error('host config failed');
      return '';
    } } as never, events: { turns: events.turns } as never,
    notify() { throw new Error('host notify failed'); }, playerFactory: () => player });
  try {
    expect(() => events.emit('TURN_SUBMITTED', { type: 'TURN_SUBMITTED', turnId: 'throws', prompt: 'prompt', origin: { source: 'tts' } })).not.toThrow();
    await drain();
    expect(() => events.emit('TURN_CANCEL', { type: 'TURN_CANCEL', turnId: 'throws', stopReason: 'cancelled' })).not.toThrow();
    await drain();
  } finally { runtime.stop(); runtime.unsubs.forEach(unsub => unsub()); }
});
