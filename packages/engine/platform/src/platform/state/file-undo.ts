import { readFileSync, realpathSync, statSync, unlinkSync } from 'node:fs';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { noteToolWrites } from './file-watcher.js';
import { noteProjectFilesChanged } from '../intelligence/project-files-epoch.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileOperation {
  /** Absolute resolved path to the file. */
  path: string;
  /**
   * File content before the operation. Null if the file did not exist. Bytes
   * when it was not UTF-8 text (a database, an image, an archive), so undo
   * puts back exactly what was there.
   */
  beforeContent: string | Buffer | null;
  /** File content after the operation: bytes when the write put bytes that are not UTF-8 text. */
  afterContent: string | Buffer;
  /** Human-readable label, e.g. "write" or "edit". */
  tool: 'write' | 'edit';
  /** ISO timestamp of the operation. */
  timestamp: string;
  /**
   * The tool call this operation belongs to (from `beginCall()`). Operations of
   * one call are one undo entry: undone and redone together.
   */
  call?: number | undefined;
}

/**
 * One undo step: every file one tool call changed. The top-level fields are
 * the call's first file, so a reader that shows one path still can.
 */
export interface FileUndoEntry extends FileOperation {
  readonly operations: readonly FileOperation[];
}

/** What an undo or redo did: every file it restored, in the order the call changed them. */
export interface FileUndoResult {
  /** The first file, for callers that show one path. */
  readonly path: string;
  readonly paths: readonly string[];
  readonly tool: string;
}

// ---------------------------------------------------------------------------
// FileUndoManager
// ---------------------------------------------------------------------------

const MAX_STACK_SIZE = 50;

/**
 * Raised when a file no longer holds what the operation left, so restoring
 * would overwrite a later change. No file of the entry is touched.
 */
export class FileUndoConflictError extends Error {
  constructor(readonly path: string, readonly direction: 'undo' | 'redo', readonly paths: readonly string[] = [path]) {
    super(`Cannot ${direction} the change to ${path}${paths.length > 1 ? ` (one of the ${paths.length} files that tool call changed)` : ''}: the file was changed after that operation (by you, another tool or another program). No file was changed and the history entry is kept: put the file back as that operation left it and ${direction} again, or drop the entry (/${direction} file drop) to reach the one before it.`);
    this.name = 'FileUndoConflictError';
  }
}

