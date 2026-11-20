/**
 * authority-record-file.ts, the authority record on disk: one file, one writer
 * at a time, read by every process of this daemon home.
 *
 * The request path costs one lstat: the file is read and its view rebuilt only
 * when the file's identity (inode, size, times) moved since this process last
 * read or wrote it, so another process's grant or revocation is taken in on
 * the next request. A file that exists and cannot be read fails CLOSED: the
 * view is null (nothing authenticates from it) and nothing is written over it.
 *
 * Every write takes the cross-process lock, reads the file again, applies the
 * change to what is on disk now, writes once (atomic, durable), publishes the
 * new view and then tells listeners. Merges from other machines (`absorb`)
 * take the same path, so a local revocation and a remote grant can never
 * overwrite each other.
 */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { acquireProcessLock } from '../utils/process-lock.js';
import { writeFileAtomicAsync } from '../utils/atomic-json-store.js';
import { fileObservationIdentity } from '../utils/file-observation.js';
import { resolveClusterGroupSettings, revocationRetentionMs } from './group-settings.js';
import {
  authorityHead,
  buildAuthorityView,
  compactAuthority,
  emptyAuthorityRecord,
  issueEntries,
  keyOf,
  mergeAuthority,
  readAuthorityRecord,
  rescopeAuthorityRecord,
  revokeEntry,
  toAuthorityWire,
  updateEntry,
  type AuthorityDraft,
  type AuthorityHead,
  type AnyAuthorityEntry,
  type AuthorityKey,
  type AuthorityMergeOptions,
  type AuthorityRecord,
  type AuthorityScope,
  type AuthorityView,
} from './authority-record.js';

/** Revoked entries are dropped this long after every member has them (owner decision D7). */
export const AUTHORITY_REVOKED_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

const ABSENT = 'absent';

export type AuthorityChange<T> =
  | { readonly kind: 'issue'; readonly entries: readonly AuthorityDraft[]; readonly value: T }
  | { readonly kind: 'update'; readonly key: AuthorityKey; readonly patch: Readonly<Record<string, unknown>>; readonly narrowsOrWidens: boolean; readonly privatePart?: unknown; readonly parent?: AuthorityKey | null | undefined; readonly value: T }
  | { readonly kind: 'revoke'; readonly key: AuthorityKey; readonly by: string; readonly reason: string; readonly value: T }
  | { readonly kind: 'many'; readonly changes: readonly AuthorityChange<unknown>[]; readonly value: T }
  | { readonly kind: 'none'; readonly value: T };

export interface AuthorityChangeNotice {
  readonly keys: readonly AuthorityKey[];
  readonly change: 'issued' | 'updated' | 'revoked' | 'absorbed';
  readonly rev: number;
  readonly origin: string;
  /** Descendants revoked with a revoked key. */
  readonly cascade: readonly AuthorityKey[];
  /** True when this process wrote the change; false for a merge from another machine or another process's write. */
  readonly local: boolean;
}

export interface AuthorityWriteResult<T> {
  readonly value: T;
  readonly head: AuthorityHead;
  readonly keys: readonly AuthorityKey[];
}

export interface AuthorityAbsorbResult {
  readonly changed: boolean;
  readonly head: AuthorityHead;
  readonly keys: readonly AuthorityKey[];
}

export interface AuthorityRecordFileOptions {
  readonly filePath: string;
  /** This node's id: the origin of its writes and the audience its view answers for. */
  readonly nodeId: string;
  readonly now?: (() => number) | undefined;
  /**
   * The highest revision every current member's gossiped head covers, or null
   * when that is not known. Revoked entries at or below it, and older than
   * the retention, are dropped on the next write. Absent: this node is alone,
   * and every revoked entry past the retention is dropped.
   */
  readonly coveredThrough?: (() => number | null) | undefined;
  /**
   * How long a revoked entry is kept after every member has it
   * (`cluster.revocationRetentionMinutes`), read at each use. Required, so no
   * record is opened without the setting; `openAuthorityRecordFile` supplies it.
   * The same window decides when a machine that has not heard its group is
   * too far behind to offer its own copy (`syncStanding`).
   */
  readonly retentionMs: () => number;
}

/**
 * The one way to open a daemon home's authority record: beside `filePath`'s
 * node id, with the retention read from the `cluster` settings at each use
 * (group-settings.ts, floor included). `cluster` is the raw settings category.
 */
