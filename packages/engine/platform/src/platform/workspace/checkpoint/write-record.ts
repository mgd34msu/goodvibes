/**
 * write-record.ts
 *
 * Who wrote which file of a project, kept per file, so a restore can say whose
 * changes it takes back from what each session and agent wrote, never from
 * which session's snapshot happened to hold the change (a checkpoint is of the
 * whole tree: one taken while another session writes holds that write).
 *
 * Every process that keeps a project's checkpoints (each terminal program, the
 * Agent, the daemon for the projects its turns run in) appends one line per
 * file its tools write (write, edit, notebook edit; state/file-cache.ts
 * `onFileWritten`) to `<project>/.goodvibes/file-writes.jsonl`: the file
 * (relative to the project), the session, the agent when an agent wrote it,
 * when, and the git blob id of what was written. One small append per write
 * (a line far under 4 KB with O_APPEND, so two processes' lines never mix); the
 * file is read only when a restore is decided. Past 2 MB it is moved aside to
 * `file-writes.1.jsonl` (the one before is dropped), and both are read. The move
 * runs only under the project's checkpoint store lock, with the size read again
 * under it, so of several processes past 2 MB at once exactly one moves the
 * record and none moves the fresh one over it; a process that finds the store
 * busy leaves the move to its next write. A line cut off mid-write (a process
 * killed during its append) is never read as a write, and the whole line
 * appended after it is still read.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync } from 'node:fs';
import { assertProjectFolderReachable } from '../project-folder-guard.js';
import { isAbsolute, join, relative, sep } from 'node:path';
import { onFileWritten, type FileWritten } from '../../state/file-cache.js';
import { withCrossProcessLockSync } from './cross-process-lock.js';
import { logger } from '../../utils/logger.js';
import { summarizeError } from '../../utils/error-display.js';

/** One write of one file, as the record keeps it. */
export interface FileWriteEntry {
  /** Path relative to the project root, `/`-separated (as the side repository names it). */
  readonly file: string;
  /** The session whose turn or agent wrote it. */
  readonly sessionId: string;
  /** The agent that wrote it, when one did. */
  readonly agentId?: string | undefined;
  /** When it was written (ms). */
  readonly at: number;
  /** The git blob id of the bytes written: tells whether a checkpoint holds this write. */
  readonly blob: string;
}

const RECORD_FILE = 'file-writes.jsonl';
const OLDER_RECORD_FILE = 'file-writes.1.jsonl';
const MOVE_ASIDE_BYTES = 2 * 1024 * 1024;

/** Resolves the session a write belongs to when the host knows it better than the turn in scope (a program's live session). */
export type WriteSessionResolver = (who: { readonly agentId?: string | undefined }) => string | undefined;

interface WatchedRoot {
  readonly roots: readonly string[];
  readonly record: string;
  /** The project's checkpoint store lock, held while the record is moved aside. */
  readonly lock: string;
  readonly resolvers: Set<WriteSessionResolver>;
}

/** Move the record aside when it is past its size, under the store lock; a busy store leaves it to a later write. */
function moveAsideWhenFull(entry: WatchedRoot): void {
  try {
    // Gone already (another process moved it a moment ago): nothing to move.
    if (statSync(entry.record).size <= MOVE_ASIDE_BYTES) return;
    withCrossProcessLockSync(entry.lock, () => {
      // Read again under the lock: another process may have moved it already, and the record here now is a fresh one.
      if (statSync(entry.record).size > MOVE_ASIDE_BYTES) renameSync(entry.record, join(entry.record, '..', OLDER_RECORD_FILE));
    });
  } catch {
    // The store is busy (a checkpoint being made, or another process moving it): the next write tries again.
  }
}

const watched = new Map<string, WatchedRoot>();
let stopListening: (() => void) | null = null;

/** The record of a project root. */
export function writeRecordPath(root: string): string {
  return join(root, '.goodvibes', RECORD_FILE);
}

