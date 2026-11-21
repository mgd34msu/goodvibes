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
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import type { PaymentReconciliationCheckpoint } from './reconciliation-checkpoint.js';
import { ORDER_MAIL_KINDS, type OrderMailKind } from '../message.js';

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

/**
 * Which kinds of merchant mail were already reported to the owner, per
 * purchase, kept beside the rows in the same file and the same write.
 */
function readMailReports(value: unknown): ReadonlyMap<string, readonly OrderMailKind[]> {
  if (value === undefined) return new Map();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PaymentPurchaseLedgerError('unavailable');
  const reports = new Map<string, readonly OrderMailKind[]>();
  for (const [purchaseId, kinds] of Object.entries(value)) {
    if (!Array.isArray(kinds) || kinds.some(kind => !(ORDER_MAIL_KINDS as readonly unknown[]).includes(kind))) {
      throw new PaymentPurchaseLedgerError('unavailable');
    }
    reports.set(purchaseId, Object.freeze([...kinds] as OrderMailKind[]));
  }
  return reports;
}

export interface StoredPurchase extends PurchaseRecord { readonly merchantDiscovered: boolean }
const PURCHASES_FILE_VERSION = 1;
export const MAX_PURCHASE_LIST_LIMIT = 500;
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

/** What an owed owner notice reports: the purchase itself, a refund the shop mailed, or a shop mail settling an unverified purchase. */
export type OwnerNoticeKind = 'purchase' | 'refund' | 'settled';

/** One notice the owner is owed and was not yet told. */
export interface OwedOwnerNotice {
  readonly purchaseId: string;
  readonly kind: OwnerNoticeKind;
  readonly message: string;
}

/**
 * The key of an owed notice in the purchases file. A purchase report is keyed
 * by its purchase id alone (as release 3.4.0 wrote it); the others add `#kind`,
 * which no purchase id contains (checkoutRequestId), so a refund notice never
 * replaces a purchase report still owed.
 */
function ownerNoticeKey(purchaseId: string, kind: OwnerNoticeKind): string {
  return kind === 'purchase' ? purchaseId : `${purchaseId}#${kind}`;
}

function ownerNoticeFromKey(key: string, message: string): OwedOwnerNotice {
  const mark = key.lastIndexOf('#');
  const kind = mark === -1 ? 'purchase' : key.slice(mark + 1);
  if (mark !== -1 && (kind === 'refund' || kind === 'settled')) return { purchaseId: key.slice(0, mark), kind, message };
  return { purchaseId: key, kind: 'purchase', message };
}

