/**
 * Where the session broker keeps its sessions.
 *
 * On disk (the daemon): one small index document of session records, plus one
 * append-only log per session holding its messages and input rows. A message
 * is one appended line; an input that changes state is one appended line (the
 * newest line for an id wins); a heartbeat, which only moves liveness
 * timestamps, writes nothing; the index is rewritten only when something it
 * lists changes (a session created, closed, reopened, renamed, a participant
 * or route added). Counters the logs already state (message count, pending
 * inputs, last agent, last error) are derived from them when a session loads.
 * Closed sessions keep their log on disk and load when something asks for
 * them.
 *
 * Injected (a caller hands the broker a `PersistentStore`): the whole store is
 * one snapshot written on every change, as before; nothing is deferred.
 *
 * Either way a stored entry this build cannot read is set aside, named, and
 * carried forward untouched, and every other entry loads.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { isRecord } from '../utils/record-coerce.js';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import { openRecordLog, type RecordLog } from '../state/record-log.js';
import type { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import type { SharedSessionInputRecord } from './session-intents.js';
import type { SharedSessionMessage, SharedSessionRecord } from './session-types.js';
import type { SharedSessionStoreSnapshot } from './session-broker-helpers.js';
import {
  SESSION_INDEX_VERSION,
  countPendingSessionInputs,
  createSessionBrokerSnapshot,
  isSessionIndexDocument,
  readSessionBrokerSnapshot,
  readStoredSessionInput,
  readStoredSessionMessage,
  readStoredSessionRecord,
  sortInputs,
  sortMessages,
  type SetAsideSessionEntry,
} from './session-broker-state.js';
import { withSessionCloseReason } from './session-broker-sessions.js';
import { countOwedChannelReplies } from './session-broker-inputs.js';
import { noteCarriedForward } from '../state/carried-forward.js';

export type { SetAsideSessionEntry } from './session-broker-state.js';

/** What the broker hands a write: its maps, read without loading anything that is still on disk. */
export interface SessionBrokerStateView {
  readonly sessions: ReadonlyMap<string, SharedSessionRecord>;
  /** The loaded messages of a session, or undefined when they are on disk only. */
  peekMessages(sessionId: string): readonly SharedSessionMessage[] | undefined;
  peekInputs(sessionId: string): readonly SharedSessionInputRecord[] | undefined;
  /** Every loaded bucket, for a whole-store writer. */
  readonly messages: ReadonlyMap<string, readonly SharedSessionMessage[]>;
  readonly inputs: ReadonlyMap<string, readonly SharedSessionInputRecord[]>;
}

export interface SessionBrokerLoadResult {
  readonly sessions: Map<string, SharedSessionRecord>;
  readonly messages: Map<string, SharedSessionMessage[]>;
  readonly inputs: Map<string, SharedSessionInputRecord[]>;
  /** Sessions whose messages and inputs stay on disk until asked for. */
  readonly deferred: ReadonlySet<string>;
  readonly setAside: readonly SetAsideSessionEntry[];
}

export interface SessionBrokerStorage {
  /** The index file, or null for an injected store (it has no file, and nothing may guess one for it). */
  readonly path: string | null;
  /** True when closed sessions can leave memory and load again on demand. */
  readonly defersSessions: boolean;
  load(): Promise<SessionBrokerLoadResult>;
  /** The messages and inputs of one deferred session. */
  loadSession(sessionId: string): { readonly messages: SharedSessionMessage[]; readonly inputs: SharedSessionInputRecord[] };
  /**
   * Write what changed. `changed` names the sessions whose record, messages or
   * inputs moved since the last write; each id is removed once it is written,
   * so a failed write leaves it for the next one.
   */
  write(state: SessionBrokerStateView, changed: Set<string>, durable: boolean): Promise<void>;
  /** Resolves once every write started so far has landed (on the daemon's store: synced). Starts no write. */
  synced(): Promise<void>;
  /** Forget a session's loaded history; the next `loadSession` reads it again. */
  unload(sessionId: string): void;
  close(): void;
}

