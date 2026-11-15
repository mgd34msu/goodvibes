import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUndoConflictError, FileUndoManager } from '../platform/src/platform/state/file-undo.js';

test('undo removes a newly created file and redo restores its contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-undo-'));
  try {
    const path = join(root, 'created.txt');
    const manager = new FileUndoManager();
    writeFileSync(path, 'created content');
    manager.snapshot({ path, beforeContent: null, afterContent: 'created content', tool: 'write' });
    expect(manager.undo()?.path).toBe(path);
    expect(existsSync(path)).toBe(false);
    expect(manager.redo()?.path).toBe(path);
    expect(readFileSync(path, 'utf8')).toBe('created content');
    manager.undo();
    expect(existsSync(path)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('undo of a creation whose file was deleted afterwards succeeds and does not block earlier entries', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-undo-'));
  try {
    const earlier = join(root, 'earlier.txt');
    const created = join(root, 'created.txt');
    const manager = new FileUndoManager();
    writeFileSync(earlier, 'v2');
    manager.snapshot({ path: earlier, beforeContent: 'v1', afterContent: 'v2', tool: 'edit' });
    writeFileSync(created, 'new');
    manager.snapshot({ path: created, beforeContent: null, afterContent: 'new', tool: 'write' });
    rmSync(created);
    expect(manager.undoDepth()).toBe(2);
    expect(() => manager.undo()).not.toThrow();
    expect(manager.undoDepth()).toBe(1);
    expect(manager.undo()?.path).toBe(earlier);
    expect(readFileSync(earlier, 'utf8')).toBe('v1');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('undo refuses an edit whose file changed externally, leaves the file alone and drops the entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-undo-'));
  try {
    const path = join(root, 'edited.txt');
    const manager = new FileUndoManager();
    writeFileSync(path, 'agent version');
    manager.snapshot({ path, beforeContent: 'original', afterContent: 'agent version', tool: 'edit' });
    writeFileSync(path, 'user version');
    expect(() => manager.undo()).toThrow(FileUndoConflictError);
    expect(readFileSync(path, 'utf8')).toBe('user version');
    expect(manager.undoDepth()).toBe(0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
