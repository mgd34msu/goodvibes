/** A project reached through a symlinked directory is observed like any other: the symlink is above the tree, not inside it. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentFileObservations } from '../../platform/src/platform/contract/current-file-observations.js';

test('a root below a symlinked ancestor yields one observation per requested file', () => {
  const base = mkdtempSync(join(tmpdir(), 'current-file-symlinked-root-'));
  try {
    const real = join(base, 'data', 'projects', 'app');
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, 'a.md'), 'first');
    mkdirSync(join(real, 'docs'));
    writeFileSync(join(real, 'docs', 'b.md'), 'second');
    symlinkSync(join(base, 'data', 'projects'), join(base, 'Projects'), 'dir');
    const observations = currentFileObservations(join(base, 'Projects', 'app'), ['a.md', 'docs/b.md'], { includeText: true });
    expect(observations).toMatchObject([
      { success: true, path: 'a.md', text: 'first' },
      { success: true, path: 'docs/b.md', text: 'second' },
    ]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});
