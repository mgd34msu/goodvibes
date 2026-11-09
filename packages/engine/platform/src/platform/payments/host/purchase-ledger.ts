/** Durable append-only purchase evidence. Missing is empty; unreadable or
 * unsupported evidence is unavailable, never empty. Writers serialize against
 * the actual file and confirm durability before reporting success. */
import { lstatSync } from 'node:fs';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { acquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import { capturePurchaseRecord } from '../purchase-record-codec.js';
import type { PurchaseLedger } from '../payment-ports.js';
import type { PurchaseRecord } from '../purchase-record.js';
import { samePaymentEvidence } from '../evidence-equality.js';
import { drainOwned } from '@goodvibes-jev/judgment';
import type { PaymentReconciliationCheckpoint } from './reconciliation-checkpoint.js';

export interface OwnerPurchaseReconciliation {
  readonly purchaseId: string;
  readonly operationId: string;
  readonly outcome: 'purchased' | 'not-purchased';
  readonly principalId: string;
  readonly atMs: number;
  readonly merchantDomain: string;
  readonly totalMinorUnits: number;
  readonly currency: string;
}
function readReconciliations(value: unknown): readonly OwnerPurchaseReconciliation[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new PaymentPurchaseLedgerError('unavailable');
  const seen = new Set<string>();
  return Object.freeze(value.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new PaymentPurchaseLedgerError('unavailable');
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).length !== 8 || !['purchaseId', 'operationId', 'principalId', 'merchantDomain'].every(key => typeof row[key] === 'string' && row[key].trim())
      || (row['outcome'] !== 'purchased' && row['outcome'] !== 'not-purchased')
      || !['atMs', 'totalMinorUnits'].every(key => typeof row[key] === 'number' && Number.isSafeInteger(row[key]) && row[key] >= 0)
      || typeof row['currency'] !== 'string' || !/^[A-Z]{3}$/.test(row['currency']) || seen.has(row['operationId'] as string)) throw new PaymentPurchaseLedgerError('unavailable');
    seen.add(row['operationId'] as string);
    return Object.freeze({ ...row }) as unknown as OwnerPurchaseReconciliation;
  }));
}

export interface StoredPurchase extends PurchaseRecord { readonly merchantDiscovered: boolean }
const PURCHASES_FILE_VERSION = 1;
export const MAX_PURCHASE_LIST_LIMIT = 500;
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

export class PaymentPurchaseLedgerError extends Error {
  override readonly name = 'PaymentPurchaseLedgerError';
  constructor(readonly kind: 'unavailable' | 'invalid-record' | 'write-uncertain') {
    super(kind === 'invalid-record' ? 'The purchase record is invalid. No new ledger entry was admitted.'
      : kind === 'write-uncertain' ? 'The purchase ledger write could not be confirmed. Inspect the original payment evidence before retrying.'
      : 'The purchase ledger is unreadable, unsupported or changed. Repair the original payment evidence and restart the payment host before making purchases.');
  }
}
interface LedgerSnapshot {
  readonly observation: FileObservation | null;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly rows: readonly StoredPurchase[];
  readonly byId: ReadonlyMap<string, StoredPurchase>;
}
export interface DaemonPurchaseLedgerOptions { readonly filePath: string; readonly beforeReconciliationWrite?: (() => void) | undefined }
export interface PurchaseListQuery { readonly limit: number; readonly dayKey: string | undefined }

export class DaemonPurchaseLedger implements PurchaseLedger {
  private readonly filePath: string;
  private cached: LedgerSnapshot | undefined;
  private unavailable = false;
  private readonly beforeReconciliationWrite: (() => void) | undefined;
  constructor(options: DaemonPurchaseLedgerOptions) { this.filePath = options.filePath; this.beforeReconciliationWrite = options.beforeReconciliationWrite; }

  private declareReconciliation(): void {
    const result: unknown = this.beforeReconciliationWrite?.();
    if (result !== undefined) { drainOwned(result); throw new PaymentPurchaseLedgerError('unavailable'); }
  }

