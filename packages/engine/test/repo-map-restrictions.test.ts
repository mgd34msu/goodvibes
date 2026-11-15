/**
 * repo_map never presents a partial map as complete: a file whose symbols are
 * withheld by a captured read filter is flagged and counted, an unreadable
 * file is flagged, and the import graph's own warnings are shown.
 */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRepoMapTool } from '../platform/src/platform/tools/repo-map/index.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) { try { chmodSync(join(root, 'src', 'locked'), 0o755); } catch { /* not created */ } rmSync(root, { recursive: true, force: true }); } });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'repo-map-restricted-')); roots.push(root);
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'core.ts'), 'export const CORE = 1;\n');
  writeFileSync(join(root, 'src', 'secret.ts'), 'export const SECRET_EXPORT = 1;\n');
  writeFileSync(join(root, 'src', 'a.ts'), "import { CORE } from './core.js';\nexport const a = CORE;\n");
  return root;
}

test('a file the captured filter denies is flagged access-restricted, counted, and its exports are not shown', async () => {
  const root = repo();
  const tool = createRepoMapTool({ projectRoot: root, capturedReadAccess: async (path) => !path.endsWith('secret.ts') });
  const result = await tool.execute({});
  expect(result.success).toBe(true);
  expect(result.output).not.toContain('SECRET_EXPORT');
  const line = (result.output ?? '').split('\n').find((entry) => entry.includes('src/secret.ts'));
  expect(line).toContain('[access-restricted]');
  expect(result.output).toContain('1 result in access-restricted file');
});

test.skipIf(process.getuid?.() === 0)('a directory the map could not read is named in the output, not silently missing', async () => {
  const root = repo();
  mkdirSync(join(root, 'src', 'locked'));
  writeFileSync(join(root, 'src', 'locked', 'hidden.ts'), 'export const HIDDEN = 1;\n');
  chmodSync(join(root, 'src', 'locked'), 0o000);
  const tool = createRepoMapTool({ projectRoot: root });
  const result = await tool.execute({});
  expect(result.output).toContain('Discovery warnings');
  expect(result.output).toContain('src/locked');
});
