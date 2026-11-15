/**
 * analyze: what each mode reports must match what it found. The short form
 * reads the fields the modes really produce, the preview diff shows exactly the
 * changed lines, a path outside the root is refused, and a scan cut short by its
 * deadline never calls an unchecked export dead.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyzeTool } from '../platform/src/platform/tools/analyze/index.js';
import { runDeadCode, runImpact } from '../platform/src/platform/tools/analyze/scan-modes.js';
import { summarizeAnalyzeResult, validateGitRefs } from '../platform/src/platform/tools/analyze/shared.js';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { useToolReadings } from './_helpers/tool-readings.ts';

useToolReadings();

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'analyze-results-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}
const llm = { chat: async () => '' } as never;
const analyze = (root: string, args: Record<string, unknown>) => createAnalyzeTool(llm, null, root).execute(args);
const classic = <T>(run: () => Promise<T>): Promise<T> => withDecisionModelPolicy(() => 'Classic - Off', run);
function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

describe('preview', () => {
  const eight = Array.from({ length: 8 }, (_, i) => `line${i + 1}`).join('\n') + '\n';

  test('one changed middle line shows one removed and one added line', async () => {
    const root = project({ 'a.ts': eight });
    const result = await analyze(root, { mode: 'preview', files: ['a.ts'], find: 'line4', replace: 'LINE4' });
    const preview = JSON.parse(result.output!) as { diff: string; changed_lines: number };
    const body = preview.diff.split('\n').slice(2);
    expect(body.filter((l) => l.startsWith('-'))).toEqual(['-line4']);
    expect(body.filter((l) => l.startsWith('+'))).toEqual(['+LINE4']);
    expect(preview.changed_lines).toBe(2);
  });

  test('a replacement holding $& stays literal, as the edit tool writes it', async () => {
    const root = project({ 'a.ts': 'one\ntwo\nthree\n' });
    const result = await analyze(root, { mode: 'preview', files: ['a.ts'], find: 'two', replace: '[$&]' });
    expect((JSON.parse(result.output!) as { diff: string }).diff).toContain('+[$&]');
  });

  test('a one-line change in a file over a thousand lines reports one removed and one added line', async () => {
    const lines = Array.from({ length: 1500 }, (_, i) => `line ${i}`);
    const changed = [...lines];
    changed[700] = 'line changed';
    const root = project({ 'big.ts': lines.join('\n') + '\n' });
    const result = await analyze(root, { mode: 'preview', files: ['big.ts'], find: 'line 700', replace: 'line changed' });
    const diff = (JSON.parse(result.output!) as { diff: string }).diff;
    const removed = diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'));
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
    expect(removed).toEqual(['-line 700']);
    expect(added).toEqual(['+line changed']);
  });

  test('an empty find is refused', async () => {
    const root = project({ 'a.ts': 'one\n' });
    const result = await analyze(root, { mode: 'preview', files: ['a.ts'], find: '', replace: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('non-empty find');
  });
});

describe('paths outside the root', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['preview', { mode: 'preview', find: 'a', replace: 'b' }],
    ['surface', { mode: 'surface' }],
    ['dead_code', { mode: 'dead_code' }],
    ['dependencies', { mode: 'dependencies' }],
    ['test_find', { mode: 'test_find' }],
    ['impact', { mode: 'impact' }],
    ['security secrets', { mode: 'security', securityScope: 'secrets' }],
    ['security permissions', { mode: 'security', securityScope: 'permissions' }],
  ];
  for (const [name, args] of cases) {
    test(`${name} refuses a parent-directory path and an absolute outside path`, async () => {
      const root = project({ 'a.ts': 'export const a = 1;\n' });
      for (const file of ['../outside.ts', '/etc/hostname']) {
        const result = await classic(() => analyze(root, { ...args, files: [file] }));
        expect(result.success).toBe(false);
        expect(result.error).toContain('is outside the project root');
      }
    });
  }

  test('a link inside the root that points outside it is refused', async () => {
    const outside = project({ 'secret.ts': 'export const secret = 1;\n' });
    const root = project({ 'a.ts': 'export const a = 1;\n' });
    symlinkSync(outside, join(root, 'link'));
    const result = await analyze(root, { mode: 'preview', files: ['link/secret.ts'], find: 'secret', replace: 'x' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('is outside the project root');
  });
});

describe('a model-supplied projectRoot', () => {
  test('cannot move the scan outside the configured root, but may narrow it to a folder inside', async () => {
    const outside = project({ 'secret.ts': 'export const secret = 1;\n' });
    const root = project({ 'sub/a.ts': 'export const a = 1;\n' });
    const escaped = await analyze(root, { mode: 'surface', projectRoot: outside, files: ['secret.ts'] });
    expect(escaped.success).toBe(false);
    expect(escaped.error).toContain('is outside the project root');
    const narrowed = await analyze(root, { mode: 'surface', projectRoot: join(root, 'sub'), files: ['a.ts'] });
    expect(narrowed.success).toBe(true);
  });
});

describe('git refs', () => {
  test('a ref that starts with a dash is refused before git sees it', async () => {
    expect(validateGitRefs('--output', 'x.txt')).toMatchObject({ error: expect.stringContaining("must not start with '-'") });
    expect(validateGitRefs('main', '-x')).not.toBeNull();
    expect(validateGitRefs('main', 'origin/feature-1')).toBeNull();
    const root = project({ 'a.ts': 'export const a = 1;\n' });
    git(root, 'init', '-q');
    const result = await analyze(root, { mode: 'diff', before: '--output', after: 'pwned.txt' });
    expect(result.success).toBe(false);
    expect(result.error).toContain("must not start with '-'");
    expect(existsSync(join(root, 'pwned.txt'))).toBe(false);
  });
});

describe('summary format reports what the mode found', () => {
  const summary = async (root: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const result = await classic(() => analyze(root, { ...args, output: { format: 'summary' } }));
    return JSON.parse(result.output!) as Record<string, unknown>;
  };

  test('impact lists the affected files', async () => {
    const root = project({ 'a.ts': 'export function shared() {}\n', 'b.ts': 'import { shared } from "./a";\nshared();\n' });
    const out = await summary(root, { mode: 'impact', files: ['a.ts'] });
    expect(out.total_affected).toBe(1);
    expect(out.exported_names).toEqual(['shared']);
    expect(out.affected_files).toEqual([{ file: 'b.ts', referenceCount: 1 }]);
  });

  test('coverage carries the measured percentages', async () => {
    const root = project({ 'coverage/coverage-summary.json': JSON.stringify({ total: { lines: { total: 10, covered: 8, pct: 80 }, statements: { pct: 75 }, branches: { pct: 50 }, functions: { pct: 60 } } }) });
    const out = await summary(root, { mode: 'coverage' });
    expect(out.source).toBe('coverage-summary.json');
    expect(out.lines).toEqual({ total: 10, covered: 8, pct: 80 });
  });

  test('bundle carries the assets of the stats file', async () => {
    const root = project({ 'stats.json': JSON.stringify({ assets: [{ name: 'main.js', size: 120 }], chunks: [{}, {}] }) });
    const out = await summary(root, { mode: 'bundle' });
    expect(out).toMatchObject({ source: 'stats.json', assetCount: 1, chunkCount: 2, assets: [{ name: 'main.js', size: 120 }] });
  });

  test('env_audit reports the variables missing from a file', async () => {
    const root = project({ '.env.example': 'A=\nB=\n', '.env': 'A=1\n' });
    const out = await summary(root, { mode: 'env_audit' });
    expect(out.reference).toBe('.env.example');
    expect(out.missingCount).toBe(1);
    expect(out.missing).toEqual([{ key: 'B', present_in: '.env.example', missing_from: ['.env'] }]);
  });

  test('test_find reports the test it found', async () => {
    const root = project({ 'src/a.ts': 'export const a = 1;\n', 'test/a.test.ts': 'import { a } from "../src/a";\nvoid a;\n' });
    const out = await summary(root, { mode: 'test_find', files: ['src/a.ts'] });
    expect(out).toMatchObject({ total: 1, found: 1, missing: 0, mappings: [{ source: 'src/a.ts', test: 'test/a.test.ts', exists: true }] });
  });

  test('preview reports how many lines change', async () => {
    const root = project({ 'a.ts': 'one\ntwo\nthree\n' });
    const out = await summary(root, { mode: 'preview', files: ['a.ts'], find: 'two', replace: 'TWO' });
    expect(out).toMatchObject({ file: 'a.ts', changed_lines: 2 });
  });

  test('diff reports the changed files of the range', async () => {
    const root = project({ 'a.ts': 'one\n' });
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'one');
    writeFileSync(join(root, 'a.ts'), 'one\ntwo\n');
    git(root, 'commit', '-qam', 'two');
    const out = await summary(root, { mode: 'diff' });
    expect(out).toMatchObject({ fileCount: 1, insertions: 1, deletions: 0, files: [{ file: 'a.ts', insertions: 1 }] });
  });

  test('breaking lists the export the range removed', async () => {
    const root = project({ 'api.ts': 'export function kept(): void {}\nexport function removed(): void {}\n' });
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'two exports');
    writeFileSync(join(root, 'api.ts'), 'export function kept(): void {}\n');
    git(root, 'commit', '-qam', 'drop one');
    const result = await analyze(root, { mode: 'breaking', output: { format: 'summary' } });
    const out = JSON.parse(result.output!) as Record<string, unknown>;
    expect(out.total_breaking).toBe(1);
    expect(out.breaking_changes).toEqual([expect.objectContaining({ file: 'api.ts', name: 'removed' })]);
  });

  test('an unassessed breaking run does not claim zero breaking changes', async () => {
    const root = project({ 'api.ts': 'export function kept(): void {}\nexport function removed(): void {}\n' });
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'two exports');
    writeFileSync(join(root, 'api.ts'), 'export function kept(): void {}\n');
    git(root, 'commit', '-qam', 'drop one');
    const out = await summary(root, { mode: 'breaking' });
    expect(out.total_breaking).toBeUndefined();
    expect(out).toMatchObject({ assessment: 'unassessed', fileCount: 1 });
  });

  test('upgrade counts every outdated package, not only the first five', () => {
    const packages = [...Array.from({ length: 6 }, (_, i) => ({ name: `current-${i}`, current: '1.0.0', latest: '1.0.0', breaking: false })),
      { name: 'old-pkg', current: '1.0.0', latest: '2.0.0', breaking: true }];
    const out = summarizeAnalyzeResult('upgrade', { packages });
    expect(out).toMatchObject({ packageCount: 7, outdatedCount: 1, outdated: [{ name: 'old-pkg', latest: '2.0.0' }] });
  });

  test('upgrade does not call a caret range at the latest version, a workspace link or a failed lookup outdated', () => {
    const packages = [
      { name: 'ranged', current: '^1.0.0', latest: '1.0.0', breaking: false },
      { name: 'linked', current: 'workspace:*', latest: 'not_from_registry', breaking: false },
      { name: 'failed', current: '^2.0.0', latest: 'fetch_failed', breaking: false },
      { name: 'behind', current: '^1.0.0', latest: '1.2.0', breaking: false },
    ];
    const out = summarizeAnalyzeResult('upgrade', { packages });
    expect(out).toMatchObject({ packageCount: 4, outdatedCount: 1, outdated: [{ name: 'behind' }] });
  });
});

describe('dependencies', () => {
  test('a package named like an Object.prototype member does not break cycle detection, and local files are not packages', async () => {
    const root = project({
      'a.ts': 'import "./b";\nimport x from "constructor";\nimport "node:fs";\nimport "fs";\nimport "@scope";\nimport y from "lodash/fp";\n',
      'b.ts': 'import "./a";\n',
    });
    const circular = await analyze(root, { mode: 'dependencies', submode: 'circular' });
    expect(circular.success).toBe(true);
    expect(JSON.parse(circular.output!)).toMatchObject({ has_cycles: true });
    const upgrade = await analyze(root, { mode: 'dependencies', submode: 'upgrade' });
    expect((JSON.parse(upgrade.output!) as { packages: string[] }).packages).toEqual(['constructor', 'lodash']);
  });
});

describe('a scan that hits its deadline', () => {
  const files = {
    'a.ts': 'export function usedFn() {}\nexport function unusedFn() {}\n',
    'b.ts': 'import { usedFn } from "./a";\nusedFn();\n',
  };

  test('without a deadline only the unreferenced export is dead', async () => {
    const out = await runDeadCode({ mode: 'dead_code' }, project(files), {}, () => false);
    expect((out.dead_exports as Array<{ name: string }>).map((e) => e.name)).toEqual(['unusedFn']);
    expect(out.stopped_by_deadline).toBeUndefined();
  });

  test('a file left unread keeps every export unverified', async () => {
    let calls = 0;
    const out = await runDeadCode({ mode: 'dead_code' }, project(files), {}, () => ++calls > 1);
    expect(out.dead_exports).toEqual([]);
    expect(out.stopped_by_deadline).toBe(true);
  });

  test('impact says its affected list is partial when it stops', async () => {
    const root = project({ 'a.ts': 'export function thing() {}\n', 'b.ts': 'thing();\n', 'c.ts': 'thing();\n' });
    let calls = 0;
    const out = await runImpact({ mode: 'impact', files: ['a.ts'] }, root, {}, () => ++calls > 1);
    expect(out.total_affected).toBe(1);
    expect(out.stopped_by_deadline).toBe(true);
  });
});
