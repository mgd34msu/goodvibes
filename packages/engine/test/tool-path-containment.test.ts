// Proves: A link, a dangling link or a .. path takes the read, write or edit tool outside the project root while the gate calls it inside.
// Red when: The tools' path check stops following a path to where it really leads, so a link, a dangling link or a directory link inside the project reads, changes or creates a file outside the root.
/**
 * The gate reads a path as written, so `link.txt` inside the project counts as
 * inside the allowed directories. What makes that true on disk is the tools'
 * own path check (utils/path-safety.ts): the real read, write and edit tools
 * on a temp project with a file outside it. A link that stays inside works.
 */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import { FileStateCache } from '../platform/src/platform/state/file-cache.ts';
import { ReadTool } from '../platform/src/platform/tools/read/index.ts';
import { createWriteTool } from '../platform/src/platform/tools/write/index.ts';
import { createEditTool } from '../platform/src/platform/tools/edit/core.ts';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-path-containment-')));
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

test('no link, dangling link or .. path reads, changes or creates a file outside the root; a link inside works', async () => {
  const project = join(root, 'project');
  mkdirSync(project);
  const outside = join(root, 'outside.txt');
  const OUTSIDE = 'OUTSIDE_SECRET_9d1e\n';
  writeFileSync(outside, OUTSIDE);
  writeFileSync(join(project, 'inside.txt'), 'INSIDE_TEXT\n');
  symlinkSync(outside, join(project, 'link.txt'));
  symlinkSync(join(root, 'created-outside.txt'), join(project, 'dangling.txt'));
  symlinkSync(root, join(project, 'up'));
  symlinkSync(join(project, 'inside.txt'), join(project, 'inside-link.txt'));

  const fileCache = new FileStateCache();
  const read = new ReadTool(new ProjectIndex(project), fileCache);
  const write = createWriteTool({ projectRoot: project, fileCache });
  const edit = createEditTool(fileCache, { cwd: project });
  const escapes = ['link.txt', '../outside.txt', 'up/outside.txt'];

  for (const path of escapes) {
    const result = await read.execute({ files: [{ path }] });
    expect(`read ${path}: ${String(result.output ?? '')}${result.error ?? ''}`).not.toContain('OUTSIDE_SECRET');
    await edit.execute({ edits: [{ path, find: 'OUTSIDE_SECRET_9d1e', replace: 'EDITED' }] });
  }
  for (const path of [...escapes, 'dangling.txt']) await write.execute({ files: [{ path, content: 'WRITTEN', mode: 'overwrite' }] });
  expect(readFileSync(outside, 'utf8')).toBe(OUTSIDE);
  expect(existsSync(join(root, 'created-outside.txt'))).toBe(false);

  // The control: a link that stays inside reads and writes.
  expect(String((await read.execute({ files: [{ path: 'inside-link.txt' }] })).output)).toContain('INSIDE_TEXT');
  expect((await write.execute({ files: [{ path: 'inside-link.txt', content: 'REWRITTEN\n', mode: 'overwrite' }] })).success).toBe(true);
  expect(readFileSync(join(project, 'inside.txt'), 'utf8')).toBe('REWRITTEN\n');
});
