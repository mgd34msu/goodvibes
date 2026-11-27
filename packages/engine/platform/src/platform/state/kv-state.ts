import { existsSync, readdirSync, statSync, unlinkSync } from 'fs';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import { outsideEveryCall } from '../utils/outside-every-call.js';
import { createHash, randomBytes } from 'crypto';
import { JsonFileStore } from './json-file-store.js';
import { StoreWriteQueue } from './store-write-queue.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * Reserved keys that cannot be set by callers.
 */
const RESERVED_KEYS = new Set(['id', 'started_at', '__proto__', 'constructor', 'prototype']);

/**
 * The only filenames this module's housekeeping will ever touch.
 *
 * The state directory is SHARED with live, unrelated data, `retries.json`,
 * `agent-tracking.json`, `workflows/`, which is exactly why the append-only
 * retention registry deliberately excludes the whole directory. Nothing outside
 * this one shape is listed, stat-ed, or removed.
 */
const SESSION_FILE_PATTERN = /^(?:session_[0-9a-f]{8}|session-[A-Za-z0-9_-]{1,64})\.json$/;

/** An id that is already the 8-hex shape keeps its original `session_<id>.json` name. */
const GENERATED_ID_PATTERN = /^[0-9a-f]{8}$/;

/**
 * The file name for a session id. A caller-supplied id (a real conversation
 * session id) is not filename-safe by construction. An id made only of
 * `[A-Za-z0-9_-]` and at most 64 long is used as it is; any other id has its
 * unsafe characters replaced and is cut short, and a hash of the whole id is
 * appended so two ids that sanitize alike (`a/b`, `a_b`) or share a long prefix
 * keep separate files. The `session-` prefix keeps these files apart from the
 * generated `session_<8 hex>` ones.
 */
function sessionFileName(sessionId: string): string {
  if (GENERATED_ID_PATTERN.test(sessionId)) return `session_${sessionId}.json`;
  if (/^[A-Za-z0-9_-]{1,64}$/.test(sessionId)) return `session-${sessionId}.json`;
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
  const digest = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  return `session-${readable}-${digest}.json`;
}

/**
 * Count bound: at most this many session files survive a pass, newest-written
 * first, of the per-process `session_<hex>` files (a conversation's own file
 * goes only when its conversation does).
 */
const SESSION_KEEP_COUNT = 50;

/** How often the housekeeping pass repeats while a surface stays up (it asks which conversations are gone; no age). */
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** The bound a single reap pass applies. */
interface ReapBounds {
  readonly keepCount: number;
}

/** What one reap pass actually reclaimed, the disclosure payload. */
interface ReapOutcome {
  readonly filesRemoved: number;
  readonly bytesReclaimed: number;
  /** Removed because their conversation is gone. */
  readonly gone: number;
  /** Removed for falling outside {@link ReapBounds.keepCount}. */
  readonly overCap: number;
}

const NOTHING_REAPED: ReapOutcome = { filesRemoved: 0, bytesReclaimed: 0, gone: 0, overCap: 0 };

/** Read a Node errno `code` off an unknown thrown value without widening to `any`. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * Remove one stale session file. Returns true only when THIS call did the
 * removing.
 *
 * ENOENT is success, not failure: another process's pass got there first, which
 * is precisely the outcome wanted. It returns false so the bytes are not counted
 * twice across two concurrent reapers, each pass discloses what it actually
 * reclaimed. Any other error (a permission problem, a locked file) leaves the
 * file alone and is logged at debug; housekeeping never escalates into a failure
 * for the session that triggered it.
 */
function removeSessionFile(path: string, name: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (err) {
    if (errorCode(err) === 'ENOENT') return false;
    logger.debug('KVState: could not remove a stale session state file', { file: name, error: summarizeError(err) });
    return false;
  }
}

/**
 * Reap stale `session_<8hex>.json` files from one directory.
 *
 * Idempotent and safe to run concurrently from any number of processes: it
 * decides purely from a fresh directory listing plus each file's own mtime, and
 * every removal tolerates the file already being gone. A second pass over an
 * already-reaped directory finds no candidates and removes nothing.
 *
 * `protectedFileName` is never a candidate: the caller's own session file must
 * survive its own recovery.
 */