/**
 * The fields of a record the index lists. Liveness (`updatedAt`,
 * `lastActivityAt`, each participant's `lastSeenAt`) is meaningful only to the
 * running process, and the counters and agent fields of an active session are
 * stated by the session's own log, read at every start, so neither rewrites
 * the index. Any other session's log is not read at start (the index lists
 * it), so its message count and last message time are the index's to carry: a
 * message appended after close rewrites the index, and the list shows it after
 * a restart without loading the history. The same holds for the channel
 * answers it still owes a send (`owedReplyCount`, index only): a session that
 * owes one is loaded at start, so the send is made again.
 */
function indexedFields(record: SharedSessionRecord, owed: number): string {
  const {
    updatedAt: _updatedAt, lastActivityAt: _lastActivityAt, lastMessageAt, messageCount,
    retainedMessageCount: _retained, pendingInputCount: _pending, activeAgentId: _active, lastAgentId: _lastAgent,
    lastAgentModel: _lastAgentModel, lastError: _lastError, participants, ...listed
  } = record;
  return JSON.stringify({
    ...listed,
    // The same rule as the deferral at start: a session that is not active is listed from here.
    ...(record.status !== 'active' ? { messageCount, lastMessageAt } : {}),
    ...(record.status !== 'active' && owed > 0 ? { [OWED_REPLY_COUNT_KEY]: owed } : {}),
    participants: participants.map(({ lastSeenAt: _seen, ...participant }) => participant),
  });
}

/** The index entry's count of channel answers a non-active session still owes a send; not part of the session record. */
const OWED_REPLY_COUNT_KEY = 'owedReplyCount';
/** Set on an index that states every session's owed count; an index without it (3.3.4) is counted from the logs once. */
const OWED_COUNTED_KEY = 'owedReplyCounted';

/** The owed count an index entry states; 0 for an entry without one (every index 3.3.4 wrote). */
function indexedOwedReplyCount(raw: unknown): number {
  const value = isRecord(raw) ? raw[OWED_REPLY_COUNT_KEY] : undefined;
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** The newest completion in a session's messages, as the broker's completeAgent stamps it. */
function deriveAgentFacts(
  record: SharedSessionRecord,
  messages: readonly SharedSessionMessage[],
  inputs: readonly SharedSessionInputRecord[],
): Pick<SharedSessionRecord, 'lastAgentId' | 'lastAgentModel' | 'lastError'> {
  let lastAgentId = record.lastAgentId;
  let lastAgentModel = record.lastAgentModel;
  let lastAgentAt = -Infinity;
  let lastError = record.lastError;
  let errorSettled = false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (!message.agentId) continue;
    if (message.createdAt > lastAgentAt) {
      lastAgentId = message.agentId; lastAgentAt = message.createdAt;
      const model = message.metadata?.['model'];
      lastAgentModel = typeof model === 'string' && model ? model : undefined;
    }
    const status = message.metadata?.['status'];
    if (!errorSettled && (status === 'failed' || status === 'completed')) {
      lastError = status === 'failed' ? message.body : undefined;
      errorSettled = true;
    }
    if (errorSettled) break;
  }
  for (const input of inputs) {
    if (input.activeAgentId && input.updatedAt > lastAgentAt) {
      // A newer agent than the last completion: its model is not in the log yet.
      if (input.activeAgentId !== lastAgentId) lastAgentModel = undefined;
      lastAgentId = input.activeAgentId; lastAgentAt = input.updatedAt;
    }
  }
  return { ...(lastAgentId ? { lastAgentId } : {}), ...(lastAgentModel ? { lastAgentModel } : {}), ...(lastError ? { lastError } : {}) };
}

/** A record with what its loaded messages and inputs state about it. */
export function withLoggedFacts(
  record: SharedSessionRecord,
  messages: readonly SharedSessionMessage[],
  inputs: readonly SharedSessionInputRecord[],
): SharedSessionRecord {
  const lastMessage = messages.at(-1);
  const latestInputAt = inputs.reduce((latest, input) => Math.max(latest, input.updatedAt), 0);
  const lastMessageAt = Math.max(record.lastMessageAt ?? 0, lastMessage?.createdAt ?? 0);
  const { lastAgentId: _a, lastAgentModel: _m, lastError: _e, retainedMessageCount, ...rest } = record;
  const messageCount = Math.max(record.messageCount, messages.length);
  return {
    ...rest,
    ...deriveAgentFacts(record, messages, inputs),
    messageCount,
    ...(retainedMessageCount !== undefined && retainedMessageCount < messageCount ? { retainedMessageCount } : {}),
    ...(lastMessageAt > 0 ? { lastMessageAt } : {}),
    pendingInputCount: countPendingSessionInputs(inputs),
    updatedAt: Math.max(record.updatedAt, lastMessageAt, latestInputAt),
    lastActivityAt: Math.max(record.lastActivityAt, lastMessageAt, latestInputAt),
  };
}

