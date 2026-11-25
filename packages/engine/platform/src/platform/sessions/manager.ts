import { existsSync, fstatSync, mkdirSync, readFileSync, readSync, readdirSync, statSync, writeFileSync, unlinkSync, renameSync, openSync, fsyncSync, closeSync } from 'fs';
import { basename, join } from 'path';
import { logger } from '../utils/logger.js';
import type { OwnerStamp } from '../utils/owner-stamp.js';
import type { AgentRecord } from '../tools/agent/index.js';
import type { Contract, ContractView } from '../contract/types.js';
import { loadedReturnContext, type SessionReturnContextSummary } from '../runtime/session-return-context.js';
import type { ConversationTitleSource } from '../core/conversation.js';
import { summarizeError } from '../utils/error-display.js';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import type { SessionSurface } from '../runtime/session-surface.js';
import { digestNameStem, storedNameStem } from '../utils/stored-name.js';
import { forgetVerificationJournal } from '../core/verification/store.js';
import { holdProcessLock, type HeldProcessLock } from '../utils/process-lock.js';

/**
 * Metadata for a saved session (the first JSONL line).
 */
export interface SessionMeta {
  title: string;
  model: string;
  provider: string;
  timestamp: number;
  titleSource?: ConversationTitleSource | undefined;
  returnContext?: SessionReturnContextSummary | undefined;
  /** File format version written into the JSONL meta line. Present on files saved after schemaVersion was introduced. Missing on older files (treat as version 0). */
  schemaVersion?: number | undefined;
  /**
   * Who caused this save: `'user'` for an explicit save the user asked for
   * (e.g. a `/save` command, never expired by the session-conversations
   * retention store, see runtime/retention/append-only-registry.ts), `'auto'`
   * for an automatic save (e.g. shutdownRuntime's save-on-exit), which the
   * bounded default retention policy may reclaim. Defaults to `'auto'` when
   * omitted at save time. A file with no `saveSource` at all (written before
   * this field existed) is treated as `'user'` by the retention store, never
   * assume an old file is safe to expire.
   *
   * INVARIANT, `'user'` is STICKY. Once a session file is stamped `'user'`,
   * no `'auto'` (or omitted) save over the same file can downgrade it back to
   * `'auto'`; SessionManager.save re-reads the existing file's stamp and keeps
   * `'user'`. Without this, an automatic periodic save of the same session id
   * (persistConversation, which defaults to `'auto'`) would quietly strip the
   * retention exemption off a conversation the user explicitly asked to keep,
   * and the next sweep would be free to delete it. Only an explicit
   * `saveSource: 'user'` ever changes the stamp, always upward.
   */
  saveSource?: 'user' | 'auto' | undefined;
  /**
   * The id of the conversation this file holds (the runtime session id). A
   * save under a name whose file holds another conversation is refused
   * unless the caller asks to replace it. Absent on files saved before it
   * was recorded.
   */
  conversationId?: string | undefined;
  /**
   * How many messages the file holds, written into the meta line so a listing
   * reads one line per file. Absent on files saved before it was recorded.
   */
  messageCount?: number | undefined;
  /**
   * Set on a copy of a conversation another owner holds (a daemon-hosted
   * session mirrored here): which owner and its revision when copied. A save
   * that is not such a copy (the conversation continued here) carries none.
   */
  mirroredFrom?: OwnerStamp | undefined;
}

/** Options of {@link SessionManager.save}. */
/** A session file's identity (device, inode, size, modification time): every save replaces the file, so any save changes it. */
function fileIdentityOf(fd: number): string {
  const stat = fstatSync(fd, { bigint: true });
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;
}

/**
 * What each session file was when a manager in this process last read it whole (a load) or wrote it, by path. A
 * save compares the file with it first: a file another process saved since then is not overwritten with this
 * process's older copy. Shared by every manager in the process, so one manager's save is not another's surprise.
 */
const knownSessionFiles = new Map<string, string>();

/** This process's copy of a session is older than its file: another terminal saved it since. Nothing was written. */
export class SessionSavedElsewhereError extends Error {
  readonly code = 'SESSION_SAVED_ELSEWHERE';
  constructor(readonly sessionName: string) {
    super(`Session ${sessionName} was saved by another terminal since this one read it, so this save would have overwritten that one's turns; nothing was saved. `
      + `Run \`/resume ${sessionName}\` to continue from that save, or keep this conversation under another name with This conversation, "Save this session under a name".`);
    this.name = 'SessionSavedElsewhereError';
  }
}

/** Another terminal has this session open for writing. Nothing was opened, saved or deleted here. */
export class SessionOpenElsewhereError extends Error {
  readonly code = 'SESSION_OPEN_ELSEWHERE';
  constructor(readonly sessionName: string, action: 'open' | 'delete' = 'open') {
    super(action === 'delete'
      ? `Session ${sessionName} is open in another terminal, so it was not deleted. Close it there, or switch that terminal to another session, then delete it.`
      : `Session ${sessionName} is open in another terminal, which writes it, so it was not opened here: two terminals writing one session would overwrite each other's turns. `
        + `Continue it in that terminal, or close it there (or switch that terminal to another session) and run \`/resume ${sessionName}\` here again. To keep working here, start a new session.`);
    this.name = 'SessionOpenElsewhereError';
  }
}

/**
 * The session files this process has open for writing, by path: each holds the
 * kernel lock on the file's `.held` companion (utils/process-lock.ts), taken
 * once when a terminal opens the session and released when every manager of
 * this process that opened it has switched away or closed it. The kernel drops
 * it when the process exits, however it exits. A save only looks here.
 */
const heldSessionFiles = new Map<string, { readonly lock: HeldProcessLock; readonly holders: Set<object> }>();

