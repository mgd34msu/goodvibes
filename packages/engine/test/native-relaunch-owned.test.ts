import { expect, spyOn, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import { restartOntoUpdatedBinary, restartOntoUpdatedBinaryAsync } from '../terminal-shell/src/service-io.js';

test('a sync relaunch without an observed exit status is failure', () => {
  expect(restartOntoUpdatedBinary({ execPath: '/owned/program', argv: ['serve'], env: {}, fromVersion: '3.1.2', spawn: () => null }, 'RESTARTED_FROM')).toBe(1);
});

test('owned relaunch abort kills the original child and waits for its actual close', async () => {
  const child = new ChildProcess(), controller = new AbortController(), reason = new Error('Owner cancelled');
  const kill = spyOn(child, 'kill').mockReturnValue(true);
  const argv = ['serve', '--port', '12345'], env = { ORIGINAL: 'unchanged' }; let completed = false;
  const task = restartOntoUpdatedBinaryAsync({ execPath: '/owned/program', argv, env, fromVersion: '3.1.2', signal: controller.signal,
    spawn(path, args, selected) { expect(path).toBe('/owned/program'); expect(args).toEqual(argv); expect(selected).toEqual({ ORIGINAL: 'unchanged', RESTARTED_FROM: '3.1.2' }); return child; } }, 'RESTARTED_FROM');
  const observed = task.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })).finally(() => { completed = true; });
  try {
    controller.abort(reason);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await Promise.resolve(); expect(completed).toBe(false);
    child.emit('close', null, 'SIGTERM');
    const result = await observed; expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Cancelled child was reported successful');
    expect(result.error).toBe(reason);
  } finally { child.emit('close', null, 'SIGTERM'); await observed; kill.mockRestore(); }
});

test('owned relaunch reports real replacement status and refuses pre-aborted admission', async () => {
  const child = new ChildProcess(), controller = new AbortController();
  const running = restartOntoUpdatedBinaryAsync({ execPath: '/owned/program', argv: [], env: {}, fromVersion: '3.1.2', signal: controller.signal, spawn: () => child }, 'FROM');
  child.emit('close', 7, null); expect(await running).toBe(7);
  controller.abort(); let starts = 0;
  await expect(restartOntoUpdatedBinaryAsync({ execPath: '/owned/program', argv: [], env: {}, fromVersion: '3.1.2', signal: controller.signal,
    spawn() { starts++; return new ChildProcess(); } }, 'FROM')).rejects.toBeDefined();
  expect(starts).toBe(0);
});