type LogLine = { readonly m: SharedSessionMessage } | { readonly i: SharedSessionInputRecord; readonly v: number };

interface SessionLogState {
  log: RecordLog<unknown> | null;
  /** Messages of the loaded bucket already in the log (the bucket only grows). */
  messagesWritten: number;
  /** Each input row as last written, by id: the object itself, so a changed row is a reference compare. */
  readonly inputs: Map<string, { readonly row: SharedSessionInputRecord; readonly v: number }>;
  /** Lines in the log, for deciding when superseded input versions are worth compacting away. */
  lines: number;
}

/** File name of a session's log: its id when that is a plain name, else a digest. */
function logFileName(sessionId: string): string {
  return /^[A-Za-z0-9_-]{1,100}$/.test(sessionId)
    ? `${sessionId}.jsonl`
    : `x-${createHash('sha256').update(sessionId).digest('hex').slice(0, 40)}.jsonl`;
}

/** The daemon's session store: an index document and one log per session. */
export class SessionBrokerFileStorage implements SessionBrokerStorage {
  readonly path: string;
  readonly defersSessions = true;
  readonly #logDir: string;
  readonly #logs = new Map<string, SessionLogState>();
  readonly #indexed = new Map<string, string>();
  /** Channel answers each session still owes a send, as its loaded inputs last stated (or its index entry, while deferred). */
  readonly #owed = new Map<string, number>();
  /** Session records this build could not read, carried forward verbatim in every index write. */
  #unreadableRecords: readonly unknown[] = [];
  #indexDirty = false;
  #sequence = 0;
  #setAside: SetAsideSessionEntry[] = [];
  /**
   * The log syncs of every write still in flight. A write that finds nothing
   * left to append (a concurrent write already took its change out of
   * `changed`) waits for these before it resolves, so no caller is told its
   * change is on disk while the sync carrying it is still running.
   */
  #syncing: Promise<void> | null = null;

  constructor(path: string) {
    this.path = path;
    this.#logDir = join(dirname(path), `${basename(path).replace(/\.json$/, '')}`);
  }

