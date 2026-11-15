import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { FileWatcher } from '../platform/src/platform/state/file-watcher.ts';
import { ProjectIndex } from '../platform/src/platform/state/project-index.ts';
import type { FileStateCache } from '../platform/src/platform/state/file-cache.ts';

/**
 * What the watcher does with one settled change. The change handler is driven
 * directly (the OS event and its debounce are not what is under test).
 */
interface Handlers {
  _handleChange(path: string): void;
  retryMissingPaths(): void;
  watchers: Map<string, unknown>;
}

let root: string;
let index: ProjectIndex;
let invalidated: string[];
let watcher: FileWatcher;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'gv-watcher-index-'));
  invalidated = [];
  index = new ProjectIndex(root);
  await index.load();
  watcher = new FileWatcher({ invalidate: (path: string) => invalidated.push(path) } as unknown as FileStateCache, index, { projectRoot: root });
});

afterEach(async () => {
  watcher.stop();
  await index.dispose();
  rmSync(root, { recursive: true, force: true });
});

const internals = (): Handlers => watcher as unknown as Handlers;

test('a deleted file leaves the index instead of being re-added empty', () => {
  const file = join(root, 'tracked.ts');
  writeFileSync(file, 'export {};\n');
  index.upsertFile(file, 3);
  internals()._handleChange(file);
  expect(index.getFile('tracked.ts')?.tokens).toBeGreaterThan(0);

  unlinkSync(file);
  internals()._handleChange(file);
  expect(index.getFile('tracked.ts')).toBeNull();
  expect(invalidated).toEqual([file, file]);
});

test('the index\'s own files do not feed back into the index', () => {
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  for (const name of ['project-index.json', 'project-index.json.4242.tmp']) internals()._handleChange(join(root, '.goodvibes', name));
  expect(index.getFiles()).toEqual([]);
  expect(invalidated).toEqual([]);
});

test('platform state under .goodvibes invalidates caches but is not indexed as project content', () => {
  mkdirSync(join(root, '.goodvibes'), { recursive: true });
  const config = join(root, '.goodvibes', 'config.json');
  writeFileSync(config, '{}');
  internals()._handleChange(config);
  expect(invalidated).toEqual([config]);
  expect(index.getFiles()).toEqual([]);
});

test('a path that did not exist when added is watched once it appears', async () => {
  await watcher.start();
  const platformDir = join(root, '.goodvibes');
  expect(internals().watchers.has(platformDir)).toBe(false);
  mkdirSync(platformDir);
  expect(existsSync(platformDir)).toBe(true);
  internals().retryMissingPaths();
  expect(internals().watchers.has(platformDir)).toBe(true);
});
