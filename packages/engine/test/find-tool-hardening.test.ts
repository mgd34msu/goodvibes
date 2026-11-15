// The find tool keeps one query's failure from costing the others, reports
// lines the way it takes them, applies the read gate to everything it reports,
// and does not let what one call asked for leak into the next through the cache.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFindTool } from '../platform/src/platform/tools/find/index.ts';
import type { FindCodeIntelligence } from '../platform/src/platform/tools/find/references.ts';

const roots: string[] = [];
function tempRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-find-hardening-')));
  roots.push(root);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

interface QueryResult {
  readonly error?: string;
  readonly files?: string[];
  readonly count?: number;
  readonly warnings?: string[];
  readonly locations?: Array<{ file: string }>;
  readonly matches?: Array<{ file: string; line: number; text: string; startLine?: number; endLine?: number }>;
}
interface FindReply { readonly success: boolean; readonly error?: string | undefined; readonly results: Record<string, QueryResult> }
const at = (reply: FindReply, id: string): QueryResult => reply.results[id] ?? {};

async function run(tool: ReturnType<typeof createFindTool>, args: Record<string, unknown>): Promise<FindReply> {
  const reply = await tool.execute(args);
  return { success: reply.success, error: reply.error, results: reply.output ? JSON.parse(reply.output) as Record<string, QueryResult> : {} };
}

describe('queries are independent', () => {
  test('an invalid pattern in one query leaves the others their results', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const reply = await run(createFindTool(root), { queries: [
      { id: 'bad', mode: 'content', pattern: '(' },
      { id: 'good', mode: 'files', patterns: ['*.ts'] },
    ] });
    expect(reply.success).toBe(true);
    expect(at(reply, 'bad').error).toMatch(/content query failed/);
    expect(at(reply, 'good').files).toEqual(['a.ts']);
  });

  test('two queries with one id are refused before anything is searched', async () => {
    const root = tempRoot();
    const reply = await run(createFindTool(root), { queries: [
      { id: 'a', mode: 'files', patterns: ['*.ts'] },
      { id: 'a', mode: 'content', pattern: 'x' },
    ] });
    expect(reply.success).toBe(false);
    expect(reply.error).toMatch(/Duplicate query id 'a'/);
  });

  test('a call where every query failed is not a success, and keeps the per-query errors', async () => {
    const root = tempRoot();
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'content' }] });
    expect(reply.success).toBe(false);
    expect(reply.error).toMatch(/All 1 find query failed: q: content mode requires pattern/);
    expect(at(reply, 'q').error).toMatch(/requires pattern/);
  });
});

describe('references', () => {
  const recording = (positions: Array<{ line: number; column: number }>): FindCodeIntelligence => ({
    async getReferences(_file, line, column) { positions.push({ line, column }); return []; },
    async getEnclosingScope() { return null; },
  });

  test('the line is one-based, as find results report it, and the language server gets it zero-based', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const positions: Array<{ line: number; column: number }> = [];
    const tool = createFindTool(root, undefined, undefined, undefined, undefined, undefined, recording(positions));
    await run(tool, { queries: [{ id: 'r', mode: 'references', file: 'a.ts', symbol: 'a', line: 10, column: 4 }] });
    expect(positions).toEqual([{ line: 9, column: 4 }]);
  });

  test('an injected code intelligence is initialized once before its first query', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const events: string[] = [];
    const intelligence = {
      async initialize() { events.push('initialize'); },
      async getReferences() { events.push('references'); return []; },
      async getEnclosingScope() { return null; },
    };
    const tool = createFindTool(root, undefined, undefined, undefined, undefined, undefined, intelligence);
    const query = { id: 'r', mode: 'references', file: 'a.ts', symbol: 'a', line: 1, column: 13 };
    await run(tool, { queries: [query] });
    await run(tool, { queries: [query] });
    expect(events).toEqual(['initialize', 'references', 'references']);
  });

  test('line 0 is refused with the convention named', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'r', mode: 'references', file: 'a.ts', symbol: 'a', line: 0, column: 0 }] });
    expect(at(reply, 'r').error).toMatch(/one-based/);
  });

  test('locations in a file the read gate holds back are not reported, and the count says so', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export const API_SECRET = 1;\n');
    writeFileSync(join(root, 'secret.ts'), 'const copy = API_SECRET;\n');
    writeFileSync(join(root, 'ok.ts'), 'const use = API_SECRET;\n');
    const tool = createFindTool(root, undefined, undefined, async (path) => !path.endsWith('secret.ts'));
    const reply = await run(tool, { queries: [{ id: 'r', mode: 'references', file: 'a.ts', symbol: 'API_SECRET', line: 1, column: 13 }] });
    const files = (at(reply, 'r').locations ?? []).map((location) => location.file.slice(root.length + 1)).sort();
    expect(files).toEqual(['a.ts', 'ok.ts']);
    expect(JSON.stringify(at(reply, 'r').warnings)).toMatch(/access-restricted/);
  });
});

