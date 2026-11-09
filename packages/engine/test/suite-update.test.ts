/** Real temporary installation + synthetic release wire. Tests are authored
 * but intentionally UNRUN until the coding pass is complete. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applySuiteUpdate, installedSuiteNeedsRepair, rollbackSuiteUpdate } from '../sdk/src/platform/runtime/suite-update.js';
import { realUpdateFileIo } from '../sdk/src/platform/runtime/self-update.js';
import { suiteReleaseFixture } from './_helpers/suite-release-fixture.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const result = suiteReleaseFixture(); roots.push(result.root); return result; }

test('same-version repair selection detects mismatched peers without hashing installed programs on each check', async () => {
  const f = fixture();
  expect(installedSuiteNeedsRepair(f.options)).toBe(true);
  await applySuiteUpdate(f.options);
  const hash = spyOn(crypto, 'createHash');
  try {
    expect(installedSuiteNeedsRepair(f.options)).toBe(false);
    expect(installedSuiteNeedsRepair(f.options)).toBe(false);
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
  const peer = join(f.root, 'goodvibes-agent.readers.json');
  const value = JSON.parse(readFileSync(peer, 'utf8'));
  value.readers.formats = [];
  writeFileSync(peer, JSON.stringify(value));
  expect(installedSuiteNeedsRepair(f.options)).toBe(true);
});

test('updates all installed products, browser driver, WebUI and native companions, then rolls back the complete release', async () => {
  const f = fixture(), result = await applySuiteUpdate(f.options);
  expect([...result.programs].sort()).toEqual(['goodvibes', 'goodvibes-agent', 'goodvibes-daemon']);
  for (const program of f.programs) expect(readFileSync(join(f.root, program.name), 'utf8')).toBe(program.name + ' version 3.1.3');
  expect(readFileSync(join(f.driver, 'index.js'), 'utf8')).toBe('new driver'); expect(readFileSync(join(f.webui, 'index.html'), 'utf8')).toBe('New WebUI');
  // The selected configured path survives; its name is not a version proof
  // that authorizes another startup fetch or a second per-product updater.
  expect(result.directoryPaths).toContain(f.webui);
  expect(JSON.parse(readFileSync(join(f.webui, '.goodvibes-release.json'), 'utf8')).version).toBe('3.1.3');
  const rollback = rollbackSuiteUpdate({ ...f.options, currentVersion: '3.1.3' }); expect(rollback.version).toBe('3.1.2');
  for (const [path, bytes] of f.original) expect(readFileSync(path).equals(bytes)).toBe(true);
  for (const directory of [f.driver, f.webui]) expect(readFileSync(join(directory, 'original.txt'), 'utf8')).toBe('Retained original directory');
  expect(readdirSync(f.root).filter(name => name.endsWith('.update-transaction'))).toEqual([]);
});

test('a missing companion prevents every selected product and directory replacement', async () => {
  const f = fixture(); f.release.delete('sqlite-darwin-x64.dylib.json');
  await expect(applySuiteUpdate(f.options)).rejects.toThrow('missing');
  for (const [path, bytes] of f.original) expect(readFileSync(path).equals(bytes)).toBe(true);
  expect(readFileSync(join(f.driver, 'original.txt'), 'utf8')).toBe('Retained original directory');
});

test('a failed native product rename restores already-committed directory assets and every original product', async () => {
  const f = fixture(); let failed = false;
  const io = { ...realUpdateFileIo, rename(from: string, to: string) {
    if (!failed && from.endsWith('.update-download') && to === join(f.root, 'goodvibes-agent')) { failed = true; throw new Error('Synthetic live rename failure'); }
    realUpdateFileIo.rename(from, to);
  } };
  await expect(applySuiteUpdate({ ...f.options, io })).rejects.toThrow();
  for (const [path, bytes] of f.original) expect(readFileSync(path).equals(bytes)).toBe(true);
  for (const directory of [f.driver, f.webui]) expect(readFileSync(join(directory, 'original.txt'), 'utf8')).toBe('Retained original directory');
});

test('rollback refuses a directory from another release before changing any selected product', async () => {
  const f = fixture(); await applySuiteUpdate(f.options);
  writeFileSync(join(f.driver + '.previous', '.goodvibes-release.json'), JSON.stringify({ schema: 1, version: '3.0.0' }));
  expect(() => rollbackSuiteUpdate({ ...f.options, currentVersion: '3.1.3' })).toThrow('same release');
  for (const program of f.programs) expect(readFileSync(join(f.root, program.name), 'utf8')).toBe(program.name + ' version 3.1.3');
});
