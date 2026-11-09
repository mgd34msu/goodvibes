/** Actual native retention fixtures; authored UNRUN during the coding pass. */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceFileRetention, enforceJournalDirectoryRetention, type AtRestPolicy } from '../platform/src/platform/runtime/at-rest-persistence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = fs.mkdtempSync(join(tmpdir(), 'at-rest-original-retention-')); roots.push(root); return root; }
function file(root: string, name: string, ageSeconds = 0, size = 2000): string {
  const path = join(root, name); fs.writeFileSync(path, 'x'.repeat(size));
  const at = Date.now() / 1000 - ageSeconds; fs.utimesSync(path, at, at); return path;
}
const policy = (maxTotalBytes = 2500, maxAgeMs = Number.MAX_SAFE_INTEGER): AtRestPolicy => ({
  redact: true, retention: { maxAgeMs, maxTotalBytes },
});

describe.skipIf(process.geteuid === undefined)('retention owns exact original native files and truthful accounting', () => {
  test('failed oldest unlink does not consume the size budget or prevent later removable files', () => {
    const root = fixture(), oldest = file(root, 'oldest.jsonl', 300), middle = file(root, 'middle.jsonl', 200), newest = file(root, 'newest.jsonl', 100);
    const oldestNative = fs.realpathSync(oldest);
    const unlink = fs.unlinkSync;
    const fault = spyOn(fs, 'unlinkSync').mockImplementation(path => {
      if (String(path) === oldestNative) throw Object.assign(new Error('Synthetic unlink refused'), { code: 'EACCES' });
      unlink(path);
    });
    try {
      const result = enforceFileRetention([oldest, middle, newest], policy());
      expect(fs.existsSync(oldest)).toBe(true); expect(fs.existsSync(middle)).toBe(false); expect(fs.existsSync(newest)).toBe(false);
      expect(result.deletedFiles).toEqual([middle, newest]); expect(result.reclaimedBytes).toBe(4000);
    } finally { fault.mockRestore(); }
  });

  test('an age deletion failure remains in the surviving size budget without a repeated unlink attempt', () => {
    const root = fixture(), expired = file(root, 'expired.jsonl', 300), fresh = file(root, 'fresh.jsonl');
    const expiredNative = fs.realpathSync(expired);
    const unlink = fs.unlinkSync; let failures = 0;
    const fault = spyOn(fs, 'unlinkSync').mockImplementation(path => {
      if (String(path) === expiredNative) { failures++; throw Object.assign(new Error('Synthetic unlink refused'), { code: 'EACCES' }); }
      unlink(path);
    });
    try {
      const result = enforceFileRetention([expired, fresh], policy(2500, 60_000));
      expect(failures).toBe(1); expect(fs.existsSync(expired)).toBe(true); expect(fs.existsSync(fresh)).toBe(false);
      expect(result.deletedFiles).toEqual([fresh]); expect(result.reclaimedBytes).toBe(2000);
    } finally { fault.mockRestore(); }
  });

  test('symlink and hardlink candidates are preserved without counting their target bytes', () => {
    const root = fixture(), target = file(root, 'outside-target.txt'), alias = join(root, 'alias.jsonl'), linked = join(root, 'hardlink.jsonl');
    fs.symlinkSync(target, alias); fs.linkSync(target, linked);
    const own = file(root, 'owned.jsonl', 0, 500);
    const result = enforceFileRetention([alias, linked, own], policy(0));
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true); expect(fs.existsSync(linked)).toBe(true); expect(fs.existsSync(target)).toBe(true);
    expect(result.deletedFiles).toEqual([own]); expect(result.reclaimedBytes).toBe(500);
  });

  test('duplicate selected paths do not inflate the byte budget and delete another file unnecessarily', () => {
    const root = fixture(), older = file(root, 'a.jsonl', 100, 1000), newer = file(root, 'b.jsonl', 0, 1000);
    const result = enforceFileRetention([older, older, newer], policy(1500));
    expect(result.deletedFiles).toEqual([older]); expect(result.reclaimedBytes).toBe(1000); expect(fs.existsSync(newer)).toBe(true);
  });

  test('a leaf replaced after selection is preserved with zero false reclamation', () => {
    const root = fixture(), path = file(root, 'selected.jsonl'), retired = join(root, 'original-kept.jsonl'); let changed = false;
    const selected: AtRestPolicy = { redact: true, retention: { get maxAgeMs() {
      if (!changed) { changed = true; fs.renameSync(path, retired); fs.writeFileSync(path, 'Replacement must remain'); }
      return -1;
    }, maxTotalBytes: 0 } };
    const result = enforceFileRetention([path], selected);
    expect(result).toEqual({ deletedFiles: [], reclaimedBytes: 0 });
    expect(fs.readFileSync(path, 'utf8')).toBe('Replacement must remain'); expect(fs.existsSync(retired)).toBe(true);
  });

  test('a parent replaced after selection cannot redirect deletion into another tree', () => {
    const root = fixture(), directory = join(root, 'journals'), retired = join(root, 'original-journals'), foreign = join(root, 'foreign');
    fs.mkdirSync(directory); fs.mkdirSync(foreign); const original = file(directory, 'same.jsonl'); file(foreign, 'same.jsonl'); let changed = false;
    const selected: AtRestPolicy = { redact: true, retention: { get maxAgeMs() {
      if (!changed) { changed = true; fs.renameSync(directory, retired); fs.symlinkSync(foreign, directory); }
      return -1;
    }, maxTotalBytes: 0 } };
    expect(enforceFileRetention([original], selected)).toEqual({ deletedFiles: [], reclaimedBytes: 0 });
    expect(fs.existsSync(join(retired, 'same.jsonl'))).toBe(true); expect(fs.existsSync(join(foreign, 'same.jsonl'))).toBe(true);
  });

  test('journal enumeration keeps its original parent through the later file selection', () => {
    const root = fixture(), directory = join(root, 'journals'), retired = join(root, 'original-journals'), foreign = join(root, 'foreign');
    fs.mkdirSync(directory); fs.mkdirSync(foreign); file(directory, 'same.jsonl'); file(foreign, 'same.jsonl');
    const now = Date.now; let changed = false;
    const swap = spyOn(Date, 'now').mockImplementation(() => {
      if (!changed) { changed = true; fs.renameSync(directory, retired); fs.symlinkSync(foreign, directory); }
      return now();
    });
    try {
      expect(enforceJournalDirectoryRetention(directory, policy(0))).toEqual({ deletedFiles: [], reclaimedBytes: 0 });
      expect(fs.existsSync(join(retired, 'same.jsonl'))).toBe(true); expect(fs.existsSync(join(foreign, 'same.jsonl'))).toBe(true);
    } finally { swap.mockRestore(); }
  });

  test('retention examines metadata without reading large journal bodies', () => {
    const root = fixture(), path = file(root, 'journal.jsonl', 0, 100_000);
    const reads = spyOn(fs, 'readFileSync');
    try {
      expect(enforceFileRetention([path], policy(0)).reclaimedBytes).toBe(100_000);
      expect(reads).not.toHaveBeenCalled();
    } finally { reads.mockRestore(); }
  });
});
