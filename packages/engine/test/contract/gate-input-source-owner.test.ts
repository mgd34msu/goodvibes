import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureGateInput } from '../../platform/src/platform/contract/gate-input.js';

let directory: string;
beforeEach(() => { directory = fs.mkdtempSync(join(tmpdir(), 'gate-source-owner-')); });
afterEach(() => { fs.rmSync(directory, { force: true, recursive: true }); });

test('the running owner retains an unchanged source without reading ordinary file contents or hashing them', () => {
  fs.writeFileSync(join(directory, 'source.ts'), 'owner-private-source');
  fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
  const hash = spyOn(crypto, 'createHash');
  const open = spyOn(fs, 'openSync');
  try {
    const original = captureGateInput(directory);
    const current = captureGateInput(directory, original);
    expect(current.source).toBe(original.source);
    expect(current.packageScripts).toEqual({ test: 'bun test' });
    expect(Object.isFrozen(current.packageScripts)).toBe(true);
    expect(hash).not.toHaveBeenCalled();
    expect(open.mock.calls.length).toBeGreaterThan(0);
    for (const call of open.mock.calls) expect(call[0]).toBe(join(directory, 'package.json'));
    expect(original.source).not.toContain('source.ts');
    expect(original.source).not.toContain('owner-private-source');
    // A copied label or a restarted caller has no live source observation.
    expect(captureGateInput(directory, { ...original }).source).not.toBe(original.source);
    expect(captureGateInput(directory).source).not.toBe(original.source);
  } finally { hash.mockRestore(); open.mockRestore(); }
});

test('same-length writes with restored mtime and same-byte file replacements retire the original source', () => {
  const path = join(directory, 'source.ts');
  fs.writeFileSync(path, 'original');
  const original = captureGateInput(directory);
  const before = fs.statSync(path);
  fs.writeFileSync(path, 'changed!');
  fs.utimesSync(path, before.atime, before.mtime);
  const rewritten = captureGateInput(directory, original);
  expect(rewritten.source).not.toBe(original.source);
  expect(captureGateInput(directory, rewritten).source).toBe(rewritten.source);
  fs.writeFileSync(join(directory, 'replacement.tmp'), 'changed!');
  fs.renameSync(join(directory, 'replacement.tmp'), path);
  expect(captureGateInput(directory, rewritten).source).not.toBe(rewritten.source);
});

test('membership, package commands and parent directory replacement invalidate owned check evidence', () => {
  fs.mkdirSync(join(directory, 'nested'));
  fs.writeFileSync(join(directory, 'nested', 'source.ts'), 'original');
  fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'bun test' } }));
  let observed = captureGateInput(directory);
  fs.writeFileSync(join(directory, 'added.ts'), 'new input');
  let current = captureGateInput(directory, observed);
  expect(current.source).not.toBe(observed.source);
  observed = current;
  fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'echo no tests' } }));
  current = captureGateInput(directory, observed);
  expect(current.source).not.toBe(observed.source);
  expect(current.packageScripts.test).toBe('echo no tests');
  observed = current;
  fs.renameSync(join(directory, 'nested'), join(directory, '.goodvibes'));
  fs.mkdirSync(join(directory, 'nested'));
  fs.writeFileSync(join(directory, 'nested', 'source.ts'), 'original');
  expect(captureGateInput(directory, observed).source).not.toBe(observed.source);
});

test('excluded runtime outputs do not retire a running check and symlinked source parents cannot become evidence', () => {
  fs.mkdirSync(join(directory, 'nested'));
  fs.writeFileSync(join(directory, 'nested', 'source.ts'), 'original');
  const original = captureGateInput(directory);
  fs.mkdirSync(join(directory, '.goodvibes'));
  fs.writeFileSync(join(directory, '.goodvibes', 'receipt.json'), '{}');
  expect(captureGateInput(directory, original).source).toBe(original.source);
  fs.renameSync(join(directory, 'nested'), join(directory, '.goodvibes', 'original'));
  fs.symlinkSync(join(directory, '.goodvibes', 'original'), join(directory, 'nested'));
  expect(() => captureGateInput(directory, original)).toThrow();
});


// Regression source intentionally unrun during the coding-first pass.
test('tracked nested-directory deletions remain observable without restoring removed files', () => {
  execFileSync('git', ['init', directory], { stdio: 'pipe' });
  fs.mkdirSync(join(directory, 'removed', 'nested'), { recursive: true });
  fs.writeFileSync(join(directory, 'removed', 'nested', 'source.ts'), 'Tracked source');
  execFileSync('git', ['-C', directory, 'add', 'removed/nested/source.ts'], { stdio: 'pipe' });
  const original = captureGateInput(directory);
  fs.rmSync(join(directory, 'removed'), { recursive: true });
  const deleted = captureGateInput(directory, original);
  expect(deleted.source).not.toBe(original.source);
  expect(captureGateInput(directory, deleted).source).toBe(deleted.source);
  expect(fs.existsSync(join(directory, 'removed'))).toBe(false);
  fs.mkdirSync(join(directory, 'removed', 'nested'), { recursive: true });
  fs.writeFileSync(join(directory, 'removed', 'nested', 'source.ts'), 'Tracked source');
  expect(captureGateInput(directory, deleted).source).not.toBe(deleted.source);
});


test('a tracked directory replaced by a regular file is a stable changed tree with missing descendants', () => {
  execFileSync('git', ['init', directory], { stdio: 'pipe' });
  fs.mkdirSync(join(directory, 'replaced'));
  fs.writeFileSync(join(directory, 'replaced', 'source.ts'), 'Tracked source');
  execFileSync('git', ['-C', directory, 'add', 'replaced/source.ts'], { stdio: 'pipe' });
  const original = captureGateInput(directory);
  fs.rmSync(join(directory, 'replaced'), { recursive: true }); fs.writeFileSync(join(directory, 'replaced'), 'Current regular file');
  const current = captureGateInput(directory, original);
  expect(current.source).not.toBe(original.source);
  expect(captureGateInput(directory, current).source).toBe(current.source);
  fs.writeFileSync(join(directory, 'replaced'), 'Changed regular file');
  expect(captureGateInput(directory, current).source).not.toBe(current.source);
});