/** The kernel lock file beside a session file; it ends in `.held`, so no session listing reads it. */
function sessionLockPath(filePath: string): string {
  return `${filePath}.held`;
}

/** Hold `filePath` open for writing for `holder`; refused when another process holds it. */
function holdSessionFile(filePath: string, holder: object, sessionName: string): void {
  const held = heldSessionFiles.get(filePath);
  if (held) { held.holders.add(holder); return; }
  const lock = holdProcessLock(sessionLockPath(filePath));
  if (!lock) throw new SessionOpenElsewhereError(sessionName);
  heldSessionFiles.set(filePath, { lock, holders: new Set([holder]) });
}

/** `holder` no longer has `filePath` open; the lock is released when no manager of this process has. */
function letGoSessionFile(filePath: string, holder: object): void {
  const held = heldSessionFiles.get(filePath);
  if (!held || !held.holders.delete(holder) || held.holders.size > 0) return;
  heldSessionFiles.delete(filePath);
  held.lock.release();
}

export interface SessionSaveOptions {
  /** Replace a file that holds another conversation (the user said so, e.g. `/save <name> --replace`). */
  readonly replace?: boolean | undefined;
  /**
   * The conversation being saved, when the file records a different one: a
   * save-as that moves the live conversation to the saved name records the
   * new id, while the check compares the conversation's id before the move.
   */
  readonly savingConversationId?: string | undefined;
  /**
   * The saved file becomes the session this manager has open for writing (the
   * live session moves to it, as `/save --switch`, a fork or a crash recovery
   * do). Without it a save under another name writes a copy and leaves the open
   * session as it is; a save of the open session, or with none open, opens it.
   */
  readonly open?: boolean | undefined;
}

/** The conversation's side branches: every branch not currently open, and the name of the one that is. */
export interface SessionBranches {
  readonly branches: Readonly<Record<string, readonly object[]>>;
  readonly currentBranch: string;
}

/** The meta fields of a parsed meta line (line 0); `messageCount` only when the file recorded it. */
function metaFromRecord(record: Record<string, unknown>): SessionMeta {
  const fileVersion = typeof record.schemaVersion === 'number' ? record.schemaVersion : 0;
  return {
    title: String(record.title ?? ''),
    model: String(record.model ?? ''),
    provider: String(record.provider ?? ''),
    timestamp: Number(record.timestamp ?? 0),
    titleSource: record.titleSource === 'user' ? 'user' : 'system',
    returnContext: loadedReturnContext(record.returnContext),
    schemaVersion: fileVersion,
    saveSource: record.saveSource === 'user' || record.saveSource === 'auto' ? record.saveSource : undefined,
    ...(typeof record.conversationId === 'string' ? { conversationId: record.conversationId } : {}),
    ...(typeof record.messageCount === 'number' && Number.isSafeInteger(record.messageCount) && record.messageCount >= 0
      ? { messageCount: record.messageCount } : {}),
    ...(readOwnerStamp(record.mirroredFrom) ? { mirroredFrom: readOwnerStamp(record.mirroredFrom) } : {}),
  };
}

function readOwnerStamp(value: unknown): OwnerStamp | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { owner, revision } = value as { readonly owner?: unknown; readonly revision?: unknown };
  return typeof owner === 'string' && typeof revision === 'string' ? { owner, revision } : undefined;
}

/** Messages in a file saved before its meta line recorded the count: every non-removed message line. */
function countMessageLines(raw: string): number {
  let count = 0;
  for (const line of raw.split('\n').slice(1)) {
    if (!line.trim()) continue;
    let record: unknown;
    try { record = JSON.parse(line); } catch { continue; }
    if (record !== null && typeof record === 'object'
      && (record as Record<string, unknown>).type === 'message'
      && (record as Record<string, unknown>).removed !== true) count++;
  }
  return count;
}

function readBranchesLine(record: Record<string, unknown>): SessionBranches | null {
  const { branches, currentBranch } = record;
  if (typeof currentBranch !== 'string' || !branches || typeof branches !== 'object' || Array.isArray(branches)) return null;
  const read: Record<string, object[]> = {};
  for (const [name, messages] of Object.entries(branches)) {
    if (!Array.isArray(messages) || messages.some(message => !message || typeof message !== 'object')) return null;
    read[name] = messages as object[];
  }
  return { branches: read, currentBranch };
}

/**
 * Summary info for listing saved sessions.
 */
export interface SessionInfo {
  name: string;
  title: string;
  model: string;
  provider: string;
  timestamp: number;
  messageCount: number;
  filePath: string;
  titleSource?: ConversationTitleSource | undefined;
  returnContext?: SessionReturnContextSummary | undefined;
  /** The owner and revision this file copies, when it is a mirror (SessionMeta.mirroredFrom). */
  mirroredFrom?: OwnerStamp | undefined;
}

/**
 * SessionManager - Handles saving and loading named conversation sessions
 * as JSONL files under the configured surface session directory.
 *
 * Format: each line is a JSON object.
 *   Line 0: { type: 'meta', ...SessionMeta }
 *   Line N: { type: 'message', ...message fields }
 *   then:   { type: 'agent_record', ...AgentRecord } per agent record
 *   then:   { type: 'contract', contract } per contract started in the session (version 2)
 *   then:   { type: 'branches', branches, currentBranch } when the conversation has side branches
 */
/**
 * Current schema version written to session files.
 * Increment when the file format changes in a backward-incompatible way.
 * Readers accept: version undefined (legacy, treated as 0), version <= CURRENT, and
 * version > CURRENT (future, logged as a warning, accepted with best-effort parsing).
 *
 * Version 2 adds the session's contract trees, one `{ type: 'contract', contract }`
 * line per contract started in the session (docs/design/contract-runner.md
 * section 7.1).
 */
