import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { callingAgentId } from '../agents/calling-agent.js';
import { currentTurn } from '../security/turn-boundary.js';

export type CacheStatus = 'miss' | 'unchanged' | 'modified';

function digest(content: string | Uint8Array): string {
  return typeof content === 'string'
    ? createHash('sha256').update(content, 'utf8').digest('hex')
    : createHash('sha256').update(content).digest('hex');
}

/** A writer the host names around a run that has no turn of its own in scope (a web chat's tool calls). */
const namedWriter = new AsyncLocalStorage<string>();

/** Runs `fn` with `writer` ("web chat <id>") as who reads and writes files in it. */
export function withFileWriter<T>(writer: string, fn: () => T): T {
  return namedWriter.run(writer, fn);
}

/**
 * Who is reading or writing a file now: the agent whose tool call runs (each
 * agent of one turn on its own), else the writer the host named, else the
 * session whose turn runs, else this process's own conversation (''). Read
 * from the host's scope, never from tool arguments.
 */
export function currentFileWriter(): string {
  const agent = callingAgentId() ?? currentTurn()?.callerAgentId ?? undefined;
  if (agent) return `agent ${agent}`;
  const named = namedWriter.getStore();
  if (named) return named;
  const session = currentTurn()?.sessionId;
  return session ? `session ${session}` : '';
}

/**
 * The last write each file had in this process, and by whom: lets a refused
 * writer be told who changed the file when that writer is in this process
 * (another agent of the turn, another session the daemon runs). A writer in
 * another process is not known here; the refusal then names no one.
 */
const lastWrites = new Map<string, { readonly hash: string; readonly writer: string }>();

/**
 * The writer is gone (its conversation was deleted): the last writes it made are no longer told to anyone, so they are
 * let go. Without this, every file a deleted chat wrote kept its entry for the life of the process.
 */
export function forgetFileWriter(writer: string): void {
  for (const [path, last] of lastWrites) if (last.writer === writer) lastWrites.delete(path);
}

/** One file a tool wrote, and who wrote it, read from the host's scope at the write. */
export interface FileWritten {
  readonly path: string;
  readonly content: string | Uint8Array;
  /** The session whose turn wrote it, when a turn is in scope. */
  readonly sessionId: string | undefined;
  /** The agent whose tool call wrote it, when an agent did. */
  readonly agentId: string | undefined;
  /** {@link currentFileWriter} at the write ('' outside any turn). */
  readonly writer: string;
}

const writeListeners = new Set<(write: FileWritten) => void>();

/**
 * Be told of every file a tool of this process writes (write, edit, notebook edit), synchronously, after the write.
 * A project's checkpoints keep who wrote which file from this (checkpoint/write-record.ts). Returns the stop.
 */
export function onFileWritten(listener: (write: FileWritten) => void): () => void {
  writeListeners.add(listener);
  return () => { writeListeners.delete(listener); };
}

/**
 * FileStateCache: "is this file still what this reader last saw?"
 *
 * One SHA-256 per reader per path (64 bytes), recorded when a tool reads or
 * writes the file. The reader is {@link currentFileWriter}: the session, or
 * each agent of a turn on its own, so two agents sharing one registry never
 * vouch for each other's reads. A read, write or edit compares the bytes it has
 * just read itself with the recorded hash, so the comparison and the operation
 * see the same instant and the file is read once per call. No lock is held and
 * nothing waits on a clock. Nothing is evicted, so the protection does not
 * lapse for files read long ago; memory grows by one hash per file read.
 *
 * - miss: this reader has not seen the file
 * - unchanged: the bytes are the ones last seen
 * - modified: the file changed since this reader last saw it
 */
export class FileStateCache {
  private readonly hashes = new Map<string, string>();

  private key(filePath: string): string {
    return `${currentFileWriter()}\u0000${filePath}`;
  }

  /** Compare content the caller just read with what this reader last saw. Records nothing. */
  compare(filePath: string, content: string | Uint8Array): CacheStatus {
    const seen = this.hashes.get(this.key(filePath));
    if (seen === undefined) return 'miss';
    return seen === digest(content) ? 'unchanged' : 'modified';
  }

  /** Record the content a tool read or wrote as what this reader has seen; anything but a read is a write. */
  update(filePath: string, content: string | Uint8Array, metadata?: { tool?: string; agent?: string }): void {
    const hash = digest(content);
    this.hashes.set(this.key(filePath), hash);
    if (metadata?.tool === 'read') return;
    const writer = currentFileWriter();
    lastWrites.set(filePath, { hash, writer: writer || 'this conversation' });
    if (writeListeners.size === 0) return;
    const turn = currentTurn();
    const written: FileWritten = { path: filePath, content, writer,
      sessionId: turn?.sessionId ?? undefined, agentId: callingAgentId() ?? turn?.callerAgentId ?? undefined };
    for (const listener of writeListeners) {
      try { listener(written); } catch { /* a record that could not be kept never fails the write */ }
    }
  }

  /**
   * Why a write over `content` (the file's bytes now, read by the caller) must
   * not happen, or null when this reader last saw exactly these bytes: the file
   * changed since this session or agent read it, or it never read it. The
   * sentence names who changed it when this process knows, and says to read it
   * again. Records nothing, so the write stays refused until the file is read.
   */
  staleWrite(filePath: string, content: string | Uint8Array): string | null {
    const status = this.compare(filePath, content);
    if (status === 'unchanged') return null;
    const me = currentFileWriter();
    const last = lastWrites.get(filePath);
    const by = last && last.hash === digest(content) && last.writer !== (me || 'this conversation') ? ` by ${last.writer}` : '';
    return status === 'modified'
      ? `'${filePath}' changed${by} since you last read it, so nothing was written: writing now would replace that change. Read it again, then write against what it holds now.`
      : `'${filePath}' already exists and you have not read it${by ? ` (last written${by})` : ''}, so nothing was written: writing now could replace someone else's change. Read it first, then write against what it holds.`;
  }

