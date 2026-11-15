import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FileOperation {
  /** Absolute resolved path to the file. */
  path: string;
  /** File content before the operation. Null if the file did not exist. */
  beforeContent: string | null;
  /** File content after the operation. */
  afterContent: string;
  /** Human-readable label, e.g. "write" or "edit". */
  tool: 'write' | 'edit';
  /** ISO timestamp of the operation. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// FileUndoManager
// ---------------------------------------------------------------------------

const MAX_STACK_SIZE = 50;

/**
 * Raised when the file no longer holds what the operation left, so restoring
 * would overwrite a later change. The file is untouched.
 */
export class FileUndoConflictError extends Error {
  constructor(readonly path: string, readonly direction: 'undo' | 'redo') {
    super(`Cannot ${direction} the change to ${path}: the file was changed after that operation (by you, another tool or another program). The file was left as it is and that history entry was dropped; the next ${direction} acts on the one before it.`);
    this.name = 'FileUndoConflictError';
  }
}

/** The file's text, or null when it does not exist. */
function readCurrent(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export class FileUndoManager {
  private undoStack: FileOperation[] = [];
  private redoStack: FileOperation[] = [];

  /** `onFileChanged` lets a file-content cache drop its copy of a path undo or redo rewrote. */
  constructor(private readonly options: { readonly onFileChanged?: (path: string) => void } = {}) {}

  // ---------------------------------------------------------------------------
  // Snapshot, called by write/edit tools after a successful write
  // ---------------------------------------------------------------------------

  /**
   * Record a completed file operation for potential undo/redo.
   * beforeContent is null when the file was newly created.
   */
  snapshot(op: Omit<FileOperation, 'timestamp'>): void {
    const entry: FileOperation = { ...op, timestamp: new Date().toISOString() };

    this.undoStack.push(entry);
    // Trim to max stack size, remove oldest entries first
    if (this.undoStack.length > MAX_STACK_SIZE) {
      this.undoStack.shift();
    }
    // Any new operation invalidates the redo stack
    this.redoStack = [];
  }

  // ---------------------------------------------------------------------------
  // Undo
  // ---------------------------------------------------------------------------

  /**
   * Revert the most recent file operation.
   * Returns `{ path }` on success, or `null` if nothing to undo.
   */
  undo(): { path: string; tool: string } | null {
    const op = this.undoStack.pop();
    if (!op) return null;

    try {
      const current = readCurrent(op.path);
      if (op.beforeContent === null) {
        // Created by the operation: already gone is the state undo wants.
        if (current === null) {
          logger.debug('file-undo: created file is already gone', { path: op.path });
        } else if (current !== op.afterContent) {
          throw new FileUndoConflictError(op.path, 'undo');
        } else {
          unlinkSync(op.path);
          logger.debug('file-undo: removed newly created file', { path: op.path });
        }
      } else {
        if (current !== op.afterContent) throw new FileUndoConflictError(op.path, 'undo');
        writeFileSync(op.path, op.beforeContent, 'utf-8');
        logger.debug('file-undo: restored previous content', { path: op.path });
      }
    } catch (err) {
      logger.warn('file-undo: undo failed', { path: op.path, error: summarizeError(err) });
      // A conflict drops the entry (it can never apply again, and keeping it
      // would block every older operation); a write failure keeps it to retry.
      if (!(err instanceof FileUndoConflictError)) this.undoStack.push(op);
      throw err;
    }
    this.options.onFileChanged?.(op.path);

    this.redoStack.push(op);
    if (this.redoStack.length > MAX_STACK_SIZE) {
      this.redoStack.shift();
    }
    return { path: op.path, tool: op.tool };
  }

  // ---------------------------------------------------------------------------
  // Redo
  // ---------------------------------------------------------------------------

  /**
   * Re-apply the most recently undone file operation.
   * Returns `{ path }` on success, or `null` if nothing to redo.
   */
  redo(): { path: string; tool: string } | null {
    const op = this.redoStack.pop();
    if (!op) return null;

    try {
      if (readCurrent(op.path) !== op.beforeContent) throw new FileUndoConflictError(op.path, 'redo');
      writeFileSync(op.path, op.afterContent, 'utf-8');
      logger.debug('file-undo: re-applied operation', { path: op.path });
    } catch (err) {
      logger.warn('file-undo: redo failed', { path: op.path, error: summarizeError(err) });
      if (!(err instanceof FileUndoConflictError)) this.redoStack.push(op);
      throw err;
    }
    this.options.onFileChanged?.(op.path);

    this.undoStack.push(op);
    if (this.undoStack.length > MAX_STACK_SIZE) {
      this.undoStack.shift();
    }
    return { path: op.path, tool: op.tool };
  }

  // ---------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------

  /** Number of operations that can be undone. */
  undoDepth(): number {
    return this.undoStack.length;
  }

  /** Number of operations that can be redone. */
  redoDepth(): number {
    return this.redoStack.length;
  }

  /** Peek at the most recent undoable operation without popping. */
  peekUndo(): FileOperation | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  /** Peek at the next redo operation without changing either stack. */
  peekRedo(): FileOperation | undefined {
    return this.redoStack[this.redoStack.length - 1];
  }

  /** Clear both stacks (e.g., on session reset). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
  }
}
