import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { makeProjectTempDir } from './_helpers/project-temp.ts';
import { sweepStaleTmpDirs } from '../toolchain/src/test-runner/temp.ts';

test('helper allocates unique directories under the runner-supplied root', () => {
  const root = process.env.GOODVIBES_TEST_TMP_ROOT;
  const first = makeProjectTempDir('project'); const second = makeProjectTempDir('project');
  expect(first).not.toBe(second); expect(basename(first)).toStartWith('project-'); expect(existsSync(first)).toBe(true);
  if (root) expect(dirname(first)).toBe(root);
});
test('helper refuses escaping prefixes before allocation', () => {
  for (const value of ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b', 'a\0b']) expect(() => makeProjectTempDir(value)).toThrow();
});
test('plain bun test (no runner root) falls back to a per-process os.tmpdir directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'raw-helper-proof-'));
  try {
    const helper = resolve(import.meta.dir, '_helpers/project-temp.ts');
    const env = { ...process.env }; delete env.GOODVIBES_TEST_TMP_ROOT;
    const result = Bun.spawnSync([process.execPath, '-e', `import {makeProjectTempDir} from ${JSON.stringify(helper)};require('node:fs').writeFileSync('child.json',JSON.stringify({d:makeProjectTempDir('raw')}))`], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
    expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
    const { d } = JSON.parse(readFileSync(join(root, 'child.json'), 'utf8')) as { d: string };
    expect(existsSync(d)).toBe(true);
    expect(dirname(dirname(d))).toBe(realpathSync(tmpdir())); expect(basename(dirname(d))).toStartWith('goodvibes-plaintest-');
    rmSync(dirname(d), { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('the sweep removes only old directories carrying its own prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-proof-'));
  try {
    const { mkdirSync } = require('node:fs') as typeof import('node:fs');
    for (const name of ['mine-old', 'mine-new', 'other-old']) mkdirSync(join(root, name));
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const name of ['mine-old', 'other-old']) utimesSync(join(root, name), old, old);
    sweepStaleTmpDirs(root, 'mine-');
    expect(existsSync(join(root, 'mine-old'))).toBe(false);
    expect(existsSync(join(root, 'mine-new'))).toBe(true);
    expect(existsSync(join(root, 'other-old'))).toBe(true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
