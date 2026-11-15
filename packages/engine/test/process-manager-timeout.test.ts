/**
 * ProcessManager.spawn timeout + SIGKILL deadline + error surfacing
 *
 * Tests:
 * a) Normal short-lived process: exits cleanly, no killDeadline
 * b) spawn returns a process_id and pid
 * (The kill on timeout itself is covered in process-manager-kill-on-timeout.test.ts.)
 */
import { describe, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { tmpdir } from 'node:os';
import { waitFor } from './_helpers/test-timeout.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

// Background spawns read which environment variable names are credentials;
// the fake port reads none as one.
useToolReadings();

describe('ProcessManager.spawn', () => {
  test('returns process_id and pid', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo hello', tmpdir(), undefined, { timeout_ms: 5000 });
    expect(result.success).toBe(true);
    expect(typeof result.process_id).toBe('string');
    expect(result.process_id!.startsWith('bg_')).toBe(true);
    expect(typeof result.pid).toBe('number');
    expect(Number.isInteger(result.pid)).toBe(true);
    expect(result.pid).not.toBe(process.pid);
  });

  test('normal short-lived process: done=true, no killDeadline after completion', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('echo done', tmpdir(), undefined, { timeout_ms: 5000 });
    const id = result.process_id!;

    await waitFor(() => {
      const status = pm.getStatus(id);
      return status === undefined || status.done === true;
    });

    const status = pm.getStatus(id);
    // killDeadline should NOT have been set for a fast-exiting process
    expect(status?.killDeadline).toBeNull();
    expect(status?.done).toBe(true);
    expect(status?.exitCode).toBe(0);
  });

  test('large output is preserved in full on disk after the memory preview fills', async () => {
    const pm = new ProcessManager();
    let path: string | undefined;
    const expected = '🛰️'.repeat(90_000) + '\nLAST_OUTPUT_MARKER\n';
    try {
      const result = await pm.spawnArgv(process.execPath, ['-e', "process.stdout.write('🛰️'.repeat(90000) + '\\nLAST_OUTPUT_MARKER\\n')"], tmpdir(), undefined);
      await waitFor(() => pm.getStatus(result.process_id!)?.done === true);
      const status = pm.getStatus(result.process_id!)!;
      expect(status.exitCode).toBe(0);
      path = /complete output continues in ([^\n]+)\]/.exec(status.stdout.join(''))?.[1];
      expect(path).toBeDefined();
      expect(await readFile(path!, 'utf8')).toBe(expected);
    } finally {
      await pm.close();
      if (path) await rm(dirname(path), { recursive: true, force: true });
    }
  });

  test('bg_list and bg_status commands work', async () => {
    const pm = new ProcessManager();
    await pm.spawn('sleep 1', tmpdir(), undefined, { timeout_ms: 5000 });
    const listResult = pm.handleCommand('bg_list');
    expect(listResult).not.toBeNull();
    expect(listResult!.success).toBe(true);
    const list = JSON.parse(listResult!.stdout) as Array<{ id: string; status: string }>;
    expect(list.length).toBeGreaterThanOrEqual(1);

    const id = list[0]!.id;
    const statusResult = pm.handleCommand(`bg_status ${id}`);
    expect(statusResult).not.toBeNull();
    expect(statusResult!.success).toBe(true);

    // Clean up
    pm.stop(id);
  }, 5000);
});