export function openAuthorityRecordFile(filePath: string, cluster: () => unknown, options: Pick<AuthorityRecordFileOptions, 'now' | 'coveredThrough'> = {}): AuthorityRecordFile {
  return new AuthorityRecordFile({
    ...options,
    filePath,
    nodeId: resolveAuthorityNodeId(filePath),
    retentionMs: () => revocationRetentionMs(resolveClusterGroupSettings(cluster())),
  });
}

/** Where this machine stands with its group's record; see `syncStanding`. */
export type AuthoritySyncStanding = 'current' | 'stale' | 'never';

/** What a machine that came back too far behind dropped, for `cluster status`. */
export interface AuthorityDroppedReport {
  readonly at: number;
  readonly count: number;
  /** Up to 20 keys, `${kind}:${id}`. */
  readonly keys: readonly AuthorityKey[];
}

/**
 * Local only, never sent: when this machine last held the same record as a
 * member of its group, and the keys it dropped because the group no longer
 * held them. Kept beside the record (`authority-sync.json`).
 */
interface AuthoritySyncState {
  readonly groupId: string | null;
  readonly lastSyncAt: number;
  readonly revisionAtSync: number;
  readonly forgotten: readonly AuthorityKey[];
  /** The token, route and endpoint hashes of forgotten entries, for the stores that look a credential up by hash. */
  readonly forgottenHashes: readonly string[];
  readonly lastDropped: AuthorityDroppedReport | null;
}

/** Most dropped keys remembered so they are never issued again; ids are never reused, so the oldest go first. */
const MAX_FORGOTTEN = 20_000;

/** The record file exists and could not be read; nothing is written over it. */
export class AuthorityRecordUnavailableError extends Error {
  override readonly name = 'AuthorityRecordUnavailableError';
  constructor(readonly filePath: string) {
    super(`The authority record ${filePath} could not be read, so no credential change is written over it. Check the file, then try again.`);
  }
}

