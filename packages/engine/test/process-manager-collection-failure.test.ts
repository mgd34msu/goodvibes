/** A group-owning process whose collection fails still reaches a finished state once its group is gone. */
import { expect, spyOn, test } from 'bun:test';
import { ProcessManager } from '../platform/src/platform/tools/shared/process-manager.js';
import { waitFor } from './_helpers/test-timeout.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

test('collection failure on an owned group does not leave the entry running forever', async () => {
  const manager = new ProcessManager();
  const realKill = process.kill.bind(process);
  let failed = false;
  const spy = spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (!failed && pid < 0 && signal === 0) {
      failed = true;
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
    }
    return realKill(pid, signal as never);
  }) as typeof process.kill);
  try {
    const child = await manager.spawnArgv(process.execPath, ['--no-env-file', '-e', 'setTimeout(() => {}, 50);'], '/tmp', undefined,
      { timeout_ms: 12_000, sigterm_grace_ms: 20 });
    const id = child.process_id!;
    await waitFor(() => failed);
    await waitFor(() => manager.list().find((row) => row.id === id)?.done === true);
    expect(manager.getStatus(id)).toMatchObject({ done: true });
  } finally { spy.mockRestore(); await manager.close(); }
});
