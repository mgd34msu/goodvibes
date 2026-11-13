/** The internal-identifier gate: planning shorthand and unfinished-work markers never land in tracked text. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { findViolations, scanTree } from '../scripts/check-internal-identifiers.ts';

const SCRIPT = resolve(import.meta.dir, '../scripts/check-internal-identifiers.ts');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'internal-id-'));
  roots.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe('findViolations', () => {
  test('flags every planning-identifier shape', () => {
    const banned = [
      'W' + '3.' + '1 shipped the renderer', 'tracked as ' + 'wo' + '402', 'see ' + 'WO-' + 'B', 'see ' + 'WO-' + '17',
      'the ' + 'DEBT-' + '4 entry', 'the ' + 'UX-' + 'A workstream', 'landed in ' + 'Wave ' + '5', 'landed in ' + 'Wave-' + '5', 'round ' + 'W2' + '-R3',
    ];
    for (const text of banned) expect(findViolations('platform/src/a.ts', `// ${text}`)).toHaveLength(1);
  });

  test('leaves ordinary technical text alone', () => {
    const fine = ["const code = 'WORKSPACE_BUSY';", '// bump to v3.1 for the release', "const status = 'TODO';", 'WORK_PLAN_TASK_CREATED'];
    for (const text of fine) expect(findViolations('platform/src/a.ts', text)).toEqual([]);
  });

  test('flags unfinished-work comments in source but not in tests or decision records', () => {
    const marker = '// ' + 'TO' + 'DO: wire this';
    expect(findViolations('platform/src/a.ts', marker)).toHaveLength(1);
    expect(findViolations('platform/src/a.test.ts', marker)).toEqual([]);
    expect(findViolations('test/a.ts', marker)).toEqual([]);
    expect(findViolations('docs/decisions/0001.md', 'landed in ' + 'Wave ' + '5')).toEqual([]);
  });
});

describe('check-internal-identifiers.ts (subprocess)', () => {
  const run = (root: string) => Bun.spawnSync({ cmd: ['bun', SCRIPT], env: { ...process.env, INTERNAL_ID_ROOT: root } });

  test('passes a clean tree and fails a tree with a planning identifier, reporting file and line', () => {
    const clean = tree({ 'platform/src/a.ts': 'export const a = 1;\n' });
    expect(scanTree(clean)).toEqual({ files: 1, violations: [] });
    expect(run(clean).exitCode).toBe(0);
    const dirty = tree({ 'platform/src/a.ts': 'export const a = 1;\n// ' + 'Wave ' + '5 work\n' });
    const result = run(dirty);
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('platform/src/a.ts:2');
  });

  test('the actual repository passes', () => {
    expect(scanTree().violations).toEqual([]);
  });
});
