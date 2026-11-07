import { afterEach, expect, test } from 'bun:test';
import { linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileObservation } from '../sdk/src/platform/utils/file-observation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const root = () => { const path = mkdtempSync(join(tmpdir(), 'file-observation-')); roots.push(path); return path; };

test('file observations retain exact bytes and distinguish replacement with identical contents', () => {
  const directory = root(), path = join(directory, 'owned');
  writeFileSync(path, 'before'); const original = readFileObservation(path);
  expect(readFileObservation(path)).toEqual(original);
  writeFileSync(path, 'AFTER!');
  expect(readFileObservation(path).bytes.equals(original.bytes)).toBe(false);
  expect(original.bytes.toString()).toBe('before');
  const replacement = join(directory, 'replacement'); writeFileSync(replacement, 'before'); renameSync(replacement, path);
  const replaced = readFileObservation(path);
  expect(replaced.bytes.equals(original.bytes)).toBe(true);
  expect(replaced.physical).not.toBe(original.physical);
});

test('file observations reject aliases and non-file sources', () => {
  const directory = root(), path = join(directory, 'owned'); writeFileSync(path, 'private');
  const alias = join(directory, 'alias'); symlinkSync(path, alias);
  expect(() => readFileObservation(alias)).toThrow();
  expect(() => readFileObservation(directory)).toThrow();
  const linked = join(directory, 'linked'); linkSync(path, linked);
  expect(() => readFileObservation(path)).toThrow();
  expect(() => readFileObservation(linked)).toThrow();
});
