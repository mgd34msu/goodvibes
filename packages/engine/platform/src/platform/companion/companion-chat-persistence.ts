/**
 * companion-chat-persistence.ts
 *
 * Disk store for CompanionChatManager. Each chat is two files under the
 * sessions directory:
 *
 * - `<id>.meta.json`: the chat's summary (title, route, status, counts), a
 *   small document replaced atomically when it changes. Start-up and the chat
 *   list read only these.
 * - `<id>.jsonl`: the transcript, one record per line. Saving a message is one
 *   appended line, whatever the chat already holds; a changed message (a
 *   delivery state, a superseded mark) is appended again and the latest line
 *   wins. The transcript is read when the chat is opened, not at start-up.
 *
 * Default storage root: ~/.goodvibes/companion-chat/sessions/
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CompanionChatMessage, CompanionChatSession } from './companion-chat-types.js';
import { openRecordLog, type RecordLog } from '../state/record-log.js';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

// ---------------------------------------------------------------------------
// On-disk shapes
// ---------------------------------------------------------------------------

/** A saved chat file that could not be loaded and was set aside, with why. */
export interface RejectedChatFile {
  /** File name as found in the sessions directory. */
  readonly file: string;
  readonly reason: string;
}

export interface PersistedChatSession {
  readonly meta: CompanionChatSession;
  readonly messages: CompanionChatMessage[];
}

/** The last turn boundary written to a transcript. */
export interface PersistedTurnMark {
  readonly userMessageId: string;
  readonly phase: 'started' | 'ended';
  readonly at: number;
}

/** A transcript as read from disk. */
export interface PersistedTranscript {
  readonly messages: CompanionChatMessage[];
  /** Absent for a chat converted from the single-file format, which wrote no turn marks. */
  readonly lastTurn?: PersistedTurnMark | undefined;
}

type ChatRecord =
  | { readonly m: CompanionChatMessage }
  | { readonly turn: PersistedTurnMark };

function recordKey(record: ChatRecord): string {
  return 'm' in record ? `m:${record.m.id}` : 'turn';
}

/** A transcript record without the per-process revision the manager issues on load. */
function storedMessage(message: CompanionChatMessage): CompanionChatMessage {
  const { contentRevision: _issuedOnLoad, ...rest } = message;
  return rest;
}

// ---------------------------------------------------------------------------
// Default path
// ---------------------------------------------------------------------------

/**
 * Resolve the companion-chat sessions directory.
 *
 * Pass the runtime's INJECTED home directory so an isolated-home daemon never
 * reads or writes the real `~/.goodvibes/companion-chat`, the rest of the
 * runtime resolves paths from the injected home, and this must agree. The
 * OS `homedir()` is used only as a last resort when nothing is injected.
 */
export function defaultSessionsDir(homeDirectory?: string): string {
  return join(homeDirectory ?? homedir(), '.goodvibes', 'companion-chat', 'sessions');
}

const META_SUFFIX = '.meta.json';
const LOG_SUFFIX = '.jsonl';
/** Rewrite a transcript whose superseded lines outnumber its messages by this much, when it is opened. */
const COMPACT_SLACK = 64;

// ---------------------------------------------------------------------------
// CompanionChatPersistence
// ---------------------------------------------------------------------------

export class CompanionChatPersistence {
  private readonly sessionsDir: string;
  private dirReady = false;
  #rejected: RejectedChatFile[] = [];
  private readonly logs = new Map<string, RecordLog<ChatRecord>>();

