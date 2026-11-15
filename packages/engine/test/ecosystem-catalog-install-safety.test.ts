/**
 * ecosystem-catalog-install-safety.test.ts
 *
 * The curated catalog installs by copying a source directory under the install
 * root, named by the entry id. Pins that an id is one plain path segment, that
 * a receipt or backup pointing outside the install root is never followed, that
 * a failed copy leaves the previous install in place and returns a result
 * instead of throwing, and that a bundle import merges rather than replaces.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  importEcosystemCatalogBundle,
  inspectEcosystemCatalogBundle,
  installEcosystemCatalogEntry,
  loadEcosystemCatalog,
  rollbackInstalledEcosystemEntry,
  uninstallEcosystemCatalogEntry,
  upsertEcosystemCatalogEntry,
  type EcosystemCatalogBundle,
  type EcosystemCatalogEntry,
} from '../platform/src/platform/runtime/ecosystem/catalog.ts';
import { makeProjectTempDir } from './_helpers/project-temp.ts';

function skill(id: string, name: string, source: string): EcosystemCatalogEntry {
  return { id, kind: 'skill', name, summary: `${name} summary`, source, tags: [] };
}

let root: string;
let options: { cwd: string; homeDir: string };

beforeEach(() => {
  root = makeProjectTempDir('eco-install-');
  options = { cwd: root, homeDir: join(root, 'home') };
  mkdirSync(options.homeDir, { recursive: true });
});

function makeSource(name: string, files: Record<string, string> = { 'SKILL.md': 'v1' }): string {
  const dir = join(root, 'src', name);
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return `./src/${name}`;
}

describe('entry ids are one plain path segment', () => {
  test('upsert refuses an id that climbs out of the install root', () => {
    for (const id of ['..', '../x', 'a/b', '.hidden', '', 'a b']) {
      const result = upsertEcosystemCatalogEntry(skill(id, 'Bad', './src/none'), options);
      expect(result.ok).toBe(false);
    }
    expect(loadEcosystemCatalog('skill', options)).toEqual([]);
  });

  test('a catalog file that names a ".." id is never offered, and installing it deletes nothing', () => {
    const sentinel = join(root, '.goodvibes', 'keep.txt');
    mkdirSync(join(root, '.goodvibes'), { recursive: true });
    writeFileSync(sentinel, 'precious');
    const source = makeSource('evil');
    const catalogDir = join(root, '.goodvibes', 'ecosystem');
    mkdirSync(catalogDir, { recursive: true });
    writeFileSync(join(catalogDir, 'skills.json'), JSON.stringify({ version: 1, entries: [skill('..', 'Evil', source)] }));

    expect(loadEcosystemCatalog('skill', options)).toEqual([]);
    const result = installEcosystemCatalogEntry('skill', '..', options);
    expect(result.ok).toBe(false);
    expect(readFileSync(sentinel, 'utf-8')).toBe('precious');
  });

  test('uninstall refuses a receipt whose target path lies outside the install root', () => {
    const source = makeSource('good');
    expect(upsertEcosystemCatalogEntry(skill('good', 'Good', source), options).ok).toBe(true);
    const installed = installEcosystemCatalogEntry('skill', 'good', options);
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;

    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'file.txt'), 'safe');
    const receiptFile = join(root, '.goodvibes', 'ecosystem', 'installed', 'skill-good.json');
    writeFileSync(receiptFile, JSON.stringify({ ...installed.receipt, targetPath: outside }));

    const result = uninstallEcosystemCatalogEntry('skill', 'good', options);
    expect(result.ok).toBe(false);
    expect(readFileSync(join(outside, 'file.txt'), 'utf-8')).toBe('safe');
  });

  test('rollback refuses an unsafe entry id', () => {
    expect(rollbackInstalledEcosystemEntry('skill', '../x', options).ok).toBe(false);
  });
});

describe('a failed install leaves the previous one in place', () => {
  test('a source that cannot be copied returns an error result and keeps the installed copy', () => {
    const source = makeSource('tool', { 'SKILL.md': 'v1' });
    expect(upsertEcosystemCatalogEntry(skill('tool', 'Tool', source), options).ok).toBe(true);
    const first = installEcosystemCatalogEntry('skill', 'tool', options);
    expect(first.ok).toBe(true);
    const installedFile = join(root, '.goodvibes', 'skills', 'tool', 'SKILL.md');
    expect(readFileSync(installedFile, 'utf-8')).toBe('v1');

    // A file the copy cannot read makes it fail part way through.
    writeFileSync(join(root, 'src', 'tool', 'SKILL.md'), 'v2');
    const unreadable = join(root, 'src', 'tool', 'secret.txt');
    writeFileSync(unreadable, 'x');
    chmodSync(unreadable, 0o000);

    let second: ReturnType<typeof installEcosystemCatalogEntry>;
    try {
      second = installEcosystemCatalogEntry('skill', 'tool', options);
    } finally {
      chmodSync(unreadable, 0o600);
    }
    expect(second.ok).toBe(false);
    expect(readFileSync(installedFile, 'utf-8')).toBe('v1');
    // No staging or displaced leftovers are left beside the install.
    expect(readdirNames(join(root, '.goodvibes', 'skills'))).toEqual(['tool']);
  });
});

function readdirNames(dir: string): string[] {
  return readdirSync(dir).sort();
}

describe('bundle import', () => {
  test('merges by kind and id instead of replacing the existing entries', () => {
    upsertEcosystemCatalogEntry(skill('mine-1', 'Mine one', './src/a'), options);
    upsertEcosystemCatalogEntry(skill('mine-2', 'Mine two', './src/b'), options);
    const bundle: EcosystemCatalogBundle = {
      version: 1,
      exportedAt: 0,
      scope: 'project',
      entries: [skill('theirs', 'Theirs', './src/c'), skill('mine-2', 'Mine two, updated', './src/d')],
    };
    const result = importEcosystemCatalogBundle(bundle, options);
    expect(result.imported).toBe(2);
    expect(result.rejected).toEqual([]);
    const names = loadEcosystemCatalog('skill', options).map((entry) => entry.name).sort();
    expect(names).toEqual(['Mine one', 'Mine two, updated', 'Theirs']);
  });

  test('reports an unknown kind or unsafe id as rejected and imports the valid entries', () => {
    const bundle = {
      version: 1,
      exportedAt: 0,
      scope: 'project',
      entries: [
        skill('ok', 'Fine', './src/a'),
        { ...skill('weird', 'Weird', './src/b'), kind: 'x' },
        skill('../escape', 'Escape', './src/c'),
      ],
    } as unknown as EcosystemCatalogBundle;
    const result = importEcosystemCatalogBundle(bundle, options);
    expect(result.imported).toBe(1);
    expect(result.rejected.map((entry) => entry.id).sort()).toEqual(['../escape', 'weird']);
    expect(loadEcosystemCatalog('skill', options).map((entry) => entry.id)).toEqual(['ok']);
  });

  test('a bundle with no entries array is an error result, not a thrown TypeError', () => {
    const result = importEcosystemCatalogBundle({ version: 1, exportedAt: 0, scope: 'project' } as unknown as EcosystemCatalogBundle, options);
    expect(result.imported).toBe(0);
    expect(result.error).toContain('no entries array');
    expect(inspectEcosystemCatalogBundle({ version: 1, exportedAt: 0, scope: 'project' } as unknown as EcosystemCatalogBundle).counts.skill).toBe(0);
  });
});
