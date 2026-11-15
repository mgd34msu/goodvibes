import { describe, expect, test } from 'bun:test';
import { consoleCallLines } from '../scripts/no-platform-console.ts';

describe('consoleCallLines', () => {
  test('a block-comment opener inside a string does not hide later calls', () => {
    const text = ["const g = 'a/*b';", 'console.log(1);', 'const ok = 1;'].join('\n');
    expect(consoleCallLines(text)).toEqual([2]);
  });

  test('a URL in a string does not cut the rest of the line', () => {
    expect(consoleCallLines("const u = 'https://x'; console.log(u);")).toEqual([1]);
  });

  test('a glob in an object literal followed by a call on a later line is still found', () => {
    const text = ["const pkg = { scripts: { test: 'node --test test/*.test.mjs' } };", '', 'console.error(pkg);'].join('\n');
    expect(consoleCallLines(text)).toEqual([3]);
  });

  test('calls inside template expressions are found, text about calls is not', () => {
    const text = ['// console.log("comment")', '/* console.warn(1) */', "const s = 'console.log(1)';", 'const t = `${console.info(2)}`;'].join('\n');
    expect(consoleCallLines(text)).toEqual([4]);
  });
});
