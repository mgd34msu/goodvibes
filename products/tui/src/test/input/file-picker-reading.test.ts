import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FilePickerModal } from '../../input/file-picker.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const pickers: FilePickerModal[] = [];
afterEach(() => { for (const picker of pickers.splice(0)) picker.close(); });
function fixture() {
  const root = makeProjectTempDir('gv-file-picker-reading');
  for (const path of ['node_modules', 'target', '.hidden', 'dist', 'src']) mkdirSync(join(root, path), { recursive: true });
  for (const path of ['node_modules/dependency.ts', 'target/generated.ts', '.hidden/private.ts', 'dist/bundle.js', 'src/app.ts', 'README.md', '.dotfile']) writeFileSync(join(root, path), 'fixture');
  const paths = { workingDirectory: root };
  const picker = new FilePickerModal(paths); pickers.push(picker);
  return { root, paths, picker };
}
function open(picker: FilePickerModal): Promise<void> {
  return new Promise(resolve => { picker.setOnUpdate(resolve); picker.open(4, true); });
}

describe('file picker listing', () => {
  test('lists what the find and grep walks search: the fixed skip names and hidden entries are left out', async () => {
    const f = fixture(); await open(f.picker);
    expect(f.picker.allFiles).toEqual(['README.md', 'src/', 'src/app.ts', 'target/', 'target/generated.ts']);
    f.picker.setQuery('s/a'); expect(f.picker.results).toEqual(['src/app.ts']);
    expect(f.picker.getSelected()).toBe('src/app.ts');
    expect(f.picker.insertPos).toBe(4); expect(f.picker.injectMode).toBe(true);
  });

  test('directory names never exclude ordinary files', async () => {
    const root = makeProjectTempDir('gv-file-picker-names');
    writeFileSync(join(root, 'node_modules'), 'authored'); writeFileSync(join(root, 'dist'), 'authored');
    const picker = new FilePickerModal({ workingDirectory: root }); pickers.push(picker); await open(picker);
    expect(picker.results).toEqual(['dist', 'node_modules']);
  });

  test('close revokes the pending list so it never lands in the UI or cache', async () => {
    const f = fixture();
    // One handler for the whole test: a later open() must not replace the counter.
    const seen: string[][] = []; let next: (() => void) | undefined;
    f.picker.setOnUpdate(() => { seen.push([...f.picker.results]); next?.(); });
    f.picker.open(0); f.picker.close();
    const other = makeProjectTempDir('gv-file-picker-fresh'); writeFileSync(join(other, 'fresh.ts'), 'fresh'); f.paths.workingDirectory = other;
    const second = new Promise<void>(resolve => { next = resolve; });
    f.picker.open(0, true); await second;
    expect(seen).toEqual([['fresh.ts']]);
    expect(f.picker.allFiles).not.toContain('target/generated.ts');
  });

  test('changing the working directory revokes the pending list of the old root', async () => {
    const f = fixture(); let updates = 0;
    f.picker.setOnUpdate(() => updates++);
    f.picker.open(0);
    f.paths.workingDirectory = makeProjectTempDir('gv-file-picker-other');
    // Nothing reopens the picker, so the first load runs to its end; it is finished when the picker drops its handle.
    while ((f.picker as unknown as { loading: unknown }).loading) await new Promise<void>(resolve => setImmediate(resolve));
    expect(updates).toBe(0);
    expect(f.picker.results).toEqual([]); expect(f.picker.allFiles).toEqual([]);
    expect(f.picker.loadError).toBeUndefined();
  });

  test('the open picker reloads after the cache is invalidated', async () => {
    const f = fixture(); await open(f.picker);
    writeFileSync(join(f.root, 'added.ts'), 'new');
    // The first notification only clears the list; the second carries the reloaded files.
    let updates = 0;
    const reloaded = new Promise<void>(resolve => f.picker.setOnUpdate(() => { if (++updates === 2) resolve(); }));
    f.picker.invalidateCache(); expect(f.picker.results).toEqual([]);
    await reloaded;
    expect(f.picker.loadError).toBeUndefined(); expect(f.picker.results).toContain('added.ts');
  });
});