  /** Files the most recent load set aside or skipped because their content is unusable. */
  rejectedOnLoad(): readonly RejectedChatFile[] { return this.#rejected; }

  constructor(sessionsDir?: string) {
    this.sessionsDir = sessionsDir ?? defaultSessionsDir();
  }

  /** Create the directory (and missing parents) private to the owner, whatever the process umask. */
  private ensureDir(): void {
    if (this.dirReady) return;
    const missing: string[] = [];
    for (let dir = this.sessionsDir; !existsSync(dir); dir = dirname(dir)) {
      missing.unshift(dir);
      if (dirname(dir) === dir) break;
    }
    for (const dir of missing) {
      try { mkdirSync(dir, { mode: 0o700 }); } catch (err) { if (!isNodeErrorCode(err, 'EEXIST')) throw err; }
      chmodSync(dir, 0o700);
    }
    this.dirReady = true;
  }

  private path(sessionId: string, suffix: string): string {
    if (!safeSessionId(sessionId)) throw new Error('Invalid saved chat identifier');
    return join(this.sessionsDir, `${sessionId}${suffix}`);
  }

  /**
   * The summary of every saved chat, for start-up. An unreadable summary is
   * moved aside by the document reader and reported in {@link rejectedOnLoad}.
   */
  loadIndex(): CompanionChatSession[] {
    this.#rejected = [];
    let names: string[];
    try {
      this.ensureDir();
      names = readdirSync(this.sessionsDir);
    } catch (err) {
      logger.warn('CompanionChatPersistence: failed to read sessions directory', { dir: this.sessionsDir, error: summarizeError(err) });
      return [];
    }
    const metas: CompanionChatSession[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      const id = name.slice(0, -META_SUFFIX.length);
      if (!safeSessionId(id)) continue;
      const meta = readDocument(join(this.sessionsDir, name), {
        label: 'companion-chat/meta',
        validate: (parsed) => readMeta(parsed, id),
        recovery: 'The chat no longer appears in the chat list; its transcript file is left in place.',
      });
      if (meta) metas.push(meta);
      else if (existsSync(join(this.sessionsDir, name)) === false) this.#rejected.push({ file: name, reason: 'summary could not be read and was set aside' });
    }
    return metas;
  }

  private open(sessionId: string): RecordLog<ChatRecord> {
    const existing = this.logs.get(sessionId);
    if (existing) return existing;
    this.ensureDir();
    const log = openRecordLog<ChatRecord>(this.path(sessionId, LOG_SUFFIX), { fsync: 'batch', key: recordKey });
    this.logs.set(sessionId, log);
    return log;
  }

  /** Read one chat's transcript (one file read). Rewrites it first when superseded lines dominate. */
  loadTranscript(sessionId: string): PersistedTranscript {
    const log = this.open(sessionId);
    const transcript = readRecords(log.scan());
    if (log.size <= transcript.messages.length * 2 + COMPACT_SLACK) return transcript;
    const remaining = new Map<string, number>();
    for (const record of log.scan()) remaining.set(recordKey(record), (remaining.get(recordKey(record)) ?? 0) + 1);
    // The rewrite runs to completion before compact() returns its promise; a failure leaves the log as it was.
    void log.compact((record) => {
      const key = recordKey(record), left = (remaining.get(key) ?? 1) - 1;
      remaining.set(key, left);
      return left === 0;
    }).catch((err: unknown) => {
      logger.warn('CompanionChatPersistence: rewriting a long transcript failed; it stays as it was', { sessionId, error: summarizeError(err) });
    });
    return transcript;
  }

  /** Replace the chat's summary (one small write and rename). */
  writeMeta(meta: CompanionChatSession): void {
    this.ensureDir();
    writeDocument(this.path(meta.id, META_SUFFIX), meta, { mode: 0o600 });
  }

  /** Append the current state of these messages (one line each). */
  appendMessages(sessionId: string, messages: readonly CompanionChatMessage[]): void {
    if (messages.length === 0) return;
    const log = this.open(sessionId);
    for (const message of messages) log.append({ m: storedMessage(message) });
  }

  /** Record that a turn started or ended, so a restart can tell a reply the daemon died in. */
  markTurn(sessionId: string, mark: PersistedTurnMark): void {
    this.open(sessionId).append({ turn: mark });
  }

  /** Close the transcript file of a chat that left memory. */
  release(sessionId: string): void {
    const log = this.logs.get(sessionId);
    if (!log) return;
    this.logs.delete(sessionId);
    try { log.close(); } catch (err) {
      logger.warn('CompanionChatPersistence: closing a transcript failed', { sessionId, error: summarizeError(err) });
    }
  }

  /** Resolves once every appended line is on disk. */
  async flush(): Promise<void> {
    await Promise.all([...this.logs.values()].map((log) => log.flush()));
  }

  close(): void {
    for (const id of [...this.logs.keys()]) this.release(id);
  }

  /** Delete a chat's files. Rejects when a file could not be removed. */
  async delete(sessionId: string): Promise<void> {
    this.release(sessionId);
    for (const suffix of [META_SUFFIX, LOG_SUFFIX]) {
      try {
        unlinkSync(this.path(sessionId, suffix));
      } catch (err) {
        if (isNodeErrorCode(err, 'ENOENT')) continue;
        throw new Error(`Companion chat session delete failed for ${sessionId}: ${summarizeError(err)}`);
      }
    }
  }

  /**
   * Every saved chat, read without changing anything on disk. For the start-up
   * fold into the shared session store, which may run beside the manager.
   * Summaries are read first; a transcript is opened only for a chat
   * `transcriptFor` accepts (all of them when it is absent), so a fold that
   * already holds a chat does not parse its history again on every start.
   */
  async loadAll(options: { readonly transcriptFor?: ((meta: CompanionChatSession) => boolean) | undefined } = {}): Promise<PersistedChatSession[]> {
    const rejected: RejectedChatFile[] = [];
    this.#rejected = rejected;
    let names: string[];
    try { names = readdirSync(this.sessionsDir); } catch (err) {
      if (!isNodeErrorCode(err, 'ENOENT')) {
        logger.warn('CompanionChatPersistence: failed to read sessions directory', { dir: this.sessionsDir, error: summarizeError(err) });
      }
      return [];
    }
    const present = new Set(names);
    const results: PersistedChatSession[] = [];
    for (const name of names) {
      try {
        if (name.endsWith(META_SUFFIX)) {
          const id = name.slice(0, -META_SUFFIX.length);
          const meta = readMeta(JSON.parse(readFileSync(join(this.sessionsDir, name), 'utf-8')) as unknown, id);
          const wanted = options.transcriptFor?.(meta) ?? true;
          const lines = wanted && present.has(`${id}${LOG_SUFFIX}`) ? readFileSync(join(this.sessionsDir, `${id}${LOG_SUFFIX}`), 'utf-8') : '';
          results.push({ meta, messages: readRecords(parseLines(lines)).messages });
        }
      } catch (err) {
        rejected.push({ file: name, reason: `could not be read (${summarizeError(err)})` });
      }
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Reading records
// ---------------------------------------------------------------------------

function* parseLines(text: string): Iterable<ChatRecord> {
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line) as ChatRecord; } catch { /* a torn last line from an interrupted write */ }
  }
}

/** The latest line per message, in the order messages first appeared. */
function readRecords(records: Iterable<ChatRecord>): PersistedTranscript {
  const messages = new Map<string, CompanionChatMessage>();
  let lastTurn: PersistedTurnMark | undefined;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    if ('m' in record && isMessage(record.m)) messages.set(record.m.id, record.m);
    else if ('turn' in record && record.turn && typeof record.turn.userMessageId === 'string') lastTurn = record.turn;
  }
  return { messages: [...messages.values()], ...(lastTurn ? { lastTurn } : {}) };
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function safeSessionId(id: string): boolean { return id.length > 0 && !/[\\/\0]/.test(id) && id !== '.' && id !== '..'; }

function readMeta(parsed: unknown, id: string): CompanionChatSession {
  if (typeof parsed !== 'object' || parsed === null) throw new Error('summary is not an object');
  const meta = parsed as Partial<CompanionChatSession>;
  if (meta.id !== id) throw new Error('summary does not name this chat');
  if (meta.status !== 'active' && meta.status !== 'closed') throw new Error('summary has no status');
  if (typeof meta.createdAt !== 'number' || typeof meta.updatedAt !== 'number') throw new Error('summary has no times');
  return parsed as CompanionChatSession;
}

function isMessage(value: unknown): value is CompanionChatMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m['id'] === 'string' && (m['role'] === 'user' || m['role'] === 'assistant') && typeof m['content'] === 'string';
}

function isNodeErrorCode(value: unknown, code: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    (value as { code?: unknown }).code === code
  );
}
