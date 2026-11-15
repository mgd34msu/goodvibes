/** find keeps each query's page within its token budget and keeps the rest reachable. */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFindTool } from '../platform/src/platform/tools/find/index.js';
import { paginateFindResult, DEFAULT_FIND_PAGE_CHARS } from '../platform/src/platform/tools/find/pagination.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('output.max_tokens shortens a files page and next_offset continues it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'find-budget-')); roots.push(root);
  for (let i = 0; i < 300; i++) writeFileSync(join(root, `file-with-a-long-name-${String(i).padStart(4, '0')}.txt`), 'x');
  const tool = createFindTool(root);
  const first = JSON.parse((await tool.execute({ queries: [{ id: 'q', mode: 'files' }], output: { max_results: 2000, max_tokens: 500 } })).output!).q;
  expect(JSON.stringify(first).length).toBeLessThanOrEqual(500 * 4);
  expect(first.has_more).toBe(true);
  expect(first.page_shortened_to_fit).toBe('max_tokens');
  expect(first.files[0]).toBe('file-with-a-long-name-0000.txt');
  const second = JSON.parse((await tool.execute({ queries: [{ id: 'q', mode: 'files' }], output: { max_results: 2000, max_tokens: 500, offset: first.next_offset } })).output!).q;
  expect(second.files[0]).toBe(`file-with-a-long-name-${String(first.returned).padStart(4, '0')}.txt`);
});

test('without max_tokens a page is bounded by the default size limit', () => {
  const rows = Array.from({ length: 5000 }, (_, i) => `/very/long/absolute/prefix/for/each/path/number/${i}.ts`);
  const page = paginateFindResult({ files: rows, count: rows.length }, { max_results: 5000 });
  expect(JSON.stringify(page).length).toBeLessThanOrEqual(DEFAULT_FIND_PAGE_CHARS);
  expect(page.page_shortened_to_fit).toBe('default_size_limit');
  expect(page.total).toBe(5000);
});
