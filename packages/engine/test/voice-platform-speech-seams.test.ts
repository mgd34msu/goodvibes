import { expect, test } from 'bun:test';
import { SpokenTurnController } from '../platform/src/platform/voice/spoken-turn/controller.js';
import type { TurnEvent } from '../platform/src/events/turn.js';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test('exit cancels queued retry backoff immediately while audible drain remains blocked', async () => {
  const drained = Promise.withResolvers<void>();
  const timers = new Map<number, () => void>(); let nextTimer = 0, requests = 0;
  const controller = new SpokenTurnController({
    configManager: { get: () => '' } as never,
    voiceService: { async synthesizeStream() { requests++; throw Object.assign(new Error('fixture unavailable'), { status: 503 }); } },
    sink: { available: true, label: 'held-drain', stop() {}, async waitForDrain() { await drained.promise; }, async play() {} },
    setInterval: (() => 1) as never, clearInterval: (() => {}) as never,
    setTimeout: ((callback: () => void) => { timers.set(++nextTimer, callback); return nextTimer; }) as never,
    clearTimeout: ((timer: number) => { timers.delete(timer); }) as never,
  });
  await controller.handleTurnEvent({ type: 'TURN_SUBMITTED', turnId: 'backoff', prompt: 'prompt', origin: { source: 'tts' } } as TurnEvent);
  await controller.handleTurnEvent({ type: 'STREAM_DELTA', turnId: 'backoff', content: 'Complete response.', accumulated: '' });
  await controller.handleTurnEvent({ type: 'TURN_COMPLETED', turnId: 'backoff' } as TurnEvent);
  await tick();
  expect(timers.size).toBe(1); const lateTimer = [...timers.values()][0]!;
  const exiting = controller.stopForExit();
  expect(timers.size).toBe(0);
  lateTimer(); await tick(); expect(requests).toBe(1);
  drained.resolve(); await exiting;
});