  private read(): LedgerSnapshot {
    if (this.unavailable) throw new PaymentPurchaseLedgerError('unavailable');
    let observation: FileObservation;
    try { observation = readFileObservation(this.filePath); }
    catch (error) {
      if (missing(error)) {
        // A dangling symlink is not an unused ledger.
        try { lstatSync(this.filePath); }
        catch (absent) {
          if (missing(absent) && (this.cached === undefined || this.cached.observation === null)) {
            return this.cached ??= { observation: null, envelope: Object.freeze({}), rows: Object.freeze([]), byId: new Map() };
          }
        }
      }
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('unavailable');
    }
    const previous = this.cached;
    if (previous?.observation?.physical === observation.physical && previous.observation.bytes.equals(observation.bytes)) return previous;
    try {
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observation.bytes), (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
        return value;
      });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const envelope = raw as Readonly<Record<string, unknown>>;
      if (envelope['version'] !== PURCHASES_FILE_VERSION || !Array.isArray(envelope['purchases'])) throw new Error();
      if (readReconciliations(envelope['purchaseReconciliations']).length > 0) this.declareReconciliation();
      const rows: StoredPurchase[] = [], byId = new Map<string, StoredPurchase>();
      for (const value of envelope['purchases'] as readonly unknown[]) {
        const row = capturePurchaseRecord(value);
        if (!row) throw new Error();
        rows.push(row); byId.set(row.purchaseId, row);
      }
      return this.cached = { observation, envelope, rows: Object.freeze(rows), byId };
    } catch {
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('unavailable');
    }
  }

  private assertFileCurrent(expected: FileObservation | null): void {
    try {
      if (expected === null) {
        try { lstatSync(this.filePath); }
        catch (error) { if (missing(error)) return; throw error; }
        throw new Error();
      }
      const current = readFileObservation(this.filePath);
      if (current.physical !== expected.physical || !current.bytes.equals(expected.bytes)) throw new Error();
    } catch { throw new PaymentPurchaseLedgerError('unavailable'); }
  }

  /** Detach before the lock await. An observed merchant submit must still be
   * recorded when its initiating request or owner has since been cancelled. */
  async record(entry: PurchaseRecord): Promise<void> {
    const row = capturePurchaseRecord(entry);
    if (!row) throw new PaymentPurchaseLedgerError('invalid-record');
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { strictOwnership: true, totalTimeoutMs: 10_000 });
      const previous = this.read();
      const rows = Object.freeze([...previous.rows, row]);
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: rows };
      const contents = `${JSON.stringify(envelope, null, 2)}\n`;
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
        assertCurrent: () => this.assertFileCurrent(previous.observation) });
      const observation = readFileObservation(this.filePath);
      if (!observation.bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
      const byId = new Map(previous.byId); byId.set(row.purchaseId, row);
      this.cached = { observation, envelope, rows, byId };
    } catch (error) {
      // A failure after rename may already have published. Keep this instance
      // disabled; reopening reads the actual disk result instead of replaying.
      this.unavailable = true;
      if (error instanceof PaymentPurchaseLedgerError) throw error;
      throw new PaymentPurchaseLedgerError('write-uncertain');
    } finally {
      try { release?.(); }
      catch { this.unavailable = true; throw new PaymentPurchaseLedgerError('write-uncertain'); }
    }
  }

  assertAvailable(): void { this.read(); }

  /** Append the owner's finding beside the original receipts. Never invent a
   * merchant receipt, tax/shipping breakdown or refund from that observation. */
  async recordOwnerReconciliation(checkpoint: PaymentReconciliationCheckpoint, current: () => void): Promise<void> {
    const original = checkpoint.journal ?? checkpoint.purchase;
    if (!original || original.totalMinorUnits === null) throw new PaymentPurchaseLedgerError('invalid-record');
    const event: OwnerPurchaseReconciliation = Object.freeze({ purchaseId: checkpoint.purchaseId, operationId: checkpoint.operationId,
      outcome: checkpoint.outcome, principalId: checkpoint.principalId, atMs: checkpoint.atMs,
      merchantDomain: original.merchantDomain, totalMinorUnits: original.totalMinorUnits, currency: original.currency });
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { strictOwnership: true, totalTimeoutMs: 10_000 });
      current();
      const previous = this.read(), events = readReconciliations(previous.envelope['purchaseReconciliations']);
      const prior = events.find(row => row.operationId === event.operationId);
      if (prior) { if (!samePaymentEvidence(prior, event)) throw new PaymentPurchaseLedgerError('unavailable'); return; }
      if (!samePaymentEvidence(previous.byId.get(checkpoint.purchaseId) ?? null, checkpoint.purchase)) throw new PaymentPurchaseLedgerError('unavailable');
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: previous.rows,
        purchaseReconciliations: [...events, event] };
      current(); this.declareReconciliation(); current();
      const contents = `${JSON.stringify(envelope, null, 2)}\n`;
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
        assertCurrent: () => { current(); this.assertFileCurrent(previous.observation); } });
      const observation = readFileObservation(this.filePath);
      if (!observation.bytes.equals(Buffer.from(contents))) throw new Error();
      this.cached = { ...previous, observation, envelope };
    } catch (error) {
      // As with merchant receipts, uncertain publication is inspected on a
      // fresh host rather than appended again through a poisoned writer.
      if (error instanceof PaymentPurchaseLedgerError) throw error;
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('write-uncertain');
    } finally { release?.(); }
  }

  /** Exact recorded submission lookup used by real boot recovery. */
  async has(purchaseId: string): Promise<boolean> {
    const row = this.read().byId.get(purchaseId);
    if (!row) return false;
    if (row.outcome === 'purchased' || row.outcome === 'submitted-unverified' || row.outcome === 'refunded') return true;
    // A future/foreign event is not evidence that the original submission is
    // absent, nor proof of a completed charge. Keep its recovery unresolved.
    throw new PaymentPurchaseLedgerError('unavailable');
  }

  /** Return the latest append-only event for this purchase without inventing
   * a verified order from the existence of an unverified submission record. */
  get(purchaseId: string): StoredPurchase | null { return this.read().byId.get(purchaseId) ?? null; }

  list(query: PurchaseListQuery): { purchases: readonly StoredPurchase[]; total: number; reconciliations: readonly OwnerPurchaseReconciliation[] } {
    const snapshot = this.read(), rows = snapshot.rows;
    const matching = query.dayKey === undefined ? rows : rows.filter(row => row.dayKey === query.dayKey);
    const limit = Number.isFinite(query.limit) ? Math.min(Math.max(1, Math.floor(query.limit)), MAX_PURCHASE_LIST_LIMIT) : MAX_PURCHASE_LIST_LIMIT;
    return { purchases: [...matching].reverse().slice(0, limit), total: matching.length,
      reconciliations: [...readReconciliations(snapshot.envelope['purchaseReconciliations'])].reverse().slice(0, limit) };
  }
}