function reapSessionFiles(
  stateDir: string,
  protectedFileName: string,
  bounds: ReapBounds,
  canReclaimKeyedState?: (sessionToken: string) => boolean,
): ReapOutcome {
  let names: string[];
  try {
    names = readdirSync(stateDir);
  } catch {
    // Absent or unreadable directory: nothing to reclaim. Housekeeping is never
    // a reason to fail, or even warn at, the session that triggered it.
    return NOTHING_REAPED;
  }

  const candidates: { readonly path: string; readonly name: string; readonly mtimeMs: number; readonly size: number; readonly keyed: boolean }[] = [];
  for (const name of names) {
    if (!SESSION_FILE_PATTERN.test(name)) continue;
    if (name === protectedFileName) continue;
    // A `session-<id>` file is a real conversation's state, which comes back
    // when that conversation resumes, however long a saved conversation
    // lasts. Only the owner of the conversations can say one is gone, so
    // without that answer these files are never reclaimed; they are also
    // outside the count bound, which is for per-process `session_<hex>` litter.
    const keyed = name.startsWith('session-');
    if (keyed && !canReclaimKeyedState?.(name.slice('session-'.length, -'.json'.length))) continue;
    const path = join(stateDir, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile()) continue;
      candidates.push({ path, name, mtimeMs: stats.mtimeMs, size: stats.size, keyed });
    } catch {
      // Vanished between readdir and stat, a concurrent pass won the race.
    }
  }

  // Newest first, so "beyond the count bound" means "least recently written".
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  let filesRemoved = 0;
  let bytesReclaimed = 0;
  let gone = 0;
  let overCap = 0;
  let generatedSeen = 0;
  for (const candidate of candidates) {
    // A conversation's own state goes when its conversation is gone (the owner of the conversations said so above),
    // whatever its age; a process's own file only past the count bound. No age decides either.
    if (!candidate.keyed) generatedSeen += 1;
    const beyondCap = !candidate.keyed && generatedSeen > bounds.keepCount;
    if (!candidate.keyed && !beyondCap) continue;
    if (!removeSessionFile(candidate.path, candidate.name)) continue;
    filesRemoved += 1;
    bytesReclaimed += candidate.size;
    if (candidate.keyed) gone += 1;
    else overCap += 1;
  }

  return { filesRemoved, bytesReclaimed, gone, overCap };
}

/**
 * Say what was reclaimed. Silent deletion is indistinguishable from data loss,
 * so a pass that removed anything reports the counts and the byte total by
 * directory. A pass that removed nothing stays quiet, that is the common case
 * on every boot and every timer tick, and logging it would bury the lines that
 * matter. Counts, a directory path and a byte total only: never file contents.
 */
function discloseReap(stateDir: string, outcome: ReapOutcome): void {
  if (outcome.filesRemoved === 0) return;
  logger.info('KVState: reclaimed stale session state files', {
    stateDir,
    filesRemoved: outcome.filesRemoved,
    gone: outcome.gone,
    overCap: outcome.overCap,
    bytesReclaimed: outcome.bytesReclaimed,
  });
}

export interface KVStateOptions {
  readonly sessionId?: string | undefined;
  readonly stateDir: string;
  /**
   * Whether the state file of a caller-supplied (`session-<id>`) session may be
   * reclaimed: its conversation is gone. Receives the file's id part.
   * Omitted, those files are never reclaimed: a resumed conversation must find
   * its state, and only the owner of the conversations knows which are gone.
   */
  readonly canReclaimKeyedState?: ((sessionToken: string) => boolean) | undefined;
}

/**
 * KVState, Session-scoped persistent key-value store.
 *
 * Storage: <stateDir>/session_{id}.json (session-{id}.json for a caller-supplied id)
 * Session ID: 8-char hex string, auto-generated if not provided. Pass the
 * conversation's own session id so state set before a restart is read back when
 * that session resumes. A `set` or `clear` resolves once the file is written, so
 * a value reported as stored survives an exit code, a signal or a crash.
 *
 * Features:
 * - Lazy load: defers disk read until first operation.
 * - Atomic persistence: write to temp file then rename.
 * - Write-through: set() and clear() write the (small) file before they resolve.
 * - Bounded store: a conversation's file whose conversation is gone, and every
 *   process file past the SESSION_KEEP_COUNT most recent, is reclaimed at
 *   recovery and then on a SWEEP_INTERVAL_MS pass. No age decides. The
 *   instance's own file is exempt.
 */
