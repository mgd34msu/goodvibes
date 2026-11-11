import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  reserveLaunchdHandover, runLaunchdHandoverWorker,
  type LaunchdHandoverDependencies, type LaunchdHandoverInput,
} from '../platform/src/platform/daemon/launchd-handover.ts';

const roots: string[] = [];
const drains: Array<() => Promise<void>> = [];
const uid = process.getuid!();
const label = 'sh.goodvibes.daemon';
const target = `gui/${uid}/${label}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function temp(): string {
  const path = mkdtempSync(join(realpathSync('/tmp'), 'gv-handover-test-'));
  chmodSync(path, 0o700); roots.push(path); return path;
}
afterEach(async () => {
  for (const drain of drains.splice(0).reverse()) await drain();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function lines(socket: Socket) {
  let pending = '';
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  socket.setEncoding('utf8');
  socket.on('data', (data: string) => {
    pending += data;
    while (pending.includes('\n')) {
      const index = pending.indexOf('\n'); queue.push(pending.slice(0, index)); pending = pending.slice(index + 1);
    }
    wake?.();
  });
  return async () => {
    while (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
    wake = undefined; return queue.shift()!;
  };
}
async function rawWorker(dependencies: LaunchdHandoverDependencies, timeoutMs = 1_000) {
  const root = temp();
  const connected = deferred<Socket>();
  const server = createServer(socket => connected.resolve(socket));
  await new Promise<void>(resolve => server.listen(join(root, 'control.sock'), resolve));
  const controller = new AbortController();
  const task = runLaunchdHandoverWorker([root, 'sh.goodvibes.handover.fixture', target, '123456', String(timeoutMs)], controller.signal, dependencies);
  void task.catch(() => undefined);
  const socket = await connected.promise;
  const next = lines(socket);
  drains.push(async () => {
    controller.abort(new Error('test cleanup')); socket.destroy(); await task.catch(() => undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  expect(await next()).toBe('READY');
  return { root, socket, next, task, controller };
}
function input(timeoutMs = 1_000): LaunchdHandoverInput {
  return { serviceName: label, servicePath: '/tmp/goodvibes-owned-service.plist', executablePath: '/tmp/goodvibes-owned-daemon',
    uid, pid: process.pid, timeoutMs, assertServiceCurrent() {} };
}
function admittedFixture() {
  let worker: Promise<number> | undefined;
  const controller = new AbortController();
  const commands: string[][] = [];
  let directory: string | undefined;
  const dependencies: LaunchdHandoverDependencies = {
    async command(args) {
      commands.push([...args]);
      if (args[0] === 'bootstrap') {
        const plist = readFileSync(args[2]!, 'utf8');
        const array = /<array>(.*?)<\/array>/.exec(plist)![1]!;
        const argv = [...array.matchAll(/<string>(.*?)<\/string>/g)].map(match => match[1]!);
        directory = argv[2]!;
        expect(plist).toContain('<key>LaunchOnlyOnce</key><true/>');
        expect(plist).toContain('<key>KeepAlive</key><false/>');
        expect(argv[0]).toBe(input().executablePath);
        worker = runLaunchdHandoverWorker(argv.slice(2), controller.signal, dependencies);
        void worker.catch(() => undefined);
      } else if (args[0] === 'bootout') {
        controller.abort(new Error('owned launchd helper retired'));
        await worker?.catch(() => undefined);
      }
    },
    async query(serviceName) { return serviceName === label ? { loaded: true, pid: process.pid } : { loaded: false }; },
  };
  drains.push(async () => { controller.abort(new Error('test cleanup')); await worker?.catch(() => undefined); });
  return { dependencies, commands, directory: () => directory, worker: () => worker };
}

describe('launchd handover (real local IPC; synthetic manager observations)', () => {
  test('manager callback success without an actual READY worker is never admission', async () => {
    const commands: string[][] = [];
    let directory = '';
    await expect(reserveLaunchdHandover(input(10), undefined, {
      async command(args) { commands.push([...args]); if (args[0] === 'bootstrap') directory = join(args[2]!, '..'); },
      async query() { return { loaded: false }; },
    })).rejects.toThrow('worker could not be confirmed');
    expect(commands.map(command => command[0])).toEqual(['bootstrap', 'bootout']);
    expect(existsSync(directory)).toBe(false);
  });

  test('reservation observes a real helper; accepted commit keeps the old parent socket open', async () => {
    const fixture = admittedFixture();
    const lease = await reserveLaunchdHandover(input(), undefined, fixture.dependencies);
    drains.push(() => lease.cancel());
    lease.assertCurrent();
    expect(lease.exitRequired).toBe(true);
    expect((await lease.commit()).status).toBe('accepted');
    expect(fixture.commands.some(command => command[0] === 'kickstart')).toBe(false);
    await lease.cancel();
    expect(fixture.commands.some(command => command[0] === 'kickstart')).toBe(false);
    expect(existsSync(fixture.directory()!)).toBe(false);
  });

  test('cancel joins one retirement and awaits the owned worker before returning', async () => {
    const fixture = admittedFixture();
    const lease = await reserveLaunchdHandover(input(), undefined, fixture.dependencies);
    const first = lease.cancel();
    expect(lease.cancel()).toBe(first);
    await first;
    await fixture.worker()?.catch(() => undefined);
    expect(fixture.commands.filter(command => command[0] === 'bootout')).toHaveLength(1);
    expect(existsSync(fixture.directory()!)).toBe(false);
  });

  test('late bootout not-found is tolerated only after observing exact helper absence', async () => {
    const fixture = admittedFixture();
    const command = fixture.dependencies.command!;
    const lease = await reserveLaunchdHandover(input(), undefined, {
      ...fixture.dependencies,
      async command(args, timeout, signal) {
        await command(args, timeout, signal);
        if (args[0] === 'bootout') throw new Error('already removed');
      },
    });
    await lease.cancel();
    expect(existsSync(fixture.directory()!)).toBe(false);
  });

  test('uncommitted parent EOF cannot enqueue a replacement', async () => {
    const commands: string[][] = [];
    const fixture = await rawWorker({ async command(args) { commands.push([...args]); }, async query() { throw new Error('no query expected'); } });
    fixture.socket.end();
    expect(await fixture.task).toBe(0);
    expect(commands).toEqual([]);
    expect(existsSync(fixture.root)).toBe(false);
  });

  test('ARMED EOF waits for the original loaded PID to retire, then no-k kickstart and command drain', async () => {
    const observedOriginal = deferred<void>();
    const retired = deferred<void>();
    const commandEntered = deferred<void>();
    const commandDrained = deferred<void>();
    const commands: string[][] = [];
    let queries = 0;
    const fixture = await rawWorker({
      async query(serviceName) {
        expect(serviceName).toBe(label);
        if (++queries === 1) { observedOriginal.resolve(); return { loaded: true, pid: 123456 }; }
        await retired.promise; return { loaded: true };
      },
      async command(args) { commands.push([...args]); commandEntered.resolve(); await commandDrained.promise; },
    });
    fixture.socket.write('COMMIT\n'); expect(await fixture.next()).toBe('ARMED');
    fixture.socket.end();
    await observedOriginal.promise;
    expect(commands).toEqual([]);
    retired.resolve(); await commandEntered.promise;
    expect(commands).toEqual([['kickstart', target]]);
    let finished = false; void fixture.task.then(() => { finished = true; });
    await Promise.resolve(); expect(finished).toBe(false);
    commandDrained.resolve(); expect(await fixture.task).toBe(0);
  });

  test('a separately started replacement is preserved and never receives -k or a PID kill', async () => {
    const commands: string[][] = [];
    const fixture = await rawWorker({ async query() { return { loaded: true, pid: 654321 }; }, async command(args) { commands.push([...args]); } });
    fixture.socket.write('COMMIT\n'); expect(await fixture.next()).toBe('ARMED'); fixture.socket.end();
    expect(await fixture.task).toBe(0);
    expect(commands).toEqual([['kickstart', target]]);
  });

  test('a removed canonical job is refused after parent exit', async () => {
    let commands = 0;
    const fixture = await rawWorker({ async query() { return { loaded: false }; }, async command() { commands++; } });
    fixture.socket.write('COMMIT\n'); expect(await fixture.next()).toBe('ARMED'); fixture.socket.end();
    await expect(fixture.task).rejects.toThrow('worker could not be confirmed');
    expect(commands).toBe(0);
  });

  test('CANCEL after ARMED suppresses even a subsequent parent EOF', async () => {
    let commands = 0;
    const fixture = await rawWorker({ async query() { throw new Error('no query expected'); }, async command() { commands++; } });
    fixture.socket.write('COMMIT\n'); expect(await fixture.next()).toBe('ARMED');
    fixture.socket.write('CANCEL\n'); expect(await fixture.next()).toBe('CANCELLED'); fixture.socket.end();
    expect(await fixture.task).toBe(0); expect(commands).toBe(0);
  });

  test('original cancellation propagates while the old PID is still live and drains IPC', async () => {
    const observed = deferred<void>();
    const fixture = await rawWorker({ async query() { observed.resolve(); return { loaded: true, pid: 123456 }; }, async command() { throw new Error('must not enqueue'); } });
    fixture.socket.write('COMMIT\n'); expect(await fixture.next()).toBe('ARMED'); fixture.socket.end();
    await observed.promise;
    const reason = new Error('original owned cancellation'); fixture.controller.abort(reason);
    await expect(fixture.task).rejects.toBe(reason);
    expect(existsSync(fixture.root)).toBe(false);
  });

  test('pre-aborted worker never attaches or starts a manager command', async () => {
    const controller = new AbortController(); const reason = new Error('before attachment'); controller.abort(reason);
    const root = temp();
    await expect(runLaunchdHandoverWorker([root, 'sh.goodvibes.handover.fixture', target, '123456', '1000'], controller.signal, {
      async query() { throw new Error('must not query'); }, async command() { throw new Error('must not invoke'); },
    })).rejects.toBe(reason);
  });
});
