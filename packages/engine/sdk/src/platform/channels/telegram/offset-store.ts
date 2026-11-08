/** Account-partitioned Telegram confirmation cursors. A cursor selects a
 * provider queue; it is never payment or ingress authority. Damaged/unbound
 * evidence is preserved and blocks polling rather than confirming history away.
 * Cursor publication must finish before another poll acknowledges that offset. */
import { lstatSync } from 'node:fs';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';

const MAX_FILE_BYTES = 16_384;
const MAX_ACCOUNTS = 64;
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
const offsetValue = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const accountValue = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) && Number.isSafeInteger(Number(value));
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export type TelegramOffsetFailure = 'unavailable' | 'unbound' | 'busy' | 'write-uncertain' | 'invalid-request';
export class TelegramOffsetStoreError extends Error {
  override readonly name = 'TelegramOffsetStoreError';
  constructor(readonly kind: TelegramOffsetFailure) {
    super(kind === 'unbound'
      ? 'The saved Telegram cursor has no bot binding. Inspect its original bot and missed messages before migrating it.'
      : kind === 'busy' ? 'Another Telegram owner is updating the saved cursor. Restart ingress after that owner finishes.'
      : kind === 'invalid-request' ? 'The Telegram bot cursor request is invalid.'
      : 'The saved Telegram cursor could not be confirmed. Restore its original state and inspect missed messages before restarting ingress.');
  }
}
export type TelegramOffsetStart = { readonly mode: 'resume'; readonly offset: number } | { readonly mode: 'fresh' }
  | { readonly mode: 'blocked'; readonly reason: string; readonly kind: TelegramOffsetFailure };