export const CURRENT_SESSION_SCHEMA_VERSION = 2;

/** A temp file this old cannot belong to a write still in progress. */
const ORPHAN_TEMP_FILE_AGE_MS = 10 * 60 * 1000;

/** A contract line's contract, when it has the fields every reader relies on. */
function readContractLine(value: unknown): Contract | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const contract = value as Record<string, unknown>;
  return typeof contract['id'] === 'string' && typeof contract['status'] === 'string' && typeof contract['sessionId'] === 'string'
    && Array.isArray(contract['groups']) && Array.isArray(contract['units'])
    ? (value as Contract)
    : null;
}

/**
 * Turn a session name (or session id) into the filename stem its durable
 * store file uses: `<sessionsDir>/<stem>.jsonl`. Module-level so a caller that
 * needs a session's store path, e.g. the recovery layer asking "is this
 * snapshot older than its own session's last clean save?" in
 * runtime/session-recovery.ts, derives exactly the same filename this class
 * writes, without constructing a SessionManager just to reach the rule.
 * {@link SessionManager.sanitizeName} delegates here, so there is one rule,
 * not two that can drift apart.
 */
export function sanitizeSessionName(name: string): string {
  return storedNameStem(name) || digestNameStem('session', name);
}

export class SessionManager {
  private sessionsDir: string;
  /** The workspace whose `.goodvibes/verification` holds the journals of the turns these sessions ran. */
  private readonly workingDirectory: string;
  private readonly deletedListeners = new Set<(sessionId: string) => void>();

  constructor(
    baseDir: string,
    options?: {
      readonly surfaceRoot?: string | undefined;
      readonly sessionsDir?: string | undefined;
      /**
       * A declare-once `SessionSurface` (see platform/runtime/session-surface.ts).
       * When given, `sessionsDir` is resolved from `surface.sessionsDir`,
       * taking priority over an explicit `sessionsDir` or `surfaceRoot` option.
       */
      readonly surface?: SessionSurface | undefined;
    },
  ) {
    this.workingDirectory = baseDir;
    this.sessionsDir = options?.surface?.sessionsDir
      ?? options?.sessionsDir
      ?? resolveScopedDirectory(baseDir, options?.surfaceRoot, 'sessions');
    // Clean up orphaned tmp files from a crashed write.
    this._cleanupOrphanTempFiles();
  }

  /**
   * Remove any `.tmp-*` files left behind by a crashed write.
   * Several processes share one sessions directory, so a temp file whose
   * writer is still alive may be mid-write and is left alone; only files from
   * this process, from a process that no longer exists, or old enough that no
   * write could still be running are removed.
   * Cleanup errors are logged and startup continues.
   */
  private _cleanupOrphanTempFiles(): void {
    if (!existsSync(this.sessionsDir)) return;
    try {
      const files = readdirSync(this.sessionsDir);
      for (const f of files) {
        if (f.startsWith('.tmp-') && this._isOrphanTempFile(f)) {
          try {
            unlinkSync(join(this.sessionsDir, f));
            logger.debug('SessionManager: removed orphan tmp file', { file: f });
          } catch (err: unknown) {
            logger.warn('SessionManager: failed to remove orphan tmp file', {
              file: join(this.sessionsDir, f),
              error: summarizeError(err),
            });
          }
        }
      }
    } catch (err: unknown) {
      // Directory may not be readable yet; log so ops can diagnose permission issues.
      logger.warn('[SessionManager] _cleanupOrphanTempFiles: directory read failed', {
        dir: this.sessionsDir,
        error: summarizeError(err),
      });
    }
  }