/** The owed owner notices kept in the purchases file: notice key -> notice text. Anything malformed reads as nothing owed. */
function readOwedNotices(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The owed notices with `notice` added under its key; undefined when there is nothing to add. */
function owingAlso(envelope: Readonly<Record<string, unknown>>, purchaseId: string, kind: OwnerNoticeKind,
  notice: string | undefined): Record<string, string> | undefined {
  if (notice === undefined) return undefined;
  return { ...readOwedNotices(envelope['ownerNoticesOwed']), [ownerNoticeKey(purchaseId, kind)]: notice };
}

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
    assertSynchronousJudgmentGuard(() => this.beforeReconciliationWrite?.(), () => new PaymentPurchaseLedgerError('unavailable'));
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
      readMailReports(envelope['mailReported']);
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
  async record(entry: PurchaseRecord, options: { readonly ownerNotice?: string | undefined } = {}): Promise<void> {
    const row = capturePurchaseRecord(entry);
    if (!row) throw new PaymentPurchaseLedgerError('invalid-record');
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { totalTimeoutMs: 10_000 });
      const previous = this.read();
      const rows = Object.freeze([...previous.rows, row]);
      // The owner's report is owed from the same write as the record (no write of its own).
      const owed = owingAlso(previous.envelope, row.purchaseId, 'purchase', options.ownerNotice);
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: rows, ...(owed ? { ownerNoticesOwed: owed } : {}) };
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
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { totalTimeoutMs: 10_000 });
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

  /**
   * Record when the shop said this purchase was refunded, on its row. False
   * when there is no such purchase or a refund is already recorded. Credits
   * no budget pool. `ownerNotice`: the refund note the owner is owed, saved in
   * the same write, so a send that fails or a stop before it still tells them.
   */
  async recordRefund(purchaseId: string, refundedAt: string, ownerNotice?: string): Promise<boolean> {
    if (!Number.isFinite(Date.parse(refundedAt))) throw new PaymentPurchaseLedgerError('invalid-record');
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { totalTimeoutMs: 10_000 });
      const previous = this.read();
      const current = previous.byId.get(purchaseId);
      if (!current || current.refundedAt !== null) return false;
      const updated = capturePurchaseRecord({ ...current, refundedAt });
      if (!updated) throw new PaymentPurchaseLedgerError('invalid-record');
      const index = previous.rows.lastIndexOf(current);
      const rows = Object.freeze(previous.rows.map((row, at) => at === index ? updated as StoredPurchase : row));
      const owed = owingAlso(previous.envelope, purchaseId, 'refund', ownerNotice);
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: rows, ...(owed ? { ownerNoticesOwed: owed } : {}) };
      const contents = `${JSON.stringify(envelope, null, 2)}\n`;
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
        assertCurrent: () => this.assertFileCurrent(previous.observation) });
      const observation = readFileObservation(this.filePath);
      if (!observation.bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
      const byId = new Map(previous.byId); byId.set(purchaseId, updated as StoredPurchase);
      this.cached = { observation, envelope, rows, byId };
      return true;
    } catch (error) {
      if (error instanceof PaymentPurchaseLedgerError) throw error;
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('write-uncertain');
    } finally {
      try { release?.(); }
      catch { this.unavailable = true; throw new PaymentPurchaseLedgerError('write-uncertain'); }
    }
  }

  /**
   * Record that the shop's own mail confirmed a submission whose landing page
   * did not: a `submitted-unverified` row becomes `purchased`, taking the
   * mail's order number when the row has none. False when the row is not
   * unverified, is refunded, or the owner already recorded a finding for it;
   * the owner's finding stands over a mail. `ownerNotice`: the report the
   * owner is owed for the move, saved in the same write.
   */
  async recordConfirmed(purchaseId: string, merchantOrderId: string | null, ownerNotice?: string): Promise<boolean> {
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { totalTimeoutMs: 10_000 });
      const previous = this.read();
      const current = previous.byId.get(purchaseId);
      if (!current || current.outcome !== 'submitted-unverified' || current.refundedAt !== null) return false;
      if (readReconciliations(previous.envelope['purchaseReconciliations']).some(row => row.purchaseId === purchaseId)) return false;
      const updated = capturePurchaseRecord({ ...current, outcome: 'purchased',
        merchantOrderId: current.merchantOrderId ?? merchantOrderId });
      if (!updated) throw new PaymentPurchaseLedgerError('invalid-record');
      const index = previous.rows.lastIndexOf(current);
      const rows = Object.freeze(previous.rows.map((row, at) => at === index ? updated as StoredPurchase : row));
      const owed = owingAlso(previous.envelope, purchaseId, 'settled', ownerNotice);
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: rows, ...(owed ? { ownerNoticesOwed: owed } : {}) };
      const contents = `${JSON.stringify(envelope, null, 2)}\n`;
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
        assertCurrent: () => this.assertFileCurrent(previous.observation) });
      const observation = readFileObservation(this.filePath);
      if (!observation.bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
      const byId = new Map(previous.byId); byId.set(purchaseId, updated as StoredPurchase);
      this.cached = { observation, envelope, rows, byId };
      return true;
    } catch (error) {
      if (error instanceof PaymentPurchaseLedgerError) throw error;
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('write-uncertain');
    } finally {
      try { release?.(); }
      catch { this.unavailable = true; throw new PaymentPurchaseLedgerError('write-uncertain'); }
    }
  }

  /** The kinds of merchant mail already reported to the owner, per purchase: one ledger read. */
  reportedMailKinds(): ReadonlyMap<string, readonly OrderMailKind[]> {
    return readMailReports(this.read().envelope['mailReported']);
  }

  /**
   * Record that the owner was told about this kind of mail for this purchase.
   * False when there is no such purchase or that kind was already reported, so
   * the caller sends nothing a second time.
   */
  async recordMailReported(purchaseId: string, kind: OrderMailKind): Promise<boolean> {
    if (!(ORDER_MAIL_KINDS as readonly string[]).includes(kind)) throw new PaymentPurchaseLedgerError('invalid-record');
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { totalTimeoutMs: 10_000 });
      const previous = this.read();
      if (!previous.byId.has(purchaseId)) return false;
      const reports = readMailReports(previous.envelope['mailReported']);
      const kinds = reports.get(purchaseId) ?? [];
      if (kinds.includes(kind)) return false;
      const mailReported = Object.fromEntries([...reports, [purchaseId, [...kinds, kind]]]);
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: previous.rows, mailReported };
      const contents = `${JSON.stringify(envelope, null, 2)}\n`;
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
        assertCurrent: () => this.assertFileCurrent(previous.observation) });
      const observation = readFileObservation(this.filePath);
      if (!observation.bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
      this.cached = { ...previous, observation, envelope };
      return true;
    } catch (error) {
      if (error instanceof PaymentPurchaseLedgerError) throw error;
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('write-uncertain');
    } finally {
      try { release?.(); }
      catch { this.unavailable = true; throw new PaymentPurchaseLedgerError('write-uncertain'); }
    }
  }

  /** Notices owed to the owner and not yet delivered: sent at start when a send failed or the process stopped before it. */
  owedOwnerNotices(): readonly OwedOwnerNotice[] {
    return Object.entries(readOwedNotices(this.read().envelope['ownerNoticesOwed'])).map(([key, message]) => ownerNoticeFromKey(key, message));
  }

  /** The owed notice reached a channel: removed from the file (one write). No-op when that notice is not owed. */
  async settleOwnerNotice(purchaseId: string, kind: OwnerNoticeKind = 'purchase'): Promise<void> {
    const key = ownerNoticeKey(purchaseId, kind);
    let release: (() => void) | undefined;
    try {
      release = await acquireCrossProcessLock(`${this.filePath}.mutation.lock`, { totalTimeoutMs: 10_000 });
      const previous = this.read();
      const owed = readOwedNotices(previous.envelope['ownerNoticesOwed']);
      if (!(key in owed)) return;
      const { [key]: _settled, ...remaining } = owed;
      const envelope = { ...previous.envelope, version: PURCHASES_FILE_VERSION, purchases: previous.rows, ownerNoticesOwed: remaining };
      const contents = `${JSON.stringify(envelope, null, 2)}\n`;
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
        assertCurrent: () => this.assertFileCurrent(previous.observation) });
      const observation = readFileObservation(this.filePath);
      if (!observation.bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
      this.cached = { ...previous, observation, envelope };
    } catch (error) {
      if (error instanceof PaymentPurchaseLedgerError) throw error;
      this.unavailable = true;
      throw new PaymentPurchaseLedgerError('write-uncertain');
    } finally {
      try { release?.(); }
      catch { this.unavailable = true; throw new PaymentPurchaseLedgerError('write-uncertain'); }
    }
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
