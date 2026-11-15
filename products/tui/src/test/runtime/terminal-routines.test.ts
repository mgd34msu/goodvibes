/**
 * With the daemon off, routines run in exactly one terminal: the one holding the
 * routine lock. A second runner over the same store never starts its manager
 * (a routine would otherwise run once per open terminal), and takes over once
 * the holder lets go.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRoutineRunner } from '../../runtime/terminal-routines.ts';

function countingManager() {
  const counts = { starts: 0, stops: 0 };
  return { counts, manager: { start: async () => { counts.starts += 1; }, stop: () => { counts.stops += 1; } } };
}

describe('local routine runner (daemon off)', () => {
  test('two runners over one store: one manager runs; the other takes over after release', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gv-routines-'));
    const lockPath = join(dir, 'automation-jobs.json.writer.sqlite');
    const first = countingManager();
    const second = countingManager();
    const a = new LocalRoutineRunner(first.manager, lockPath);
    const b = new LocalRoutineRunner(second.manager, lockPath);
    try {
      expect(await a.ensure()).toBe(true);
      expect(await b.ensure()).toBe(false);
      expect(first.counts.starts).toBe(1);
      expect(second.counts.starts).toBe(0);

      a.release();
      expect(first.counts.stops).toBe(1);
      expect(await b.ensure()).toBe(true);
      expect(second.counts.starts).toBe(1);
    } finally {
      a.release();
      b.release();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
