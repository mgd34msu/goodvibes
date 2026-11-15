/**
 * The machine adapters of the Google connector: the subprocess port.
 */
import { describe, expect, test } from 'bun:test';
import { createProcessCommandPort } from '../platform/src/platform/google/node.ts';

describe('createProcessCommandPort', () => {
  const port = createProcessCommandPort();

  test('returns the output and exit code of a command that ran', async () => {
    const result = await port.run(process.execPath, ['-e', 'console.log("hello"); process.exit(3)']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.code).toBe(3);
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeNull();
  });

  test('passes the given environment to the command', async () => {
    const result = await port.run(process.execPath, ['-e', 'console.log(process.env.GV_PORT_TEST)'], { env: { GV_PORT_TEST: 'visible' } });
    expect(result.stdout.trim()).toBe('visible');
  });

  test('a command that does not exist is a spawn error, not a thrown exception', async () => {
    const result = await port.run('/definitely/not/a/real/binary', []);
    expect(result.code).toBeNull();
    expect(result.spawnError).not.toBeNull();
  });

  test('a command that outlives its timeout is killed and reported as timed out', async () => {
    const result = await port.run(process.execPath, ['-e', 'await new Promise(() => {})'], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
  });
});
