/**
 * Unified diffs are read by their hunk structure, not by line prefixes.
 */
import { describe, expect, test } from 'bun:test';
import { parseDiffForApply } from '../platform/src/platform/core/conversation-diff.ts';

describe('parseDiffForApply', () => {
  test('a removed line that starts with dashes is content, not a header', () => {
    const diff = [
      '--- a/query.sql',
      '+++ b/query.sql',
      '@@ -1,3 +1,3 @@',
      ' select 1;',
      '--- old comment',
      '+-- new comment',
      ' select 2;',
    ].join('\n');

    const parsed = parseDiffForApply(diff);

    expect(parsed.filePath).toBe('query.sql');
    expect(parsed.diffOriginal).toBe('select 1;\n-- old comment\nselect 2;');
    expect(parsed.diffUpdated).toBe('select 1;\n-- new comment\nselect 2;');
  });

  test('an added line that starts with plus signs is content', () => {
    const diff = ['--- a/x.c', '+++ b/x.c', '@@ -1 +1 @@', '-x', '+++x'].join('\n');
    expect(parseDiffForApply(diff).diffUpdated).toBe('++x');
  });

  test('the no-newline marker is not treated as file content', () => {
    const diff = ['--- a/x.txt', '+++ b/x.txt', '@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n');
    const parsed = parseDiffForApply(diff);

    expect(parsed.diffOriginal).toBe('old');
    expect(parsed.diffUpdated).toBe('new');
  });

  test('a diff with several hunks is reported as unsupported instead of joined into text that is not in the file', () => {
    const diff = [
      '--- a/x.ts', '+++ b/x.ts',
      '@@ -1,2 +1,2 @@', ' a', '-b', '+B',
      '@@ -20,2 +20,2 @@', ' y', '-z', '+Z',
    ].join('\n');
    const parsed = parseDiffForApply(diff);

    expect(parsed.filePath).toBe('x.ts');
    expect(parsed.unsupported).toContain('2 separate hunks');
    expect(parsed.diffOriginal).toBeUndefined();
    expect(parsed.diffUpdated).toBeUndefined();
  });

  test('a diff touching two files is reported as unsupported', () => {
    const diff = [
      '--- a/one.ts', '+++ b/one.ts', '@@ -1 +1 @@', '-a', '+b',
      '--- a/two.ts', '+++ b/two.ts', '@@ -1 +1 @@', '-c', '+d',
    ].join('\n');

    expect(parseDiffForApply(diff).unsupported).toContain('more than one file');
  });

  test('a header path outside the project is not offered for applying', () => {
    for (const path of ['/etc/passwd', '../outside.ts', 'a/../../outside.ts']) {
      const parsed = parseDiffForApply(['--- a/x', `+++ ${path}`, '@@ -1 +1 @@', '-a', '+b'].join('\n'));
      expect(parsed.filePath).toBeUndefined();
    }
  });
});
