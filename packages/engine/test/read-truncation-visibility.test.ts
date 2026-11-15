/**
 * What a read did not return is stated at the top level: clipped files carry a
 * continuation line, binary skips carry a reason, and one restricted path does
 * not fail the other files in the batch.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { ReadTool } from '../platform/src/platform/tools/read/index.js';

let root: string;
let index: ProjectIndex;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'read-truncation-'));
  writeFileSync(join(root, 'long.ts'), Array.from({ length: 200 }, (_, i) => `export const value${i} = ${i};`).join('\n'));
  writeFileSync(join(root, 'nul.ts'), 'export const a = 1;\0\n');
  index = new ProjectIndex(root);
});
afterEach(async () => { await index.dispose(); rmSync(root, { recursive: true, force: true }); });

test('a max_tokens clip is listed in summary.truncated with the line to continue from', async () => {
  const result = await new ReadTool(index).execute({ files: [{ path: 'long.ts' }], output: { max_tokens: 100 } });
  const output = JSON.parse(result.output!);
  const [entry] = output.summary.truncated;
  expect(entry.path).toBe('long.ts');
  expect(entry.reason).toBe('max_tokens');
  expect(entry.next_start_line).toBe(entry.returned_lines + 1);
  expect(output.summary.returned_tokens).toBeLessThanOrEqual(100);
  expect(output.summary.source_tokens).toBe(output.summary.total_tokens);
  expect(output.files[0].tokenEstimate).toBeUndefined();
});

test('a max_per_item limit is listed as truncated too', async () => {
  const result = await new ReadTool(index).execute({ files: [{ path: 'long.ts' }], output: { max_per_item: 10 } });
  const output = JSON.parse(result.output!);
  expect(output.summary.truncated).toEqual([{ path: 'long.ts', returned_lines: 10, next_start_line: 11, reason: 'max_per_item' }]);
});

test('a complete read lists nothing as truncated', async () => {
  const output = JSON.parse((await new ReadTool(index).execute({ files: [{ path: 'long.ts' }] })).output!);
  expect(output.summary.truncated).toBeUndefined();
});

test('a binary skip says why and how to read it anyway', async () => {
  const skipped = JSON.parse((await new ReadTool(index).execute({ files: [{ path: 'nul.ts' }] })).output!);
  expect(skipped.files[0].binary).toBe(true);
  expect(skipped.files[0].skipped).toContain('NUL byte at offset 19');
  const forced = JSON.parse((await new ReadTool(index).execute({ files: [{ path: 'nul.ts', force_text: true }] })).output!);
  expect(forced.files[0].content).toContain('export const a = 1;');
});

test('one access-restricted path fails only that file', async () => {
  const tool = new ReadTool(index, undefined, undefined, async (path) => !path.endsWith('nul.ts'));
  const result = await tool.execute({ files: [{ path: 'long.ts', range: { start: 1, end: 2 }, extract: 'lines' }, { path: 'nul.ts' }] });
  expect(result.success).toBe(true);
  const output = JSON.parse(result.output!);
  expect(output.files[0].content).toContain('value0');
  expect(output.files[1].error).toContain('Access restricted');
});

test('without max_tokens a very large file is still bounded and says where to continue', async () => {
  writeFileSync(join(root, 'huge.ts'), Array.from({ length: 20_000 }, (_, i) => `export const v${i} = '${'x'.repeat(20)}';`).join('\n'));
  const output = JSON.parse((await new ReadTool(index).execute({ files: [{ path: 'huge.ts' }] })).output!);
  expect(output.summary.returned_tokens).toBeLessThanOrEqual(25_000);
  expect(output.summary.truncated[0].reason).toBe('max_tokens');
});

test('the standing token budget pages a batch when the call sets none, and an explicit budget wins', async () => {
  writeFileSync(join(root, 'second.ts'), Array.from({ length: 200 }, (_, i) => `export const other${i} = ${i};`).join('\n'));
  const files = [{ path: 'long.ts' }, { path: 'second.ts' }];
  const standing = new ReadTool(index, undefined, undefined, undefined, () => false, () => 500);

  const first = JSON.parse((await standing.execute({ files })).output!);
  expect(first.pagination.pending_files).toEqual(['second.ts']);

  const explicit = JSON.parse((await standing.execute({ files, token_budget: 1_000_000 })).output!);
  expect(explicit.pagination?.pending_files ?? []).toEqual([]);

  const unset = JSON.parse((await new ReadTool(index, undefined, undefined, undefined, () => false, () => 0).execute({ files })).output!);
  expect(unset.pagination?.pending_files ?? []).toEqual([]);
});
