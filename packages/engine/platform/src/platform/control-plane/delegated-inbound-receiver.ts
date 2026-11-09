/** Durable metadata-only review queue; the original is exclusively abortable memory. */
import { randomUUID } from 'node:crypto';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { sameNativeInboundSourceRef, type NativeInboundSourceRef, type NativeInboundResolvedSource } from './native-inbound-source.js';
import type { NativeInboundAcceptance, NativeInboundReceiver } from './native-inbound-handoff.js';
import { delegatedReviewRecordSchema, type DelegatedInboundChoices, type DelegatedReviewOwner } from './delegated-inbound-wire.js';
export interface DelegatedReviewRecord {
  readonly id: string; readonly ref: NativeInboundSourceRef; readonly origin: NativeInboundResolvedSource['origin'];
  readonly configurationId: string; readonly ownerRevision: string; readonly owner?: DelegatedReviewOwner; readonly workspaceRevision: string;
  readonly approvalId: string; readonly choices: DelegatedInboundChoices;
  readonly acceptedAt: number; readonly sourceExpiresAt: number; readonly recordExpiresAt: number;
  readonly state: 'accepted-for-review' | 'cancelled'; readonly execution: 'not-started';
}
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
  private loading?: Promise<void>;
  private cleanupFailed = false;
  private closed = false;
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(path: string, private readonly beforeOwnerWrite?: () => void) { this.store = new PersistentStore<Snapshot>(path); }
  private start(): Promise<void> {
    return this.loading ??= (async () => {
    const saved = await this.store.load();
    if (saved) for (const value of saved.records) {
      const { owner, ...fields } = delegatedReviewRecordSchema.parse(value);
      const record: DelegatedReviewRecord = { ...fields, ...(owner === undefined ? {} : { owner }) };
      Object.freeze(record.ref); Object.freeze(record.origin); Object.freeze(record.choices);
      if (record.owner) { Object.freeze(record.owner.scopes); Object.freeze(record.owner); }
      Object.freeze(record);
      // Old original proof is never reconstructed; persisted rows are metadata only.
      if (record.recordExpiresAt > Date.now()) { this.records.set(record.ref.requestId, record); this.durable.add(record.ref.requestId); }
    }
    for (const record of this.records.values()) this.armExpiry(record);
    if (saved) await this.persist();
    })();
  }
  private armExpiry(record: DelegatedReviewRecord): void {
    if (this.closed) return;
    const timer = setTimeout(() => { this.release(record.ref); this.records.delete(record.ref.requestId); this.durable.delete(record.ref.requestId); this.expiryTimers.delete(record.ref.requestId); void this.persist().catch(() => { this.cleanupFailed = true; }); }, Math.max(1, record.recordExpiresAt - Date.now()));
    timer.unref(); this.expiryTimers.set(record.ref.requestId, timer);
  }
  private persist(): Promise<void> {
    const snapshot = { records: [...this.records.values()] };
    return this.writes.run(() => {
      // Publish the reader floor before any new-format write, including pruning/cancel.
      if (snapshot.records.some(record => record.owner !== undefined)) {
        const result: unknown = this.beforeOwnerWrite?.();
        if (result !== undefined) { drainOwned(result); throw new Error('Review reader compatibility must be confirmed synchronously'); }
      }
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
        if (this.closed) throw new Error('Delegated review receiver is closed');
        if (this.records.size >= 500) throw new Error('Review queue is full');
        if (this.records.has(source.ref.requestId)) throw new Error('Existing request requires read-only recovery');
        if (grant.sourceExpiresAt <= Date.now()) throw new Error('Original source expired');
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
        try {
          await this.persist(); this.durable.add(source.ref.requestId); options.signal.throwIfAborted(); options.assertCurrent();
        } catch (error) {
          // A failed write/guard cannot leave an original retained in a receiver
          // whose ownership handoff never completed. Saved metadata grants no replay.
          this.release(source.ref); throw error;
        }
        return { ref: source.ref, disposition: 'transferred' };
      },
      inspect: async ref => { const record = await this.get(ref); return record?.state === 'accepted-for-review' ? { ref: record.ref, disposition: 'transferred' } : null; },
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
    if (!record || !entry || record.state !== 'accepted-for-review' || record.sourceExpiresAt <= Date.now()) { this.release(ref); return null; }
    try { entry.assertCurrent(); return entry.source.original; } catch { this.release(ref); return null; }
  }
  async cancel(ref: NativeInboundSourceRef): Promise<void> {
    const record = await this.get(ref); if (!record) return;
    this.release(ref); this.records.set(ref.requestId, { ...record, state: 'cancelled' }); await this.persist();
  }
  reopen(): void { this.closed = false; for (const record of this.records.values()) if (!this.expiryTimers.has(record.ref.requestId)) this.armExpiry(record); }
  close(): void { this.closed = true; for (const timer of this.expiryTimers.values()) clearTimeout(timer); this.expiryTimers.clear(); for (const entry of [...this.originals.values()]) this.release(entry.source.ref); }
}