/** The git blob id of `content` (what `git hash-object` gives), so a write can be matched to a checkpoint's tree. */
export function gitBlobId(content: string | Uint8Array): string {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function relativeInside(root: string, path: string): string | null {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function keep(write: FileWritten): void {
  for (const entry of watched.values()) {
    let file: string | null = null;
    for (const root of entry.roots) {
      file = relativeInside(root, write.path);
      if (file) break;
    }
    // The product's own storage is never a project file.
    if (!file || file === '.goodvibes' || file.startsWith('.goodvibes/')) continue;
    let sessionId: string | undefined;
    for (const resolve of entry.resolvers) {
      sessionId = resolve(write.agentId ? { agentId: write.agentId } : {});
      if (sessionId) break;
    }
    sessionId ??= write.sessionId ?? (write.writer || `process ${process.pid}`);
    const line = `${JSON.stringify({ f: file, s: sessionId, ...(write.agentId ? { a: write.agentId } : {}), t: Date.now(), b: gitBlobId(write.content) })}\n`;
    try {
      appendFileSync(entry.record, line);
      moveAsideWhenFull(entry);
    } catch (error) {
      try {
        assertProjectFolderReachable(entry.record);
        mkdirSync(join(entry.record, '..'), { recursive: true });
        appendFileSync(entry.record, line);
      } catch {
        logger.debug('a file write was not recorded for its project', { file, error: summarizeError(error) });
      }
    }
  }
}

/**
 * Record every file this process's tools write inside `root` (a project's checkpoint root). `resolveSession` names
 * the session a write belongs to when the host knows it (a program's live session); else the turn's session. Several
 * managers of one root in one process share one record. `storeLock`: the lock of the store keeping the root's
 * checkpoints (the project's one store's by default). Returns the stop.
 */
export function recordFileWrites(root: string, resolveSession?: WriteSessionResolver, storeLock?: string): () => void {
  let real = root;
  try { real = realpathSync(root); } catch { /* the root as given */ }
  const key = real;
  let entry = watched.get(key);
  if (!entry) {
    entry = { roots: real === root ? [root] : [root, real], record: writeRecordPath(real),
      lock: storeLock ?? join(real, '.goodvibes', 'shared', 'checkpoints', 'git', '.gv-lock'), resolvers: new Set() };
    watched.set(key, entry);
  }
  const resolver: WriteSessionResolver = resolveSession ?? (() => undefined);
  entry.resolvers.add(resolver);
  stopListening ??= onFileWritten(keep);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    entry.resolvers.delete(resolver);
    if (entry.resolvers.size === 0) watched.delete(key);
    if (watched.size === 0 && stopListening) { stopListening(); stopListening = null; }
  };
}

/** Every recorded write of `files` in the project at `root`, oldest first, by file. */
export function recordedWrites(root: string, files: ReadonlySet<string>): Map<string, FileWriteEntry[]> {
  const byFile = new Map<string, FileWriteEntry[]>();
  let real = root;
  try { real = realpathSync(root); } catch { /* the root as given */ }
  for (const path of [join(real, '.goodvibes', OLDER_RECORD_FILE), writeRecordPath(real)]) {
    if (!existsSync(path)) continue;
    let text: string;
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line) continue;
      let parsed: { f?: unknown; s?: unknown; a?: unknown; t?: unknown; b?: unknown };
      try { parsed = JSON.parse(line) as typeof parsed; } catch {
        // A line cut off mid-write has the next whole line appended to it: read that one (`{"f":` never occurs inside a
        // JSON string, whose quotes are escaped), never the cut-off part.
        const at = line.lastIndexOf('{"f":');
        if (at <= 0) continue;
        try { parsed = JSON.parse(line.slice(at)) as typeof parsed; } catch { continue; }
      }
      if (typeof parsed.f !== 'string' || !files.has(parsed.f) || typeof parsed.s !== 'string' || typeof parsed.t !== 'number' || typeof parsed.b !== 'string') continue;
      const list = byFile.get(parsed.f) ?? [];
      list.push({ file: parsed.f, sessionId: parsed.s, ...(typeof parsed.a === 'string' ? { agentId: parsed.a } : {}), at: parsed.t, blob: parsed.b });
      byFile.set(parsed.f, list);
    }
  }
  for (const list of byFile.values()) list.sort((a, b) => a.at - b.at);
  return byFile;
}

/**
 * The writes of one file a restore to a checkpoint takes back: every write after the checkpoint was made, and the
 * last write before it when the checkpoint does not hold what it wrote (it landed while the snapshot was being taken).
 * `held` is the blob the checkpoint holds for the file (undefined: the file is not in it).
 */
export function writesTakenBack(writes: readonly FileWriteEntry[], madeAt: number, held: string | undefined): FileWriteEntry[] {
  let lastBefore = -1;
  for (let i = 0; i < writes.length; i++) if (writes[i]!.at <= madeAt) lastBefore = i;
  const after = writes.slice(lastBefore + 1);
  const raced = lastBefore >= 0 && writes[lastBefore]!.blob !== held ? [writes[lastBefore]!] : [];
  return [...raced, ...after];
}
