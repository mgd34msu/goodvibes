/**
 * The edit tool's result must match what is on disk: a conflict refusal
 * holds until the file is read again, a non-atomic validation failure says
 * which files keep the edits, and a rolled-back edit leaves no undo entry.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool } from '../platform/src/platform/tools/edit/index.js';
import { FindRuntimeService } from '../platform/src/platform/tools/find/shared.js';
import { FileStateCache } from '../platform/src/platform/state/file-cache.js';
import { FileUndoManager } from '../platform/src/platform/state/file-undo.js';
import type { ValidatorRunner } from '../platform/src/platform/tools/shared/validators.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-edit-truth-'));
  roots.push(root);
  return root;
}

const failingBuild: ValidatorRunner = async (validator) => ({ validator, passed: false, stdout: '', stderr: 'build broke', exitCode: 1 });

describe('edit conflict refusal', () => {
  test('an identical retry after a conflict is refused again until the file is read', async () => {
    const root = tempRoot();
    const file = join(root, 'a.ts');
    writeFileSync(file, 'const a = 1;\n');
    const cache = new FileStateCache();
    cache.update(file, 'const a = 1;\n');
    writeFileSync(file, 'const a = 1;\nconst b = 2;\n');
    const tool = createEditTool(cache, { cwd: root });
    const call = { edits: [{ path: 'a.ts', find: 'const a = 1;', replace: 'const a = 3;' }] };

    const first = await tool.execute(call);
    expect(first.success).toBe(false);
    expect(first.error).toContain('read it again before editing');
    const retry = await tool.execute(call);
    expect(retry.success).toBe(false);
    expect(retry.error).toContain('OCC conflict');
    expect(readFileSync(file, 'utf-8')).toBe('const a = 1;\nconst b = 2;\n');

    // Reading the file again records what the session now saw.
    const current = readFileSync(file, 'utf-8');
    expect(cache.compare(file, current)).toBe('modified');
    cache.update(file, current);
    const afterRead = await tool.execute(call);
    expect(afterRead.success).toBe(true);
  });
});

describe('edit validation results', () => {
  test('a non-atomic validation failure names the files that keep the edits and includes the per-edit output', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'b.ts'), 'old');
    const tool = createEditTool(new FileStateCache(), { cwd: root, validatorRunner: failingBuild });
    const result = await tool.execute({
      edits: [{ path: 'b.ts', find: 'old', replace: 'new' }],
      validate: { after: ['build'] },
      transaction: { mode: 'partial' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('edits remain applied to:');
    expect(result.error).toContain(join(root, 'b.ts'));
    expect(result.output).toContain('Edits applied: 1');
    expect(readFileSync(join(root, 'b.ts'), 'utf-8')).toBe('new');
  });

  test('an atomic rollback leaves no undo snapshot behind', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'c.ts'), 'old');
    const undo = new FileUndoManager();
    const tool = createEditTool(new FileStateCache(), { cwd: root, validatorRunner: failingBuild, fileUndoManager: undo });
    const result = await tool.execute({
      edits: [{ path: 'c.ts', find: 'old', replace: 'new' }],
      validate: { after: ['build'] },
      transaction: { mode: 'atomic' },
    });
    expect(result.error).toContain('edits rolled back');
    expect(readFileSync(join(root, 'c.ts'), 'utf-8')).toBe('old');
    expect(undo.undoDepth()).toBe(0);
  });

  test('a successful edit still records its undo snapshot', async () => {
    const root = tempRoot();
    writeFileSync(join(root, 'd.ts'), 'old');
    const undo = new FileUndoManager();
    const tool = createEditTool(new FileStateCache(), { cwd: root, fileUndoManager: undo });
    const result = await tool.execute({ edits: [{ path: 'd.ts', find: 'old', replace: 'new' }] });
    expect(result.success).toBe(true);
    expect(undo.undoDepth()).toBe(1);
  });

  test('a partial call where every edit fails carries an error summary', async () => {
    const root = tempRoot();
    const tool = createEditTool(new FileStateCache(), { cwd: root });
    const result = await tool.execute({
      edits: [{ path: 'e.ts', find: 'zzz', replace: 'y' }],
      transaction: { mode: 'partial' },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('No edits applied');
    expect(result.error).toContain('e.ts');
  });
});

describe('edit dependent type check', () => {
  test('never runs npx; without a local compiler it says dependents were not type-checked', async () => {
    const root = tempRoot();
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const marker = join(root, 'npx-ran');
    writeFileSync(join(bin, 'npx'), `#!/bin/sh\ntouch ${marker}\nexit 1\n`);
    chmodSync(join(bin, 'npx'), 0o755);
    writeFileSync(join(root, 'lib.ts'), 'export const x = 1;\n');
    writeFileSync(join(root, 'use.ts'), "import { x } from './lib';\nexport const y = x;\n");
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ''}`;
    try {
      const tool = createEditTool(new FileStateCache(), { cwd: root });
      const result = await tool.execute({ edits: [{ path: 'lib.ts', find: 'x = 1', replace: 'x = 2' }] });
      expect(result.success).toBe(true);
      expect(existsSync(marker)).toBe(false);
      expect(result.output).toContain('Import graph');
      expect(result.output).toContain('not type-checked');
    } finally {
      process.env.PATH = previousPath;
    }
  });
});

describe('edit and the cached import graph', () => {
  test('a successful edit makes a graph built before it stale', async () => {
    const root = tempRoot();
    const file = join(root, 'a.ts');
    writeFileSync(file, 'const a = 1;\n');
    const cache = new FileStateCache();
    cache.update(file, 'const a = 1;\n');
    const service = new FindRuntimeService();
    const before = await service.getImportGraph(root);
    expect(await service.getImportGraph(root)).toBe(before);
    const result = await createEditTool(cache, { cwd: root }).execute({ edits: [{ path: 'a.ts', find: 'const a = 1;', replace: 'const a = 2;' }] });
    expect(result.success).toBe(true);
    expect(await service.getImportGraph(root)).not.toBe(before);
  });
});
