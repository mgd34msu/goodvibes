import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool } from '@goodvibes-jev/engine/platform/platform/tools';
import { FileStateCache } from '@goodvibes-jev/engine/platform/platform/state';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { computeAstPatternEdit, computeSingleEdit, findAllPositions } from '../platform/src/platform/tools/edit/match.ts';
import { buildImportGraphWarning } from '../platform/src/platform/tools/edit/core.ts';

let root: string;
let previous: ReturnType<typeof installJudgmentPort>;
let selectorCalls: number;

beforeEach(() => {
  selectorCalls = 0;
  previous = installJudgmentPort(fakePort((name, question) => {
    if (question.type === 'choice') { selectorCalls++; return choiceAnswer(question, 'none', 1); }
    if (name.startsWith('fits_')) selectorCalls++;
    return noulAnswer(0);
  }).port);
  root = mkdtempSync(join(tmpdir(), 'edit-match-safety-'));
});
afterEach(() => {
  installJudgmentPort(previous);
  rmSync(root, { recursive: true, force: true });
});

const write = (name: string, content: string): string => {
  const path = join(root, name);
  writeFileSync(path, content, 'utf-8');
  return path;
};
const tool = () => createEditTool(new FileStateCache(), { cwd: root });

describe('empty find', () => {
  test('the exact search returns no positions for an empty needle instead of looping', () => {
    expect(findAllPositions('abc', '', 'exact', true)).toEqual([]);
    expect(findAllPositions('abc', '', 'fuzzy', true)).toEqual([]);
  });

  test('an empty find is refused and the file is unchanged', async () => {
    const file = write('a.ts', 'abc\n');
    const result = await tool().execute({ edits: [{ path: 'a.ts', find: '', replace: 'x' }] });
    expect(result.success).toBe(false);
    expect(result.output).toContain('find text is empty');
    expect(readFileSync(file, 'utf-8')).toBe('abc\n');
  });

  test('a find_base64 that decodes to nothing is refused too', async () => {
    const file = write('a.ts', 'abc\n');
    const result = await tool().execute({ edits: [{ path: 'a.ts', find: '', find_base64: '=', replace: 'x' }] });
    expect(result.success).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('abc\n');
  });
});