export class AuthorityRecordFile {
  readonly filePath: string;
  readonly nodeId: string;
  private readonly now: () => number;
  private identity: string | null = null;
  private current: AuthorityView | null = null;
  private failed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(notice: AuthorityChangeNotice) => void>();
  private syncState: AuthoritySyncState | null = null;
  private forgottenKeys: Set<AuthorityKey> | null = null;
  private forgottenHashes: Set<string> | null = null;
  private syncStatePersistedAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: AuthorityRecordFileOptions) {
    this.filePath = options.filePath;
    this.nodeId = options.nodeId;
    this.now = options.now ?? Date.now;
  }

  /** One lstat; re-reads only when the file moved. Null while the file cannot be read (fail closed). */
  view(): AuthorityView | null {
    this.refresh(true);
    return this.failed ? null : this.current;
  }

  /** The head this node gossips, or null while the record cannot be read. */
  head(): AuthorityHead | null {
    return this.view()?.head ?? null;
  }

  onChange(listener: (notice: AuthorityChangeNotice) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Read, apply `change` to what is on disk, write once, publish, notify. */
  write<T>(change: (view: AuthorityView) => AuthorityChange<T>): Promise<AuthorityWriteResult<T>> {
    return this.serialized(async () => {
      const before = this.readLocked();
      const view = this.makeView(before);
      // A key this machine dropped on returning too far behind its group is
      // never issued again: ids are never reused, so its owner removed it.
      const decided = this.withoutForgotten(change(view));
      const context = { origin: this.nodeId, now: this.now() };
      const applied = applyChange(before, decided, context);
      if (applied.record === before) return { value: decided.value, head: view.head, keys: [] };
      const compacted = compactAuthority(applied.record, context.now, this.retentionMs(),
        this.options.coveredThrough ? this.options.coveredThrough() : applied.record.revision);
      // What compaction dropped stays revoked on this machine (see makeView).
      if (compacted !== applied.record) await this.forget([...applied.record.entries.values()].filter((entry) => !compacted.entries.has(keyOf(entry))));
      await this.persist(compacted);
      const after = this.current!;
      const revoked = applied.revoked;
      const cascade = revoked.flatMap((key) => after.descendants(key));
      this.notify({
        keys: applied.keys,
        change: revoked.length > 0 ? 'revoked' : applied.updated ? 'updated' : 'issued',
        rev: compacted.revision,
        origin: this.nodeId,
        cascade,
        local: true,
      });
      return { value: decided.value, head: after.head, keys: applied.keys };
    });
  }

  /** Merge a copy received from another machine. One write when the merge changed anything. */
  absorb(remote: AuthorityRecord, options: AuthorityMergeOptions = {}): Promise<AuthorityAbsorbResult> {
    return this.serialized(async () => {
      const before = this.readLocked();
      const merged = mergeAuthority(before, remote, options);
      const keys = changedKeys(before, merged);
      if (keys.length === 0 && merged.revocationFloor === before.revocationFloor && merged.revision === before.revision) {
        return { changed: false, head: authorityHead(before), keys: [] };
      }
      await this.persist(merged);
      const after = this.current!;
      const revoked = keys.filter((key) => after.isRevoked(key) && !buildAuthorityView(before, this.nodeId).isRevoked(key));
      this.notify({ keys, change: 'absorbed', rev: merged.revision, origin: this.nodeId, cascade: revoked.flatMap((key) => after.descendants(key)), local: false });
      return { changed: true, head: after.head, keys };
    });
  }

  /** The revoked-entry retention in force now. */
  retentionMs(): number {
    const value = this.options.retentionMs();
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : AUTHORITY_REVOKED_RETENTION_MS;
  }

  /**
   * Where this machine stands with `groupId`'s record: `current` when it last
   * held the same record as a member within the retention window, `stale`
   * when longer ago (a revocation it missed may have been dropped from the
   * group's record since), `never` when it has not synced with this group.
   */
  syncStanding(groupId: string): AuthoritySyncStanding {
    const state = this.readSyncState();
    if (state.groupId !== groupId || state.lastSyncAt <= 0) return 'never';
    return this.now() - state.lastSyncAt > this.retentionMs() ? 'stale' : 'current';
  }

  /**
   * This machine holds the group's record now (it took a member's whole
   * record, or its head matched a member's). Saved at most once per tenth of
   * the retention window, so ordinary gossip writes almost never.
   */
  async noteSynced(groupId: string): Promise<void> {
    const state = this.readSyncState();
    const now = this.now();
    const revision = this.view()?.record.revision ?? state.revisionAtSync;
    const due = state.groupId !== groupId || now - this.syncStatePersistedAt >= this.retentionMs() / 10;
    this.syncState = { ...state, groupId, lastSyncAt: now, revisionAtSync: revision };
    if (due) await this.saveSyncState();
  }

  /** Whether this machine dropped `key` on returning too far behind its group. */
  isForgotten(key: AuthorityKey): boolean {
    this.readSyncState();
    return this.forgottenKeys!.has(key);
  }

  /** The last drop made on returning too far behind, for `cluster status`. */
  droppedReport(): AuthorityDroppedReport | null {
    return this.readSyncState().lastDropped;
  }

  /**
   * Take a member's whole record as the truth for what is live, on a machine
   * that is `stale` or `never` synced with `groupId`. Every entry the group
   * holds is merged as usual (a revocation on either side still wins). An
   * entry only this machine holds is kept, and so offered to the group, only
   * when this machine wrote it after it last synced (any it wrote itself, when
   * it never synced with this group); anything else was removed by the group
   * while this machine was away and is dropped here, remembered so it is never
   * issued again, and reported.
   */
  adoptGroupTruth(remote: AuthorityRecord, groupId: string, options: AuthorityMergeOptions = {}): Promise<AuthorityAbsorbResult & { readonly dropped: readonly AuthorityKey[] }> {
    return this.serialized(async () => {
      const before = this.readLocked();
      const state = this.readSyncState();
      const never = state.groupId !== groupId || state.lastSyncAt <= 0;
      const kept = new Map(before.entries);
      const dropped: AuthorityKey[] = [];
      for (const [key, entry] of before.entries) {
        if (remote.entries.has(key)) continue;
        const ownAfterSync = entry.origin === this.nodeId && (never || Math.max(entry.rev, entry.revoked?.rev ?? 0) > state.revisionAtSync);
        if (ownAfterSync) continue;
        kept.delete(key);
        dropped.push(key);
      }
      const trimmed: AuthorityRecord = { ...before, entries: kept };
      const merged = mergeAuthority(trimmed, remote, options);
      const keys = [...changedKeys(before, merged), ...dropped];
      const now = this.now();
      this.syncState = {
        ...state, groupId, lastSyncAt: now, revisionAtSync: merged.revision,
        lastDropped: dropped.length > 0 ? { at: now, count: dropped.length, keys: dropped.slice(0, 20) } : state.lastDropped,
      };
      await this.forget(dropped.map((key) => before.entries.get(key)!));
      await this.saveSyncState();
      if (keys.length > 0 || merged.revocationFloor !== before.revocationFloor || merged.revision !== before.revision) await this.persist(merged);
      else this.current = this.makeView(before);
      const after = this.current!;
      if (keys.length > 0) this.notify({ keys, change: 'absorbed', rev: merged.revision, origin: this.nodeId, cascade: [], local: false });
      return { changed: keys.length > 0, head: after.head, keys, dropped };
    });
  }

  private syncStatePath(): string {
    return join(dirname(this.filePath), 'authority-sync.json');
  }

  private readSyncState(): AuthoritySyncState {
    if (this.syncState) return this.syncState;
    let state: AuthoritySyncState = { groupId: null, lastSyncAt: 0, revisionAtSync: 0, forgotten: [], forgottenHashes: [], lastDropped: null };
    try {
      const raw = JSON.parse(readFileSync(this.syncStatePath(), 'utf8')) as Record<string, unknown>;
      const lastDropped = raw['lastDropped'] as AuthorityDroppedReport | null | undefined;
      state = {
        groupId: typeof raw['groupId'] === 'string' ? raw['groupId'] : null,
        lastSyncAt: typeof raw['lastSyncAt'] === 'number' ? raw['lastSyncAt'] : 0,
        revisionAtSync: typeof raw['revisionAtSync'] === 'number' ? raw['revisionAtSync'] : 0,
        forgotten: Array.isArray(raw['forgotten']) ? raw['forgotten'].filter((key): key is AuthorityKey => typeof key === 'string' && key.includes(':')) : [],
        forgottenHashes: Array.isArray(raw['forgottenHashes']) ? raw['forgottenHashes'].filter((hash): hash is string => typeof hash === 'string') : [],
        lastDropped: lastDropped && typeof lastDropped === 'object' && typeof lastDropped.at === 'number' ? lastDropped : null,
      };
    } catch { /* absent or unreadable: never synced, nothing forgotten */ }
    this.syncState = state;
    this.forgottenKeys = new Set(state.forgotten);
    this.forgottenHashes = new Set(state.forgottenHashes);
    return state;
  }

  /**
   * Remember entries this record no longer holds (dropped by compaction, or
   * on returning too far behind) as revoked on this machine for good. A store
   * that keeps its own copy of a credential (the pairing file, the grant
   * ledger, the push store) asks `isRevoked` or `deviceTokenRevoked`; without
   * this, the copy would read as live again once the record forgot it.
   */
  private async forget(entries: readonly AnyAuthorityEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const state = this.readSyncState();
    const keys = entries.map((entry) => keyOf(entry));
    const hashes: string[] = [];
    for (const entry of entries) {
      const fields = entry.public as unknown as Record<string, unknown>;
      for (const field of ['tokenHash', 'routeHash', 'endpointHash']) if (typeof fields[field] === 'string') hashes.push(fields[field] as string);
    }
    const forgotten = [...state.forgotten.filter((key) => !keys.includes(key)), ...keys].slice(-MAX_FORGOTTEN);
    const forgottenHashes = [...state.forgottenHashes.filter((hash) => !hashes.includes(hash)), ...hashes].slice(-MAX_FORGOTTEN);
    this.syncState = { ...state, forgotten, forgottenHashes };
    this.forgottenKeys = new Set(forgotten);
    this.forgottenHashes = new Set(forgottenHashes);
    await this.saveSyncState();
  }

  /** The record's view, with what this machine forgot still answering as revoked. */
  private makeView(record: AuthorityRecord): AuthorityView {
    this.readSyncState();
    const keys = this.forgottenKeys!, hashes = this.forgottenHashes!;
    return buildAuthorityView(record, this.nodeId, keys.size === 0 && hashes.size === 0 ? undefined : { keys, hashes });
  }

  private async saveSyncState(): Promise<void> {
    await writeFileAtomicAsync(this.syncStatePath(), `${JSON.stringify(this.readSyncState())}\n`, { mode: 0o600, durable: true });
    this.syncStatePersistedAt = this.now();
  }

  private withoutForgotten<T>(change: AuthorityChange<T>): AuthorityChange<T> {
    this.readSyncState();
    if (this.forgottenKeys!.size === 0) return change;
    if (change.kind === 'issue') {
      const entries = change.entries.filter((draft) => !this.forgottenKeys!.has(keyOf(draft)));
      return entries.length === change.entries.length ? change : entries.length === 0 ? { kind: 'none', value: change.value } : { ...change, entries };
    }
    if (change.kind === 'many') return { ...change, changes: change.changes.map((part) => this.withoutForgotten(part)) };
    return change;
  }

  /** Move the record into a group's scope (this machine joined one) or back to its own (it left). Nothing is removed. */
  rescope(scope: AuthorityScope): Promise<void> {
    return this.serialized(async () => {
      const before = this.readLocked();
      if (JSON.stringify(before.scope) === JSON.stringify(scope)) return;
      await this.persist(rescopeAuthorityRecord(before, scope));
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const lock = await acquireProcessLock(`${this.filePath}.writer.lock`);
      try { return await work(); }
      finally { lock.release(); }
    });
    this.queue = task.catch(() => {});
    return task;
  }

  /** Under the lock: the record on disk now. Throws rather than write over a file it cannot read. */
  private readLocked(): AuthorityRecord {
    this.refresh(false);
    if (this.failed) throw new AuthorityRecordUnavailableError(this.filePath);
    return this.current!.record;
  }

  private statIdentity(): string | null {
    try { return fileObservationIdentity(this.filePath); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? ABSENT : null; }
  }

  private refresh(notifyOthers: boolean): void {
    const identity = this.statIdentity();
    if (identity !== null && identity === this.identity && this.current) return;
    const previous = this.current?.record ?? null;
    let record: AuthorityRecord;
    if (identity === ABSENT) {
      record = emptyAuthorityRecord({ groupId: null, nodeId: this.nodeId });
    } else {
      try {
        const parsed = readAuthorityRecord(JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown);
        if (!parsed) throw new Error('not an authority record');
        record = parsed;
      } catch {
        this.failed = true;
        this.identity = null;
        return;
      }
    }
    this.failed = false;
    this.identity = identity;
    this.current = this.makeView(record);
    // Another process (the terminal app beside the daemon) changed the record:
    // listeners hear about it as they would about their own change.
    if (notifyOthers && previous) {
      const keys = changedKeys(previous, record);
      if (keys.length > 0) this.notify({ keys, change: 'absorbed', rev: record.revision, origin: this.nodeId, cascade: [], local: false });
    }
  }

  private async persist(record: AuthorityRecord): Promise<void> {
    await writeFileAtomicAsync(this.filePath, `${JSON.stringify(toAuthorityWire(record))}\n`, { mode: 0o600, durable: true });
    this.identity = this.statIdentity();
    this.failed = false;
    this.current = this.makeView(record);
  }

  private notify(notice: AuthorityChangeNotice): void {
    for (const listener of this.listeners) {
      try { listener(notice); } catch { /* one listener cannot stop the others */ }
    }
  }
}

