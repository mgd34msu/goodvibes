/**
 * analyze git modes: what a diff, breaking, semantic_diff and upgrade result
 * says about the range and the files it was asked about.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitService } from '../platform/src/platform/git/service.ts';
import { parseDiffStats } from '../platform/src/platform/tools/analyze/shared.ts';
import {
  extractSignaturesFromDiff,
  narrowStatToDiff,
  runDiff,
  runUpgrade,
  trySemanticDiffLlm,
} from '../platform/src/platform/tools/analyze/git-modes.ts';

const TWO_FILE_MOVE = [
  'diff --git a/a.ts b/a.ts',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,2 +1 @@',
  '-export interface Props { a: string }',
  ' const keep = 1;',
  'diff --git a/b.ts b/b.ts',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -0,0 +1 @@',
  '+export interface Props { a: string }',
].join('\n');

describe('extractSignaturesFromDiff', () => {
  test('the same export name in two files is two exports, so a removal in one file is not hidden by an addition in the other', () => {
    const { before, after } = extractSignaturesFromDiff(TWO_FILE_MOVE);
    expect([...before.values()].map((entry) => [entry.file, entry.name])).toEqual([['a.ts', 'Props']]);
    expect([...after.values()].map((entry) => [entry.file, entry.name])).toEqual([['b.ts', 'Props']]);
    // Nothing in `after` shares a key with the removed export.
    expect([...before.keys()].some((key) => after.has(key))).toBe(false);
  });

  test('export lists, star re-exports and default expressions are exports too', () => {
    const diff = [
      'diff --git a/index.ts b/index.ts',
      '--- a/index.ts',
      '+++ b/index.ts',
      "-export { alpha, beta as gamma } from './impl';",
      "-export * from './all';",
      '-export default makeThing;',
    ].join('\n');
    const { before } = extractSignaturesFromDiff(diff);
    expect([...before.values()].map((entry) => entry.name).sort()).toEqual(['* from \'./all\'', 'alpha', 'default', 'gamma']);
  });
});

describe('extractSignaturesFromDiff multi-line and anonymous exports', () => {
  test('a multi-line export list and anonymous default declarations are exports', () => {
    const diff = [
      'diff --git a/index.ts b/index.ts',
      '--- a/index.ts',
      '+++ b/index.ts',
      '-export {',
      '-  alpha,',
      '-  beta as gamma,',
      "-} from './impl';",
      '-export default async function () {',
      '-  return 1;',
      '-}',
    ].join('\n');
    const { before } = extractSignaturesFromDiff(diff);
    expect([...before.values()].map((entry) => entry.name).sort()).toEqual(['alpha', 'default', 'gamma']);
    expect([...before.values()].find((entry) => entry.name === 'alpha')?.sig).toContain("from './impl'");
  });

  test('an anonymous default class is the default export, not a class named extends', () => {
    const diff = ['diff --git a/c.ts b/c.ts', '+export default class extends Base {'].join('\n');
    expect([...extractSignaturesFromDiff(diff).after.values()].map((entry) => entry.name)).toEqual(['default']);
  });

  test('a file whose name git quotes is attributed under its real name', () => {
    const diff = ['diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"', '-export const a = 1;'].join('\n');
    expect([...extractSignaturesFromDiff(diff).before.values()].map((entry) => entry.file)).toEqual(['\u00e9.ts']);
  });
});

describe('narrowStatToDiff', () => {
  test('keeps a file whose name git quotes in both the stat row and the diff header', () => {
    const quotedStat = ' "\\303\\251.ts" | 1 +\n other.ts | 2 ++\n 2 files changed, 3 insertions(+)\n';
    const quotedDiff = 'diff --git "a/\\303\\251.ts" "b/\\303\\251.ts"\n--- "a/\\303\\251.ts"\n+++ "b/\\303\\251.ts"\n@@ -1 +1 @@\n-x\n+y\n';
    const narrowed = narrowStatToDiff(quotedStat, quotedDiff, ['\u00e9.ts']);
    expect(narrowed).toContain('1 file changed');
    expect(narrowed).not.toContain('other.ts');
    expect(parseDiffStats(narrowed).map((row) => row.file)).toEqual(['\u00e9.ts']);
  });

  const stat = ' src/a.ts | 3 ++-\n src/b.ts | 5 +++++\n 2 files changed, 7 insertions(+), 1 deletion(-)\n';
  const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-x\n+y\n';

  test('keeps only the files the narrowed diff contains, and recounts them', () => {
    const narrowed = narrowStatToDiff(stat, diff, ['src/a.ts']);
    expect(narrowed).toContain('src/a.ts');
    expect(narrowed).not.toContain('src/b.ts');
    expect(narrowed).toContain('1 file changed');
  });

  test('without a file request the stat is returned unchanged', () => {
    expect(narrowStatToDiff(stat, diff, undefined)).toBe(stat);
  });
});

describe('runDiff', () => {
  let repo: string;

  function git(...args: string[]): void {
    const result = Bun.spawnSync(['git', ...args], { cwd: repo, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`);
  }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gv-analyze-diff-'));
    git('init', '-q');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    writeFileSync(join(repo, 'a.ts'), 'export const a = 2;\n');
    writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'change both');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  test('a request for one file lists only that file, not the whole range', async () => {
    const result = await runDiff({ mode: 'diff', files: ['a.ts'] }, repo);
    expect((result.files as Array<{ file: string }>).map((row) => row.file)).toEqual(['a.ts']);
    expect(String(result.stat)).not.toContain('b.ts');
    expect(String(result.diff)).not.toContain('b.ts');
  });

  test('a diff that could not be read after the stat succeeded says so instead of returning an empty diff', async () => {
    const failing = spyOn(GitService.prototype, 'diffBetween').mockRejectedValue(new Error('object store unreadable'));
    try {
      const result = await runDiff({ mode: 'diff' }, repo);
      expect(result.diff).toBe('');
      expect(String(result.diff_error)).toContain('object store unreadable');
      expect(String(result.stat)).toContain('a.ts');
    } finally { failing.mockRestore(); }
  });

  test('a diff past the output limit is marked truncated', async () => {
    writeFileSync(join(repo, 'big.ts'), Array.from({ length: 2000 }, (_, i) => `export const v${i} = ${i};`).join('\n'));
    git('add', '.');
    git('commit', '-q', '-m', 'big');
    const result = await runDiff({ mode: 'diff', before: 'HEAD~1', after: 'HEAD' }, repo);
    expect(result.diff_truncated).toBe(true);
    expect(String(result.diff)).toContain('truncated');
  });
});

describe('trySemanticDiffLlm', () => {
  test('a reply that outlives the budget is abandoned and the request is aborted', async () => {
    let received: AbortSignal | undefined;
    const reply = await trySemanticDiffLlm({
      chat: (_prompt, options) => new Promise<string>((_resolve, reject) => {
        received = options?.signal;
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    }, 'prompt', 5);
    expect(reply).toBe('');
    expect(received?.aborted).toBe(true);
  });

  test('a reply inside the budget is returned and its request is not aborted', async () => {
    let received: AbortSignal | undefined;
    const reply = await trySemanticDiffLlm({ chat: async (_prompt, options) => { received = options?.signal; return 'summary'; } }, 'prompt');
    expect(reply).toBe('summary');
    expect(received?.aborted).toBe(false);
  });
});

describe('runUpgrade', () => {
  let root: string;
  let requested: string[];
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'gv-upgrade-'));
    requested = [];
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input: unknown) => {
      requested.push(String(input));
      return new Response(JSON.stringify({ version: '4.17.21' }), { status: 200 });
    }) as never);
  });

  afterEach(() => { fetchSpy.mockRestore(); rmSync(root, { recursive: true, force: true }); });

  function manifest(dependencies: Record<string, string>, name = 'app'): void {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name, dependencies }));
  }

  test('a range that starts at the latest version is not outdated', async () => {
    manifest({ lodash: '^4.17.21' });
    const result = await runUpgrade({ mode: 'upgrade' }, root);
    expect(result.outdated).toBe(0);
    expect(result.breaking).toBe(0);
  });

  test('a workspace, git or own-scope dependency is never sent to the public registry and is not a breaking upgrade', async () => {
    manifest({ '@acme/engine': 'workspace:*', '@acme/published': '^1.0.0', tool: 'github:acme/tool', lodash: '^3.0.0' }, '@acme/app');
    const result = await runUpgrade({ mode: 'upgrade' }, root);
    expect(requested).toEqual(['https://registry.npmjs.org/lodash/latest']);
    const rows = result.packages as Array<{ name: string; latest: string; breaking: boolean }>;
    expect(rows.find((row) => row.name === '@acme/engine')).toMatchObject({ latest: 'not_from_registry', breaking: false });
    expect(rows.find((row) => row.name === 'tool')).toMatchObject({ latest: 'not_from_registry', breaking: false });
    expect(rows.find((row) => row.name === 'lodash')).toMatchObject({ breaking: true });
    expect(result.not_from_registry).toBe(3);
    expect(result.outdated).toBe(1);
  });

  test('every dependency is checked, not the first twenty', async () => {
    manifest(Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`pkg-${i}`, '^1.0.0'])));
    const result = await runUpgrade({ mode: 'upgrade' }, root);
    expect(result.total).toBe(25);
    expect(requested).toHaveLength(25);
  });
});
