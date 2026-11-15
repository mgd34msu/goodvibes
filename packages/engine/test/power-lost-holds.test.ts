/**
 * power-lost-holds.test.ts
 *
 * What the served power state claims must stay true after the start: an OS hold
 * that ends on its own is no longer reported as held, a sleep-edge watcher that
 * dies is restarted, sleep and wake hooks never overlap, a host with no support
 * says so, and a signal that the host handles without exiting does not drop the
 * holds the state still lists.
 */
import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { markSleepWatcherReaper } from '../platform/src/platform/power/child-hygiene.ts';
import { createDarwinCaffeinateSeam } from '../platform/src/platform/power/darwin-caffeinate.ts';
import { createLinuxLogindSeam } from '../platform/src/platform/power/linux-logind.ts';
import {
  KEEP_AWAKE_NOT_HELD,
  KEEP_AWAKE_NOT_SAVED,
  KEEP_AWAKE_REQUEST_NOT_APPLIED,
  PowerManager,
  defaultRegisterProcessExitHooks,
  keepAwakeUnsupportedNote,
  type PowerExitProcess,
} from '../platform/src/platform/power/manager.ts';
import { postPowerKeepAwakeSet } from '../platform/src/platform/power/keep-awake-remote.ts';
import { SLEEP_WATCH_MAX_RESTARTS } from '../platform/src/platform/power/sleep-edge-watch.ts';
import { createUnavailablePowerSeam, type PowerInhibitClass, type PowerInhibitHandle, type PowerPlatformSeam } from '../platform/src/platform/power/types.ts';

interface FakeChild {
  readonly child: ChildProcess;
  feed(text: string): void;
  exit(code: number): void;
  killed(): boolean;
}

