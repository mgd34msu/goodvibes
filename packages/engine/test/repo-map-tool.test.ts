/**
 * repo-map-tool.test.ts
 *
 * The model-invoked, token-budgeted repo_map tool: it returns a ranked outline
 * of the repo (directory summary + highest-centrality source files with their
 * top-level exports), capped to a token budget. Covers: tool registration
 * (incl. contract verification), budget respected, stable ranking by import
 * centrality, and top-level export extraction.
 */
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoMapTool, extractTopLevelExports } from '../platform/src/platform/tools/repo-map/index.ts';
import { ImportGraph } from '../platform/src/platform/intelligence/import-graph.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import { estimateTokens } from '../platform/src/platform/core/compaction-types.ts';

/** A small repo where core.ts is imported by two files (highest centrality). */
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-map-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'core.ts'), 'export const CORE = 1;\nexport function coreFn() { return CORE; }\n');
  writeFileSync(join(root, 'src', 'a.ts'), "import { CORE } from './core.js';\nexport const a = CORE;\n");
  writeFileSync(join(root, 'src', 'b.ts'), "import { coreFn } from './core.js';\nexport const b = coreFn();\n");
  writeFileSync(join(root, 'src', 'index.ts'), "import { a } from './a.js';\nimport { b } from './b.js';\nexport const all = [a, b];\n");
  return root;
}

// ── registration ──────────────────────────────────────────────────────────────

describe('repo_map registration', () => {
  test('registers with the tool registry and passes contract verification', () => {
    const registry = new ToolRegistry();
    const result = registry.registerWithContract(createRepoMapTool({ projectRoot: makeRepo() }), {
      strictIdempotency: false,
      strictPermissionClass: false,
    });
    expect(result.passed).toBe(true);
    expect(registry.has('repo_map')).toBe(true);
    const def = registry.getToolDefinitions().find((d) => d.name === 'repo_map');
    expect(def?.sideEffects).toEqual(['read_fs']);
  });
});

// ── export extraction ────────────────────────────────────────────────────────

describe('extractTopLevelExports', () => {
  test('captures declarations, named re-exports, and default', () => {
    const src = [
      'export const A = 1;',
      'export function fn() {}',
      'export class C {}',
      'export interface I {}',
      'export type T = number;',
      'export { x, y as z };',
      'export default 42;',
    ].join('\n');
    const names = extractTopLevelExports(src);
    for (const n of ['A', 'fn', 'C', 'I', 'T', 'x', 'z', 'default']) {
      expect(names).toContain(n);
    }
  });
});

// ── output + ranking + budget ───────────────────────────────────────────────────

describe('repo_map execution', () => {
  test('produces a structured map with the most-imported file ranked first', async () => {
    const tool = createRepoMapTool({ projectRoot: makeRepo() });
    const result = await tool.execute({ budgetTokens: 2000 });
    expect(result.success).toBe(true);
    const output = result.output as string;
    expect(output).toContain('Repository map');
    expect(output).toContain('Directories:');
    expect(output).toContain('Key files');
    // core.ts has two dependents (a.ts, b.ts) → ranked ahead of every other file.
    const coreIdx = output.indexOf('src/core.ts');
    const aIdx = output.indexOf('src/a.ts');
    const indexIdx = output.indexOf('src/index.ts');
    expect(coreIdx).toBeGreaterThan(-1);
    expect(coreIdx).toBeLessThan(aIdx);
    expect(coreIdx).toBeLessThan(indexIdx);
    // exports of core surfaced.
    expect(output).toContain('coreFn');
  });

  test('respects the token budget', async () => {
    const tool = createRepoMapTool({ projectRoot: makeRepo() });
    const budgetTokens = 300;
    const result = await tool.execute({ budgetTokens });
    expect(result.success).toBe(true);
    expect(estimateTokens(result.output as string)).toBeLessThanOrEqual(budgetTokens);
  });

  test('ranking is stable across repeated runs', async () => {
    const tool = createRepoMapTool({ projectRoot: makeRepo() });
    const first = await tool.execute({ budgetTokens: 2000 });
    const second = await tool.execute({ budgetTokens: 2000 });
    expect(first.output).toBe(second.output);
  });
});