  /** Forget a file (it was changed by something that did not read it, such as an undo). */
  invalidate(filePath: string): void {
    const suffix = `\u0000${filePath}`;
    for (const key of [...this.hashes.keys()]) if (key.endsWith(suffix)) this.hashes.delete(key);
  }

  /** Forget every file. */
  clear(): void {
    this.hashes.clear();
  }
}

/**
 * Generate a simple unified diff between two strings.
 * Uses line-by-line LCS diff, not the Myers algorithm.
 */
export function unifiedDiff(oldContent: string, newContent: string, label: string, contextLines = 3): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');
  const hunks = computeHunks(oldLines, newLines, contextLines);
  if (hunks.length === 0) return '';

  const header = `--- ${label}\n+++ ${label}\n`;
  return header + hunks.join('');
}

interface HunkLine {
  type: 'context' | 'removed' | 'added';
  text: string;
}

function computeHunks(oldLines: string[], newLines: string[], CONTEXT = 3): string[] {
  // Simple O(n*m) LCS-based diff, practical for reasonable file sizes
  const edits = computeEdits(oldLines, newLines);
  if (edits.length === 0) return [];

  // Group edits into hunks with context
  const result: string[] = [];
  let i = 0;
  while (i < edits.length) {
    // Find next non-context edit
    while (i < edits.length && edits[i]?.type === 'context') i++;
    if (i >= edits.length) break;

    // Collect hunk starting CONTEXT lines before
    const hunkStart = Math.max(0, i - CONTEXT);
    let hunkEnd = i;
    // Extend to next gap
    while (hunkEnd < edits.length) {
      if (edits[hunkEnd]?.type !== 'context') {
        hunkEnd++;
      } else {
        // Check if there's another non-context within CONTEXT distance
        let next = hunkEnd + 1;
        while (next < edits.length && edits[next]?.type === 'context') next++;
        if (next < edits.length && next - hunkEnd <= CONTEXT * 2) {
          hunkEnd = next;
        } else {
          break;
        }
      }
    }
    const hunkRealEnd = Math.min(edits.length, hunkEnd + CONTEXT);

    const hunkLines = edits.slice(hunkStart, hunkRealEnd);
    let oldStart = 1, oldCount = 0, newStart = 1, newCount = 0;
    // Compute line numbers
    let oldLine = 1;
    let newLine = 1;
    for (let j = 0; j < hunkStart; j++) {
      if (edits[j]?.type !== 'added') oldLine++;
      if (edits[j]?.type !== 'removed') newLine++;
    }
    oldStart = oldLine;
    newStart = newLine;
    for (const hl of hunkLines) {
      if (hl.type !== 'added') oldCount++;
      if (hl.type !== 'removed') newCount++;
    }

    let hunk = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (const hl of hunkLines) {
      const prefix = hl.type === 'context' ? ' ' : hl.type === 'removed' ? '-' : '+';
      hunk += prefix + hl.text + '\n';
    }
    result.push(hunk);
    i = hunkRealEnd;
  }
  return result;
}

function computeEdits(allOld: string[], allNew: string[]): HunkLine[] {
  // Unchanged leading and trailing lines never need the LCS table, so a small
  // change in a large file is diffed on the changed middle only.
  let prefix = 0;
  const maxPrefix = Math.min(allOld.length, allNew.length);
  while (prefix < maxPrefix && allOld[prefix] === allNew[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = maxPrefix - prefix;
  while (suffix < maxSuffix && allOld[allOld.length - 1 - suffix] === allNew[allNew.length - 1 - suffix]) suffix++;
  if (prefix > 0 || suffix > 0) {
    const middle = computeEdits(
      allOld.slice(prefix, allOld.length - suffix),
      allNew.slice(prefix, allNew.length - suffix),
    );
    return [
      ...allOld.slice(0, prefix).map((text): HunkLine => ({ type: 'context', text })),
      ...middle,
      ...allOld.slice(allOld.length - suffix).map((text): HunkLine => ({ type: 'context', text })),
    ];
  }
  const oldLines = allOld;
  const newLines = allNew;
  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  // For large files, fall back to simple append diff to avoid O(mn) memory
  if (m * n > 1_000_000) {
    const edits: HunkLine[] = [];
    for (const l of oldLines) edits.push({ type: 'removed', text: l });
    for (const l of newLines) edits.push({ type: 'added', text: l });
    return edits;
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        dp[i]![j]! = dp[i + 1]![j + 1]! + 1;
      } else {
        dp[i]![j]! = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
      }
    }
  }

  // Reconstruct diff
  const edits: HunkLine[] = [];
  let i = 0, j = 0;
  while (i < m || j < n) {
    if (i < m && j < n && oldLines[i] === newLines[j]) {
      edits.push({ type: 'context', text: oldLines[i]! });
      i++; j++;
    } else if (j < n && (i >= m || (dp[i + 1]?.[j] ?? 0) <= (dp[i]?.[j + 1] ?? 0))) {
      edits.push({ type: 'added', text: newLines[j]! });
      j++;
    } else {
      edits.push({ type: 'removed', text: oldLines[i]! });
      i++;
    }
  }
  return edits;
}
