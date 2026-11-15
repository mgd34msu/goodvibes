/**
 * Structural and symbols find modes report what they could not do, stop at the time budget with a stated
 * partial count, and the import graph is kept per root and built once for concurrent callers.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeStructuralQuery } from '../platform/src/platform/tools/find/structural.ts';
import { executeSymbolsQuery } from '../platform/src/platform/tools/find/symbols.ts';
import { FindRuntimeService } from '../platform/src/platform/tools/find/shared.ts';
import { executeContentQuery } from '../platform/src/platform/tools/find/content.ts';
import { executeReferencesQuery } from '../platform/src/platform/tools/find/references.ts';
import { CodeIntelligence } from '../platform/src/platform/intelligence/index.ts';
import { noteProjectFilesChanged } from '../platform/src/platform/intelligence/project-files-epoch.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gv-find-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const write = (file: string, content: string) => { mkdirSync(join(root, file, '..'), { recursive: true }); writeFileSync(join(root, file), content); };

describe('structural', () => {
  test('a pattern that cannot be parsed is an error, not zero matches', async () => {
    write('a.ts', 'export const a = 1;\n');
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'a b c d' } as never, {}, root);
    expect(String(result.error)).toContain('Invalid structural pattern');
  });

  test('a valid pattern still matches', async () => {
    write('a.ts', 'function f(x) { return x; }\n');
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'function $F($$$A) { $$$B }' } as never, {}, root);
    expect(result.count).toBe(1);
  });

  test('files in a language it does not support are counted in a warning, not silently skipped', async () => {
    write('main.go', 'package main\n');
    write('b.ts', 'export const b = 1;\n');
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'export const $N = $V' } as never, {}, root);
    expect(result.count).toBe(1);
    expect(String((result.warnings as string[]).join(' '))).toContain('Skipped 1 file(s) whose language structural mode does not support');
  });

  test('a tree of only unsupported files warns instead of reporting a clean zero', async () => {
    write('main.go', 'package main\n');
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'x' } as never, {}, root);
    expect(result.count).toBe(0);
    expect((result.warnings as string[]).join(' ')).toContain('does not support');
  });

  test('a budget that ended before the files were found is stated, not reported as a clean empty result', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.ts`, `export const ${name} = 1;\n`);
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'export const $N = $V' } as never, {}, root, { shouldContinue: () => false });
    expect((result.warnings as string[]).join(' ')).toContain('Stopped at the time budget while finding files');
  });

  test('a budget that ends after the files were found stops the per-file loop and says how many were searched', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.ts`, `export const ${name} = 1;\n`);
    let expired = false;
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'export const $N = $V' } as never, {}, root, { readAccessFilter: async () => { expired = true; return true; }, shouldContinue: () => !expired });
    expect(result.count).toBe(0);
    expect((result.warnings as string[]).join(' ')).toMatch(/searched 0 of 3 files/);
  });
});

describe('files the read rules restrict', () => {
  const holdBack = (name: string) => async (path: string) => !path.endsWith(name);

  test('structural mode neither reads nor reports a restricted file, and says one was held back', async () => {
    write('open.ts', 'export const open = 1;\n');
    write('secret.ts', 'export const secret = 2;\n');
    const result = await executeStructuralQuery({ id: 'q', mode: 'structural', pattern: 'export const $N = $V' } as never, {}, root, { readAccessFilter: holdBack('secret.ts') });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.count).toBe(1);
    expect((result.warnings as string[]).join(' ')).toContain('1 result in access-restricted file');
  });

  for (const format of ['signatures', 'full', 'files_only', 'count_only'] as const) {
    test(`symbols mode with output ${format} never lists a restricted file`, async () => {
      write('open.ts', 'export function openFn() {}\n');
      write('secret.ts', 'export function secretFn() {}\n');
      const result = await executeSymbolsQuery({ id: 'q', mode: 'symbols' } as never, { format }, root, { readAccessFilter: holdBack('secret.ts') });
      expect(JSON.stringify(result)).not.toContain('secret');
      if (format === 'signatures' || format === 'full') expect(JSON.stringify(result)).toContain('openFn');
      expect((result.warnings as string[]).join(' ')).toContain('access-restricted file');
    });
  }
});

describe('symbols', () => {
  test('a budget that ended before the files were found is stated', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.ts`, `export function ${name}() {}\n`);
    const result = await executeSymbolsQuery({ id: 'q', mode: 'symbols' } as never, {}, root, { shouldContinue: () => false });
    expect((result.warnings as string[]).join(' ')).toContain('Stopped at the time budget while finding files');
  });

  test('a budget that ends after the files were found stops the per-file loop and says how many were searched', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.ts`, `export function ${name}() {}\n`);
    let expired = false;
    const result = await executeSymbolsQuery({ id: 'q', mode: 'symbols' } as never, {}, root, { readAccessFilter: async () => { expired = true; return true; }, shouldContinue: () => !expired });
    expect((result.warnings as string[]).join(' ')).toMatch(/searched 0 of 3 files/);
  });

  test('a cancellation after the parser returned ends the call and is not reported as a parser failure', async () => {
    write('a.ts', 'export function alpha() {}\n');
    // The directory walk and the per-file check also call beforeAttempt, so cancel only once the parser has returned.
    let parsed = false;
    const original = CodeIntelligence.prototype.getSymbols;
    CodeIntelligence.prototype.getSymbols = async () => { parsed = true; return [{ name: 'alpha', kind: 'function', line: 1, exported: true }] as never; };
    const outcome: string[] = [];
    try {
      // Throw once: a wide catch around the parser would swallow this single throw and resolve with a parser warning.
      let thrown = false;
      const beforeAttempt = () => { if (parsed && !thrown) { thrown = true; throw new Error('cancelled after parsing'); } };
      await executeSymbolsQuery({ id: 'q', mode: 'symbols', query: 'alpha' } as never, {}, root, { beforeAttempt })
        .then(result => outcome.push(...((result.warnings as string[] | undefined) ?? [])), error => outcome.push(`rejected: ${(error as Error).message}`));
    } finally { CodeIntelligence.prototype.getSymbols = original; }
    expect(parsed).toBe(true);
    expect(outcome).toEqual(['rejected: cancelled after parsing']);
  });

  test('a scan that finishes carries no budget warning', async () => {
    write('a.ts', 'export function a() {}\n');
    const result = await executeSymbolsQuery({ id: 'q', mode: 'symbols' } as never, {}, root, { shouldContinue: () => true });
    expect(JSON.stringify(result.warnings ?? [])).not.toContain('Stopped at the time budget');
  });
});

describe('import graph', () => {
  test('two roots have two graphs, so the second is not answered from the first', async () => {
    const other = mkdtempSync(join(tmpdir(), 'gv-find-other-'));
    try {
      write('src/a.ts', "import { b } from './b';\nexport const a = b;\n");
      write('src/b.ts', 'export const b = 1;\n');
      writeFileSync(join(other, 'x.ts'), 'export const x = 1;\n');
      const service = new FindRuntimeService();
      const first = await service.getImportGraph(root);
      const second = await service.getImportGraph(other);
      expect(second).not.toBe(first);
      expect(first.findImports(join(root, 'src', 'a.ts')).length).toBe(1);
      expect(second.findImports(join(root, 'src', 'a.ts'))).toEqual([]);
      expect(await service.getImportGraph(root)).toBe(first);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test('concurrent callers share one build', async () => {
    write('a.ts', 'export const a = 1;\n');
    const service = new FindRuntimeService();
    const [one, two] = await Promise.all([service.getImportGraph(root), service.getImportGraph(root)]);
    expect(one).toBe(two);
  });

  test('a write by the edit or write tool makes the cached graph stale at once', async () => {
    write('a.ts', 'export const a = 1;\n');
    const service = new FindRuntimeService();
    const first = await service.getImportGraph(root);
    expect(await service.getImportGraph(root)).toBe(first);
    noteProjectFilesChanged();
    expect(await service.getImportGraph(root)).not.toBe(first);
  });
});

describe('content relationships', () => {
  const layout = () => {
    write('lib/b.ts', 'export const marker = 1;\n');
    write('app/c.ts', "import { marker } from '../lib/b';\nexport const c = marker;\n");
  };
  const search = (readAccessFilter?: (path: string) => Promise<boolean>) => executeContentQuery(
    { id: 'q', mode: 'content', pattern: 'marker', path: 'lib', relationships: true } as never,
    { format: 'matches' },
    new FindRuntimeService(),
    root,
    readAccessFilter,
  );

  test('importedBy covers the whole project, not only the searched path', async () => {
    layout();
    const result = await search();
    const entry = (result.relationships as Record<string, { importedBy: string[] }>)[join(root, 'lib', 'b.ts')];
    expect(entry?.importedBy).toEqual([join(root, 'app', 'c.ts')]);
  });

  test('an importer the read gate holds back is neither named nor hidden without a note', async () => {
    layout();
    const result = await search(async (path) => !path.endsWith('c.ts'));
    const entry = (result.relationships as Record<string, { importedBy: string[] }>)[join(root, 'lib', 'b.ts')];
    expect(entry?.importedBy).toEqual([]);
    expect((result.warnings as string[]).join(' ')).toContain('access-restricted');
  });
});

describe('references text fallback', () => {
  test('a budget that ends the scan is stated', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.ts`, `export const ${name} = target;\n`);
    const result = await executeReferencesQuery(
      { id: 'q', mode: 'references', file: 'a.ts', symbol: 'target', line: 1, column: 0 } as never,
      {},
      root,
      { shouldContinue: () => false },
    );
    expect((result.warnings as string[]).join(' ')).toContain('Stopped at the time budget');
  });

  test('a budget that ends after the files were found stops the per-file loop and says how many were searched', async () => {
    for (const name of ['a', 'b', 'c']) write(`${name}.ts`, `export const ${name} = target;\n`);
    const query = { id: 'q', mode: 'references', file: 'a.ts', symbol: 'target', line: 1, column: 0 } as never;
    // A scan the budget never ends shows how many checks it makes: the discovery walk's, one after it, then one per file.
    let total = 0;
    await executeReferencesQuery(query, {}, root, { shouldContinue: () => { total++; return true; } });
    let checks = 0;
    const result = await executeReferencesQuery(query, {}, root, { shouldContinue: () => ++checks <= total - 3 });
    expect((result.warnings as string[]).join(' ')).toMatch(/searched 0 of 3 files/);
  });
});
