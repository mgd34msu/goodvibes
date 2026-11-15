import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FILE_WATCHER_MAX_PATHS, FileWatcher } from '../platform/src/platform/state/file-watcher.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';

/**
 * What the watcher does with one settled change. The change handler is driven
 * directly (the OS event and its debounce are not what is under test).
 */
interface Handlers {
  _handleChange(path: string): void;
}

let root: string;
let index: ProjectIndex;
let watcher: FileWatcher;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gv-watcher-index-'));
  index = new ProjectIndex(root);
  await index.load();
  watcher = new FileWatcher(index, { projectRoot: root });
});

afterEach(async () => {
  watcher.stop();
  await index.dispose();
  rmSync(root, { recursive: true, force: true });
});

const internals = (): Handlers => watcher as unknown as Handlers;

test('a file deleted outside the write tool leaves the project index', async () => {
  const file = join(root, 'tracked.ts');
  writeFileSync(file, 'export {};\n');
  index.upsertFile(file, 3);
  await watcher.start();
  internals()._handleChange(file);
  expect(index.getFile('tracked.ts')?.tokens).toBeGreaterThan(0);

  unlinkSync(file);
  internals()._handleChange(file);
  expect(index.getFile('tracked.ts')).toBeNull();
});

test('platform state under .goodvibes is neither watched nor indexed', async () => {
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const config = join(root, '.goodvibes', 'config.json');
  writeFileSync(config, '{}');
  await watcher.start();
  watcher.addPath(config);
  internals()._handleChange(config);
  expect(watcher.getWatchedPaths().has(config)).toBe(false);
  expect(index.getFiles()).toEqual([]);
});

test('the watch cap holds on every add, not only at start', () => {
  for (let i = 0; i < FILE_WATCHER_MAX_PATHS + 100; i++) watcher.addPath(join(root, `f${i}.ts`));
  expect(watcher.getWatchedPaths().size).toBe(FILE_WATCHER_MAX_PATHS);
});