/** The file's bytes, or null when it does not exist. */
function readCurrent(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Whether the file holds `content` exactly (text compared as its UTF-8 bytes). */
function holds(current: Buffer | null, content: string | Buffer | null): boolean {
  if (current === null || content === null) return current === content;
  return current.equals(typeof content === 'string' ? Buffer.from(content, 'utf-8') : content);
}

/**
 * Put `content` at `path`; null removes the file. The new content is written
 * beside the file and renamed over it, so a write that fails (a full disk)
 * leaves the file as it was, never truncated; the file keeps its mode. With
 * `expected`, the file is checked again right before the rename and a file
 * changed meanwhile refuses (`conflict`), so an editor's save between the
 * first check and this write is never overwritten.
 */
function restore(path: string, content: string | Buffer | null, expected?: { readonly content: string | Buffer | null; readonly conflict: () => Error }): void {
  const check = expected === undefined ? undefined : (): void => {
    const current = readCurrent(path);
    // Already what this restore writes (a created file already gone) is not a change by someone else.
    if (!holds(current, expected.content) && !holds(current, content)) throw expected.conflict();
  };
  if (content === null) {
    check?.();
    try { unlinkSync(path); } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  } else {
    let mode: number;
    try { mode = statSync(path).mode & 0o7777; } catch { mode = 0o666 & ~process.umask(); }
    // Through a symlink, as a plain write would go: the link stays a link.
    let target = path;
    try { target = realpathSync(path); } catch { target = path; }
    writeFileAtomic(target, typeof content === 'string' ? Buffer.from(content, 'utf-8') : content, {
      mode, cleanupStaleTemps: false, ...(check ? { assertCurrent: check } : {}),
    });
  }
  // An undo or redo is the product's own change, not one made outside it.
  noteToolWrites([path]);
  // A cached import graph built before the undo must not answer the next relationship query.
  noteProjectFilesChanged();
}

function entryOf(operations: FileOperation[]): FileUndoEntry {
  return { ...operations[0]!, operations };
}

export class FileUndoManager {
  private undoStack: FileUndoEntry[] = [];
  private redoStack: FileUndoEntry[] = [];
  private callSequence = 0;

  /** `onFileChanged` lets a file-content cache drop its copy of a path undo or redo rewrote. */
  constructor(private readonly options: { readonly onFileChanged?: (path: string) => void } = {}) {}

  /** A token for one tool call; pass it as `call` on every snapshot of that call. */
  beginCall(): number {
    return ++this.callSequence;
  }

  // ---------------------------------------------------------------------------
  // Snapshot, called by write/edit tools after a successful write
  // ---------------------------------------------------------------------------

  /**
   * Record a completed file operation for potential undo/redo.
   * beforeContent is null when the file was newly created. An operation with
   * the same `call` as an entry still in the history joins it, wherever it sits
   * (calls that run side by side interleave their writes); a second write of the
   * same file in that call keeps the first before-content and the last after-content.
   */
  snapshot(op: Omit<FileOperation, 'timestamp'>): void {
    const operation: FileOperation = { ...op, timestamp: new Date().toISOString() };
    const joined = op.call === undefined ? undefined : this.entryForCall(op.call);
    if (joined) {
      const operations = joined.operations as FileOperation[];
      const same = operations.find((existing) => existing.path === op.path);
      if (same) same.afterContent = op.afterContent;
      else operations.push(operation);
      if (operations[0] === same) joined.afterContent = op.afterContent;
    } else {
      this.undoStack.push(entryOf([operation]));
      // Trim to max stack size, remove oldest entries first
      if (this.undoStack.length > MAX_STACK_SIZE) this.undoStack.shift();
    }
    // Any new operation invalidates the redo stack
    this.redoStack = [];
  }

  /** The undo entry of `call`, newest first; at most MAX_STACK_SIZE entries to look through. */
  private entryForCall(call: number): FileUndoEntry | undefined {
    for (let index = this.undoStack.length - 1; index >= 0; index--) {
      if (this.undoStack[index]!.call === call) return this.undoStack[index];
    }
    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Undo / redo
  // ---------------------------------------------------------------------------

  /**
   * Revert the most recent tool call's file operations: every file or none.
   * Every file is checked first; a file changed since the call refuses the
   * whole entry (FileUndoConflictError, nothing written, entry kept: the owner
   * puts the file back and tries again, or drops the entry with {@link discard}).
   * Returns the restored paths, or `null` if nothing to undo.
   */
  undo(): FileUndoResult | null {
    return this.apply('undo');
  }

  /** Re-apply the most recently undone tool call, every file or none. */
  redo(): FileUndoResult | null {
    return this.apply('redo');
  }

  private apply(direction: 'undo' | 'redo'): FileUndoResult | null {
    const from = direction === 'undo' ? this.undoStack : this.redoStack;
    const to = direction === 'undo' ? this.redoStack : this.undoStack;
    const entry = from.pop();
    if (!entry) return null;
    const operations = direction === 'undo' ? [...entry.operations].reverse() : [...entry.operations];
    const paths = entry.operations.map((op) => op.path);
    const expected = (op: FileOperation): string | Buffer | null => direction === 'undo' ? op.afterContent : op.beforeContent;
    const target = (op: FileOperation): string | Buffer | null => direction === 'undo' ? op.beforeContent : op.afterContent;
    const done: FileOperation[] = [];
    try {
      for (const op of operations) {
        const current = readCurrent(op.path);
        // A file the call created and that is already gone is the state undo wants.
        const settled = direction === 'undo' && op.beforeContent === null && current === null;
        if (!settled && !holds(current, expected(op))) throw new FileUndoConflictError(op.path, direction, paths);
      }
      for (const op of operations) {
        // Checked again at the rename: a file changed since the check above refuses, and what was done is put back below.
        restore(op.path, target(op), { content: expected(op), conflict: () => new FileUndoConflictError(op.path, direction, paths) });
        done.push(op);
        logger.debug(`file-undo: ${direction} applied`, { path: op.path });
      }
    } catch (err) {
      logger.warn(`file-undo: ${direction} failed`, { path: done.length < operations.length ? operations[done.length]!.path : entry.path, error: summarizeError(err) });
      // A write failed part way: put back what was already restored, so the
      // files stay as the call left them, and keep the entry to retry.
      for (const op of done.reverse()) {
        try { restore(op.path, expected(op)); } catch (rollbackError) {
          logger.warn(`file-undo: ${direction} could not put back a file`, { path: op.path, error: summarizeError(rollbackError) });
        }
      }
      // The entry is kept either way: a conflict until the owner puts the file back or
      // drops it (discard), a write failure to retry. Nothing he could still undo is lost.
      from.push(entry);
      throw err;
    }
    for (const op of done) this.options.onFileChanged?.(op.path);
    to.push(entry);
    if (to.length > MAX_STACK_SIZE) to.shift();
    return { path: entry.path, paths, tool: entry.tool };
  }

  /**
   * Drop the newest undo (or redo) entry without touching any file: the way
   * past an entry a later change makes impossible to apply. Returns what was
   * dropped, or null when there was none.
   */
  discard(direction: 'undo' | 'redo'): FileUndoResult | null {
    const entry = (direction === 'undo' ? this.undoStack : this.redoStack).pop();
    return entry ? { path: entry.path, paths: entry.operations.map((op) => op.path), tool: entry.tool } : null;
  }

  /**
   * Revert the first tool call recorded at or after `since` that changed one of
   * `paths` (absolute): the call a decision made at `since` let run. Every file
   * of that call is checked first; a file changed since (by a later call or by
   * hand) refuses the whole entry (FileUndoConflictError, nothing written).
   * The entry leaves the undo history and is not offered for redo, since later
   * calls may sit above it. Returns null when no such call is recorded.
   */
  undoCallAfter(since: number, paths: readonly string[]): FileUndoResult | null {
    const wanted = new Set(paths);
    const index = this.undoStack.findIndex((entry) => Date.parse(entry.timestamp) >= since
      && entry.operations.some((op) => wanted.has(op.path)));
    if (index < 0) return null;
    const entry = this.undoStack[index]!;
    const operations = [...entry.operations].reverse();
    const all = entry.operations.map((op) => op.path);
    for (const op of operations) {
      const current = readCurrent(op.path);
      if (!(op.beforeContent === null && current === null) && !holds(current, op.afterContent)) {
        // It can never apply again; kept, it would be found first by every later look.
        this.undoStack.splice(index, 1);
        throw new FileUndoConflictError(op.path, 'undo', all);
      }
    }
    const done: FileOperation[] = [];
    try {
      for (const op of operations) {
        restore(op.path, op.beforeContent, { content: op.afterContent, conflict: () => new FileUndoConflictError(op.path, 'undo', all) });
        done.push(op);
      }
    } catch (err) {
      for (const op of done.reverse()) {
        try { restore(op.path, op.afterContent); } catch (rollbackError) {
          logger.warn('file-undo: undo could not put back a file', { path: op.path, error: summarizeError(rollbackError) });
        }
      }
      throw err;
    }
    this.undoStack.splice(index, 1);
    for (const op of done) this.options.onFileChanged?.(op.path);
    return { path: entry.path, paths: all, tool: entry.tool };
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Number of tool calls that can be undone. */
  undoDepth(): number {
    return this.undoStack.length;
  }

  /** Number of tool calls that can be redone. */
  redoDepth(): number {
    return this.redoStack.length;
  }

  /** Peek at the most recent undoable entry without popping. */
  peekUndo(): FileUndoEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  /** Peek at the next redo entry without changing either stack. */
  peekRedo(): FileUndoEntry | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  /** Clear both stacks (e.g., on session reset). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
