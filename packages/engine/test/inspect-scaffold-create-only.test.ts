/** Scaffold creates a module skeleton; it never replaces files that already exist. */
import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InspectTool } from '../platform/src/platform/tools/inspect/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('scaffold refuses when a target exists, names it, and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-scaffold-')); roots.push(root);
  mkdirSync(join(root, 'src', 'utils'), { recursive: true });
  writeFileSync(join(root, 'src', 'utils', 'index.ts'), 'export const keep = 1;\n');
  const result = await new InspectTool(undefined, root).execute({ mode: 'scaffold', moduleName: 'utils', dryRun: false });
  expect(result.success).toBe(false);
  expect(result.error).toContain('src/utils/index.ts');
  expect(result.error).toContain('nothing was written');
  expect(readFileSync(join(root, 'src', 'utils', 'index.ts'), 'utf8')).toBe('export const keep = 1;\n');
  expect(existsSync(join(root, 'src', 'utils', 'types.ts'))).toBe(false);
});

test('scaffold still creates a new module', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gv-scaffold-')); roots.push(root);
  const result = await new InspectTool(undefined, root).execute({ mode: 'scaffold', moduleName: 'widget', dryRun: false });
  expect(result.success).toBe(true);
  expect(existsSync(join(root, 'src', 'widget', 'widget.ts'))).toBe(true);
});
