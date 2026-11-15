import { expect, test } from 'bun:test';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('bg_stop answers "Stopped" only after the process has actually ended, and a second stop says it is unknown', async () => {
  const manager = new ProcessManager();
  try {
    const started = await manager.spawn('sleep 300', undefined, undefined);
    const id = started.process_id!;
    const pid = started.pid!;
    expect(alive(pid)).toBe(true);
    const stopped = await manager.handleCommandAsync(`bg_stop ${id}`);
    expect(stopped).toMatchObject({ success: true, stdout: `Stopped ${id}` });
    expect(alive(pid)).toBe(false);
    expect(await manager.handleCommandAsync(`bg_stop ${id}`)).toMatchObject({ success: false, stderr: `Unknown process: ${id}` });
    expect(manager.handleCommand('bg_list')?.success).toBe(true);
  } finally { await manager.close(); }
});
