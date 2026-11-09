/** Native host regressions, authored and UNRUN during coding first. */
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedLatestRelease, probeVersionLine, resolveSelfDirectory } from '../sdk/src/platform/runtime/reachability-check.ts';
test('a failed version process printing our banner remains unidentified', () => {
  const root = mkdtempSync(join(tmpdir(), 'reachability-failed-version-'));
  try {
    const path = join(root, 'goodvibes');
    writeFileSync(path, '#!/bin/sh\nprintf "goodvibes 2.0.25\\n"; exit 7\n', { mode: 0o755 });
    expect(probeVersionLine(path)).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('a broken unrelated PATH alias does not prevent identifying the running executable', () => {
  expect(resolveSelfDirectory({ execPath: '/home/owner/bin/goodvibes', command: 'goodvibes', pathEntries: ['/broken', '/home/owner/bin'],
    isExecutableFile: () => true, realPath: path => { if (path.startsWith('/broken/')) throw Error('unresolved'); return path; },
  })).toBe('/home/owner/bin');
});
test('completed and rejected release lookups remove their outstanding startup timeout', async () => {
  const cleared = spyOn(globalThis, 'clearTimeout');
  try {
    await expect(boundedLatestRelease(async () => '3.1.2', 60_000)).resolves.toBe('3.1.2');
    await expect(boundedLatestRelease(async () => { throw Error('offline'); }, 60_000)).resolves.toBeUndefined();
    expect(cleared).toHaveBeenCalledTimes(2);
  } finally { cleared.mockRestore(); }
});
