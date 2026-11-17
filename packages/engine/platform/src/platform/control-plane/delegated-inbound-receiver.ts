/** Durable metadata-only review queue; the original is exclusively abortable memory. */
import { randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { readDocument } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { sameNativeInboundSourceRef, type NativeInboundSourceRef, type NativeInboundResolvedSource } from './native-inbound-source.js';
import { NativeInboundReceiverRefusal, type NativeInboundAcceptance, type NativeInboundReceiver } from './native-inbound-handoff.js';
import { delegatedReviewRecordSchema, type DelegatedInboundChoices, type DelegatedReviewOwner } from './delegated-inbound-wire.js';
export interface DelegatedReviewRecord {
  readonly id: string; readonly ref: NativeInboundSourceRef; readonly origin: NativeInboundResolvedSource['origin'];
  readonly configurationId: string; readonly ownerRevision: string; readonly owner: DelegatedReviewOwner; readonly workspaceRevision: string;
  readonly approvalId: string; readonly choices: DelegatedInboundChoices;
  readonly acceptedAt: number; readonly sourceExpiresAt: number; readonly recordExpiresAt: number;
  /** `reviewed` once the owner has read the original; a review leaves the queue when cancelled or expired. */
  readonly state: 'accepted-for-review' | 'reviewed' | 'cancelled'; readonly execution: 'not-started';
}
function isOpenReview(record: DelegatedReviewRecord): boolean {
  return record.state === 'accepted-for-review' || record.state === 'reviewed';
}
/** Rows waiting for review that one queue holds. A cancelled row is dropped at once, so cancelling makes room. */
const MAX_REVIEW_ROWS = 500;
interface Snapshot extends Record<string, unknown> { readonly records: readonly DelegatedReviewRecord[]; }
export interface DelegatedReviewGrant {
  readonly configurationId: string; readonly ownerRevision: string; readonly owner: DelegatedReviewOwner; readonly workspaceRevision: string;
  readonly approvalId: string; readonly choices: DelegatedInboundChoices; readonly sourceExpiresAt: number;
}
export class DelegatedInboundReviewReceiver {
  private readonly store: PersistentStore<Snapshot>;
  private readonly writes = new StoreWriteQueue();
  private readonly records = new Map<string, DelegatedReviewRecord>();
  private readonly durable = new Set<string>();
  private readonly originals = new Map<string, { source: NativeInboundResolvedSource; assertCurrent: () => void; cleanup: () => void }>();
  private loading: Promise<void> | undefined;
  private cleanupFailed = false;
  private closed = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private readonly path: string, private readonly beforeOwnerWrite?: () => void) { this.store = new PersistentStore<Snapshot>(path); }
  private start(): Promise<void> {
    // A failed load is retried by the next caller instead of disabling the receiver until restart.
    return this.loading ??= this.load().catch((error: unknown) => { this.loading = undefined; throw error; });
  }
  private async load(): Promise<void> {
    // A file that cannot be read as a queue is set aside whole (and disclosed by
    // the quarantine helper) and the queue starts empty: saved rows grant no
    // replay, so an empty queue loses nothing a restart would have kept.
    // The quarantining read is synchronous. Yield first so a close() issued
    // right after start still lands before any retention timer is armed.
    await Promise.resolve();
    const saved = readDocument<Snapshot>(this.path, {
      label: 'delegated review queue',
      recovery: 'The review queue starts empty; requests that were waiting must be sent again.',
      validate: (value) => {
        if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { records?: unknown }).records)) {
          throw new Error('not a review queue');
        }
        return value as Snapshot;
      },
    });
    // Parse every row before adopting any. A row that fails its schema is
    // dropped on its own: its neighbours are unaffected, and nothing is guessed.
    const loaded: DelegatedReviewRecord[] = [];
    let droppedRows = 0;
    let ownerlessRows = 0;
    if (saved) for (const value of saved.records) {
      const parsed = delegatedReviewRecordSchema.safeParse(value);
      if (!parsed.success) { droppedRows += 1; continue; }
      const { owner, ...fields } = parsed.data;
      // A row an earlier build saved without its owner can be answered by no
      // one, so it goes the way an expired row does.
      if (owner === undefined) { ownerlessRows += 1; continue; }
      const record: DelegatedReviewRecord = { ...fields, owner };
      Object.freeze(record.ref); Object.freeze(record.origin); Object.freeze(record.choices);
      Object.freeze(record.owner.scopes); Object.freeze(record.owner);
      Object.freeze(record);
      loaded.push(record);
    }
    if (droppedRows > 0) logger.warn('Delegated review queue rows failed validation and were dropped', { droppedRows, kept: loaded.length });
    if (ownerlessRows > 0) logger.info('Delegated review queue rows with no owner were dropped; their requests must be sent again', { ownerlessRows, kept: loaded.length });
    // Old original proof is never reconstructed; persisted rows are metadata
    // only. A cancelled row grants nothing, so one left by an earlier build is dropped.
    for (const record of loaded) if (record.recordExpiresAt > Date.now() && isOpenReview(record)) { this.records.set(record.ref.requestId, record); this.durable.add(record.ref.requestId); }
    for (const record of this.records.values()) this.armExpiry(record);
    // Rewrite only when loading dropped something; a clean file is already what memory holds.
    if (saved && this.records.size !== saved.records.length) await this.persist();
  }
  private armExpiry(record: DelegatedReviewRecord): void {
    if (this.closed) return;
    const timer = setTimeout(() => { this.release(record.ref); this.records.delete(record.ref.requestId); this.durable.delete(record.ref.requestId); this.expiryTimers.delete(record.ref.requestId); void this.persist().catch(() => { this.cleanupFailed = true; }); }, Math.max(1, record.recordExpiresAt - Date.now()));
    timer.unref(); this.expiryTimers.set(record.ref.requestId, timer);
  }
  private persist(): Promise<void> {
    const snapshot = { records: [...this.records.values()] };
    return this.writes.run(() => {
      // Publish the reader floor before any new-format write (every row carries its owner), including pruning/cancel.
      if (snapshot.records.length > 0) this.beforeOwnerWrite?.();
      return this.store.persist(snapshot, { durable: true });
    });
  }
  private async expire(): Promise<void> {
    let changed = this.cleanupFailed;
    for (const record of this.records.values()) if (record.recordExpiresAt <= Date.now()) {
      this.release(record.ref); this.records.delete(record.ref.requestId); this.durable.delete(record.ref.requestId);
      const timer = this.expiryTimers.get(record.ref.requestId); if (timer) clearTimeout(timer);
      this.expiryTimers.delete(record.ref.requestId); changed = true;
    }
    if (changed) { await this.persist(); this.cleanupFailed = false; }
  }
  release(ref: NativeInboundSourceRef): void {
    const entry = this.originals.get(ref.requestId);
    if (entry && sameNativeInboundSourceRef(entry.source.ref, ref)) { this.originals.delete(ref.requestId); entry.cleanup(); }
  }
  receiver(grant: DelegatedReviewGrant): NativeInboundReceiver {
    return {
      accept: async (source, options): Promise<NativeInboundAcceptance> => {
        await this.start(); await this.expire(); options.signal.throwIfAborted(); options.assertCurrent();
        if (this.closed) throw new NativeInboundReceiverRefusal('Delegated review receiver is closed');
        if (this.records.size >= MAX_REVIEW_ROWS) throw new NativeInboundReceiverRefusal(`The review queue holds ${MAX_REVIEW_ROWS} messages waiting for review. Cancel one with inbound.telegram.cancel, or wait for its review record to expire.`);
        if (this.records.has(source.ref.requestId)) throw new NativeInboundReceiverRefusal('This message is already in the review queue. Read it with inbound.telegram.status instead of accepting it again.');
        if (grant.sourceExpiresAt <= Date.now()) throw new NativeInboundReceiverRefusal('Original source expired');
        const record: DelegatedReviewRecord = Object.freeze({ id: `external-review-${randomUUID()}`, ref: source.ref, origin: source.origin,
          configurationId: grant.configurationId, ownerRevision: grant.ownerRevision, owner: grant.owner, workspaceRevision: grant.workspaceRevision,
          approvalId: grant.approvalId, choices: grant.choices, acceptedAt: Date.now(), sourceExpiresAt: grant.sourceExpiresAt,
          recordExpiresAt: Date.now() + grant.choices.derivedRecordRetentionMs, state: 'accepted-for-review', execution: 'not-started' });
        const release = () => this.release(source.ref);
        const timer = setTimeout(release, Math.max(1, grant.sourceExpiresAt - Date.now())); timer.unref();
        const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener('abort', release); };
        this.originals.set(source.ref.requestId, { source, assertCurrent: options.assertCurrent, cleanup });
        options.signal.addEventListener('abort', release, { once: true });
        this.records.set(source.ref.requestId, record); this.armExpiry(record);
        let written = false;
        try {
          await this.persist(); written = true; this.durable.add(source.ref.requestId); options.signal.throwIfAborted(); options.assertCurrent();
        } catch (error) {
          // A failed write/guard cannot leave an original retained in a receiver
          // whose ownership handoff never completed. Saved metadata grants no replay.
          this.release(source.ref);
          // A row whose write failed was never durable; dropping it lets the
          // owner retry instead of every retry reading as an existing request.
          if (!written && this.records.get(source.ref.requestId) === record) {
            this.records.delete(source.ref.requestId);
            const timer = this.expiryTimers.get(source.ref.requestId); if (timer) clearTimeout(timer);
            this.expiryTimers.delete(source.ref.requestId);
          }
          throw error;
        }
        return { ref: source.ref, disposition: 'transferred' };
      },
      inspect: async ref => { const record = await this.get(ref); return record && isOpenReview(record) ? { ref: record.ref, disposition: 'transferred' } : null; },
      cancel: async ref => { await this.cancel(ref); },
    };
  }
  async get(ref: NativeInboundSourceRef): Promise<DelegatedReviewRecord | null> {
    await this.start(); await this.expire(); const record = this.records.get(ref.requestId);
    return record && this.durable.has(ref.requestId) && sameNativeInboundSourceRef(record.ref, ref) ? record : null;
  }
  async list(): Promise<readonly DelegatedReviewRecord[]> { await this.start(); await this.expire(); return [...this.records.values()].filter(record => this.durable.has(record.ref.requestId)); }
  async read(ref: NativeInboundSourceRef): Promise<NativeInboundResolvedSource['original'] | null> {
    const record = await this.get(ref); const entry = this.originals.get(ref.requestId);
    if (!record || !entry || !isOpenReview(record) || record.sourceExpiresAt <= Date.now()) { this.release(ref); return null; }
    try { entry.assertCurrent(); return entry.source.original; } catch { this.release(ref); return null; }
  }
  /**
   * The owner read this review's original: its row says `reviewed` from now on,
   * so a later list shows which messages still wait to be read. One write the
   * first time; nothing after that.
   */
  async markReviewed(ref: NativeInboundSourceRef): Promise<DelegatedReviewRecord | null> {
    const record = await this.get(ref);
    if (!record || record.state !== 'accepted-for-review') return record;
    const reviewed: DelegatedReviewRecord = Object.freeze({ ...record, state: 'reviewed' });
    this.records.set(ref.requestId, reviewed);
    await this.persist();
    return reviewed;
  }
  /** A cancelled review grants nothing, so its row leaves the queue at once and frees its place. */
  async cancel(ref: NativeInboundSourceRef): Promise<void> {
    const record = await this.get(ref); if (!record) return;
    this.release(ref);
    this.records.delete(ref.requestId); this.durable.delete(ref.requestId);
    const timer = this.expiryTimers.get(ref.requestId); if (timer) clearTimeout(timer);
    this.expiryTimers.delete(ref.requestId);
    await this.persist();
  }
  reopen(): void { this.closed = false; for (const record of this.records.values()) if (!this.expiryTimers.has(record.ref.requestId)) this.armExpiry(record); }
  close(): void { this.closed = true; for (const timer of this.expiryTimers.values()) clearTimeout(timer); this.expiryTimers.clear(); for (const entry of [...this.originals.values()]) this.release(entry.source.ref); }
}
