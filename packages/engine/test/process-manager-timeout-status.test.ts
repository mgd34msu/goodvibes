/**
 * A background process's status line names what actually ended it.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { describeProcessStatus, ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { tmpdir } from 'node:os';
import { waitFor } from './_helpers/test-timeout.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

describe('background process status after a timeout', () => {
  test('a process left running past its timeout that then exits on its own is not reported as killed', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 0.3', tmpdir(), undefined, { timeout_ms: 50, kill_on_timeout: false });
    const id = result.process_id!;
    await waitFor(() => pm.getStatus(id)?.done === true);
    const status = describeProcessStatus(pm.getStatus(id)!);
    expect(status).not.toContain('SIGKILL');
    expect(status).toContain('exit 0');
  });

  test('a process ended by its timeout still reads as timed out', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn('sleep 10', tmpdir(), undefined, { timeout_ms: 50, sigterm_grace_ms: 30 });
    const id = result.process_id!;
    await waitFor(() => pm.getStatus(id)?.done === true);
    expect(describeProcessStatus(pm.getStatus(id)!)).toStartWith('timed out');
  });
});

describe('background output spill file', () => {
  test('is removed once the process record is stopped and dropped', async () => {
    const pm = new ProcessManager();
    const result = await pm.spawn("head -c 300000 /dev/zero | tr '\\0' a", tmpdir(), undefined, {});
    const id = result.process_id!;
    await waitFor(() => pm.getStatus(id)?.done === true);
    const path = /complete output continues in (\S+)\]/.exec(pm.getOutput(id)!.stdout)?.[1];
    expect(path).toBeDefined();
    expect(existsSync(path!)).toBe(true);
    expect(pm.stop(id)).toBe(true);
    await waitFor(() => !existsSync(path!)).catch(() => undefined);
    expect(existsSync(path!)).toBe(false);
  });
});
