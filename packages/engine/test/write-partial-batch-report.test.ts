/**
 * A non-atomic write batch that stops part-way, or partly fails, must leave a
 * truthful record: the files already on disk are named, and undo covers them.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { ConfigManager } from '../platform/src/platform/config/manager.js';
import { FileStateCache } from '../platform/src/platform/state/file-cache.js';
import { FileUndoManager } from '../platform/src/platform/state/file-undo.js';
import { createWriteTool } from '../platform/src/platform/tools/write/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-write-partial-'));
  roots.push(root);
  return root;
}

test('a terminal heal failure mid-batch names the files already written and records their undo and cache state', async () => {
  const root = tempRoot();
  const undo = new FileUndoManager();
  const cache = new FileStateCache();
  const tool = createWriteTool({
    projectRoot: root, fileUndoManager: undo, fileCache: cache,
    configManager: { get: ((key: string) => key === 'tools.autoHeal' ? true : 'on') as ConfigManager['get'] },
    toolLLM: { chat: async () => 'unused' },
  });
  const which = spyOn(Bun, 'which').mockReturnValue(null);
  const terminal = new JudgmentError('unavailable', 'terminal heal judgment');
  const previous = installJudgmentPort({ model: 'fixture', ask: async () => { throw terminal; } });
  try {
    const call = tool.execute({ files: [
      { path: 'one.txt', content: 'one\n' },
      { path: 'broken.ts', content: 'export const x = ;\n' },
      { path: 'later.txt', content: 'later\n' },
    ] });
    await expect(call).rejects.toBe(terminal);
    expect(terminal.message).toContain('Files already written by this call before it stopped: one.txt, broken.ts');
    expect(readFileSync(join(root, 'broken.ts'), 'utf8')).toBe('export const x = ;\n');
    // Both files the call wrote are one undo entry.
    expect(undo.undoDepth()).toBe(1);
    expect(undo.peekUndo()?.operations.length).toBe(2);
    expect(cache.compare(join(root, 'broken.ts'), readFileSync(join(root, 'broken.ts'), 'utf8'))).toBe('unchanged');
  } finally {
    installJudgmentPort(previous);
    which.mockRestore();
  }
});

test('a partial failure in default verbosity lists written paths and carries an error summary', async () => {
  const root = tempRoot();
  writeFileSync(join(root, 'exists.txt'), 'keep');
  const tool = createWriteTool({ projectRoot: root });
  const result = await tool.execute({ files: [
    { path: 'new.txt', content: 'new' },
    { path: 'exists.txt', content: 'replace' },
  ] });
  expect(result.success).toBe(false);
  expect(result.error).toContain('1 of 2 file(s) failed; 1 written');
  const output = JSON.parse(result.output ?? '{}') as { written_paths?: string[]; errors?: string[] };
  expect(output.written_paths).toEqual(['new.txt']);
  expect(output.errors?.[0]).toContain('exists.txt');
  expect(readFileSync(join(root, 'exists.txt'), 'utf8')).toBe('keep');
});

test('an atomic rollback removes the backup copy and index entries this call created', async () => {
  const { ProjectIndex } = await import('../platform/src/platform/state/project-index.js');
  const { existsSync } = await import('node:fs');
  const root = tempRoot();
  writeFileSync(join(root, 'kept.txt'), 'original');
  writeFileSync(join(root, 'blocker.txt'), 'exists');
  const index = new ProjectIndex(root);
  try {
    const tool = createWriteTool({ projectRoot: root, projectIndex: index });
    const result = await tool.execute({ transaction: { mode: 'atomic' }, files: [
      { path: 'kept.txt', content: 'changed', mode: 'backup' },
      { path: 'fresh.txt', content: 'new' },
      { path: 'blocker.txt', content: 'x' },
    ] });
    expect(result.success).toBe(false);
    expect(readFileSync(join(root, 'kept.txt'), 'utf8')).toBe('original');
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false);
    expect(index.getFile(join(root, 'fresh.txt'))).toBeNull();
    const backups = join(root, '.goodvibes', '.backups');
    const { readdirSync } = await import('node:fs');
    const left = existsSync(backups) ? readdirSync(backups, { recursive: true }).filter((entry) => String(entry).includes('kept')) : [];
    expect(left).toEqual([]);
  } finally {
    await index.dispose();
  }
});

test('an atomic rollback removes the directories it created, and keeps one that already had other content', async () => {
  const { existsSync, mkdirSync } = await import('node:fs');
  const root = tempRoot();
  writeFileSync(join(root, 'blocker.txt'), 'exists');
  mkdirSync(join(root, 'old'));
  writeFileSync(join(root, 'old', 'keep.txt'), 'mine');
  const tool = createWriteTool({ projectRoot: root });
  const result = await tool.execute({ transaction: { mode: 'atomic' }, files: [
    { path: 'a/b/c/new.txt', content: 'new' },
    { path: 'old/sub/new.txt', content: 'new' },
    { path: 'blocker.txt', content: 'x' },
  ] });
  expect(result.success).toBe(false);
  expect(existsSync(join(root, 'a'))).toBe(false);
  expect(existsSync(join(root, 'old', 'sub'))).toBe(false);
  expect(readFileSync(join(root, 'old', 'keep.txt'), 'utf8')).toBe('mine');
});

test('a failed post-write validation keeps the files and says so, instead of reading as a clean success', async () => {
  const root = tempRoot();
  const tool = createWriteTool({ projectRoot: root,
    validatorRunner: async () => ({ exitCode: 1, stdout: '', stderr: 'type error in kept.ts', timedOut: false }) as never });
  const result = await tool.execute({ files: [{ path: 'kept.ts', content: 'const x: number = "a";' }], validate: { after: ['typecheck'] } });
  const output = JSON.parse(result.output!) as { validation_failures?: unknown[]; warnings?: string[] };
  expect(output.validation_failures).toHaveLength(1);
  expect(output.warnings?.join(' ')).toContain('kept on disk, not rolled back');
  expect(readFileSync(join(root, 'kept.ts'), 'utf8')).toContain('const x');
});
