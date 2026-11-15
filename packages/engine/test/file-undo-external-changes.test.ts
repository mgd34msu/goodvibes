import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { FileUndoConflictError, FileUndoManager } from '../platform/src/platform/state/file-undo.js';

/**
 * Undo and redo act on the file as the operation left it. A file that changed
 * since, or is already gone, never wedges the stack or loses a later edit.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const dir = (): string => { const root = mkdtempSync(join(tmpdir(), 'file-undo-ext-')); roots.push(root); return root; };

describe('undo of a created file', () => {
  test('a file already deleted counts as undone, and the older operations stay reachable', () => {
    const root = dir();
    const older = join(root, 'older.txt');
    const created = join(root, 'created.txt');
    const manager = new FileUndoManager();
    writeFileSync(older, 'v2');
    manager.snapshot({ path: older, beforeContent: 'v1', afterContent: 'v2', tool: 'edit' });
    writeFileSync(created, 'new');
    manager.snapshot({ path: created, beforeContent: null, afterContent: 'new', tool: 'write' });
    unlinkSync(created);

    expect(manager.undo()?.path).toBe(created);
    expect(manager.undoDepth()).toBe(1);
    expect(manager.undo()?.path).toBe(older);
    expect(readFileSync(older, 'utf8')).toBe('v1');
  });

  test('a created file the user has since edited is not deleted', () => {
    const root = dir();
    const path = join(root, 'created.txt');
    const manager = new FileUndoManager();
    writeFileSync(path, 'new');
    manager.snapshot({ path, beforeContent: null, afterContent: 'new', tool: 'write' });
    writeFileSync(path, 'new plus my own work');
    expect(() => manager.undo()).toThrow(FileUndoConflictError);
    expect(readFileSync(path, 'utf8')).toBe('new plus my own work');
  });
});

describe('undo and redo of an edit', () => {
  test('a later edit is not overwritten, and the next undo reaches the operation before it', () => {
    const root = dir();
    const a = join(root, 'a.txt');
    const b = join(root, 'b.txt');
    const manager = new FileUndoManager();
    writeFileSync(a, 'a1'); manager.snapshot({ path: a, beforeContent: 'a0', afterContent: 'a1', tool: 'edit' });
    writeFileSync(b, 'b1'); manager.snapshot({ path: b, beforeContent: 'b0', afterContent: 'b1', tool: 'edit' });
    writeFileSync(b, 'b1 changed elsewhere');

    expect(() => manager.undo()).toThrow(/changed after that operation/);
    expect(readFileSync(b, 'utf8')).toBe('b1 changed elsewhere');
    expect(manager.undo()?.path).toBe(a);
    expect(readFileSync(a, 'utf8')).toBe('a0');
  });

  test('redo refuses a file that changed after the undo', () => {
    const root = dir();
    const path = join(root, 'f.txt');
    const manager = new FileUndoManager();
    writeFileSync(path, 'after');
    manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
    manager.undo();
    writeFileSync(path, 'something else');
    expect(() => manager.redo()).toThrow(FileUndoConflictError);
    expect(readFileSync(path, 'utf8')).toBe('something else');
    expect(existsSync(path)).toBe(true);
  });

  test('the cache hook is told which path was rewritten', () => {
    const root = dir();
    const path = join(root, 'f.txt');
    const changed: string[] = [];
    const manager = new FileUndoManager({ onFileChanged: (changedPath) => changed.push(changedPath) });
    writeFileSync(path, 'after');
    manager.snapshot({ path, beforeContent: 'before', afterContent: 'after', tool: 'edit' });
    manager.undo();
    manager.redo();
    expect(changed).toEqual([path, path]);
  });
});
