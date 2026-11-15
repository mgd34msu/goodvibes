/**
 * power-hold-honesty.test.ts
 *
 * The served power state never claims a hold the OS did not grant, the hard
 * cap is not re-armed for wedged work by unrelated later work, a stopped
 * manager never acquires again, and a stale cap release cannot drop a fresh
 * inhibitor.
 */
import { describe, expect, test } from 'bun:test';
import { KEEP_AWAKE_NOT_HELD, PowerManager, keepAwakeCondition } from '../platform/src/platform/power/manager.ts';
import type { PowerInhibitClass, PowerInhibitHandle, PowerPlatformSeam } from '../platform/src/platform/power/types.ts';
import type { EventEnvelope } from '@goodvibes-jev/engine/transport-core';

function scriptedSeam(options: { refuse?: () => boolean } = {}) {
  const log: string[] = [];
  let sleepEdge: ((sleeping: boolean) => void) | null = null;
  let held = 0;
  const seam: PowerPlatformSeam = {
    platform: 'fixture',
    isAvailable: async () => true,
    inhibit: async (input): Promise<PowerInhibitHandle | null> => {
      if (options.refuse?.()) { log.push('refused'); return null; }
      held += 1;
      const granted: PowerInhibitClass[] = [...input.classes];
      log.push(`acquire:${granted.join('+')}`);
      let released = false;
      return {
        grantedClasses: granted,
        deniedClasses: [],
        release: async () => { if (!released) { released = true; held -= 1; log.push(`release:${granted.join('+')}`); } },
      };
    },
    onPrepareForSleep: (callback) => { sleepEdge = callback; return () => { sleepEdge = null; }; },
  };
  return { seam, log, held: () => held, fireSleepEdge: (sleeping: boolean) => sleepEdge?.(sleeping) };
}

function makeManager(seam: PowerPlatformSeam, config: Record<string, unknown> = {}, extra: Partial<ConstructorParameters<typeof PowerManager>[0]> = {}) {
  return new PowerManager({
    seam,
    readConfig: (key) => config[key],
    writeConfig: (key, value) => { config[key] = value; },
    registerProcessExitHooks: () => () => {},
    ...extra,
  });
}

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe('keep-awake that the OS refused', () => {
  test('is served as on-but-not-holding with a note, not as holding', async () => {
    const { seam } = scriptedSeam({ refuse: () => true });
    const manager = makeManager(seam);
    const state = await manager.setKeepAwake(true);
    expect(state.keepAwake.enabled).toBe(true);
    expect(state.keepAwake.held).toBe(false);
    expect(state.keepAwake.note).toBe(KEEP_AWAKE_NOT_HELD);
    expect(keepAwakeCondition(state.keepAwake)).toBe('refused');
  });

  test('is retried on the wake edge', async () => {
    let refuse = true;
    const { seam, fireSleepEdge } = scriptedSeam({ refuse: () => refuse });
    const manager = makeManager(seam);
    await manager.start();
    await manager.setKeepAwake(true);
    expect(manager.getState().keepAwake.held).toBe(false);
    refuse = false;
    fireSleepEdge(false);
    await settle();
    const state = manager.getState();
    expect(state.keepAwake.held).toBe(true);
    expect(state.keepAwake.note).toBeNull();
    expect(keepAwakeCondition(state.keepAwake)).toBe('held');
  });

  test('is retried by turning it on again', async () => {
    let refuse = true;
    const { seam } = scriptedSeam({ refuse: () => refuse });
    const manager = makeManager(seam);
    await manager.setKeepAwake(true);
    refuse = false;
    expect((await manager.setKeepAwake(true)).keepAwake.held).toBe(true);
  });
});

/** Timers and a clock the test drives, so the cap fires exactly when a test says. */
function cappedClock() {
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  let now = 1_000_000;
  return {
    timers,
    advance: (ms: number) => { now += ms; },
    now: () => now,
    seam: {
      setTimeout: ((fn: () => void, ms: number) => {
        const timer = { fn, ms, cancelled: false };
        timers.push(timer);
        return timer;
      }) as unknown as typeof setTimeout,
      clearTimeout: ((timer: { cancelled: boolean }) => { timer.cancelled = true; }) as unknown as typeof clearTimeout,
    },
    /** The cap timers still armed, oldest first. */
    live: () => timers.filter((timer) => !timer.cancelled),
  };
}

const flush = async (): Promise<void> => { for (let i = 0; i < 100; i += 1) await Promise.resolve(); };
const CAP_MINUTES = 180;
const CAP_MS = CAP_MINUTES * 60_000;

