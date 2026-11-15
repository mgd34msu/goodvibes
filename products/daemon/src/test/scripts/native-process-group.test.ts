import { expect, spyOn, test } from 'bun:test';
import { drainNativeProcessGroup, spawnNativeProcessGroup } from '../../../scripts/native-execution-process.mjs';

test('a reaped leader\'s group is signalled once, at its exit, and never again by the final drain', async () => {
  const child = spawnNativeProcessGroup(process.execPath, ['-e', ''], { stdio: ['ignore', 'ignore', 'ignore'] });
  const closed = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('close', () => resolve()); });
  const pid = child.pid as number;
  const kills: Array<[number, unknown]> = [];
  const real = process.kill.bind(process);
  const spy = spyOn(process, 'kill').mockImplementation(((target: number, signal?: string | number) => {
    // Only the owned group is observed and intercepted; the pid may already belong to another process by now.
    if (target === -pid) { kills.push([target, signal]); if (signal === 0) { const error = new Error('gone') as NodeJS.ErrnoException; error.code = 'ESRCH'; throw error; } return true; }
    return real(target, signal as never);
  }) as typeof process.kill);
  try {
    await closed;
    await drainNativeProcessGroup(child, closed);
  } finally { spy.mockRestore(); }
  const delivered = kills.filter(([, signal]) => signal !== 0);
  expect(delivered).toEqual([[-pid, 'SIGKILL']]);
});
