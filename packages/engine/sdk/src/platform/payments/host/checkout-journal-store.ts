/** Durable checkout evidence. Only a missing file means an unused journal.
 * Damaged, unsupported or externally replaced state disables this owner without
 * replacing the original file. Unknown JSON fields survive supported records.
 * Writes publish in memory only after file and directory durability succeeds.
 * A failed write has an uncertain disk outcome, so this owner cannot continue
 * from an assumed old state. Reopening reads the actual committed file.
 */
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { lstatSync } from 'node:fs';
import { readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { logger } from '../../utils/logger.js';
import { captureCheckoutRecord } from '../checkout-record.js';
import type { CheckoutJournal, InFlightCheckout } from '../checkout-registry.js';

const JOURNAL_FILE_VERSION = 1;
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

export class PaymentCheckoutJournalUnavailableError extends Error {
  override readonly name = 'PaymentCheckoutJournalUnavailableError';
  constructor() { super('The checkout journal is unavailable. Repair or restore the original payment state and inspect pending purchases before retrying.'); }
}

export class DurableCheckoutJournal implements CheckoutJournal {
  private records = new Map<string, InFlightCheckout>();
  private observed: FileObservation | null = null;
  private unavailable = false;

  constructor(private readonly filePath: string) {
    try { lstatSync(filePath); }
    catch (error) { if (!missing(error)) this.disable(); return; }
    try {
      this.observed = readFileObservation(filePath);
      const file: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.observed.bytes));
      if (file === null || typeof file !== 'object' || Array.isArray(file) || !('version' in file)
        || file.version !== JOURNAL_FILE_VERSION || !('records' in file) || !Array.isArray(file.records)) throw new Error();
      for (const value of file.records) {
        const row = captureCheckoutRecord(value);
        if (row === null || this.records.has(row.purchaseId)) throw new Error();
        this.records.set(row.purchaseId, row);
      }
    } catch { this.disable(); }
  }

  private disable(): void {
    if (!this.unavailable) logger.warn('Checkout journal is unreadable, unsupported or changed. Checkout operations are disabled; the original evidence was not discarded.', { filePath: this.filePath });
    this.unavailable = true;
  }

  private assertAvailable(): void {
    if (this.unavailable) throw new PaymentCheckoutJournalUnavailableError();
  }

  /** Capture the full supported record before accepting borrowed caller data. */
  async put(record: InFlightCheckout): Promise<void> {
    this.assertAvailable();
    let owned: InFlightCheckout | null;
    try { owned = captureCheckoutRecord(record); }
    catch { throw new PaymentCheckoutJournalUnavailableError(); }
    if (owned === null) throw new PaymentCheckoutJournalUnavailableError();
    const next = new Map(this.records);
    next.set(owned.purchaseId, owned);
    this.persist(next);
    this.records = next;
  }

  /** A failed removal keeps the record owned and reports the failure. */
  async remove(purchaseId: string): Promise<void> {
    this.assertAvailable();
    if (!this.records.has(purchaseId)) { this.assertFileCurrent(); return; }
    const next = new Map(this.records);
    next.delete(purchaseId);
    this.persist(next);
    this.records = next;
  }

  async list(): Promise<readonly InFlightCheckout[]> {
    this.assertAvailable();
    this.assertFileCurrent();
    return Object.freeze([...this.records.values()]);
  }

  /** Detect replacement by another store or operator. This is a restriction on
   * this owner, not a cross-process writer lease or permission to rebind state.
   */
  private assertFileCurrent(): void {
    try {
      if (this.observed === null) {
        try { lstatSync(this.filePath); }
        catch (error) { if (missing(error)) return; throw error; }
        throw new Error();
      }
      const current = readFileObservation(this.filePath);
      if (current.physical !== this.observed.physical || !current.bytes.equals(this.observed.bytes)) throw new Error();
    } catch {
      this.disable();
      throw new PaymentCheckoutJournalUnavailableError();
    }
  }

  private persist(records: ReadonlyMap<string, InFlightCheckout>): void {
    this.assertFileCurrent();
    const contents = `${JSON.stringify({ version: JOURNAL_FILE_VERSION, records: [...records.values()] }, null, 2)}\n`;
    try {
      atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true });
      const current = readFileObservation(this.filePath);
      if (!current.bytes.equals(Buffer.from(contents, 'utf-8'))) throw new Error();
      this.observed = current;
    } catch {
      this.disable();
      throw new PaymentCheckoutJournalUnavailableError();
    }
  }
}