describe('the work hard cap', () => {
  function capped() {
    const clock = cappedClock();
    const { seam, held, log } = scriptedSeam();
    const manager = makeManager(seam, { 'power.workInhibitMaxMinutes': CAP_MINUTES }, { now: clock.now, timers: clock.seam });
    return { clock, manager, held, log };
  }

  test('later work does not re-arm a full cap for the wedged hold', async () => {
    const { clock, manager, held } = capped();
    manager.holdWork('wedged', 'a hold that never drains');
    await flush();
    expect(clock.live()).toHaveLength(1);
    expect(clock.live()[0]!.ms).toBe(CAP_MS);
    clock.advance(CAP_MS);
    clock.live()[0]!.fn();
    await flush();
    expect(manager.getState().work.held).toBe(false);

    manager.holdWork('turn', 'a turn is running');
    await flush();
    expect(manager.getState().work.held).toBe(true);
    manager.releaseWork('turn');
    await flush();
    // Only the wedged (already capped) reason remains: nothing is held for it again.
    const state = manager.getState();
    expect(state.work.held).toBe(false);
    expect(held()).toBe(0);
    expect(state.work.reasons).toEqual(['a hold that never drains']);
  });

  test('work that started shortly before the cap fired keeps a hold of its own', async () => {
    const { clock, manager } = capped();
    manager.holdWork('wedged', 'a hold that never drains');
    await flush();
    clock.advance(CAP_MS - 1_000);
    manager.holdWork('young', 'a turn is running');
    await flush();
    clock.advance(1_000);
    clock.live()[0]!.fn();
    await flush();
    let state = manager.getState();
    expect(state.work.capExpired).toBe(true);
    expect(state.work.held).toBe(true);
    manager.releaseWork('young');
    await flush();
    state = manager.getState();
    expect(state.work.held).toBe(false);
    expect(state.work.reasons).toEqual(['a hold that never drains']);
  });

  test('the cap-expired flag clears once the capped work drains', async () => {
    const { clock, manager } = capped();
    manager.holdWork('wedged', 'a hold that never drains');
    await flush();
    clock.advance(CAP_MS);
    clock.live()[0]!.fn();
    await flush();
    expect(manager.getState().work.capExpired).toBe(true);
    manager.releaseWork('wedged');
    await flush();
    expect(manager.getState().work.capExpired).toBe(false);
    expect(manager.getState().work.reasons).toEqual([]);
  });

  test('a cap timer that was already running when its hold was replaced does not drop the new hold', async () => {
    const { clock, manager, held, log } = capped();
    manager.holdWork('first', 'the first piece of work');
    await flush();
    const firstCap = clock.live()[0]!;

    // The work drains (its cap timer is cancelled, but a timer that has
    // already begun to fire cannot be recalled) and new work takes a fresh hold.
    manager.releaseWork('first');
    await flush();
    manager.holdWork('second', 'the second piece of work');
    await flush();
    expect(held()).toBe(1);

    firstCap.fn();
    await flush();

    expect(held()).toBe(1);
    expect(manager.getState().work.held).toBe(true);
    // The fresh hold was acquired once and never released by the stale cap.
    expect(log).toEqual([
      'acquire:idle+sleep', 'release:idle+sleep',
      'acquire:idle+sleep',
    ]);
  });
});

describe('a stopped manager', () => {
  test('acquires nothing for work events that arrive after stop()', async () => {
    const { seam, log } = scriptedSeam();
    const handlers = new Map<string, (envelope: EventEnvelope<string, Record<string, unknown>>) => void>();
    const manager = makeManager(seam, {}, {
      workSignalBus: { on: (type, cb) => { handlers.set(type, cb); return () => { handlers.delete(type); }; } },
    });
    await manager.start();
    await manager.stop();
    manager.holdWork('late', 'work after shutdown');
    await settle();
    expect(log).toEqual([]);
    expect(manager.getState().work.held).toBe(false);
    // stop() also unbound the bus listeners.
    expect(handlers.size).toBe(0);
  });

  test('does not keep keep-awake it acquires after stop()', async () => {
    const { seam, held } = scriptedSeam();
    const manager = makeManager(seam);
    await manager.stop();
    await manager.setKeepAwake(true);
    expect(held()).toBe(0);
  });

  test('releaseAllHoldsNow clears the held-since stamp with the hold', async () => {
    const { seam } = scriptedSeam();
    const manager = makeManager(seam);
    manager.holdWork('turn', 'a turn is running');
    await settle();
    expect(manager.getState().work.heldSince).not.toBeNull();
    manager.releaseAllHoldsNow();
    expect(manager.getState().work.heldSince).toBeNull();
  });
});

test('the served power state names what keep-awake is doing, so a client never infers a refusal', async () => {
  const { createPowerStatusHandler } = await import('../platform/src/platform/control-plane/routes/power.js');
  const view = (enabled: boolean, held: boolean, deniedClasses: readonly string[]) => ({
    platform: 'linux',
    work: { held: false, grantedClasses: [], deniedClasses: [], reasons: [], heldSince: null, capMinutes: 60, capExpiresAt: null, capExpired: false },
    keepAwake: { enabled, held, grantedClasses: [], deniedClasses, note: null },
  });
  const served = async (state: ReturnType<typeof view>) => {
    const handler = createPowerStatusHandler({ getState: () => state, setKeepAwake: async () => state } as never);
    return await handler({} as never) as { keepAwake: { state: string } };
  };
  expect((await served(view(false, false, []))).keepAwake.state).toBe('off');
  expect((await served(view(true, false, []))).keepAwake.state).toBe('refused');
  expect((await served(view(true, true, ['handle-lid-switch']))).keepAwake.state).toBe('held-partial');
  expect((await served(view(true, true, []))).keepAwake.state).toBe('held');
});