interface AccountCursor { readonly accountId: string; readonly offset: number; readonly updatedAt: string; }
declare const legacyMigrationHandle: unique symbol;
export interface TelegramLegacyCursorHandle { readonly [legacyMigrationHandle]: true; }
interface LegacyCursor { readonly offset: number; readonly updatedAt: string; }
function legacyCursor(value: unknown): LegacyCursor {
  if (!object(value) || Object.keys(value).length !== 3 || value['version'] !== 1 || !offsetValue(value['offset'])
    || typeof value['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(value['updatedAt']))) throw new TelegramOffsetStoreError('unavailable');
  return Object.freeze({ offset: value['offset'], updatedAt: value['updatedAt'] });
}
interface CursorSnapshot { readonly observed: FileObservation | null; readonly accounts: readonly AccountCursor[]; }

export class TelegramOffsetStore {
  private readonly migrations = new WeakMap<TelegramLegacyCursorHandle, { readonly observed: FileObservation; readonly cursor: LegacyCursor }>();
  private observedFile = false;
  private failed: TelegramOffsetFailure | undefined;
  constructor(private readonly filePath: string, private readonly accountId: string, private readonly beforeWrite?: () => void) {
    if (!accountValue(accountId)) throw new TelegramOffsetStoreError('invalid-request');
  }

  private readRaw(): { readonly observed: FileObservation; readonly row: unknown } | null {
    if (this.failed) throw new TelegramOffsetStoreError(this.failed);
    try {
      const stat = lstatSync(this.filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) throw new Error();
      const observed = readFileObservation(this.filePath);
      if (observed.bytes.length > MAX_FILE_BYTES) throw new Error();
      const row: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes));
      this.observedFile = true; return { observed, row };
    } catch (error) {
      if (missing(error) && !this.observedFile) {
        try { lstatSync(this.filePath); } catch (absent) { if (missing(absent)) return null; }
      }
      this.failed = 'unavailable'; throw new TelegramOffsetStoreError('unavailable');
    }
  }
  private read(): CursorSnapshot {
    try {
      const raw = this.readRaw(); if (!raw) return { observed: null, accounts: [] };
      const { row, observed } = raw;
      if (object(row) && row['version'] === 1) { legacyCursor(row); throw new TelegramOffsetStoreError('unbound'); }
      if (!object(row) || Object.keys(row).length !== 2 || row['version'] !== 2 || !Array.isArray(row['accounts'])
        || row['accounts'].length > MAX_ACCOUNTS) throw new Error();
      const seen = new Set<string>();
      for (const entry of row['accounts']) {
        if (!object(entry) || Object.keys(entry).length !== 3 || !accountValue(entry['accountId']) || seen.has(entry['accountId'])
          || !offsetValue(entry['offset']) || typeof entry['updatedAt'] !== 'string' || !Number.isFinite(Date.parse(entry['updatedAt']))) throw new Error();
        seen.add(entry['accountId']);
      }
      return { observed, accounts: row['accounts'] as unknown as readonly AccountCursor[] };
    } catch (error) {
      this.failed = error instanceof TelegramOffsetStoreError ? error.kind : 'unavailable';
      throw new TelegramOffsetStoreError(this.failed);
    }
  }

  /** A private, exact-file preparation. No parsed or caller-supplied offset can
   * become this handle, and preparing never writes or clears the old record. */
  prepareLegacyMigration(): (LegacyCursor & { readonly handle: TelegramLegacyCursorHandle }) | null {
    const raw = this.readRaw(); if (!raw) return null;
    if (object(raw.row) && raw.row['version'] === 2) { this.read(); return null; }
    const cursor = legacyCursor(raw.row), handle = Object.freeze({}) as TelegramLegacyCursorHandle;
    this.migrations.set(handle, { observed: raw.observed, cursor });
    return Object.freeze({ ...cursor, handle });
  }

  /** Explicit administrative adoption, preserving the observed offset/time.
   * This only binds a provider queue; it grants no ingress/payment authority. */
  migrateLegacy(handle: TelegramLegacyCursorHandle, assertCurrent: () => void): number {
    const prepared = this.migrations.get(handle);
    this.migrations.delete(handle);
    if (!prepared) throw new TelegramOffsetStoreError('invalid-request');
    return this.mutate(assertCurrent, currentLease => {
      const observed = readFileObservation(this.filePath);
      if (observed.physical !== prepared.observed.physical || !observed.bytes.equals(prepared.observed.bytes)) throw new Error();
      this.publish(prepared.observed, [{ accountId: this.accountId, ...prepared.cursor }], assertCurrent, currentLease);
      return prepared.cursor.offset;
    });
  }

  load(): TelegramOffsetStart {
    try {
      const snapshot = this.read(), cursor = snapshot.accounts.find(entry => entry.accountId === this.accountId);
      return cursor ? { mode: 'resume', offset: cursor.offset } : { mode: 'fresh' };
    } catch (error) {
      const failure = error instanceof TelegramOffsetStoreError ? error : new TelegramOffsetStoreError('unavailable');
      return { mode: 'blocked', reason: failure.message, kind: failure.kind };
    }
  }

  /** Refresh under the real shared lock and preserve every other bot's cursor.
   * Return the published offset; an older batch cannot move confirmation back.
   * A failed write stops polling before another getUpdates can acknowledge it. */
  save(offset: number, assertCurrent: () => void = () => {}): number {
    if (!offsetValue(offset)) throw new TelegramOffsetStoreError('invalid-request');
    assertCurrent();
    if (this.failed) throw new TelegramOffsetStoreError(this.failed);
    return this.mutate(assertCurrent, currentLease => {
      const snapshot = this.read();
      const previous = snapshot.accounts.find(entry => entry.accountId === this.accountId);
      const nextOffset = Math.max(previous?.offset ?? 0, offset);
      if (previous?.offset === nextOffset) { assertCurrent(); currentLease(); this.assertFileCurrent(snapshot.observed); return nextOffset; }
      if (!previous && snapshot.accounts.length >= MAX_ACCOUNTS) throw new Error();
      const next = { accountId: this.accountId, offset: nextOffset, updatedAt: new Date().toISOString() };
      const accounts = previous ? snapshot.accounts.map(entry => entry.accountId === this.accountId ? next : entry) : [...snapshot.accounts, next];
      this.publish(snapshot.observed, accounts, assertCurrent, currentLease);
      return nextOffset;
    });
  }

  private assertFileCurrent(observed: FileObservation | null): void {
    if (observed) {
      const file = readFileObservation(this.filePath);
      if (file.physical !== observed.physical || !file.bytes.equals(observed.bytes)) throw new Error();
    } else {
      try { lstatSync(this.filePath); } catch (error) { if (missing(error)) return; throw error; }
      throw new Error();
    }
  }
  private publish(observed: FileObservation | null, accounts: readonly AccountCursor[], assertCurrent: () => void, currentLease: () => void): void {
    const contents = `${JSON.stringify({ version: 2, accounts })}\n`;
    if (Buffer.byteLength(contents, 'utf8') > MAX_FILE_BYTES) throw new Error();
    const current = () => { assertCurrent(); currentLease(); this.assertFileCurrent(observed); };
    try {
      current();
      const published: unknown = this.beforeWrite?.();
      if (published !== undefined) { drainOwned(published); throw new Error(); }
      current();
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, assertCurrent: current });
      if (!readFileObservation(this.filePath).bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
      this.observedFile = true; assertCurrent(); currentLease();
    } catch { this.failed = 'write-uncertain'; throw new TelegramOffsetStoreError('write-uncertain'); }
  }
  private mutate(assertCurrent: () => void, operation: (currentLease: () => void) => number): number {
    assertCurrent();
    if (this.failed) throw new TelegramOffsetStoreError(this.failed);
    const lockPath = `${this.filePath}.mutation.lock`;
    let release: (() => void) | null;
    try { release = tryAcquireCrossProcessLock(lockPath); } catch { throw new TelegramOffsetStoreError('unavailable'); }
    if (!release) throw new TelegramOffsetStoreError('busy');
    try {
      const lease = readFileObservation(lockPath);
      const currentLease = () => {
        const held = readFileObservation(lockPath);
        if (held.physical !== lease.physical || !held.bytes.equals(lease.bytes)) throw new Error();
      };
      return operation(currentLease);
    } catch (error) {
      this.failed ??= error instanceof TelegramOffsetStoreError ? error.kind : 'unavailable';
      throw new TelegramOffsetStoreError(this.failed);
    } finally {
      try { release(); } catch { this.failed = 'write-uncertain'; throw new TelegramOffsetStoreError('write-uncertain'); }
    }
  }
}