function fakeChild(): FakeChild {
  const emitter = new EventEmitter();
  let killed = false;
  const fields = emitter as unknown as { stdout: EventEmitter; unref: () => void; kill: () => boolean; pid: number; exitCode: number | null };
  fields.stdout = new EventEmitter();
  fields.unref = () => {};
  fields.pid = 4242;
  fields.exitCode = null;
  fields.kill = () => {
    killed = true;
    fields.exitCode = 0;
    emitter.emit('exit', 0);
    return true;
  };
  return {
    child: emitter as unknown as ChildProcess,
    feed: (text) => fields.stdout.emit('data', Buffer.from(text, 'utf-8')),
    exit: (code) => {
      fields.exitCode = code;
      emitter.emit('exit', code);
    },
    killed: () => killed,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

/** A seam whose holds the test can end from outside, as the OS would. */
function losableSeam(options: { refuseAfter?: number } = {}) {
  const lose: Array<() => void> = [];
  const classes: PowerInhibitClass[][] = [];
  const seam: PowerPlatformSeam = {
    platform: 'fixture',
    isAvailable: async () => true,
    inhibit: async (input): Promise<PowerInhibitHandle | null> => {
      if (options.refuseAfter !== undefined && classes.length >= options.refuseAfter) return null;
      classes.push([...input.classes]);
      const callbacks: Array<() => void> = [];
      lose.push(() => { for (const callback of callbacks.splice(0)) callback(); });
      return {
        grantedClasses: [...input.classes],
        deniedClasses: [],
        release: async () => {},
        onLost: (callback) => { callbacks.push(callback); },
      };
    },
  };
  return { seam, lose, classes };
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

describe('a hold the OS ended on its own', () => {
  test('keep-awake stops reporting held and is acquired again', async () => {
    const { seam, lose, classes } = losableSeam();
    const manager = makeManager(seam);
    await manager.setKeepAwake(true);
    expect(manager.getState().keepAwake.held).toBe(true);
    lose[0]!();
    await flush();
    expect(classes).toHaveLength(2);
    expect(manager.getState().keepAwake.held).toBe(true);
    await manager.stop();
  });

  test('keep-awake that cannot be re-acquired is served as refused, not held', async () => {
    const { seam, lose } = losableSeam({ refuseAfter: 1 });
    const manager = makeManager(seam);
    await manager.setKeepAwake(true);
    lose[0]!();
    await flush();
    const state = manager.getState();
    expect(state.keepAwake.held).toBe(false);
    expect(state.keepAwake.note).toBe(KEEP_AWAKE_NOT_HELD);
    await manager.stop();
  });

  test('the work hold drops when the OS ends it and nothing can re-acquire it', async () => {
    const { seam, lose } = losableSeam({ refuseAfter: 1 });
    const manager = makeManager(seam);
    manager.holdWork('turn-1', 'a turn is running');
    await flush();
    expect(manager.getState().work.held).toBe(true);
    lose[0]!();
    await flush();
    expect(manager.getState().work.held).toBe(false);
    expect(manager.getState().work.reasons).toEqual(['a turn is running']);
    await manager.stop();
  });
});

describe('seam children', () => {
  test('caffeinate ending after the start probe fires onLost once; a deliberate release does not', async () => {
    const children: FakeChild[] = [];
    const seam = createDarwinCaffeinateSeam({
      startProbeMs: 1,
      readPowerSource: async () => 'ac',
      spawnInhibitor: () => {
        const fake = fakeChild();
        children.push(fake);
        return fake.child;
      },
    });
    const first = await seam.inhibit({ classes: ['idle'], who: 'goodvibes', why: 'x' });
    let lostFirst = 0;
    first!.onLost!(() => { lostFirst += 1; });
    children[0]!.exit(1);
    children[0]!.exit(1);
    expect(lostFirst).toBe(1);

    const second = await seam.inhibit({ classes: ['idle'], who: 'goodvibes', why: 'x' });
    let lostSecond = 0;
    second!.onLost!(() => { lostSecond += 1; });
    await second!.release();
    expect(lostSecond).toBe(0);
  });

  test('a systemd-inhibit child dying after the probe loses the whole handle and gives the other children back', async () => {
    const children: FakeChild[] = [];
    const whos: string[] = [];
    const seam = createLinuxLogindSeam({
      startProbeMs: 1,
      spawnInhibitor: (_command, args) => {
        whos.push(args.find((arg) => arg.startsWith('--who='))!);
        const fake = fakeChild();
        children.push(fake);
        return fake.child;
      },
    });
    const handle = await seam.inhibit({ classes: ['idle', 'sleep'], who: 'goodvibes keep-awake', why: 'x' });
    expect(handle!.grantedClasses).toEqual(['idle', 'sleep']);
    // The caller's label survives (still starting with the seam's own, which the orphan reaper matches).
    expect(whos[0]).toStartWith('--who=goodvibes keep-awake [owner-pid ');
    let lost = 0;
    handle!.onLost!(() => { lost += 1; });
    children[0]!.exit(1);
    expect(lost).toBe(1);
    expect(children[1]!.killed()).toBe(true);
  });

  test('a sleep-edge watcher that exits is restarted, a bounded number of times', async () => {
    const watchers: FakeChild[] = [];
    const edges: boolean[] = [];
    const seam = createDarwinCaffeinateSeam({
      spawnMonitor: () => {
        const fake = fakeChild();
        watchers.push(fake);
        return fake.child;
      },
    });
    const stop = seam.onPrepareForSleep!((sleeping) => edges.push(sleeping));
    for (let i = 0; i < SLEEP_WATCH_MAX_RESTARTS + 2; i += 1) watchers.at(-1)!.exit(1);
    expect(watchers).toHaveLength(SLEEP_WATCH_MAX_RESTARTS + 1);
    stop();
  });

  test('a watcher stopped on purpose is not restarted', async () => {
    const watchers: FakeChild[] = [];
    const seam = createDarwinCaffeinateSeam({
      spawnMonitor: () => {
        const fake = fakeChild();
        watchers.push(fake);
        return fake.child;
      },
    });
    seam.onPrepareForSleep!(() => {})();
    expect(watchers).toHaveLength(1);
    expect(watchers[0]!.killed()).toBe(true);
  });
});

describe('sleep edges', () => {
  test('the wake hook starts only after the sleep hook has finished', async () => {
    let edge: ((sleeping: boolean) => void) | null = null;
    const seam: PowerPlatformSeam = {
      platform: 'fixture',
      isAvailable: async () => true,
      inhibit: async () => null,
      onPrepareForSleep: (callback) => { edge = callback; return () => {}; },
    };
    const manager = makeManager(seam);
    const log: string[] = [];
    let finishSleep!: () => void;
    manager.onSleepEdge({
      onSleep: () => new Promise<void>((resolve) => { log.push('sleep:start'); finishSleep = () => { log.push('sleep:end'); resolve(); }; }),
      onWake: () => { log.push('wake:start'); },
    });
    await manager.start();
    edge!(true);
    edge!(false);
    await flush();
    expect(log).toEqual(['sleep:start']);
    finishSleep();
    await flush();
    expect(log).toEqual(['sleep:start', 'sleep:end', 'wake:start']);
    await manager.stop();
  });
});

describe('the served keep-awake note', () => {
  test('a host without sleep-inhibit support says so instead of promising a retry', async () => {
    const seam = createUnavailablePowerSeam('no power seam for win32');
    const manager = makeManager(seam);
    await manager.start();
    const state = await manager.setKeepAwake(true);
    expect(state.keepAwake.note).toBe(keepAwakeUnsupportedNote(seam.platform));
    expect(state.keepAwake.note).not.toContain('refused');
    await manager.stop();
  });

  test('a toggle that could not be saved is flagged as reverting on restart', async () => {
    const { seam } = losableSeam();
    const manager = makeManager(seam, {}, { writeConfig: () => { throw new Error('read-only config'); } });
    const state = await manager.setKeepAwake(true);
    expect(state.keepAwake.held).toBe(true);
    expect(state.keepAwake.note).toBe(KEEP_AWAKE_NOT_SAVED);
    await manager.stop();
  });

  test('a request to a stopped manager says it was not applied', async () => {
    const { seam } = losableSeam();
    const manager = makeManager(seam);
    await manager.stop();
    const state = await manager.setKeepAwake(true);
    expect(state.keepAwake.enabled).toBe(false);
    expect(state.keepAwake.note).toBe(KEEP_AWAKE_REQUEST_NOT_APPLIED);
  });
});

describe('default process exit hook', () => {
  function fakeProcess() {
    const emitter = new EventEmitter();
    const kills: string[] = [];
    const proc = Object.assign(emitter, {
      pid: 1,
      kill: (_pid: number, signal: string) => { kills.push(signal); return true; },
    }) as unknown as PowerExitProcess;
    return { emitter, proc, kills };
  }

  test('a signal the host also handles releases nothing and re-raises nothing', () => {
    const { emitter, proc, kills } = fakeProcess();
    let releases = 0;
    emitter.on('SIGHUP', () => {});
    defaultRegisterProcessExitHooks(() => { releases += 1; }, proc);
    emitter.emit('SIGHUP');
    expect(releases).toBe(0);
    expect(kills).toEqual([]);
    // The host exiting later still releases through the exit event.
    emitter.emit('exit');
    expect(releases).toBe(1);
  });

  test('a signal nobody else handles releases the holds and re-raises it', () => {
    const { emitter, proc, kills } = fakeProcess();
    let releases = 0;
    defaultRegisterProcessExitHooks(() => { releases += 1; }, proc);
    emitter.emit('SIGTERM');
    expect(releases).toBe(1);
    expect(kills).toEqual(['SIGTERM']);
  });
});

describe('default process exit hook beside the sleep watcher reaper', () => {
  test('a signal only the watcher reaper also listens for still releases and re-raises once', () => {
    const emitter = new EventEmitter();
    const kills: string[] = [];
    const proc = Object.assign(emitter, {
      pid: 1,
      kill: (_pid: number, signal: string) => { kills.push(signal); return true; },
    }) as unknown as PowerExitProcess;
    // The reaper is registered first, as it is once a sleep watcher has started.
    emitter.on('SIGTERM', markSleepWatcherReaper(() => {}));
    let releases = 0;
    defaultRegisterProcessExitHooks(() => { releases += 1; }, proc);
    emitter.emit('SIGTERM');
    expect(releases).toBe(1);
    expect(kills).toEqual(['SIGTERM']);
  });

  test('a host listener beside the reaper still keeps ownership of shutdown', () => {
    const emitter = new EventEmitter();
    const kills: string[] = [];
    const proc = Object.assign(emitter, {
      pid: 1,
      kill: (_pid: number, signal: string) => { kills.push(signal); return true; },
    }) as unknown as PowerExitProcess;
    emitter.on('SIGTERM', markSleepWatcherReaper(() => {}));
    emitter.on('SIGTERM', () => {});
    let releases = 0;
    defaultRegisterProcessExitHooks(() => { releases += 1; }, proc);
    emitter.emit('SIGTERM');
    expect(releases).toBe(0);
    expect(kills).toEqual([]);
  });
});

describe('forwarding keep-awake to an adopted daemon', () => {
  const connection = { baseUrl: 'http://127.0.0.1:1', token: 't' };

  test('an accepted request still reports what the daemon says keep-awake is doing', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ keepAwake: { enabled: true, held: false, state: 'refused' } }), { status: 200 })) as unknown as typeof fetch;
    try {
      const result = await postPowerKeepAwakeSet(connection, true);
      expect(result).toEqual({ ok: true, keepAwakeState: 'refused' });
    } finally {
      globalThis.fetch = original;
    }
  });

  test('an answer without a keep-awake state is still ok, with no state claimed', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    try {
      expect(await postPowerKeepAwakeSet(connection, true)).toEqual({ ok: true });
    } finally {
      globalThis.fetch = original;
    }
  });
});
