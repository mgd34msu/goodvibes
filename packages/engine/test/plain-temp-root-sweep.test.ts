import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLAIN_ROOT_OWNER_FILE, STALE_RUN_MS, plainRootOwnerAlive, sweepStaleTmpDirs } from '../toolchain/src/test-runner/temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('a plain-run temp root whose owner process is alive survives the sweep, one whose owner is gone does not', () => {
  const root = mkdtempSync(join(tmpdir(), 'plain-root-sweep-test-')); roots.push(root);
  const old = new Date(Date.now() - STALE_RUN_MS - 60_000);
  const make = (name: string, pid: string | undefined) => {
    const path = join(root, name); mkdirSync(path);
    if (pid !== undefined) writeFileSync(join(path, PLAIN_ROOT_OWNER_FILE), pid);
    utimesSync(path, old, old);
    return path;
  };
  const live = make('goodvibes-plaintest-live', String(process.pid));
  const gone = make('goodvibes-plaintest-gone', '2147483646');
  const unrecorded = make('goodvibes-plaintest-unrecorded', undefined);
  sweepStaleTmpDirs(root, 'goodvibes-plaintest-', STALE_RUN_MS, { preserve: plainRootOwnerAlive });
  expect(existsSync(live)).toBe(true);
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(unrecorded)).toBe(false);
});