test('an omitted map budget includes every file and export beyond the former caps', async () => {
  const root = makeRepo();
  for (let file = 0; file < 80; file++) writeFileSync(join(root, `src/large-${file}.ts`),
    Array.from({ length: 30 }, (_, index) => `export const symbol_${file}_${index} = ${index};`).join('\n'));
  const tool = createRepoMapTool({ projectRoot: root });
  const result = await tool.execute({});
  expect(result.success).toBe(true);
  expect(estimateTokens(result.output!)).toBeGreaterThan(2_000);
  for (let file = 0; file < 80; file++) expect(result.output).toContain(`symbol_${file}_29`);
  const explicit = await tool.execute({ budgetTokens: 100_000 });
  expect(explicit.output).toContain('symbol_79_29');
});

function structurePaths(output: string): string[] {
  return output.split('\n').filter(line => line.startsWith('[')).flatMap(line => {
    const [directory, names] = JSON.parse(line) as [string, string[]];
    return names.map(name => directory === '.' ? name : `${directory}/${name}`);
  });
}

describe('repo_map structure detail', () => {
  test('preserves every discovered path without a symbol budget, graph build or source permission request', async () => {
    const root = makeRepo();
    const names = Array.from({ length: 100 }, (_, index) => `extra-${index}.ts`);
    for (const name of names) writeFileSync(join(root, 'src', name), 'export const PRIVATE_SOURCE_SYMBOL = 1;\n');
    writeFileSync(join(root, 'root.ts'), 'export const PRIVATE_ROOT_SYMBOL = 2;\n');
    writeFileSync(join(root, 'src', 'quote"name.ts'), 'export const PRIVATE_ODD_SYMBOL = 3;\n');
    mkdirSync(join(root, 'node_modules'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'dependency.ts'), 'export const DEPENDENCY = 4;\n');
    let permissionRequests = 0;
    const denyContents = async () => { permissionRequests++; return false; };
    const build = spyOn(ImportGraph.prototype, 'build').mockImplementation(async () => { throw new Error('Structure must not build an import graph'); });
    try {
      const tool = createRepoMapTool({ projectRoot: root, readAccessFilter: denyContents, capturedReadAccess: denyContents });
      const result = await tool.execute({ detail: 'structure', budgetTokens: 1 });
      expect(result.success).toBe(true);
      expect(build).not.toHaveBeenCalled();
      expect(permissionRequests).toBe(0);
      expect(result.output).not.toContain('PRIVATE_');
      expect(result.output).not.toContain('omitted');
      expect(result.output).toContain('does not establish content read permission');
      expect(structurePaths(result.output!).sort()).toEqual([
        'root.ts', 'src/a.ts', 'src/b.ts', 'src/core.ts', 'src/index.ts', 'src/quote"name.ts',
        ...names.map(name => `src/${name}`),
      ].sort());
    } finally { build.mockRestore(); }
  });

  test('uses the requested subdirectory as root and orders complete paths consistently', async () => {
    const root = makeRepo();
    const tool = createRepoMapTool({ projectRoot: root });
    const first = await tool.execute({ detail: 'structure', path: 'src' });
    const second = await tool.execute({ detail: 'structure', path: 'src' });
    expect(first.success).toBe(true);
    expect(first.output).toBe(second.output);
    expect(structurePaths(first.output!)).toEqual(['a.ts', 'b.ts', 'core.ts', 'index.ts']);
    expect(first.output).not.toContain('coreFn');
  });

  test('retained captured inputs require their construction-owned authority even for structure discovery', async () => {
    const root = makeRepo();
    const captured = join(root, '.goodvibes', '.worktrees', 'contract-input', 'old');
    mkdirSync(captured, { recursive: true });
    writeFileSync(join(captured, 'private.ts'), 'export const PRIVATE_CAPTURED_SYMBOL = 1;\n');
    const tool = createRepoMapTool({ projectRoot: root });
    const live = await tool.execute({ detail: 'structure' });
    expect(live.success).toBe(true);
    expect(live.output).not.toContain('private.ts');
    expect(structurePaths(live.output!)).toHaveLength(4);
    const retained = await tool.execute({ detail: 'structure', path: captured });
    expect(retained.success).toBe(false);
    expect(retained.error).toContain('construction-owned authority');
  });
});
