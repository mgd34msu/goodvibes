import { noteSourceFilesWritten } from '../../intelligence/import-graph.js';
import type { SessionChangeTracker } from '../../sessions/change-tracker.js';
import type { FileUndoManager } from '../../state/file-undo.js';
import { noteToolWrites } from '../../state/file-watcher.js';

/** What the edit tool keeps about a file it changed, for text and notebook edits alike. */
export interface EditPublishEnv {
  fileUndoManager?: FileUndoManager | undefined;
  /** This call's undo token: every file it changes is one undo entry. */
  undoCall?: number | undefined;
  changeTracker?: Pick<SessionChangeTracker, 'recordChange'> | undefined;
}

/**
 * Announce what a call put in each path (null for a removed file): the project
 * files epoch moves and the shared import graph is patched instead of rescanned.
 */
export function announceWrites(paths: Iterable<string>, contents: ReadonlyMap<string, string>): void {
  const written = new Map<string, string | null>();
  for (const path of paths) written.set(path, contents.get(path) ?? null);
  noteSourceFilesWritten(written);
  noteToolWrites(written.keys());
}

/** Most characters of one file's content a verbose result shows before and after. */
const VERBOSE_CONTENT_MAX_CHARS = 20_000;

/** A file's content as a verbose result shows it; longer content says how much was left out and how to see it. */
export function verboseContent(content: string): string {
  if (content.length <= VERBOSE_CONTENT_MAX_CHARS) return content;
  return `${content.slice(0, VERBOSE_CONTENT_MAX_CHARS)}\n[${content.length - VERBOSE_CONTENT_MAX_CHARS} more characters not shown; read the file for the rest]`;
}

/**
 * The final bookkeeping of one changed file, once the call's outcome is final:
 * an undo snapshot and the session's changed-files list. A failed snapshot does
 * not fail the edit that already landed.
 */
export function recordPublishedEdit(env: EditPublishEnv, path: string, beforeContent: string | null, afterContent: string): void {
  if (env.fileUndoManager) {
    try {
      env.fileUndoManager.snapshot({ path, beforeContent, afterContent, tool: 'edit', call: env.undoCall });
    } catch {
      // Undo snapshot failure should not fail the edit.
    }
  }
  env.changeTracker?.recordChange(path);
}
