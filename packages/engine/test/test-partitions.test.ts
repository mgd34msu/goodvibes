import { afterEach, expect, test } from 'bun:test';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { defaultTestArgs } from '../scripts/test-discovery.ts';
import { partitionTestFiles, selectPartition } from '../scripts/test-partitions.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(paths: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'engine-partitions-'));
  roots.push(root);
  mkdirSync(join(root, 'test'));
  for (const path of paths) {
    const file = join(root, 'test', path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, '');
  }
  return root;
}

test('partitions deterministically, balances file counts, and visits every input exactly once', () => {
  const files = ['g', 'a', 'f', 'b', 'e', 'c', 'd'];
  const partitions = partitionTestFiles(files, 3);
  expect(partitions).toEqual([['a', 'd', 'g'], ['b', 'e'], ['c', 'f']]);
  expect(partitions).toEqual(partitionTestFiles([...files].reverse(), 3));
  expect(partitions.flat().sort()).toEqual([...files].sort());
  expect(files).toEqual(['g', 'a', 'f', 'b', 'e', 'c', 'd']);
  expect(partitionTestFiles(files, 1)).toEqual([[...files].sort()]);
});

test('rejects duplicate input, invalid counts and empty partitions rather than passing no tests', () => {
  for (const count of [0, -1, 1.5, NaN, Infinity, 17, 5]) {
    expect(() => partitionTestFiles(['a', 'b', 'c', 'd'], count)).toThrow();
  }
  expect(() => partitionTestFiles([], 1)).toThrow();
  expect(() => partitionTestFiles(['a', 'a'], 2)).toThrow('duplicate');
});

test('rejects malformed partition specs', () => {
  const root = fixture(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']);
  for (const spec of ['', '0/4', '5/4', '1/0', '1/5', '1/4.0', '01/4', '1', 'x/4']) expect(() => selectPartition(root, spec), spec).toThrow();
});

test('the actual repo partitions are an exact disjoint cover of the discovered files', () => {
  const root = resolve(import.meta.dir, '..');
  const files = defaultTestArgs(root);
  const independent = readdirSync(join(root, 'test'), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1).replaceAll('\\', '/'))
    .filter((file) => !/^test\/(workers|workers-wrangler|hermes|fixtures|types)\//.test(file))
    .filter((file) => !file.split('/').some((part) => ['node_modules', '.git', 'dist'].includes(part)))
    .sort();
  expect(files).toEqual(independent);
  const selected = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => selectPartition(root, `${index}/9`).map((file) => {
    expect(file).toStartWith('./test/');
    return file.slice(2);
  }));
  expect(selected.flat().sort()).toEqual([...files]);
  expect(new Set(selected.flat()).size).toBe(files.length);
  const dedicated = selected.find(part => part.includes('test/knowledge-semantic-answer.test.ts'));
  expect(dedicated).toEqual(['test/knowledge-semantic-answer.test.ts']);
  const shared = selected.filter(part => part !== dedicated);
  expect(Math.max(...shared.map(part => part.length)) - Math.min(...shared.map(part => part.length))).toBeLessThanOrEqual(1);
});

test('real owned runner executes each partition once, preserves skips and propagates a failing partition', () => {
  // The first two files land in different partitions. Bare substring filters
  // would accidentally select the second file while running the first one.
  const paths = ['a.test.ts', 'nested/test/a.test.ts', 'y.test.ts', 'z.test.ts'];
  const root = fixture([...paths, 'workers/ignored.test.ts', 'fixtures/ignored.test.ts']);
  const scripts = join(root, 'scripts');
  mkdirSync(scripts);
  for (const file of ['test.ts', 'test-discovery.ts', 'test-partitions.ts']) {
    copyFileSync(resolve(import.meta.dir, '../scripts', file), join(scripts, file));
  }
  cpSync(resolve(import.meta.dir, '../toolchain/src/test-runner'), join(root, 'toolchain/src/test-runner'), { recursive: true });
  const receipt = join(root, 'executed.jsonl');
  for (const path of paths) writeFileSync(join(root, 'test', path), `
    import { test, expect } from 'bun:test';
    import { appendFileSync } from 'node:fs';
    test(${JSON.stringify(path)}, () => {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      appendFileSync(${JSON.stringify(receipt)}, ${JSON.stringify(path + '\n')});
      expect(true).toBe(true);
    });
    test.skip('declared optional fixture', () => { throw new Error('must remain skipped'); });
  `);
  for (const path of ['workers/ignored.test.ts', 'fixtures/ignored.test.ts']) {
    writeFileSync(join(root, 'test', path), "throw new Error('excluded area ran');");
  }
  const run = (args: string[]) => {
    const child = Bun.spawnSync({
      cmd: [process.execPath, join(scripts, 'test.ts'), ...args], cwd: root,
      env: { PATH: process.env.PATH ?? '', HOME: root, OPENAI_API_KEY: 'synthetic-must-not-inherit' },
      timeout: 15_000, stdout: 'pipe', stderr: 'pipe',
    });
    return { code: child.exitCode, output: `${child.stdout.toString()}${child.stderr.toString()}` };
  };
  for (const id of ['1/2', '2/2']) {
    const result = run([`--partition=${id}`, '--manifest=/nonexistent/ignored.json']);
    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain('2 pass');
    expect(result.output).toContain('2 skip');
  }
  expect(readFileSync(receipt, 'utf8').trim().split('\n').sort()).toEqual(paths);
  writeFileSync(join(root, 'test/z.test.ts'), "import { test, expect } from 'bun:test'; test('failure must reach CI', () => expect(false).toBe(true));");
  const failed = run(['--partition=2/2']);
  expect(failed.code, failed.output).not.toBe(0);
  expect(failed.output).toContain('failure must reach CI');
    const invalid = run(['--partition=1/2', 'test/a.test.ts']);
  expect(invalid.code).not.toBe(0);
  expect(invalid.output).toContain('do not combine');
}, 60_000);
