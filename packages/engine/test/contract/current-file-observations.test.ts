import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentFileObservations } from '../../platform/src/platform/contract/current-file-observations.js';
import { captureContractInput } from '../../platform/src/platform/contract/input-snapshot.js';

test('ambiguous and escaping observation paths are refused before filesystem lookup', () => {
  const lookup = spyOn(fs, 'lstatSync');
  try {
    expect(currentFileObservations('/unused', ['../outside', '..\\outside\\report.md', 'nested//report.md', './report.md', 'nested/../report.md'], { includeText: true })).toEqual([]);
    expect(lookup).not.toHaveBeenCalled();
  } finally { lookup.mockRestore(); }
});

test('current owner observations bind the actual admitted file and withhold changed bytes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'current-owner-observation-'));
  try {
    for (const args of [['init', '-q', '--object-format=sha256'], ['config', 'user.name', 'Fixture'], ['config', 'user.email', 'fixture@example.invalid']]) {
      expect(spawnSync('git', ['-C', root, ...args]).status).toBe(0);
    }
    writeFileSync(join(root, 'report.md'), 'The captured report.');
    expect(spawnSync('git', ['-C', root, 'add', '.']).status).toBe(0);
    expect(spawnSync('git', ['-C', root, 'commit', '-qm', 'fixture']).status).toBe(0);
    const snapshot = await captureContractInput(root), expected = snapshot.files.find(file => file.path === 'report.md')!;
    expect(expected.digest).toBeUndefined();
    expect(currentFileObservations(root, ['report.md'], { includeText: true, inputFile: expected })).toMatchObject([
      { success: true, text: 'The captured report.', inputBlobOid: expected.oid },
    ]);
    writeFileSync(join(root, 'report.md'), 'UNREVIEWED_REPLACEMENT');
    const changed = currentFileObservations(root, ['report.md'], { includeText: true, inputFile: expected });
    expect(changed).toMatchObject([{ success: false }]);
    expect(JSON.stringify(changed)).not.toContain('UNREVIEWED_REPLACEMENT');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a pathname replaced between lstat and open cannot enter a current-file observation', () => {
  const root = mkdtempSync(join(tmpdir(), 'current-file-open-race-')), path = join(root, 'report.md');
  writeFileSync(path, 'ORIGINAL_CONTENT');
  const open = fs.openSync;
  let raced = false;
  const tap = spyOn(fs, 'openSync').mockImplementation((target, ...args) => {
    if (target === path && !raced) {
      raced = true;
      fs.renameSync(path, join(root, 'previous.md'));
      writeFileSync(path, 'UNREVIEWED_REPLACEMENT');
    }
    return open(target, ...args);
  });
  try {
    const observations = currentFileObservations(root, ['report.md'], { includeText: true });
    expect(raced).toBe(true);
    expect(observations).toMatchObject([{ success: false }]);
    expect(JSON.stringify(observations)).not.toContain('UNREVIEWED_REPLACEMENT');
  } finally { tap.mockRestore(); rmSync(root, { recursive: true, force: true }); }
});

test('current native file observations refuse symlinked parents and nested runtime metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'current-file-observation-'));
  try {
    const tree = join(root, 'tree'), outside = join(root, 'outside');
    mkdirSync(tree); mkdirSync(outside);
    writeFileSync(join(outside, 'report.md'), 'OUTSIDE-TREE-CONTENT');
    symlinkSync(outside, join(tree, 'redirect'), 'dir');
    expect(currentFileObservations(tree, ['redirect/report.md'], { includeText: true })).toEqual([]);
    mkdirSync(join(tree, 'nested', '.goodvibes'), { recursive: true });
    writeFileSync(join(tree, 'nested', '.goodvibes', 'private.json'), 'RUNTIME-METADATA');
    expect(currentFileObservations(tree, ['nested/.goodvibes/private.json'], { includeText: true })).toEqual([]);
    writeFileSync(join(tree, 'report.md'), 'The accepted report.');
    expect(currentFileObservations(tree, ['report.md'], { includeText: true })).toMatchObject([
      { success: true, path: 'report.md', text: 'The accepted report.' },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
