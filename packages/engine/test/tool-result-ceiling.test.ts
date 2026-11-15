import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CEILING_TOKENS, capToolText } from '../platform/src/platform/runtime/tools/output-policy.js';
import { applyAnalyzeTokenBudget } from '../platform/src/platform/tools/analyze/shared.js';
import { InspectTool } from '../platform/src/platform/tools/inspect/index.js';

test('a result over the ceiling is cut on a line boundary and says how much was kept', () => {
  const text = Array.from({ length: 400 }, (_, i) => `row ${i}`).join('\n');
  const cut = capToolText(text, 100, 'Narrow it.');
  expect(cut.startsWith('row 0\nrow 1\n')).toBe(true);
  expect(cut).toMatch(/\[Output cut: kept the first \d+ of \d+ characters \(limit 100 tokens\)\. Narrow it\.\]$/);
  expect(cut.split('\n[Output cut')[0]!.endsWith('\n')).toBe(false);
  expect(capToolText('short', 100, 'x')).toBe('short');
});

test('analyze output over the default ceiling is cut with a note; an explicit max_tokens wins either way', () => {
  const big = 'x'.repeat(DEFAULT_CEILING_TOKENS.analyze * 4 + 500);
  expect(applyAnalyzeTokenBudget(big, undefined)).toContain('[Output cut: kept the first');
  expect(applyAnalyzeTokenBudget(big, DEFAULT_CEILING_TOKENS.analyze * 2)).toBe(big);
  expect(applyAnalyzeTokenBudget('x'.repeat(2000), 100)).toContain('limit 100 tokens');
});

test('inspect honours its advertised output.max_tokens', async () => {
  const root = mkdtempSync(join(tmpdir(), 'inspect-ceiling-'));
  try {
    const tool = new InspectTool(null, root);
    const full = await tool.execute({ mode: 'api_spec', projectRoot: root });
    expect(full.success).toBe(true);
    expect(full.output!.length).toBeGreaterThan(40);
    const capped = await tool.execute({ mode: 'api_spec', projectRoot: root, output: { max_tokens: 1 } });
    expect(capped.output).toContain('[Output cut: kept the first');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('an analyze scan that ran into its time limit says the result covers only part of the tree', async () => {
  const { createAnalyzeTool } = await import('../platform/src/platform/tools/analyze/index.js');
  const { MAX_SCAN_MS } = await import('../platform/src/platform/tools/analyze/shared.js');
  const { writeFileSync } = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'analyze-limit-'));
  try {
    writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
    // The first read is the scan start; every later one is past the limit, as a very large tree would make it.
    let reads = 0;
    const slowClock = () => (reads++ === 0 ? 0 : MAX_SCAN_MS + 1_000);
    const slow = await createAnalyzeTool({ chat: async () => '' } as never, null, root, slowClock).execute({ mode: 'dead_code' });
    expect(slow.success).toBe(true);
    expect(JSON.parse(slow.output!).scan_note).toContain('scan limit');
    const fast = await createAnalyzeTool({ chat: async () => '' } as never, null, root, () => 0).execute({ mode: 'dead_code' });
    expect(JSON.parse(fast.output!).scan_note).toBeUndefined();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