  async load(): Promise<SessionBrokerLoadResult> {
    this.close();
    this.#indexed.clear();
    this.#owed.clear();
    this.#setAside = [];
    this.#indexDirty = false;
    const document = readDocument<Record<string, unknown>>(this.path, {
      label: 'shared sessions index',
      recovery: 'Sessions whose message logs remain are listed again from those logs.',
      validate: (parsed) => {
        if (!isRecord(parsed)) throw new Error('the sessions index is not a JSON object');
        return parsed;
      },
    });
    let records: readonly unknown[] = [];
    let carried: readonly unknown[] = [];
    if (document && isSessionIndexDocument(document)) {
      records = document.sessions;
      carried = Array.isArray(document.setAside) ? document.setAside : [];
    } else if (document) {
      ({ records, carried } = await this.#migrateWholeStore(document));
    }
    // An index this build wrote states every owed channel send. One from before
    // (3.3.4) does not, but each session's log does (its input rows carry
    // `channelReply: 'owed'`), so at the first start on such an index every
    // session that would wait on disk is read once for it, and the rewritten
    // index records the counts.
    const owedCounted = isRecord(document) && document[OWED_COUNTED_KEY] === true;
    if (document && !owedCounted) this.#indexDirty = true;
    let carriedOwed = 0;
    const sessions = new Map<string, SharedSessionRecord>();
    const messages = new Map<string, SharedSessionMessage[]>();
    const inputs = new Map<string, SharedSessionInputRecord[]>();
    const deferred = new Set<string>();
    const unreadable: unknown[] = [];
    // Records an earlier start set aside are read again: a build that knows them
    // gets those sessions back, in place of a stand-in an older build listed from
    // the session's log, and the index lists them again.
    for (const [index, raw] of [...records, ...carried].entries()) {
      const record = readStoredSessionRecord(raw, index, [], [], this.#setAside);
      if (!record) { unreadable.push(raw); continue; }
      if (index >= records.length) {
        this.#indexDirty = true;
        deferred.delete(record.id);
        messages.delete(record.id);
        inputs.delete(record.id);
      }
      const owed = indexedOwedReplyCount(raw);
      this.#owed.set(record.id, owed);
      this.#indexed.set(record.id, indexedFields(record, owed));
      // Active sessions and any with work or a channel send still owed load now; the rest wait until asked for.
      const waits = record.status !== 'active' && record.pendingInputCount === 0;
      if (waits && owedCounted && owed === 0) {
        sessions.set(record.id, record);
        deferred.add(record.id);
        continue;
      }
      const history = this.loadSession(record.id);
      const owedOnLog = countOwedChannelReplies(history.inputs);
      this.#owed.set(record.id, owedOnLog);
      if (waits && owedOnLog === 0) {
        // Read only to count what it owes (the first start on an index from before): it owes nothing, so it waits on disk.
        this.unload(record.id);
        sessions.set(record.id, record);
        deferred.add(record.id);
        continue;
      }
      if (waits && !owedCounted) carriedOwed += owedOnLog;
      if (history.messages.length > 0) messages.set(record.id, history.messages);
      if (history.inputs.length > 0) inputs.set(record.id, history.inputs);
      sessions.set(record.id, withLoggedFacts(record, history.messages, history.inputs));
    }
    this.#unreadableRecords = unreadable;
    this.#recoverUnlistedLogs(sessions, messages, inputs);
    if (this.#indexDirty) this.#writeIndex(sessions);
    noteCarriedForward('unsent channel answer', carriedOwed);
    return { sessions, messages, inputs, deferred, setAside: this.#setAside };
  }

  loadSession(sessionId: string): { readonly messages: SharedSessionMessage[]; readonly inputs: SharedSessionInputRecord[] } {
    this.unload(sessionId);
    const path = join(this.#logDir, logFileName(sessionId));
    const state: SessionLogState = { log: null, messagesWritten: 0, inputs: new Map(), lines: 0 };
    this.#logs.set(sessionId, state);
    if (!existsSync(path)) return { messages: [], inputs: [] };
    const log = openRecordLog<unknown>(path, { fsync: 'batch' });
    state.log = log;
    const byId = new Map<string, SharedSessionMessage>();
    const rows = new Map<string, { row: SharedSessionInputRecord; v: number }>();
    for (const line of log.scan()) {
      state.lines += 1;
      if (!isRecord(line)) continue;
      if ('m' in line) {
        const message = readStoredSessionMessage(line['m'], state.lines, this.#setAside);
        if (message) byId.set(message.id, message);
      } else if ('i' in line) {
        const row = readStoredSessionInput(line['i'], state.lines, this.#setAside);
        if (!row) continue;
        const v = typeof line['v'] === 'number' ? line['v'] : state.lines;
        if (v > this.#sequence) this.#sequence = v;
        const previous = rows.get(row.id);
        if (!previous || v >= previous.v) rows.set(row.id, { row, v });
      }
    }
    const messages = sortMessages(byId.values());
    const inputs = sortInputs([...rows.values()].map((entry) => entry.row));
    state.messagesWritten = messages.length;
    for (const [id, entry] of rows) state.inputs.set(id, entry);
    return { messages, inputs };
  }

  /**
   * Every write is synced before it resolves (one data sync per log written, one
   * for the index when it changed), so `durable` asks for nothing more. A write
   * with nothing left to append still waits for the syncs in flight, which may
   * carry its change.
   */
  async write(state: SessionBrokerStateView, changed: Set<string>, _durable: boolean): Promise<void> {
    const syncs: Promise<void>[] = [];
    for (const sessionId of [...changed]) {
      const record = state.sessions.get(sessionId);
      const messages = state.peekMessages(sessionId);
      const inputs = state.peekInputs(sessionId);
      if (!record && !messages && !inputs) {
        this.#dropSession(sessionId);
        changed.delete(sessionId);
        continue;
      }
      const appended = this.#appendChanges(sessionId, messages, inputs);
      if (appended) syncs.push(appended);
      if (record) {
        if (inputs) this.#owed.set(sessionId, countOwedChannelReplies(inputs));
        const listed = indexedFields(record, this.#owed.get(sessionId) ?? 0);
        if (this.#indexed.get(sessionId) !== listed) {
          this.#indexed.set(sessionId, listed);
          this.#indexDirty = true;
        }
      }
      changed.delete(sessionId);
    }
    // Lines are synced before the index names them; a crash between the two
    // leaves a log the next start lists again (#recoverUnlistedLogs).
    await this.#track(syncs);
    if (this.#indexDirty) this.#writeIndex(state.sessions);
  }

  synced(): Promise<void> {
    return this.#track([]);
  }

  /** Waits for `syncs` and for every sync already in flight; adds no sync of its own. */
  #track(syncs: readonly Promise<void>[]): Promise<void> {
    const inFlight = this.#syncing;
    if (syncs.length === 0) return inFlight ?? Promise.resolve();
    const all = Promise.all(inFlight ? [inFlight, ...syncs] : syncs).then(() => undefined);
    const tracked = all.finally(() => { if (this.#syncing === tracked) this.#syncing = null; });
    // Each caller awaits `all` and sees its failure; the shared handle never reports an unobserved rejection.
    tracked.catch(() => {});
    this.#syncing = tracked;
    return all;
  }

  unload(sessionId: string): void {
    const entry = this.#logs.get(sessionId);
    if (!entry) return;
    entry.log?.close();
    this.#logs.delete(sessionId);
  }

  close(): void {
    for (const entry of this.#logs.values()) entry.log?.close();
    this.#logs.clear();
  }

  #logFor(sessionId: string, entry: SessionLogState): RecordLog<unknown> {
    entry.log ??= openRecordLog<unknown>(join(this.#logDir, logFileName(sessionId)), { fsync: 'batch' });
    return entry.log;
  }

  /** Append the messages and input versions the log does not hold yet; resolves when they are synced. */
  #appendChanges(
    sessionId: string,
    messages: readonly SharedSessionMessage[] | undefined,
    inputs: readonly SharedSessionInputRecord[] | undefined,
  ): Promise<void> | null {
    let entry = this.#logs.get(sessionId);
    if (!entry) {
      entry = { log: null, messagesWritten: 0, inputs: new Map(), lines: 0 };
      this.#logs.set(sessionId, entry);
    }
    // A bucket shorter than what was written means the session was replaced
    // in memory (deleted and created again under its id): start its log over.
    if (messages && messages.length < entry.messagesWritten) {
      this.#dropSession(sessionId);
      entry = { log: null, messagesWritten: 0, inputs: new Map(), lines: 0 };
      this.#logs.set(sessionId, entry);
    }
    const lines: LogLine[] = [];
    if (messages) for (let index = entry.messagesWritten; index < messages.length; index += 1) lines.push({ m: messages[index]! });
    const present = new Set<string>();
    const versions: Array<{ readonly row: SharedSessionInputRecord; readonly v: number }> = [];
    if (inputs) {
      for (const row of inputs) {
        present.add(row.id);
        if (entry.inputs.get(row.id)?.row === row) continue;
        const version = { row, v: ++this.#sequence };
        versions.push(version);
        lines.push({ i: row, v: version.v });
      }
      // Rows the bucket dropped (finished history past its cap) leave the log at the next compaction.
      for (const id of [...entry.inputs.keys()]) if (!present.has(id)) entry.inputs.delete(id);
    }
    if (lines.length === 0) return null;
    const log = this.#logFor(sessionId, entry);
    let versionIndex = 0;
    for (const line of lines) {
      log.append(line);
      entry.lines += 1;
      if ('m' in line) entry.messagesWritten += 1;
      else { const version = versions[versionIndex++]!; entry.inputs.set(version.row.id, version); }
    }
    const tracked = entry;
    const live = () => tracked.messagesWritten + tracked.inputs.size;
    // Superseded input versions are dropped once they outnumber the live rows;
    // compaction itself runs without yielding, so no append can fall between its read and its rename.
    if (entry.lines - live() > Math.max(256, live())) {
      return log.flush().then(() => {
        if (this.#logs.get(sessionId) !== tracked || tracked.log !== log) return;
        return log.compact((line) => {
          if (!isRecord(line) || !('i' in line)) return true;
          // A row this build cannot read is kept as it is, for a build that can.
          const row = readStoredSessionInput(line['i'], 0, []);
          return row === null || tracked.inputs.get(row.id)?.v === line['v'];
        }).then(() => { tracked.lines = live(); });
      });
    }
    return log.flush();
  }

  #dropSession(sessionId: string): void {
    this.unload(sessionId);
    this.#owed.delete(sessionId);
    if (this.#indexed.delete(sessionId)) this.#indexDirty = true;
    const path = join(this.#logDir, logFileName(sessionId));
    try { unlinkSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  #writeIndex(sessions: ReadonlyMap<string, SharedSessionRecord>): void {
    writeDocument(this.path, {
      version: SESSION_INDEX_VERSION,
      [OWED_COUNTED_KEY]: true,
      sessions: [...sessions.values()].map((record) => {
        const owed = this.#owed.get(record.id) ?? 0;
        return record.status !== 'active' && owed > 0 ? { ...record, [OWED_REPLY_COUNT_KEY]: owed } : record;
      }),
      ...(this.#unreadableRecords.length > 0 ? { setAside: this.#unreadableRecords } : {}),
    });
    this.#indexDirty = false;
  }

  /**
   * The store from before the per-session layout: one document holding every
   * record, message and input. Each session's messages and inputs move into
   * its log (merged by id with any log already there, so a repeat is a no-op),
   * a copy of the document is kept beside it once, and the index replaces it.
   */
  async #migrateWholeStore(document: Record<string, unknown>): Promise<{ records: readonly unknown[]; carried: readonly unknown[] }> {
    const read = readSessionBrokerSnapshot(document as SharedSessionStoreSnapshot);
    this.#setAside.push(...read.setAside);
    const backup = `${this.path}.whole-store-backup`;
    if (!existsSync(backup)) copyFileSync(this.path, backup);
    const ids = new Set([...read.messages.keys(), ...read.inputs.keys()]);
    for (const sessionId of ids) {
      const existing = this.loadSession(sessionId);
      const haveMessages = new Set(existing.messages.map((message) => message.id));
      const haveInputs = new Map(existing.inputs.map((row) => [row.id, row] as const));
      const messages = [...existing.messages, ...(read.messages.get(sessionId) ?? []).filter((message) => !haveMessages.has(message.id))];
      const inputs = [...existing.inputs, ...(read.inputs.get(sessionId) ?? []).filter((row) => !haveInputs.has(row.id))];
      await this.#appendChanges(sessionId, sortMessages(messages), sortInputs(inputs));
      this.unload(sessionId);
    }
    for (const [sessionId, bucket] of read.messages) if (!read.sessions.has(sessionId)) this.#setAside.push({ kind: 'message', id: sessionId, reason: `${bucket.length} message(s) name a session the store does not list` });
    // Messages and inputs of an unreadable entry stay in the copy; the index carries unreadable records.
    this.#indexDirty = true;
    return { records: [...read.sessions.values()], carried: read.unreadable.sessions };
  }

  /** A log the index does not list (a crash between the two writes, or a lost index) is listed again, closed, with its history. */
  #recoverUnlistedLogs(
    sessions: Map<string, SharedSessionRecord>,
    messages: Map<string, SharedSessionMessage[]>,
    inputs: Map<string, SharedSessionInputRecord[]>,
  ): void {
    let names: string[];
    try { names = readdirSync(this.#logDir); } catch { return; }
    const listed = new Set([...sessions.keys()].map(logFileName));
    // A set-aside session still owns its log: it is kept for a build that can read the record, not listed again as a new one.
    for (const raw of this.#unreadableRecords) {
      if (isRecord(raw) && typeof raw['id'] === 'string') listed.add(logFileName(raw['id']));
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl') || listed.has(name)) continue;
      const probeId = name.slice(0, -'.jsonl'.length);
      const history = this.loadSession(probeId);
      const sessionId = history.messages[0]?.sessionId ?? history.inputs[0]?.sessionId;
      this.unload(probeId);
      if (!sessionId || sessions.has(sessionId) || logFileName(sessionId) !== name) continue;
      const loaded = this.loadSession(sessionId);
      const first = loaded.messages[0]?.createdAt ?? loaded.inputs[0]?.createdAt ?? Date.now();
      const record: SharedSessionRecord = withLoggedFacts({
        id: sessionId, kind: 'tui', project: 'unknown', title: `Session ${sessionId}`, status: 'closed',
        createdAt: first, updatedAt: first, lastActivityAt: first, closedAt: Date.now(), messageCount: 0, pendingInputCount: 0,
        routeIds: [], surfaceKinds: [], participants: [],
        metadata: withSessionCloseReason({ recoveredFromLog: true }, 'boot-orphaned'),
      }, loaded.messages, loaded.inputs);
      sessions.set(sessionId, record);
      if (loaded.messages.length > 0) messages.set(sessionId, loaded.messages);
      if (loaded.inputs.length > 0) inputs.set(sessionId, loaded.inputs);
      this.#owed.set(sessionId, countOwedChannelReplies(loaded.inputs));
      this.#indexed.set(sessionId, indexedFields(record, this.#owed.get(sessionId) ?? 0));
      this.#indexDirty = true;
      logger.warn('[session-broker] a session log the index did not list was listed again, closed', { sessionId, messages: loaded.messages.length });
    }
  }
}

/** An injected store: the whole snapshot on every write, nothing deferred. */
export class SessionBrokerSnapshotStorage implements SessionBrokerStorage {
  readonly path = null;
  readonly defersSessions = false;
  readonly #writes = new StoreWriteQueue();
  #unreadable: { readonly sessions: readonly unknown[]; readonly messages: readonly unknown[]; readonly inputs: readonly unknown[] } = { sessions: [], messages: [], inputs: [] };

  constructor(private readonly store: PersistentStore<SharedSessionStoreSnapshot>) {}

  async load(): Promise<SessionBrokerLoadResult> {
    const read = readSessionBrokerSnapshot(await this.store.load());
    this.#unreadable = read.unreadable;
    return { sessions: read.sessions, messages: read.messages, inputs: read.inputs, deferred: new Set(), setAside: read.setAside };
  }

  loadSession(): { readonly messages: SharedSessionMessage[]; readonly inputs: SharedSessionInputRecord[] } {
    return { messages: [], inputs: [] };
  }

  /** Snapshot now, write in call order, so a later write never lands under an earlier one; `durable` asks the store to sync the file before it resolves. */
  async write(state: SessionBrokerStateView, changed: Set<string>, durable: boolean): Promise<void> {
    changed.clear();
    const snapshot = createSessionBrokerSnapshot(state, Number.POSITIVE_INFINITY);
    const unreadable = this.#unreadable;
    const whole: SharedSessionStoreSnapshot = unreadable.sessions.length + unreadable.messages.length + unreadable.inputs.length === 0 ? snapshot : {
      sessions: [...snapshot.sessions, ...unreadable.sessions as SharedSessionRecord[]],
      messages: [...snapshot.messages, ...unreadable.messages as SharedSessionMessage[]],
      inputs: [...snapshot.inputs, ...unreadable.inputs as SharedSessionInputRecord[]],
    };
    await this.#writes.run(() => this.store.persist(whole, { durable }));
  }

  /** An injected store: resolves once every queued write has landed (synced when it was asked to be durable). */
  synced(): Promise<void> {
    return this.#writes.drain();
  }

  unload(): void {}
  close(): void {}
}

/** Log the entries a load set aside, once, by id. */
export function reportSetAsideSessionEntries(path: string | null, setAside: readonly SetAsideSessionEntry[]): void {
  if (setAside.length === 0) return;
  logger.warn('[session-broker] stored entries this build cannot read were set aside; every other session loaded', {
    store: path ?? 'injected store',
    entries: setAside.slice(0, 50).map((entry) => `${entry.kind} ${entry.id}: ${entry.reason}`),
    ...(setAside.length > 50 ? { more: setAside.length - 50 } : {}),
    next: 'They stay in the store untouched; a build that knows them reads them again.',
  });
}
