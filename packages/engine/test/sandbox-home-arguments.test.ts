/**
 * A sandboxed command's path arguments never bind part of the home directory
 * the boundary hides: not a key file named directly, and not a link outside
 * home that leads into it. A path outside home is still bound so the program
 * can read it, and a path in the workspace needs no extra binding.
 *
 * The real launch-plan path selection over a temp tree standing for home,
 * workspace and an outside data directory.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { programReadOnlyPaths } from '../platform/src/platform/runtime/sandbox/backend.js';

let root: string;
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-sandbox-home-'))); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

test('arguments inside home, or linking into it, are not bound; an outside path is', () => {
  const home = join(root, 'home');
  const workspace = join(home, 'project');
  const keyFile = join(home, '.ssh', 'id_rsa');
  const outside = join(root, 'data');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(keyFile, 'private');
  writeFileSync(join(workspace, 'script.sh'), 'echo hi');
  writeFileSync(join(outside, 'input.txt'), 'data');
  symlinkSync(join(home, '.ssh'), join(root, 'keys'));

  const bound = programReadOnlyPaths('/bin/sh', [
    keyFile, join(root, 'keys'), join(workspace, 'script.sh'), join(outside, 'input.txt'),
  ], workspace, home);

  expect(bound).toEqual([outside]);
});