describe('base64 fields', () => {
  test('an edit with only the base64 fields runs', async () => {
    const file = write('a.ts', 'hello world\n');
    const result = await tool().execute({
      edits: [{ path: 'a.ts', find_base64: Buffer.from('hello').toString('base64'), replace_base64: Buffer.from('bye').toString('base64') }],
    });
    expect(result.success).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('bye world\n');
  });

  test('an empty replace_base64 deletes the match', async () => {
    const file = write('a.ts', 'hello world\n');
    const result = await tool().execute({ edits: [{ path: 'a.ts', find: 'hello ', replace_base64: '' }] });
    expect(result.success).toBe(true);
    expect(readFileSync(file, 'utf-8')).toBe('world\n');
  });

  test('a plain field that disagrees with its base64 twin is refused', async () => {
    const file = write('a.ts', 'hello world\n');
    const result = await tool().execute({
      edits: [{ path: 'a.ts', find: 'hello', replace: 'shown', replace_base64: Buffer.from('written').toString('base64') }],
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('replace and replace_base64 disagree');
    expect(readFileSync(file, 'utf-8')).toBe('hello world\n');
  });

  test('a missing replacement is refused instead of deleting the match', async () => {
    const file = write('a.ts', 'hello world\n');
    const result = await tool().execute({ edits: [{ path: 'a.ts', find: 'hello' }] });
    expect(result.success).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe('hello world\n');
  });
});

describe('hints bind the whole search', () => {
  const content = ['function foo() {', '  return 1;', '}', 'function bar() {', '  const x = 1;', '}', ''].join('\n');

  test('a match only outside the hinted function is not edited', async () => {
    const file = write('h.ts', content);
    const result = await tool().execute({ edits: [{ path: 'h.ts', find: 'const x = 1;', replace: 'const x = 2;', hints: { in_function: 'foo' } }] });
    expect(result.success).toBe(false);
    expect(result.output).toContain('[not_found]');
    expect(result.output).toContain('within the requested hints');
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  test('a whitespace-different copy outside the hinted function is not edited either', async () => {
    const file = write('h.ts', content);
    const result = await tool().execute({ edits: [{ path: 'h.ts', find: 'const   x = 1;', replace: 'const x = 2;', hints: { in_function: 'foo' } }] });
    expect(result.success).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  test('a missing anchor is reported and the edit does not land', async () => {
    const file = write('h.ts', content);
    const result = await tool().execute({ edits: [{ path: 'h.ts', find: 'return 1;', replace: 'return 2;', hints: { after: 'NO_SUCH_ANCHOR' } }] });
    expect(result.success).toBe(false);
    expect(result.output).toContain('after anchor "NO_SUCH_ANCHOR" not found');
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  test('a match inside the hinted function still applies', async () => {
    const file = write('h.ts', content);
    const result = await tool().execute({ edits: [{ path: 'h.ts', find: 'const x = 1;', replace: 'const x = 2;', hints: { in_function: 'bar' } }] });
    expect(result.success).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('const x = 2;');
  });
});

describe('occurrence all does not overlap', () => {
  test('aa in aaa is replaced once, not twice over the same character', async () => {
    const result = await computeSingleEdit('aaa', { path: 'a', find: 'aa', replace: 'b', occurrence: 'all' }, 'exact', true);
    expect(result).toMatchObject({ newContent: 'ba', occurrencesReplaced: 1 });
  });

  test('a run of newlines collapses by whole pairs', async () => {
    const result = await computeSingleEdit('a\n\n\nb', { path: 'a', find: '\n\n', replace: '\n', occurrence: 'all' }, 'exact', true);
    expect(result).toMatchObject({ newContent: 'a\n\nb' });
  });

  test('fuzzy token windows do not overlap', async () => {
    const result = await computeSingleEdit('a a a', { path: 'a', find: 'a a', replace: 'b', occurrence: 'all' }, 'fuzzy', true);
    expect(result).toMatchObject({ newContent: 'b a', occurrencesReplaced: 1 });
  });
});

describe('regex captures read the whole file', () => {
  test('a lookahead pattern keeps its capture group', async () => {
    const result = await computeSingleEdit('foobar', { path: 'a', find: '(foo)(?=bar)', replace: '$1-', occurrence: 'all' }, 'regex', true);
    expect(result).toMatchObject({ newContent: 'foo-bar' });
  });

  test('a dotAll pattern that spans a newline keeps both captures', async () => {
    const result = await computeSingleEdit('foo\nbar', { path: 'a', find: '(foo).(bar)', replace: '$2$1' }, 'regex', true, true, true);
    expect(result).toMatchObject({ newContent: 'barfoo' });
  });

  test('a lookbehind pattern keeps its capture group', async () => {
    const result = await computeSingleEdit('xa ya', { path: 'a', find: '(?<=y)(a)', replace: '[$1]' }, 'regex', true);
    expect(result).toMatchObject({ newContent: 'xa y[a]' });
  });
});

describe('ast_pattern nested matches', () => {
  test('occurrence all rewrites the outer call once and leaves well-formed text', async () => {
    const result = await computeAstPatternEdit('const x = foo(foo(1));\n', { path: 'a.ts', find: 'foo($A)', replace: 'wrap($A)', occurrence: 'all' }, 'a.ts');
    expect(result).toMatchObject({ newContent: 'const x = wrap(foo(1));\n', occurrencesReplaced: 1 });
  });
});

describe('hints bind ast and ast_pattern modes', () => {
  const content = ['function foo() {', '  return 1;', '}', 'function bar() {', '  const x = 1;', '}', ''].join('\n');

  test('match_mode ast does not edit a copy outside the hinted function', async () => {
    const file = write('ha.ts', content);
    const result = await tool().execute({ edits: [{ path: 'ha.ts', find: 'const x = 1;', replace: 'const x = 2;', match_mode: 'ast', hints: { in_function: 'foo' } }] });
    expect(result.success).toBe(false);
    expect(readFileSync(file, 'utf-8')).toBe(content);
  });

  test('match_mode ast still edits a copy inside the hinted function', async () => {
    const file = write('ha.ts', content);
    const result = await tool().execute({ edits: [{ path: 'ha.ts', find: 'const x = 1;', replace: 'const x = 2;', match_mode: 'ast', hints: { in_function: 'bar' } }] });
    expect(result.success).toBe(true);
    expect(readFileSync(file, 'utf-8')).toContain('const x = 2;');
  });

  test('ast_pattern keeps only matches inside the hinted function', async () => {
    const code = 'function foo() {\n  log(1);\n}\nfunction bar() {\n  log(2);\n}\n';
    const inside = await computeAstPatternEdit(code, { path: 'p.ts', find: 'log($A)', replace: 'warn($A)', hints: { in_function: 'bar' } }, 'p.ts');
    expect(inside).toMatchObject({ newContent: 'function foo() {\n  log(1);\n}\nfunction bar() {\n  warn(2);\n}\n', occurrencesReplaced: 1 });
    const outside = await computeAstPatternEdit(code, { path: 'p.ts', find: 'log($A)', replace: 'warn($A)', hints: { in_function: 'baz' } }, 'p.ts');
    expect('error' in outside && outside.error).toContain('requested hints');
  });
});

describe('a find text that is not in the file', () => {
  test('exact mode answers at once from code with the closest lines, asking nothing, however large the file', async () => {
    const lines = Array.from({ length: 5_000 }, (_, i) => `const v${i} = ${i};`);
    const result = await computeSingleEdit(lines.join('\n'), { path: 'big.ts', find: 'const v2500 = 25OO;', replace: 'x' }, 'exact', true);
    expect('error' in result && result.error).toContain('Find string not found in file. Closest text:');
    expect('error' in result && result.error).toContain('line 2501');
    expect(selectorCalls).toBe(0);
  });
});

describe('batch results', () => {
  test('count_only names the failed edits', async () => {
    write('a.ts', 'one\n');
    write('b.ts', 'two\n');
    const result = await tool().execute({
      edits: [
        { path: 'a.ts', find: 'one', replace: '1' },
        { path: 'b.ts', find: 'absent text', replace: '2', id: 'second' },
      ],
      transaction: { mode: 'partial' },
      output: { format: 'count_only' },
    });
    const summary = JSON.parse(result.output!) as { applied: number; failed: number; failed_edits: Array<{ path: string; id: string; status: string }> };
    expect(summary.applied).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.failed_edits).toEqual([expect.objectContaining({ path: 'b.ts', id: 'second', status: 'not_found' })]);
  });

  test('count_only keeps the dependents note inside the JSON', async () => {
    write('lib.ts', 'export const x = 1;\n');
    write('use.ts', "import { x } from './lib';\nexport const y = x;\n");
    const result = await tool().execute({ edits: [{ path: 'lib.ts', find: 'x = 1', replace: 'x = 2' }], output: { format: 'count_only' } });
    const summary = JSON.parse(result.output!) as { applied: number; notes: string[] };
    expect(summary.applied).toBe(1);
    expect(summary.notes.join(' ')).toContain('1 transitive dependent(s) affected');
  });

  test('count_only stays minimal when nothing failed', async () => {
    write('a.ts', 'one\n');
    const result = await tool().execute({ edits: [{ path: 'a.ts', find: 'one', replace: '1' }], output: { format: 'count_only' } });
    expect(JSON.parse(result.output!)).toEqual({ applied: 1, failed: 0, dry_run: false });
  });
});

describe('paths that fail containment', () => {
  test('a partial-mode edit of an outside path says why and the path is never read', async () => {
    write('inside.ts', 'one\n');
    const outside = mkdtempSync(join(tmpdir(), 'edit-outside-'));
    try {
      // A directory: reading it as a file would fail with a different message, so the
      // reported text proves the path was refused before any read.
      mkdirSync(join(outside, 'dir'));
      const result = await tool().execute({
        edits: [
          { path: join(outside, 'dir'), find: 'x', replace: 'y' },
          { path: 'inside.ts', find: 'one', replace: '1' },
        ],
        transaction: { mode: 'partial' },
      });
      expect(result.output).toContain('is outside the project root');
      expect(result.output).not.toContain('File not found or unreadable');
      expect(readFileSync(join(root, 'inside.ts'), 'utf-8')).toBe('1\n');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('notebook operations', () => {
  const notebook = (...sources: string[]): string => JSON.stringify({
    nbformat: 4, nbformat_minor: 5, metadata: {},
    cells: sources.map((source, i) => ({ cell_type: 'code', source: [source], metadata: {}, outputs: [], execution_count: null, id: `c${i}` })),
  });
  const sourcesOf = (path: string): string[] => (JSON.parse(readFileSync(path, 'utf-8')) as { cells: Array<{ source: string[] }> }).cells.map((c) => c.source.join(''));

  test('an appended cell does not shift the numbering of a later delete', async () => {
    const file = write('n.ipynb', notebook('A', 'B', 'C'));
    const result = await tool().execute({
      notebook_operations: { path: 'n.ipynb', operations: [{ op: 'insert', cell_type: 'code', source: 'X' }, { op: 'delete', cell: 0 }] },
    });
    expect(result.success).toBe(true);
    expect(sourcesOf(file)).toEqual(['B', 'C', 'X']);
  });

  test('a cell deleted earlier in the call cannot be addressed again', async () => {
    const file = write('n.ipynb', notebook('A', 'B'));
    const before = readFileSync(file, 'utf-8');
    const result = await tool().execute({
      notebook_operations: { path: 'n.ipynb', operations: [{ op: 'delete', cell: 0 }, { op: 'replace', cell: 0, source: 'Z' }] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('deleted by an earlier operation');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });

  test('options that only apply to text edits are refused instead of silently ignored', async () => {
    const file = write('n.ipynb', notebook('A'));
    const before = readFileSync(file, 'utf-8');
    const result = await tool().execute({
      notebook_operations: { path: 'n.ipynb', operations: [{ op: 'delete', cell: 0 }] },
      validate: { after: ['lint'] },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('validate');
    expect(readFileSync(file, 'utf-8')).toBe(before);
  });
});

describe('dependents scan', () => {
  test('stops past its time limit and says the dependents were not computed', async () => {
    const lib = write('lib.ts', 'export const x = 1;\n');
    write('use.ts', "import { x } from './lib';\nexport const y = x;\n");
    write('other.ts', 'export const z = 1;\n');
    // A clock that moves one second per file: the third file is past the 2.5 second limit.
    let clock = 0;
    const warning = await buildImportGraphWarning(root, new Set([lib]), () => {}, undefined, { maxMs: 2500, now: () => (clock += 1000) });
    expect(warning).toContain('scan stopped after 3s');
  });

  test('reports dependents without compiling anything when the scan completes', async () => {
    const lib = write('lib.ts', 'export const x = 1;\n');
    write('use.ts', "import { x } from './lib';\nexport const y = x;\n");
    const warning = await buildImportGraphWarning(root, new Set([lib]), () => {});
    expect(warning).toContain('1 transitive dependent(s) affected');
    expect(warning).toContain('not type-checked');
  });

  test('never runs a compiler found in the project', async () => {
    const marker = join(root, 'tsc-ran');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'tsc'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(join(root, 'node_modules', '.bin', 'tsc'), 0o755);
    write('lib.ts', 'export const x = 1;\n');
    write('use.ts', "import { x } from './lib';\nexport const y = x;\n");
    const result = await tool().execute({ edits: [{ path: 'lib.ts', find: 'x = 1', replace: 'x = 2' }] });
    expect(result.success).toBe(true);
    expect(result.output).toContain('not type-checked');
    expect(existsSync(marker)).toBe(false);
  });

  test('a cancelled call returns no warning', async () => {
    const lib = write('lib.ts', 'export const x = 1;\n');
    write('use.ts', "import { x } from './lib';\n");
    const controller = new AbortController();
    controller.abort();
    expect(await buildImportGraphWarning(root, new Set([lib]), () => {}, controller.signal)).toBeUndefined();
  });
});
