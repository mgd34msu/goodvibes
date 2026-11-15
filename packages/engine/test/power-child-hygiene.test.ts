/**
 * Sleep-watcher children: stdout is split into whole lines including a final
 * unterminated one, a broken pipe does not throw, and a tracked watcher is
 * stopped by its stop function and forgotten when it fails to spawn.
 */
import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { onStdoutLines, trackSleepWatcher } from '../platform/src/platform/power/child-hygiene.ts';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; kills: string[]; kill(signal: string): boolean; unref(): void };
  child.stdout = new PassThrough();
  child.kills = [];
  child.kill = (signal: string) => { child.kills.push(signal); return true; };
  child.unref = () => undefined;
  return child;
}

describe('onStdoutLines', () => {
  test('joins a line split across chunks and delivers a final line with no newline', async () => {
    const child = fakeChild();
    const lines: string[] = [];
    onStdoutLines(child as unknown as ChildProcess, (line) => lines.push(line));
    child.stdout.write('first li');
    child.stdout.write('ne\nsecond\nthi');
    child.stdout.end('rd');
    await new Promise<void>((resolve) => child.stdout.on('end', () => resolve()));
    expect(lines).toEqual(['first line', 'second', 'third']);
  });

  test('a stream error is absorbed and the partial line is dropped', () => {
    const child = fakeChild();
    const lines: string[] = [];
    onStdoutLines(child as unknown as ChildProcess, (line) => lines.push(line));
    child.stdout.write('half');
    expect(() => child.stdout.emit('error', new Error('EPIPE'))).not.toThrow();
    expect(lines).toEqual([]);
  });
});

describe('trackSleepWatcher', () => {
  test('the stop function terminates the child', () => {
    const child = fakeChild();
    const stop = trackSleepWatcher(child as unknown as ChildProcess, () => undefined);
    stop();
    expect(child.kills).toEqual(['SIGTERM']);
  });

  test('a spawn error is reported to the caller', () => {
    const child = fakeChild();
    const errors: string[] = [];
    trackSleepWatcher(child as unknown as ChildProcess, (error) => errors.push(error.message));
    child.emit('error', new Error('ENOENT'));
    expect(errors).toEqual(['ENOENT']);
  });
});

describe('signal handling with the power manager hooks', () => {
  /** A process stand-in whose kill re-delivers the signal, as the operating system does, until nothing handles it. */
  function fakeProcess() {
    const emitter = new EventEmitter();
    const state = { terminatedBy: undefined as string | undefined, raised: 0 };
    const proc = Object.assign(emitter, {
      pid: 1,
      kill(_pid: number, signal: string) {
        state.raised++;
        if (state.raised > 5) throw new Error('signal re-raised without end');
        if (emitter.listenerCount(signal) === 0) { state.terminatedBy = signal; return true; }
        emitter.emit(signal);
        return true;
      },
    });
    return { proc, state };
  }

  test.each(['reaper-first', 'manager-first'] as const)('a signal nobody else handles still ends the process (%s)', async (order) => {
    const { installSleepWatcherSignalReapers } = await import('../platform/src/platform/power/child-hygiene.ts');
    const { defaultRegisterProcessExitHooks } = await import('../platform/src/platform/power/manager.ts');
    const { proc, state } = fakeProcess();
    let cleanups = 0;
    const install = () => installSleepWatcherSignalReapers(proc as never);
    const register = () => defaultRegisterProcessExitHooks(() => { cleanups++; }, proc as never);
    if (order === 'reaper-first') { install(); register(); } else { register(); install(); }
    proc.emit('SIGTERM');
    expect(state.terminatedBy).toBe('SIGTERM');
    expect(cleanups).toBe(1);
  });

  test('a host that handles the signal keeps owning shutdown and the reaper stays installed', async () => {
    const { installSleepWatcherSignalReapers } = await import('../platform/src/platform/power/child-hygiene.ts');
    const { defaultRegisterProcessExitHooks } = await import('../platform/src/platform/power/manager.ts');
    const { proc, state } = fakeProcess();
    installSleepWatcherSignalReapers(proc as never);
    defaultRegisterProcessExitHooks(() => undefined, proc as never);
    let hostCalls = 0;
    proc.on('SIGTERM', () => { hostCalls++; });
    proc.emit('SIGTERM');
    proc.emit('SIGTERM');
    expect(hostCalls).toBe(2);
    expect(state.terminatedBy).toBeUndefined();
    expect(proc.listenerCount('SIGTERM')).toBeGreaterThanOrEqual(2);
  });
});