export class KVState {
  private sessionId: string;
  private stateDir: string;
  private filePath: string;
  /** Basename of this instance's own file, the one name housekeeping must never touch. */
  private readonly fileName: string;
  private data: Record<string, unknown> | null = null;
  private loadPromise: Promise<void> | null = null;
  private readonly store: JsonFileStore<Record<string, unknown>>;
  private readonly canReclaimKeyedState: ((sessionToken: string) => boolean) | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private housekeepingStarted = false;
  /** Whole-file writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(options: KVStateOptions) {
    if (!options.stateDir || options.stateDir.trim().length === 0) {
      throw new Error('KVState requires a non-empty stateDir');
    }
    this.sessionId = options.sessionId ?? KVState.generateId();
    this.stateDir = options.stateDir;
    this.fileName = sessionFileName(this.sessionId);
    this.filePath = join(this.stateDir, this.fileName);
    this.store = new JsonFileStore(this.filePath);
    this.canReclaimKeyedState = options.canReclaimKeyedState;
  }

  async get(keys: string[]): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(this.data!, key)) {
        result[key] = this.data![key];
      }
    }
    return result;
  }

  async set(values: Record<string, unknown>): Promise<void> {
    await this.ensureLoaded();
    // Checked before anything is written, so a refused call changes nothing.
    const reserved = Object.keys(values).filter((key) => RESERVED_KEYS.has(key));
    if (reserved.length > 0) {
      throw new Error(`KVState cannot set reserved key(s): ${reserved.join(', ')}. Nothing was stored; use a different key name.`);
    }
    const data = this.data!;
    const before = new Map<string, { readonly present: boolean; readonly value: unknown }>();
    for (const [key, value] of Object.entries(values)) {
      before.set(key, { present: Object.prototype.hasOwnProperty.call(data, key), value: data[key] });
      data[key] = value;
    }
    try {
      await this.persist();
    } catch (error) {
      // Not stored: put back each key this call still holds, so the value is
      // neither readable nor written by a later successful write. A key a
      // later call has set since keeps that call's value.
      for (const [key, value] of Object.entries(values)) {
        const previous = before.get(key)!;
        if (!Object.prototype.hasOwnProperty.call(data, key) || !Object.is(data[key], value)) continue;
        if (previous.present) data[key] = previous.value;
        else delete data[key];
      }
      throw error;
    }
  }

  async list(prefix?: string): Promise<Record<string, unknown>> {
    await this.ensureLoaded();
    if (!prefix) {
      return { ...this.data! };
    }

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.data!)) {
      if (key.startsWith(prefix)) {
        result[key] = value;
      }
    }
    return result;
  }

  async clear(keys: string[]): Promise<void> {
    await this.ensureLoaded();
    const data = this.data!;
    const removed = new Map<string, unknown>();
    for (const key of keys) {
      if (RESERVED_KEYS.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        removed.set(key, data[key]);
        delete data[key];
      }
    }
    if (removed.size === 0) return;
    try {
      await this.persist();
    } catch (error) {
      // Not cleared: put back each key that is still absent; a key a later call
      // has set since keeps that call's value.
      for (const [key, value] of removed) {
        if (!Object.prototype.hasOwnProperty.call(data, key)) data[key] = value;
      }
      throw error;
    }
  }

  async load(): Promise<void> {
    // Recovery point. Loading, not construction, is when the process actually
    // re-attaches to the state directory, and it is also the first moment this
    // instance's own file is known and can be exempted. Construction only
    // records paths: tools/index.ts builds a KVState during tool registration
    // and agents/session.ts builds one per agent spawn, and neither of those
    // has recovered anything yet, so neither should be doing filesystem work on
    // the caller's synchronous construction path.
    this.startHousekeeping();

    const loaded = this.validateLoaded(await this.store.load());
    if (loaded) {
      this.data = loaded;
      if (!this.data.id) this.data.id = this.sessionId;
      if (!this.data.started_at) this.data.started_at = new Date().toISOString();
      return;
    }

    this.data = {
      id: this.sessionId,
      started_at: new Date().toISOString(),
    };
  }

  /**
   * Write the session file, after every write already queued has finished.
   * Concurrent `set`/`clear` calls each write; `JsonFileStore.save` renames
   * atomically without saying which rename lands last, so the queue orders them
   * and an older view can never land after a newer one.
   *
   * `this.data` is passed by reference: `save` serialises it when the write
   * RUNS, so each queued write emits a view at least as new as the one before it.
   */
  async persist(): Promise<void> {
    const data = this.data;
    if (data === null) return;
    await this.writes.run(() => this.store.save(data));
  }

  getSessionId(): string {
    return this.sessionId;
  }

  static listSessions(options: Pick<KVStateOptions, 'stateDir'>): string[] {
    const stateDir = readKVStateDir(options);
    if (!existsSync(stateDir)) return [];
    return readdirSync(stateDir)
      .filter(f => SESSION_FILE_PATTERN.test(f))
      .map(f => f.replace(/^session[_-]/, '').replace(/\.json$/, ''))
      .sort();
  }

