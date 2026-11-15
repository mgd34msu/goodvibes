import { expect, spyOn, test } from 'bun:test';
import { findCardNumberShapes } from '../platform/src/platform/security/card-shapes.ts';
import { ProcessManager, type BgCommandResult } from '../platform/src/platform/tools/shared/process-manager.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

// Luhn-valid on its own: a handle carrying it must still not read as card material.
const epoch = 1_700_000_000_004;

test('same-time allocations are distinct, addressable and never read as card numbers', async () => {
  const manager = new ProcessManager();
  const clock = spyOn(Date, 'now').mockReturnValue(epoch);
  try {
    const ids: string[] = [];
    for (let count = 1; count <= 12; count++) {
      const result = await manager.spawn('printf identifier', undefined, undefined);
      ids.push(result.process_id!);
    }
    expect(new Set(ids).size).toBe(12);
    for (const id of ids) {
      expect(findCardNumberShapes(`started ${id}`)).toEqual([]);
      expect(manager.getStatus(id)?.id).toBe(id);
      expect(manager.handleCommand(`bg_status ${id}`)?.success).toBe(true);
    }
  } finally { clock.mockRestore(); await manager.close(); }
});

test('owned allocation keeps its exact owner-bound identity', async () => {
  const manager = new ProcessManager();
  const owner = {};
  const otherOwner = {};
  let finish!: (result: BgCommandResult) => void;
  const completion = new Promise<BgCommandResult>((resolve) => { finish = resolve; });
  const output: BgCommandResult = { cmd: 'fixture', exit_code: null, stdout: 'owned output', stderr: '', success: true };
  let reads = 0;
  let stops = 0;
  const clock = spyOn(Date, 'now').mockReturnValue(epoch);
  try {
    const started = await manager.trackOwnedBoundary({ owner, cmd: 'fixture', started: Promise.resolve({ pid: 1234 }), completion,
      readOutput: async () => { reads++; return output; },
      stop: async () => { stops++; finish({ ...output, exit_code: 0 }); },
    });
    expect(started.process_id).toBe(`bg_owned_1_${epoch}`);
    const id = started.process_id!;
    expect(manager.hasBoundaryOwner(id)).toBe(true);
    const readsBefore = reads;
    for (const command of ['status', 'output', 'stop']) {
      expect(await manager.handleOwnedBoundaryCommand(`bg_${command} ${id}`, otherOwner)).toMatchObject({
        success: false, stdout: '', stderr: 'Unknown process in this execution authority',
      });
    }
    expect(reads).toBe(readsBefore);
    expect(stops).toBe(0);
    expect(await manager.handleOwnedBoundaryCommand(`bg_output ${id}`, owner)).toMatchObject({ success: true, stdout: 'owned output' });
    expect(await manager.handleOwnedBoundaryCommand(`bg_status ${id}`, owner)).toMatchObject({ success: true });
    expect(await manager.handleOwnedBoundaryCommand(`bg_stop ${id}`, owner)).toMatchObject({ success: true });
    expect(stops).toBe(1);
    expect(manager.getStatus(id)).toBeUndefined();
  } finally { clock.mockRestore(); finish({ ...output, exit_code: 0 }); await manager.close(); }
});
