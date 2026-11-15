import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { readFileSync, rmSync } from 'node:fs';
import { basename } from 'node:path';
import { BookmarkManager, bookmarkFileSlug, isSavedFileForLabel } from '@goodvibes-jev/engine/platform/platform/bookmarks';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

describe('BookmarkManager.saveToFile name collisions', () => {
  let dir: string;
  let bm: BookmarkManager;

  beforeEach(() => {
    dir = makeProjectTempDir('gv-bm-collide');
    bm = new BookmarkManager(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every block saved under the same label, and under labels that slug the same', () => {
    const paths = [
      bm.saveToFile('first', 'Notes'),
      bm.saveToFile('second', 'Notes'),
      bm.saveToFile('third', 'notes!'),
    ];
    expect(new Set(paths).size).toBe(3);
    expect(paths.map((path) => readFileSync(path, 'utf-8'))).toEqual(['first', 'second', 'third']);
  });

  it('a file saved with a counter suffix is still found for its label', () => {
    bm.saveToFile('first', 'Notes');
    const second = basename(bm.saveToFile('second', 'Notes'));
    expect(isSavedFileForLabel(second, 'Notes')).toBe(true);
    expect(isSavedFileForLabel(second, 'Other')).toBe(false);
  });

  it('labels become short, safe file name parts', () => {
    expect(bookmarkFileSlug('My Label: With Spaces!')).toBe('my-label-with-spaces');
    expect(bookmarkFileSlug('!!!')).toBe('block');
    expect(bookmarkFileSlug('x'.repeat(80))).toHaveLength(40);
  });
});
