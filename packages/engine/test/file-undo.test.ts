// Proves: The gate lets recoverable writes through without asking because undo can restore them; if undo does not restore the exact prior content, or overwrites what the person changed since, that is lost work.
// Red when: Undo does not restore an edit's prior content or remove a created file, or overwrites a file the person changed after the agent's edit.
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileUndoConflictError, FileUndoManager } from '../platform/src/platform/state/file-undo.js';

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

test('undo refuses an edit whose file changed externally, leaves the file alone and keeps the entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'file-undo-'));
  try {
    const path = join(root, 'edited.txt');
    const manager = new FileUndoManager();
    writeFileSync(path, 'agent version');
    manager.snapshot({ path, beforeContent: 'original', afterContent: 'agent version', tool: 'edit' });
    writeFileSync(path, 'user version');
    expect(() => manager.undo()).toThrow(FileUndoConflictError);
    expect(readFileSync(path, 'utf8')).toBe('user version');
    expect(manager.undoDepth()).toBe(1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