describe('the search cache', () => {
  test('a restriction that is lifted between two identical searches shows the file in the second', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'open.txt'), 'needle here\n');
    writeFileSync(join(root, 'held.txt'), 'needle there\n');
    let restricted = true;
    const tool = createFindTool(root, undefined, undefined, async (path) => !(restricted && path.endsWith('held.txt')));
    const query = { queries: [{ id: 'q', mode: 'content', pattern: 'needle' }], output: { format: 'files_only' } };
    expect(at(await run(tool, query), 'q').files).toEqual([join(root, 'open.txt')]);
    restricted = false;
    expect([...(at(await run(tool, query), 'q').files ?? [])].sort()).toEqual([join(root, 'held.txt'), join(root, 'open.txt')]);
  });

  test('scope expansion asked for by one call does not appear in the next call\'s matches', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'function outer() {\n  return needle;\n}\n');
    const intelligence: FindCodeIntelligence = {
      async getReferences() { return []; },
      async getEnclosingScope() { return { kind: 'function', name: 'outer', startLine: 1, endLine: 3 }; },
    };
    const tool = createFindTool(root, undefined, undefined, undefined, undefined, undefined, intelligence);
    const base = { queries: [{ id: 'q', mode: 'content', pattern: 'needle' }] };
    const expanded = await run(tool, { ...base, output: { expand_to: 'function' } });
    expect(at(expanded, 'q').matches?.[0]).toMatchObject({ startLine: 1, endLine: 3 });
    const plain = await run(tool, base);
    expect(at(plain, 'q').matches?.[0]?.startLine).toBeUndefined();
    const again = await run(tool, { ...base, output: { expand_to: 'function' } });
    expect(at(again, 'q').matches?.[0]).toMatchObject({ startLine: 1, endLine: 3 });
  });

  test('expand_to works with the built-in tree-sitter when no code intelligence is injected', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'function outer() {\n  const x = 1;\n  return needle;\n}\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'content', pattern: 'needle' }], output: { expand_to: 'function' } });
    expect(at(reply, 'q').matches?.[0]).toMatchObject({ startLine: 1, endLine: 4 });
  });
});

describe('content mode details', () => {
  test('negate does not list binary files as files without the pattern', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'plain.txt'), 'nothing relevant\n');
    writeFileSync(join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x1a, 0x0a, 0x00]));
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'content', pattern: 'needle', negate: true }] });
    expect((at(reply, 'q').files ?? []).map((file) => file.slice(root.length + 1))).toEqual(['plain.txt']);
  });

  test('a Windows line ending does not stop an end-of-line pattern matching', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'win.txt'), 'first foo\r\nsecond\r\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'content', pattern: 'foo$' }] });
    expect(at(reply, 'q').matches).toHaveLength(1);
    expect(at(reply, 'q').matches?.[0]?.text).toBe('first foo');
  });

  test('multiline says it has no effect instead of silently matching nothing', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'a\nb\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'content', pattern: 'a\\nb', multiline: true }] });
    expect(at(reply, 'q').count).toBe(0);
    expect(JSON.stringify(at(reply, 'q').warnings)).toMatch(/multiline has no effect/);
  });

  test('a format that belongs to files mode is replaced and the call says so', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'needle\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'content', pattern: 'needle' }], output: { format: 'with_stats' } });
    expect(at(reply, 'q').matches).toHaveLength(1);
    expect(JSON.stringify(at(reply, 'q').warnings)).toMatch(/only valid for files mode/);
  });

  test('a content format given to files mode returns the file list and says so', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'x\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'files', patterns: ['*.txt'] }], output: { format: 'matches' } });
    expect(at(reply, 'q').files).toEqual(['a.txt']);
    expect(JSON.stringify(at(reply, 'q').warnings)).toMatch(/does not apply to files mode/);
  });

  test('a page size of zero is refused instead of returning an endless empty page', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.txt'), 'x\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'files', patterns: ['*.txt'] }], output: { max_results: 0 } });
    expect(at(reply, 'q').error).toMatch(/at least 1/);
  });
});

describe('files mode', () => {
  test('a root-anchored ignore rule applies to a search that starts in a subdirectory', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'src/generated'), { recursive: true });
    writeFileSync(join(root, '.gitignore'), 'src/generated/\n');
    writeFileSync(join(root, 'src/keep.ts'), 'x\n');
    writeFileSync(join(root, 'src/generated/skip.ts'), 'x\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 'q', mode: 'files', path: 'src', patterns: ['**/*.ts'] }] });
    expect((at(reply, 'q').files ?? []).map((file) => file.replace(/^src\//, ''))).toEqual(['keep.ts']);
  });
});

describe('symbols mode names the options it does not use', () => {
  test('a content format and context lines are reported, not silently dropped', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 's', mode: 'symbols' }], output: { format: 'context', context_before: 2 } });
    const warnings = at(reply, 's').warnings ?? [];
    expect(warnings.some((w) => /'context' does not apply to symbols mode/.test(w))).toBe(true);
    expect(warnings.some((w) => /context_before and context_after/.test(w))).toBe(true);
  });

  test('a symbols format raises no warning', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'export function alpha() {}\n');
    const reply = await run(createFindTool(root), { queries: [{ id: 's', mode: 'symbols' }], output: { format: 'signatures' } });
    expect(at(reply, 's').warnings ?? []).toEqual([]);
  });
});