  private _isOrphanTempFile(file: string): boolean {
    const pid = Number(/^\.tmp-(\d+)-/.exec(file)?.[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return true;
    try {
      if (Date.now() - statSync(join(this.sessionsDir, file)).mtimeMs > ORPHAN_TEMP_FILE_AGE_MS) return true;
    } catch {
      return false;
    }
    try {
      process.kill(pid, 0);
      return false;
    } catch (err: unknown) {
      // EPERM means the process exists but belongs to someone else.
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  /**
   * Atomically write content to filePath via a temp file + fsync(file) + rename + fsync(dir).
   * Protects against partial writes and directory-entry reversion on power loss:
   *   1. Write content to a tmp file in the same directory.
   *   2. fsync the tmp file to flush its data to storage.
   *   3. rename the tmp file into place (atomic on POSIX).
   *   4. fsync the parent directory to flush the directory entry, without
   *      this step, on power loss after rename the directory entry can
   *      revert and the renamed file disappears.
   * Mirrors the reference implementation in platform/security/user-auth.ts
   * (atomicWriteSecretFile), which performs both fsyncs.
   */
  private _atomicWrite(filePath: string, content: string, bless: boolean): void {
    const tmpPath = join(this.sessionsDir, `.tmp-${process.pid}-${Date.now()}`);
    writeFileSync(tmpPath, content, 'utf-8');
    // fsync the file to flush data buffers before rename
    const fileFd = openSync(tmpPath, 'r+');
    let written: string;
    try {
      fsyncSync(fileFd);
      // The rename keeps the inode, size and time: this is the file's identity once published.
      written = fileIdentityOf(fileFd);
    } finally {
      closeSync(fileFd);
    }
    renameSync(tmpPath, filePath);
    // What this process now knows the file to be; a write that did not start from a current copy leaves the old
    // (now stale) identity, so a later save of an older copy is still refused.
    if (bless) knownSessionFiles.set(filePath, written);
    // fsync the directory to flush the directory entry (makes rename durable)
    const dirFd = openSync(this.sessionsDir, 'r');
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }

  /**
   * Read just the `saveSource` stamp off an existing session file's meta line
   * (line 0), without loading the conversation. Returns undefined when the
   * file is absent, unreadable, or carries no readable stamp.
   */
  private _readExistingSaveSource(filePath: string): 'user' | 'auto' | undefined {
    const record = this._readExistingMetaRecord(filePath);
    return record?.saveSource === 'user' || record?.saveSource === 'auto' ? record.saveSource : undefined;
  }

  /** The refusal for a save whose name already holds another conversation: when it was saved and how long it is. */
  private _describeOtherConversation(name: string, filePath: string): string {
    let saved = 'at an unknown time';
    let count = 0;
    try {
      const meta = this._readMetaOf(filePath);
      if (meta && meta.timestamp > 0) saved = new Date(meta.timestamp).toLocaleString();
      count = meta?.messageCount ?? countMessageLines(readFileSync(filePath, 'utf-8'));
    } catch { /* the refusal stands without the details */ }
    return `A saved session named "${name}" already holds another conversation (saved ${saved}, ${count} message${count === 1 ? '' : 's'}). `
      + 'Nothing was saved. Save again with --replace to replace it, or save under another name.';
  }

  /**
   * The file a stored session `name` is in, or null when there is none. A file
   * whose recorded name is another name is not this session (two names can
   * share a stem), unless `name` is the file's own name.
   */
  private _resolveSessionFile(name: string): string | null {
    const stem = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${stem}.jsonl`);
    if (existsSync(filePath)) {
      // The file's own name (what list() shows) always addresses it.
      if (name === stem) return filePath;
      const recorded = this._readExistingMetaRecord(filePath)?.name;
      return typeof recorded === 'string' && recorded !== name ? null : filePath;
    }
    return null;
  }

  /** The meta of a session file from its first line alone, or null when it has no readable meta line. */
  private _readMetaOf(filePath: string): SessionMeta | null {
    const record = this._readExistingMetaRecord(filePath);
    return record ? metaFromRecord(record) : null;
  }

  /**
   * The meta line (line 0) of an existing session file, or undefined when absent, unreadable or not a meta line.
   * `identity`, when given, receives the identity of the file read (from the descriptor already open; no extra read).
   */
  private _readExistingMetaRecord(filePath: string, identity?: { value?: string | undefined }): Record<string, unknown> & { saveSource?: unknown; name?: unknown; conversationId?: unknown } | undefined {
    if (!existsSync(filePath)) return undefined;
    let fd: number;
    try {
      fd = openSync(filePath, 'r');
    } catch {
      return undefined;
    }
    try {
      if (identity) identity.value = fileIdentityOf(fd);
      // Read up to the first newline: a long title or return context can push
      // the meta line past any fixed prefix, and an unparseable prefix would
      // read as "no stamp" and downgrade a user save.
      const chunks: Buffer[] = [];
      let position = 0;
      for (;;) {
        const buf = Buffer.alloc(8192);
        const bytesRead = readSync(fd, buf, 0, buf.length, position);
        if (bytesRead === 0) break;
        const newline = buf.subarray(0, bytesRead).indexOf(0x0a);
        chunks.push(buf.subarray(0, newline === -1 ? bytesRead : newline));
        if (newline !== -1) break;
        position += bytesRead;
      }
      const firstLine = Buffer.concat(chunks).toString('utf-8');
      if (!firstLine.trim()) return undefined;
      const record = JSON.parse(firstLine) as Record<string, unknown>;
      return record !== null && typeof record === 'object' && record.type === 'meta' ? record : undefined;
    } catch {
      return undefined;
    } finally {
      closeSync(fd);
    }
  }

  /**
   * The `saveSource` to stamp on this write. `'user'` is sticky: an explicit
   * `'user'` always wins, and an `'auto'`/omitted save over a file already
   * stamped `'user'` PRESERVES `'user'` rather than downgrading it (see the
   * invariant on {@link SessionMeta.saveSource}).
   */
  private _resolveSaveSource(filePath: string, incoming: 'user' | 'auto' | undefined): 'user' | 'auto' {
    if (incoming === 'user') return 'user';
    return this._readExistingSaveSource(filePath) === 'user' ? 'user' : (incoming ?? 'auto');
  }

  /**
   * Save conversation messages to a JSONL session file.
   * Overwrites if file already exists.
   * Returns the sanitized filename used (may differ from input name).
   */
  save(
    name: string,
    messages: object[],
    meta: SessionMeta,
    agentRecords?: AgentRecord[],
    /** The trees of the contracts started in this session, written after the agent records. */
    contracts?: readonly ContractView[],
    /** Branches made with /branch; without them a resumed session has only its current transcript. */
    branches?: SessionBranches,
    options: SessionSaveOptions = {},
  ): { filePath: string; sanitizedName: string } {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    mkdirSync(this.sessionsDir, { recursive: true });
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.sessionsDir, `${sanitizedName}.jsonl`);
    // A session is written by the one terminal that has it open. Saving the one
    // this manager already has open is a check in memory; saving another takes
    // its lock (refused when another terminal has it open) without letting go of
    // the open one. Only a save that succeeds moves the open session to the
    // file, and only when the file becomes the live session (none was open, or
    // `options.open`); otherwise the lock is let go again, so a copy saved under
    // another name stays free and the live session stays held. A copy of a
    // conversation another owner holds (a daemon-hosted session mirrored here,
    // `mirroredFrom`) is written by every terminal attached to it from that
    // owner's one transcript, so it opens nothing; the file-identity check below
    // still applies to it.
    const tookHold = !meta.mirroredFrom && !this.#holds(filePath);
    if (tookHold) holdSessionFile(filePath, this, sanitizedName);
    let written = false;
    try {
      const result = this.#writeSession(name, sanitizedName, filePath, messages, meta, agentRecords, contracts, branches, options);
      written = true;
      return result;
    } finally {
      if (tookHold) {
        if (written && (this.#open === null || this.#open === filePath || options.open === true)) {
          if (this.#open !== null && this.#open !== filePath) letGoSessionFile(this.#open, this);
          this.#open = filePath;
        } else {
          letGoSessionFile(filePath, this);
        }
      }
    }
  }

  /** The checks and the write of {@link save}, run while this manager holds the file's lock. */
  #writeSession(
    name: string,
    sanitizedName: string,
    filePath: string,
    messages: object[],
    meta: SessionMeta,
    agentRecords: AgentRecord[] | undefined,
    contracts: readonly ContractView[] | undefined,
    branches: SessionBranches | undefined,
    options: SessionSaveOptions,
  ): { filePath: string; sanitizedName: string } {
    // Different names can still reduce to one file name ("My Chat" and "my-chat"). A file
    // that recorded the name it was saved under is never overwritten by a different name;
    // files from before the name was recorded cannot be told apart and keep their overwrite behaviour.
    // The file's own stem (what list() shows, what an opened session's id is) always
    // addresses it, as it does for reads: such a save keeps the name the file recorded.
    const onDisk: { value?: string | undefined } = {};
    const existing = this._readExistingMetaRecord(filePath, onDisk);
    // The file another terminal saved after this process last read or wrote it is not overwritten with this copy.
    const known = knownSessionFiles.get(filePath);
    if (!options.replace && known !== undefined && onDisk.value !== undefined && onDisk.value !== known) {
      throw new SessionSavedElsewhereError(sanitizedName);
    }
    const existingName = existing?.name;
    const addressedByStem = name === sanitizedName;
    if (typeof existingName === 'string' && existingName !== name && !addressedByStem) {
      throw new Error(
        `Session name "${name}" maps to the same file as the existing session "${existingName}" (${sanitizedName}.jsonl). `
        + 'Nothing was saved; choose a name that differs in more than case, spacing or punctuation.',
      );
    }
    // The same name in another conversation would replace that conversation's save.
    // A file saved before the conversation was recorded holds the conversation
    // it is named after (an automatic save is named by its session id).
    const saving = options.savingConversationId ?? meta.conversationId;
    if (existing && !options.replace && saving !== undefined) {
      const existingConversation = typeof existing.conversationId === 'string' ? existing.conversationId
        : typeof existingName === 'string' ? existingName : sanitizedName;
      if (existingConversation !== saving) {
        throw new Error(this._describeOtherConversation(name, filePath));
      }
    }

    const lines: string[] = [];

    // First line: meta record
    const metaRecord = {
      type: 'meta' as const,
      name: addressedByStem && typeof existingName === 'string' ? existingName : name,
      schemaVersion: CURRENT_SESSION_SCHEMA_VERSION,
      timestamp: meta.timestamp,
      title: meta.title,
      model: meta.model,
      provider: meta.provider,
      titleSource: meta.titleSource ?? 'system',
      returnContext: loadedReturnContext(meta.returnContext),
      saveSource: this._resolveSaveSource(filePath, meta.saveSource),
      ...(meta.conversationId !== undefined ? { conversationId: meta.conversationId } : {}),
      messageCount: messages.filter(message => (message as { removed?: unknown }).removed !== true).length,
      ...(meta.mirroredFrom ? { mirroredFrom: { owner: meta.mirroredFrom.owner, revision: meta.mirroredFrom.revision } } : {}),
    };
    lines.push(JSON.stringify(metaRecord));

    // Subsequent lines: one message per line
    for (const msg of messages) {
      const { type: _ignored, ...safeMsg } = msg as Record<string, unknown>;
      const record = { ...safeMsg, type: 'message' as const };
      lines.push(JSON.stringify(record));
    }

    // Agent records: one per line, after messages
    if (agentRecords && agentRecords.length > 0) {
      for (const agent of agentRecords) {
        const record = { ...agent, type: 'agent_record' as const };
        lines.push(JSON.stringify(record));
      }
    }

    for (const contract of contracts ?? []) {
      lines.push(JSON.stringify({ type: 'contract' as const, contract }));
    }

    if (branches && (Object.keys(branches.branches).length > 0 || branches.currentBranch !== 'main')) {
      lines.push(JSON.stringify({ type: 'branches' as const, branches: branches.branches, currentBranch: branches.currentBranch }));
    }

    this._atomicWrite(filePath, lines.join('\n') + '\n', true);
    return { filePath, sanitizedName };
  }

  /**
   * Open a session for writing from this terminal: resuming it, before its
   * history is read. Refused with SessionOpenElsewhereError, saying what to do,
   * when another terminal has it open; lets go of the session this manager had
   * open before. Costs one lock taken at open, nothing per save.
   */
  openForWriting(name: string): void {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    mkdirSync(this.sessionsDir, { recursive: true });
    const filePath = this._resolveSessionFile(name) ?? join(this.sessionsDir, `${this.sanitizeName(name)}.jsonl`);
    this.#holdOpen(filePath, basename(filePath).replace(/\.jsonl$/, ''));
  }

  /** Close the session this manager has open for writing (the terminal leaves it); another terminal may then open it. */
  closeForWriting(): void {
    if (this.#open === null) return;
    letGoSessionFile(this.#open, this);
    this.#open = null;
  }

  /** The session file this manager has open for writing (its lock is in heldSessionFiles), or null. */
  #open: string | null = null;

  /** True when this manager already holds `filePath`'s lock as its open session. */
  #holds(filePath: string): boolean {
    return this.#open === filePath && heldSessionFiles.get(filePath)?.holders.has(this) === true;
  }

  #holdOpen(filePath: string, sessionName: string): void {
    if (this.#holds(filePath)) return;
    holdSessionFile(filePath, this, sessionName);
    if (this.#open !== null && this.#open !== filePath) letGoSessionFile(this.#open, this);
    this.#open = filePath;
  }

  /**
   * Load a session from JSONL. Returns meta and messages (excluding removed ones).
   * Throws if the file does not exist or cannot be parsed.
   */
  load(name: string): { meta: SessionMeta; messages: object[]; agentRecords: AgentRecord[]; contracts: Contract[]; branches?: SessionBranches } {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filePath = this._resolveSessionFile(name);
    if (filePath === null) {
      throw new Error(`Session not found: ${name}`);
    }

    // Read through one descriptor, whose identity is what a later save of this session compares the file with.
    const fd = openSync(filePath, 'r');
    let raw: string;
    try {
      knownSessionFiles.set(filePath, fileIdentityOf(fd));
      raw = readFileSync(fd, 'utf-8');
    } finally { closeSync(fd); }
    const lines = raw.split('\n').filter(l => l.trim().length > 0);

    let meta: SessionMeta = { title: '', model: '', provider: '', timestamp: 0, titleSource: 'system' };
    const messages: object[] = [];
    const agentRecords: AgentRecord[] = [];
    const contracts: Contract[] = [];
    let branches: SessionBranches | undefined;

    let skipped = 0;
    for (const line of lines) {
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        // Malformed JSON line: skip and count it.
        skipped++;
        continue;
      }

      if (record.type === 'meta') {
        meta = metaFromRecord(record);
        if ((meta.schemaVersion ?? 0) > CURRENT_SESSION_SCHEMA_VERSION) {
          logger.warn('SessionManager: session file has a newer schemaVersion, loading with best-effort parsing', {
            name,
            fileVersion: meta.schemaVersion,
            currentVersion: CURRENT_SESSION_SCHEMA_VERSION,
          });
        }
      } else if (record.type === 'message') {
        if (record.removed === true) continue;
        // Strip the 'type' wrapper before returning raw message
        const { type: _type, ...msgFields } = record;
        messages.push(msgFields);
      } else if (record.type === 'agent_record') {
        const { type: _type, ...agentFields } = record;
        if (typeof agentFields.id === 'string' && typeof agentFields.status === 'string' && typeof agentFields.task === 'string') {
          agentRecords.push(agentFields as unknown as AgentRecord);
        }
      } else if (record.type === 'contract') {
        const contract = readContractLine(record.contract);
        if (contract === null) skipped++;
        else contracts.push(contract);
      } else if (record.type === 'branches') {
        const read = readBranchesLine(record);
        if (read === null) skipped++;
        else branches = read;
      }
    }

    if (skipped > 0) logger.warn('Skipped malformed session log lines', { name, skipped });
    return { meta, messages, agentRecords, contracts, ...(branches ? { branches } : {}) };
  }

  /**
   * A cheap signature of the saved sessions: each file's name, size, modification time and
   * inode, read from the directory without opening any file. Every save replaces its file, so
   * any change to a session changes this string; equal strings mean the sessions read the same.
   */
  fingerprint(): string {
    let files: string[];
    try { files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl')).sort(); } catch { return ''; }
    const entries: string[] = [];
    for (const file of files) {
      try {
        const stat = statSync(join(this.sessionsDir, file), { bigint: true });
        entries.push(`${file}:${stat.size}:${stat.mtimeNs}:${stat.ino}`);
      } catch { entries.push(`${file}:gone`); }
    }
    return entries.join('\n');
  }

  /**
   * List all saved sessions with metadata, sorted by most recent first.
   */
  list(): SessionInfo[] {
    if (!existsSync(this.sessionsDir)) return [];

    let files: string[];
    try {
      files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl'));
    } catch (err: unknown) {
      // Sessions directory unreadable: return an empty listing.
      logger.warn('SessionManager: could not read sessions directory', {
        dir: this.sessionsDir,
        error: summarizeError(err),
      });
      return [];
    }

    const sessions: SessionInfo[] = [];

    // One line per file: the meta line carries the message count. A file saved
    // before the count was recorded is read whole once, until its next save.
    for (const file of files) {
      const name = file.replace(/\.jsonl$/, '');
      const filePath = join(this.sessionsDir, file);
      let meta: SessionMeta | null;
      let messageCount: number;
      try {
        meta = this._readMetaOf(filePath);
        messageCount = meta?.messageCount ?? countMessageLines(readFileSync(filePath, 'utf-8'));
      } catch (err: unknown) {
        // Session file unreadable: skip it from the listing.
        logger.warn('SessionManager: unreadable session file', {
          name,
          error: summarizeError(err),
        });
        continue;
      }
      sessions.push(this._infoOf(name, filePath, meta, messageCount));
    }

    // Sort by most recent first
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    return sessions;
  }

  private _infoOf(name: string, filePath: string, meta: SessionMeta | null, messageCount: number): SessionInfo {
    return {
      name,
      title: meta?.title ?? '',
      model: meta?.model ?? '',
      provider: meta?.provider ?? '',
      timestamp: meta?.timestamp ?? 0,
      messageCount,
      filePath,
      titleSource: meta?.titleSource ?? 'system',
      returnContext: meta?.returnContext,
      ...(meta?.mirroredFrom ? { mirroredFrom: meta.mirroredFrom } : {}),
    };
  }

  /**
   * The listing entry of the one session `name` addresses (its file name, or
   * the name it was saved under), read from its meta line; null when there is
   * none. An exact id never lists the directory.
   */
  info(name: string): SessionInfo | null {
    if (!name || !name.trim()) return null;
    const filePath = this._resolveSessionFile(name);
    if (filePath === null) return null;
    try {
      const meta = this._readMetaOf(filePath);
      const messageCount = meta?.messageCount ?? countMessageLines(readFileSync(filePath, 'utf-8'));
      return this._infoOf(basename(filePath).replace(/\.jsonl$/, ''), filePath, meta, messageCount);
    } catch (err: unknown) {
      logger.warn('SessionManager: could not read session meta', { name: filePath, error: summarizeError(err) });
      return null;
    }
  }

  /**
   * Get just the metadata for a session without loading all messages (its first line).
   * Returns null if the session does not exist or meta cannot be parsed.
   */
  getMeta(name: string): SessionMeta | null {
    if (!name || !name.trim()) return null;
    const filePath = this._resolveSessionFile(name);
    if (filePath === null) return null;
    return this._readMetaOf(filePath);
  }

  /**
   * Rename a session by rewriting its meta line with a new title.
   * The file is stored under the sanitized name, rename updates the title
   * field inside the file but does NOT rename the file itself. The explicit
   * owner choice is a user save; automatic titles belong to the conversation.
   * Throws if the session does not exist.
   */
  rename(name: string, newTitle: string): void {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filePath = this._resolveSessionFile(name);
    if (filePath === null) throw new Error(`Session not found: ${name}`);

    const fd = openSync(filePath, 'r');
    let raw: string, read: string;
    try {
      read = fileIdentityOf(fd);
      raw = readFileSync(fd, 'utf-8');
    } finally { closeSync(fd); }
    const lines = raw.split('\n');
    if (lines.length === 0) throw new Error('Session file is empty');

    try {
      const record = JSON.parse(lines[0]!) as Record<string, unknown>;
      record.title = newTitle;
      // This is the explicit owner-rename contract, not automatic title generation.
      // Preserve the choice after reload and keep curated sessions out of auto retention.
      record.titleSource = newTitle.trim().length > 0 ? 'user' : 'system';
      record.saveSource = 'user';
      // A metadata rewrite must not carry retired pane state forward.
      if ('returnContext' in record) {
        const returnContext = loadedReturnContext(record.returnContext);
        if (returnContext) record.returnContext = returnContext;
        else delete record.returnContext;
      }
      lines[0]! = JSON.stringify(record);
      // The title is changed on the file as read now, so another terminal's save is kept. This process's own copy
      // counts as current afterwards only if it was current before (no other save came between).
      this._atomicWrite(filePath, lines.join('\n'), knownSessionFiles.get(filePath) === read);
    } catch (err: unknown) {
      if (err instanceof SessionSavedElsewhereError) throw err;
      throw new Error(`Failed to update session title: ${name}: ${summarizeError(err)}`);
    }
  }

  /**
   * Delete a session file.
   * Throws if the session does not exist.
   */
  delete(name: string): void {
    if (!name || !name.trim()) throw new Error('Session name cannot be empty');
    const filePath = this._resolveSessionFile(name);
    if (filePath === null) throw new Error(`Session not found: ${name}`);
    const sessionId = basename(filePath).replace(/\.jsonl$/, '');
    const journals = this._verificationJournalsOf(filePath, sessionId);
    // Deleted while holding its lock, so no other terminal has it open meanwhile; its lock file goes with it,
    // removed before the lock is let go. This process's own hold (a terminal deleting the session it has open) serves.
    const ownHold = heldSessionFiles.get(filePath);
    const lock = ownHold?.lock ?? holdProcessLock(sessionLockPath(filePath));
    if (!lock) throw new SessionOpenElsewhereError(sessionId, 'delete');
    try {
      unlinkSync(filePath);
    } catch (e) {
      // Not deleted: a hold this process had stays; one taken for the delete is let go.
      if (!ownHold) lock.release();
      throw new Error(`Failed to delete session: ${summarizeError(e)}`);
    }
    try { unlinkSync(sessionLockPath(filePath)); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('SessionManager: a deleted session\'s lock file could not be removed', { file: sessionLockPath(filePath), error: summarizeError(e) });
    }
    if (ownHold) heldSessionFiles.delete(filePath);
    lock.release();
    if (this.#open === filePath) this.#open = null;
    knownSessionFiles.delete(filePath);
    this._forgetVerificationJournals(journals);
    for (const listener of [...this.deletedListeners]) {
      try {
        listener(sessionId);
      } catch (err: unknown) {
        logger.warn('SessionManager: a session-deleted listener failed', { sessionId, error: summarizeError(err) });
      }
    }
  }

  /**
   * The ids whose verification journals hold this saved session's tool output
   * and file contents: the conversation it records (its file name and its
   * recorded conversation) and every agent run in it. Read once, at deletion.
   */
  private _verificationJournalsOf(filePath: string, stem: string): { readonly conversations: ReadonlySet<string>; readonly agents: readonly string[] } {
    const conversations = new Set<string>([stem]);
    const agents: string[] = [];
    let raw: string;
    try { raw = readFileSync(filePath, 'utf-8'); } catch { return { conversations, agents }; }
    const lines = raw.split('\n');
    try {
      const meta = JSON.parse(lines[0] ?? '') as { conversationId?: unknown };
      if (typeof meta.conversationId === 'string') conversations.add(meta.conversationId);
    } catch { /* a file with no readable meta line names its conversation by its file name alone */ }
    for (const line of lines) {
      if (!line.includes('"agent_record"')) continue;
      try {
        const record = JSON.parse(line) as { type?: unknown; id?: unknown };
        if (record.type === 'agent_record' && typeof record.id === 'string') agents.push(record.id);
      } catch { /* a torn line names no agent */ }
    }
    return { conversations, agents };
  }

  /**
   * Remove the verification journals of a deleted session, unless another
   * saved session still holds the same conversation (a named save of it, or
   * its automatic save): that one still owns them.
   */
  private _forgetVerificationJournals(journals: { readonly conversations: ReadonlySet<string>; readonly agents: readonly string[] }): void {
    let files: string[];
    try { files = readdirSync(this.sessionsDir).filter(file => file.endsWith('.jsonl')); } catch { files = []; }
    for (const file of files) {
      const stem = file.replace(/\.jsonl$/, '');
      const conversation = this._readExistingMetaRecord(join(this.sessionsDir, file))?.conversationId;
      if (journals.conversations.has(stem) || typeof conversation === 'string' && journals.conversations.has(conversation)) return;
    }
    for (const id of [...journals.conversations, ...journals.agents]) forgetVerificationJournal(this.workingDirectory, id);
  }

  /**
   * Run `listener` with the session's id after each session this manager
   * deletes (what was waiting for that session, such as the owner's answers to
   * its questions, is told it never will be). Returns the unsubscribe function.
   */
  onDeleted(listener: (sessionId: string) => void): () => void {
    this.deletedListeners.add(listener);
    return () => { this.deletedListeners.delete(listener); };
  }

  /**
   * Search all sessions for messages containing the query string (case-insensitive).
   * Returns sessions with match count and up to 3 context snippets per session.
   */
  search(query: string): Array<{ session: SessionInfo; matchCount: number; snippets: string[] }> {
    if (!query || !query.trim()) return [];
    return searchSessionMessages(this.readSearchable(), query);
  }

  /**
   * Every saved session with the text of its messages, each file read once: what a search over them needs, so a
   * search typed a character at a time (the Sessions place) reads the files when it opens and filters in memory.
   */
  readSearchable(): Array<{ session: SessionInfo; messages: string[] }> {
    const out: Array<{ session: SessionInfo; messages: string[] }> = [];
    for (const session of this.list()) {
      try {
        const lines = readFileSync(session.filePath, 'utf-8').split('\n').filter(l => l.trim().length > 0);
        const messages: string[] = [];
        for (const line of lines.slice(1)) { // skip meta line
          try {
            const record = JSON.parse(line) as Record<string, unknown>;
            if (record.type === 'message') messages.push(String(record.content ?? ''));
          } catch (err: unknown) {
            // Malformed line in session during search: skip it.
            logger.warn('SessionManager: malformed line during search', {
              name: session.name,
              error: summarizeError(err),
            });
          }
        }
        out.push({ session, messages });
      } catch (err: unknown) {
        // Session unreadable during search: skip it.
        logger.warn('SessionManager: unreadable session during search', {
          name: session.name,
          error: summarizeError(err),
        });
      }
    }
    return out;
  }

  /** Whether a saved conversation exists under this name or id (the store file is present). */
  has(name: string): boolean {
    if (!name || !name.trim()) return false;
    return this._resolveSessionFile(name) !== null;
  }

  /**
   * The file a session is (or will be) saved in: present means it can be
   * opened again. Another process reads it to tell a closed session from a
   * deleted one (the owner inbox, for a session that asked a question).
   */
  filePathFor(name: string): string {
    return this._resolveSessionFile(name) ?? join(this.sessionsDir, `${this.sanitizeName(name)}.jsonl`);
  }

  /**
   * Sanitize a session name into a safe filename: see {@link sanitizeSessionName}
   * (letters and digits of every script, `-` and `_`; a digest when nothing is left).
   */
  sanitizeName(name: string): string {
    return sanitizeSessionName(name);
  }
}

/**
 * The sessions `target` names: an exact id (or saved name) is one meta-line
 * read; only a title or id prefix lists the directory. Callers must
 * disambiguate multiple matches.
 */
/**
 * The sessions whose messages hold the query (case-insensitive), most matches first, each with how many messages hold
 * it and up to three lines around them: over sessions already read (`SessionManager.readSearchable`), no file read.
 */
export function searchSessionMessages<S>(
  sessions: readonly { readonly session: S; readonly messages: readonly string[] }[], query: string,
): Array<{ session: S; matchCount: number; snippets: string[] }> {
  if (!query || !query.trim()) return [];
  const q = query.toLowerCase();
  const results: Array<{ session: S; matchCount: number; snippets: string[] }> = [];
  for (const { session, messages } of sessions) {
    let matchCount = 0;
    const snippets: string[] = [];
    for (const content of messages) {
      const idx = content.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      matchCount++;
      if (snippets.length < 3) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(content.length, idx + q.length + 60);
        snippets.push((start > 0 ? '...' : '') + content.slice(start, end).replace(/\n/g, ' ') + (end < content.length ? '...' : ''));
      }
    }
    if (matchCount > 0) results.push({ session, matchCount, snippets });
  }
  // Sort by match count descending
  results.sort((a, b) => b.matchCount - a.matchCount);
  return results;
}

export function resolveSessionTarget(manager: Pick<SessionManager, 'info' | 'list'>, target: string): SessionInfo[] {
  const exact = manager.info(target);
  return exact ? [exact] : findSessionCandidates(manager.list(), target);
}

/** Exact ids win over titles and prefixes; callers must disambiguate multiple matches. */
export function findSessionCandidates<T extends { name: string; title: string }>(sessions: readonly T[], target: string): T[] {
  const exact = sessions.find(session => session.name === target);
  if (exact) return [exact];
  const titled = sessions.filter(session => session.title.toLowerCase() === target.toLowerCase());
  return titled.length ? titled : sessions.filter(session => session.name.startsWith(target));
}
