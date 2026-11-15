/**
 * analyze tool output: the short form keeps a refusal and a partial-coverage
 * note, and the scan-limit note is only claimed by modes that stop.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyzeTool } from '../platform/src/platform/tools/analyze/index.js';
import { MAX_SCAN_MS } from '../platform/src/platform/tools/analyze/shared.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'analyze-output-'));
  roots.push(root);
  writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
  return root;
}
const llm = { chat: async () => '' } as never;

test('a call that did nothing fails with the reason and what to pass instead', async () => {
  const tool = createAnalyzeTool(llm, null, project());
  const result = await tool.execute({ mode: 'impact', output: { format: 'summary' } });
  expect(result.success).toBe(false);
  expect(result.error).toContain('requires at least one file');
  expect(result.error).toContain('Pass files');
});

test('a mode with no deadline never claims it stopped at the scan limit, however long it took', async () => {
  const root = project();
  const real = Date.now.bind(Date);
  let calls = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? real() : real() + MAX_SCAN_MS + 1_000));
  try {
    const result = await createAnalyzeTool(llm, null, root).execute({ mode: 'env_audit' });
    expect(JSON.parse(result.output!).scan_note).toBeUndefined();
  } finally { clock.mockRestore(); }
});

test('the scan-limit note survives the short form', async () => {
  const root = project();
  const real = Date.now.bind(Date);
  let calls = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => (calls++ === 0 ? real() : real() + MAX_SCAN_MS + 1_000));
  try {
    const result = await createAnalyzeTool(llm, null, root).execute({ mode: 'dead_code', output: { format: 'summary' } });
    expect(JSON.parse(result.output!).scan_note).toContain('scan limit');
  } finally { clock.mockRestore(); }
});