function changedKeys(before: AuthorityRecord, after: AuthorityRecord): AuthorityKey[] {
  const keys: AuthorityKey[] = [];
  for (const [key, entry] of after.entries) {
    const old = before.entries.get(key);
    if (!old || old.rev !== entry.rev || old.origin !== entry.origin || (old.revoked === null) !== (entry.revoked === null)
      || ((entry.kind === 'budget-spend' || entry.kind === 'job') && JSON.stringify(old.public) !== JSON.stringify(entry.public))) keys.push(key);
  }
  return keys;
}

interface Applied {
  readonly record: AuthorityRecord;
  readonly keys: AuthorityKey[];
  readonly revoked: AuthorityKey[];
  readonly updated: boolean;
}

function applyChange(record: AuthorityRecord, change: AuthorityChange<unknown>, context: { origin: string; now: number }): Applied {
  switch (change.kind) {
    case 'none':
      return { record, keys: [], revoked: [], updated: false };
    case 'issue': {
      const issued = issueEntries(record, change.entries, context);
      return { record: issued.record, keys: issued.keys, revoked: [], updated: false };
    }
    case 'update':
      return { record: updateEntry(record, change.key, change.patch, change.narrowsOrWidens, context, change.privatePart, change.parent), keys: [change.key], revoked: [], updated: true };
    case 'revoke': {
      const next = revokeEntry(record, change.key, change.by, change.reason, context);
      return { record: next, keys: next === record ? [] : [change.key], revoked: next === record ? [] : [change.key], updated: false };
    }
    case 'many': {
      let current = record;
      const keys: AuthorityKey[] = [], revoked: AuthorityKey[] = [];
      let updated = false;
      for (const part of change.changes) {
        const applied = applyChange(current, part, context);
        current = applied.record;
        keys.push(...applied.keys);
        revoked.push(...applied.revoked);
        updated ||= applied.updated;
      }
      return { record: current, keys, revoked, updated };
    }
  }
}

export { keyOf };

/**
 * The id this daemon home writes its authority entries under: one per home,
 * shared by every process that uses it (the daemon and the terminal apps
 * beside it), made once beside the record and never changed.
 */
export function resolveAuthorityNodeId(recordPath: string): string {
  const path = join(dirname(recordPath), 'authority-node-id');
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const id = randomUUID();
  try { writeFileSync(path, `${id}\n`, { flag: 'wx', mode: 0o600 }); return id; }
  catch (error) {
    // Another process made it first: use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFileSync(path, 'utf8').trim();
    throw error;
  }
}
