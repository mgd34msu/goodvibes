/**
 * Undo compares the file read as UTF-8, so a write in a narrow encoding is not
 * recorded for undo; a utf-8 write still is.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUndoManager } from '../platform/src/platform/state/file-undo.js';
import { createWriteTool } from '../platform/src/platform/tools/write/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'gv-write-enc-'));
  roots.push(root);
  return root;
}

test('a latin1 write leaves no undo entry that would fail with a conflict', async () => {
  const root = tempRoot();
  const undo = new FileUndoManager();
  const tool = createWriteTool({ projectRoot: root, fileUndoManager: undo });
  const result = await tool.execute({ files: [{ path: 'cafe.txt', content: 'café', encoding: 'latin1' }] });
  expect(result.success).toBe(true);
  expect([...readFileSync(join(root, 'cafe.txt'))]).toEqual([0x63, 0x61, 0x66, 0xe9]);
  expect(undo.undoDepth()).toBe(0);
});

test('a utf-8 write is still undoable', async () => {
  const root = tempRoot();
  const undo = new FileUndoManager();
  const tool = createWriteTool({ projectRoot: root, fileUndoManager: undo });
  await tool.execute({ files: [{ path: 'plain.txt', content: 'café' }] });
  expect(undo.undoDepth()).toBe(1);
  undo.undo();
  expect(() => readFileSync(join(root, 'plain.txt'))).toThrow();
});