  /**
   * Count-bounded reap of a state directory, on demand.
   *
   * This is NOT what keeps the store bounded, for a long time nothing called
   * it, and every session file the platform had ever written accumulated forever.
   * The bounds are now enforced by each instance's own housekeeping (see
   * {@link KVState.load}), which runs this count bound and reclaims the files of
   * conversations that are gone, at recovery and then on a pass. This static form survives for callers that
   * want an explicit count-only pass, and now shares the same idempotent,
   * concurrency-tolerant, disclosed implementation instead of its own
   * unguarded `unlinkSync`.
   *
   * No file is exempt here: the caller names the directory and the keep count,
   * and nothing in a bare static call identifies a "current" session.
   */
  static cleanupOldSessions(keepCount: number, options: Pick<KVStateOptions, 'stateDir'>): void {
    const stateDir = readKVStateDir(options);
    discloseReap(
      stateDir,
      reapSessionFiles(stateDir, '', { keepCount }),
    );
  }

  /** Stops housekeeping and waits for any write still in flight (every acknowledged write is already on disk). */
  async dispose(): Promise<void> {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    await this.writes.drain();
  }

  /**
   * Validate a loaded session file by its parsed SHAPE, not by the file having
   * existed and parsed.
   *
   * JsonFileStore already rejects bytes that are not JSON at all, which covers a
   * zero-byte file, a truncated object and a page of NULs. It does not cover
   * bytes that parse to something that is not a state record: `null`, `[]`,
   * `123`, `"…"`. A crash can leave any of those, and every one of them would
   * otherwise be installed as `this.data` and served to callers as if it were
   * their session state, `list()` would spread an array, `get()` would read
   * properties off a number. A corrupt session file is a hard failure rather
   * than a silently substituted blank session.
   */
  private validateLoaded(loaded: Record<string, unknown> | null): Record<string, unknown> | null {
    if (loaded === null || loaded === undefined) return null;
    if (typeof loaded === 'object' && !Array.isArray(loaded)) return loaded;
    throw new Error(`KVState failed to load ${this.filePath}: parsed content is not a session state object. Move or delete that file to start this session's state clean.`);
  }

  /**
   * Start this instance's housekeeping: one pass now, then a pass every
   * {@link SWEEP_INTERVAL_MS}.
   *
   * The timer exists because startup-only housekeeping in a process that stays
   * up for days reclaims nothing after its first minute, a long-lived surface
   * spawning agents all week would cross both bounds without ever restarting.
   * It is unref'd, so it can never be the reason a process refuses to exit, and
   * `dispose()` clears it.
   *
   * Runs at most once per instance. Several KVState instances in one process may
   * point at the same directory (the surface's own, plus one per agent); every
   * pass is idempotent and race-tolerant, so the overlap costs a directory
   * listing and nothing else.
   */
  private startHousekeeping(): void {
    if (this.housekeepingStarted) return;
    this.housekeepingStarted = true;
    this.sweep();
    // Started by the first read or write (a turn's): armed in the process's own context (utils/outside-every-call.ts).
    this.sweepTimer = outsideEveryCall(() => setInterval(() => this.sweep(), SWEEP_INTERVAL_MS));
    this.sweepTimer.unref?.();
  }

  /**
   * One housekeeping pass over this instance's state directory. Never throws:
   * a housekeeping problem must not become a failure of the session that
   * triggered it.
   */
  private sweep(): void {
    try {
      discloseReap(
        this.stateDir,
        reapSessionFiles(this.stateDir, this.fileName, { keepCount: SESSION_KEEP_COUNT }, this.canReclaimKeyedState),
      );
    } catch (err) {
      logger.debug('KVState: session state housekeeping pass failed', { error: summarizeError(err) });
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.data !== null) return;
    if (!this.loadPromise) {
      // Cleared on failure too: a transient read error must not answer every
      // later call for the life of the process.
      this.loadPromise = this.load().finally(() => {
        this.loadPromise = null;
      });
    }
    return this.loadPromise;
  }

  private static generateId(): string {
    const bytes = new Uint8Array(4);
    const rand = randomBytes(4);
    bytes.set(rand);

    return Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
}

function readKVStateDir(options: Pick<KVStateOptions, 'stateDir'>): string {
  if (!options.stateDir || options.stateDir.trim().length === 0) {
    throw new Error('KVState requires a non-empty stateDir');
  }
  return options.stateDir;
}
