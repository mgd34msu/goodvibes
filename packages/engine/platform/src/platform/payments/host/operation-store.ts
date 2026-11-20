/** One durable metadata file per checkout identity. Populated exclusive
 * publication prevents another process/retry replacing an admitted request.
 * A strict execution lease spans its actual work, independently of its socket.
 * Public status projects references and outcomes only. Private v2 bookkeeping
 * checkpoints retain the original journal/receipt facts (including item and
 * window notice), mode 0600. No protected request, raw quote, card material or
 * credential is moved into operation metadata. */
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import { purchaseDisposition, purchaseOutcomeText, readPaymentOperation, type PaymentOperationView } from '../operation-view.js';
import type { PaymentUnreadableOperation } from '../window-view.js';
import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { capturePaymentReconciliation, type PaymentReconciliationCheckpoint } from './reconciliation-checkpoint.js';

export class PaymentOperationStoreError extends Error {
  override readonly name = 'PaymentOperationStoreError';
  /** `message` replaces the kind's generic sentence when the caller knows the
   * actual state and the allowed next step. It never carries stored evidence. */
  constructor(readonly kind: 'invalid' | 'exists' | 'busy' | 'unavailable', message?: string) {
    super(message ?? (kind === 'exists' ? 'This checkout identity was already admitted. Read its purchase status; do not begin it again.'
      : kind === 'busy' ? 'This checkout is owned by an active payment host. Read its status on that host.'
      : kind === 'invalid' ? 'Use a stable checkout requestId containing 1–128 letters, digits, dots, colons, underscores or hyphens.'
      : 'Purchase-operation evidence is unavailable or changed. Inspect the original payment state before retrying.'));
  }
}
export function checkoutRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new PaymentOperationStoreError('invalid');
  return value;
}
const absent = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
interface StoredOperation { readonly version: 1 | 2; readonly principalId: string | null; readonly operation: PaymentOperationView; readonly reconciliation?: PaymentReconciliationCheckpoint }
function parse(bytes: Uint8Array): StoredOperation {
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaymentOperationStoreError('unavailable');
  const row = raw as Record<string, unknown>;
  if (!(row['principalId'] === null || (typeof row['principalId'] === 'string' && row['principalId']))) throw new PaymentOperationStoreError('unavailable');
  const operation = readPaymentOperation(row['operation']);
  if (row['version'] === 1 && Object.keys(row).length === 3) return Object.freeze({ version: 1, principalId: row['principalId'] as string | null, operation });
  if (row['version'] !== 2 || Object.keys(row).length !== 4) throw new PaymentOperationStoreError('unavailable');
  const reconciliation = capturePaymentReconciliation(row['reconciliation']);
  if (reconciliation.purchaseId !== operation.purchaseId || reconciliation.operationId !== operation.operationId) throw new PaymentOperationStoreError('unavailable');
  return Object.freeze({ version: 2, principalId: row['principalId'] as string | null, operation, reconciliation });
}
function flushDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** This writer is evidence ownership, never purchase authority. It remains
 * usable for final accounting after cancellation, until release() drains it. */
export interface PaymentOperationWriter {
  readonly purchaseId: string;
  readonly principalId: string | null;
  read(): PaymentOperationView;
  update(operation: PaymentOperationView, assertCurrent?: () => void): void;
  reconciliation(): PaymentReconciliationCheckpoint | null;
  beginReconciliation(checkpoint: PaymentReconciliationCheckpoint, assertCurrent: () => void): void;
  assertCurrent(): void;
  release(): void;
}
export interface PaymentRecoveryLease { assertCurrent(): void; release(): void }
export class DurablePaymentOperations {
  private readonly known = new Set<string>();
  private observedIndex = false;
  constructor(private readonly directory: string, private readonly beforeReconciliationWrite?: () => void) {}

  private declareReconciliation(): void {
    assertSynchronousJudgmentGuard(() => this.beforeReconciliationWrite?.(), () => new PaymentOperationStoreError('unavailable'));
  }
  private path(id: string): string { return join(this.directory, `${Buffer.from(checkoutRequestId(id)).toString('base64url')}.json`); }
  private lock(id: string): string { return join(this.directory, '.owners', `${Buffer.from(checkoutRequestId(id)).toString('base64url')}.lock`); }

  get(id: string): PaymentOperationView | null {
    try {
      const row = parse(readFileObservation(this.path(id)).bytes);
      if (row.version === 2) this.declareReconciliation();
      if (row.operation.purchaseId !== id) throw new Error();
      this.known.add(id); return row.operation;
    } catch (error) {
      if (absent(error) && !this.known.has(id)) {
        try { lstatSync(this.path(id)); } catch (missing) {
          if (absent(missing)) {
            const index = this.index().value;
            if (index.open.includes(id) || index.recent.includes(id)) throw new PaymentOperationStoreError('unavailable');
            return null;
          }
        }
      }
      throw error instanceof PaymentOperationStoreError ? error : new PaymentOperationStoreError('unavailable');
    }
  }
  list(id?: string): readonly PaymentOperationView[] {
    if (id !== undefined) { const operation = this.get(id); return operation ? [operation] : []; }
    const { operations, unreadable } = this.report();
    const first = unreadable[0];
    if (first) throw new PaymentOperationStoreError('unavailable', first.reason);
    return operations;
  }
  /** Every readable row, and the records that could not be read by name, so one
   * damaged file never hides the evidence of the other purchases. */
  report(): { readonly operations: readonly PaymentOperationView[]; readonly unreadable: readonly PaymentUnreadableOperation[] } {
    const { value } = this.index();
    const operations: PaymentOperationView[] = [], unreadable: PaymentUnreadableOperation[] = [];
    // The files are the record; the index is a cache of them. An operation
    // published and never indexed (a stop between the two) is found by its
    // file, listed, and put back in the index, so recovery and status see it.
    const unindexed = this.unindexedOperationIds(value);
    for (const key of new Set([...value.open, ...value.recent, ...unindexed])) {
      let operation: PaymentOperationView | null;
      try { operation = this.get(key); } catch { operation = null; }
      if (operation) operations.push(operation);
      else unreadable.push(Object.freeze({ purchaseId: key, reason: `The status record for purchase ${key} is unreadable or missing. `
        + 'Inspect that purchase\'s payment evidence (its journal entry and merchant history) before taking further action on it; its status cannot be shown.' }));
    }
    operations.sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.purchaseId.localeCompare(b.purchaseId));
    for (const operation of operations) {
      if (!unindexed.includes(operation.purchaseId)) continue;
      try { this.indexOperation(operation); } catch { /* The file still lists it; the index is repaired on a later read. */ }
    }
    return { operations, unreadable };
  }

  /** Operation files in the directory that the index does not name: one directory read. */
  private unindexedOperationIds(index: { readonly open: readonly string[]; readonly recent: readonly string[] }): string[] {
    let files: string[];
    try { files = readdirSync(this.directory); } catch { return []; }
    const named = new Set([...index.open, ...index.recent]);
    const found: string[] = [];
    for (const file of files) {
      if (!file.endsWith('.json') || file.startsWith('.')) continue;
      let id: string;
      try { id = checkoutRequestId(Buffer.from(file.slice(0, -'.json'.length), 'base64url').toString('utf8')); } catch { continue; }
      if (!named.has(id) && this.path(id) === join(this.directory, file)) found.push(id);
    }
    return found;
  }
  private index(): { value: { version: 1; open: string[]; recent: string[] }; observed: FileObservation | null } {
    try {
      const observed = readFileObservation(join(this.directory, 'index'));
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const row = raw as Record<string, unknown>;
      if (Object.keys(row).length !== 3 || row['version'] !== 1 || !Array.isArray(row['open']) || row['open'].length > 256 || !Array.isArray(row['recent']) || row['recent'].length > 100) throw new Error();
      const open = row['open'].map(checkoutRequestId), recent = row['recent'].map(checkoutRequestId);
      if (new Set(open).size !== open.length || new Set(recent).size !== recent.length) throw new Error();
      this.observedIndex = true;
      return { value: { version: 1, open, recent }, observed };
    } catch (error) {
      if (absent(error) && !this.observedIndex) {
        try {
          let indexExists = true;
          try { lstatSync(join(this.directory, 'index')); } catch (missing) { if (!absent(missing)) throw missing; indexExists = false; }
          if (indexExists) throw new Error();
          let files: string[];
          try { files = readdirSync(this.directory); } catch (missing) { if (!absent(missing)) throw missing; files = []; }
          // Existing evidence never becomes an empty index: the index is a cache
          // of the operation files, so a lost one is rebuilt from them.
          if (files.some(file => file.endsWith('.json') && !file.startsWith('.'))) return this.rebuildIndex();
          return { value: { version: 1, open: [], recent: [] }, observed: null };
        } catch { /* Existing evidence cannot become an empty index. */ }
      }
      throw new PaymentOperationStoreError('unavailable');
    }
  }
  /**
   * Rebuild a lost index from the operation files: an empty index is
   * published under the index lock, then each readable operation is indexed
   * as its own write would have, oldest first. Throws when any file cannot be
   * read (its evidence must not be dropped from the listing).
   */
  private rebuildIndex(): { value: { version: 1; open: string[]; recent: string[] }; observed: FileObservation | null } {
    const release = tryAcquireCrossProcessLock(join(this.directory, '.index.lock'));
    if (!release) throw new PaymentOperationStoreError('busy');
    const operations: PaymentOperationView[] = [];
    try {
      for (const id of this.unindexedOperationIds({ open: [], recent: [] })) {
        const operation = this.get(id);
        if (operation === null) throw new PaymentOperationStoreError('unavailable');
        operations.push(operation);
      }
      const path = join(this.directory, 'index');
      writeFileAtomic(path, `${JSON.stringify({ version: 1, open: [], recent: [] })}\n`, { mode: 0o600, durable: true, cleanupStaleTemps: false,
        assertCurrent: () => {
          try { lstatSync(path); } catch (error) { if (absent(error)) return; throw error; }
          throw new PaymentOperationStoreError('unavailable');
        } });
      this.observedIndex = true;
    } finally { release(); }
    operations.sort((a, b) => a.updatedAtMs - b.updatedAtMs || a.purchaseId.localeCompare(b.purchaseId));
    for (const operation of operations) this.indexOperation(operation);
    return this.index();
  }
  private initializeIndex(): void {
    const release = tryAcquireCrossProcessLock(join(this.directory, '.index.lock'));
    if (!release) throw new PaymentOperationStoreError('busy');
    try {
      const previous = this.index();
      if (previous.observed !== null) return;
      const path = join(this.directory, 'index');
      writeFileAtomic(path, `${JSON.stringify(previous.value)}\n`, { mode: 0o600, durable: true, cleanupStaleTemps: false,
        assertCurrent: () => {
          try { lstatSync(path); } catch (error) { if (absent(error)) return; throw error; }
          throw new PaymentOperationStoreError('unavailable');
        } });
      this.observedIndex = true;
    } finally { release(); }
  }
  private indexOperation(operation: PaymentOperationView): void {
    const release = tryAcquireCrossProcessLock(join(this.directory, '.index.lock'));
    if (!release) throw new PaymentOperationStoreError('busy');
    try {
      const previous = this.index(), id = operation.purchaseId;
      // An order this daemon could not confirm stays listed until the owner reconciles it
      // (which changes its outcome), however many later purchases push it out of `recent`.
      const retained = purchaseDisposition(operation).keepListed;
      const open = previous.value.open.filter(key => key !== id);
      if (retained) open.push(id);
      if (open.length > 256) throw new PaymentOperationStoreError('busy');
      const next = { version: 1, open, recent: [id, ...previous.value.recent.filter(key => key !== id)].slice(0, 100) };
      const path = join(this.directory, 'index');
      atomicWriteFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600, mkdirp: true, assertCurrent: () => {
        try {
          if (previous.observed === null) {
            try { lstatSync(path); } catch (error) { if (absent(error)) return; throw error; }
            throw new Error();
          }
          const current = readFileObservation(path);
          if (current.physical !== previous.observed.physical || !current.bytes.equals(previous.observed.bytes)) throw new Error();
        } catch { throw new PaymentOperationStoreError('unavailable'); }
      } });
      this.observedIndex = true;
    } finally { release(); }
  }

  create(operation: PaymentOperationView, principalId: string | null, beforePublication: () => void): PaymentOperationWriter {
    const id = checkoutRequestId(operation.purchaseId), path = this.path(id);
    if (this.get(id)) throw new PaymentOperationStoreError('exists');
    const release = this.acquire(id); if (!release) throw new PaymentOperationStoreError('busy');
    let staged: string | undefined;
    try {
      if (this.get(id)) throw new PaymentOperationStoreError('exists');
      // Publish the empty index under its own lock before any populated
      // operation file exists. Concurrent first admissions cannot mistake
      // one another's newly published file for a lost historical index.
      this.initializeIndex();
      const row: StoredOperation = { version: 1, principalId, operation: readPaymentOperation(operation) };
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      staged = join(this.directory, `.new-${crypto.randomUUID()}`);
      writeFileAtomic(staged, `${JSON.stringify(row)}\n`, { mode: 0o600, durable: true, cleanupStaleTemps: false });
      beforePublication();
      // link is create-if-absent, never a rename over an earlier admission.
      linkSync(staged, path); this.known.add(id);
      let observation: FileObservation, persisted: StoredOperation;
      try {
        unlinkSync(staged); staged = undefined; flushDirectory(this.directory);
        observation = readFileObservation(path); persisted = parse(observation.bytes);
        if (JSON.stringify(persisted) !== JSON.stringify(row)) throw new Error();
        this.indexOperation(operation);
      } catch (error) {
        // Published but never indexed (or not confirmed as written), with no
        // executor to run it: status and boot recovery both find operations
        // through the index, so the file would sit as `accepted` forever and a
        // retry would answer `exists`. The lease is still held and nothing has
        // started, so take it back.
        this.known.delete(id);
        try { unlinkSync(path); flushDirectory(this.directory); } catch { /* A file we cannot remove is reported by the original failure below. */ }
        throw error;
      }
      return this.writer(id, persisted, observation, release);
    } catch (error) {
      release();
      if (error instanceof PaymentOperationStoreError) throw error;
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw new PaymentOperationStoreError('exists');
      throw new PaymentOperationStoreError('unavailable');
    } finally { if (staged) { try { unlinkSync(staged); } catch { /* Unpublished staging evidence grants no execution. */ } } }
  }

  /** Recovery can inspect/update only when the real earlier executor no longer
   * holds the strict lease. A busy lease never means an interrupted operation. */
  recover(id: string): PaymentOperationWriter | null {
    const release = this.acquire(id); if (!release) return null;
    try {
      const observation = readFileObservation(this.path(id)), row = parse(observation.bytes);
      if (row.version === 2) this.declareReconciliation();
      if (row.operation.purchaseId !== id) throw new Error();
      this.known.add(id); return this.writer(id, row, observation, release);
    } catch { release(); throw new PaymentOperationStoreError('unavailable'); }
  }
  /** The journal sweep takes the same lease as execution, including for a
   * purchase from before operation metadata existed. A live owner is skipped. */
  retainRecovery(id: string): PaymentRecoveryLease | null {
    const release = this.acquire(id); if (!release) return null;
    try {
      const path = this.lock(id), owner = lstatSync(path, { bigint: true });
      let released = false;
      return Object.freeze({
        assertCurrent: () => {
          if (released) throw new PaymentOperationStoreError('unavailable');
          try {
            const current = lstatSync(path, { bigint: true });
            if (!current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error();
          } catch { throw new PaymentOperationStoreError('unavailable'); }
        },
        release: () => { if (released) return; released = true; release(); },
      });
    } catch { release(); throw new PaymentOperationStoreError('unavailable'); }
  }
  private acquire(id: string): (() => void) | null {
    try { return tryAcquireCrossProcessLock(this.lock(id)); } catch { throw new PaymentOperationStoreError('unavailable'); }
  }
  private writer(id: string, initial: StoredOperation, initialObservation: FileObservation, releaseLease: () => void): PaymentOperationWriter {
    const path = this.path(id), lock = this.lock(id), owner = lstatSync(lock, { bigint: true });
    let row = initial, observed = initialObservation, released = false, failed = false;
    // The newest state whose index entry could not be written. The file is the
    // record and is already durable, so a busy or changed index is repaired
    // here later and is not a reason to stop writing.
    let unindexed: PaymentOperationView | null = null;
    const repairIndex = () => {
      if (unindexed === null) return;
      try { this.indexOperation(unindexed); unindexed = null; } catch { /* Still held elsewhere; tried again on the next write or release. */ }
    };
    const assertCurrent = () => {
      if (released || failed) throw new PaymentOperationStoreError('unavailable');
      try {
        const current = lstatSync(lock, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error();
        const file = readFileObservation(path);
        if (file.physical !== observed.physical || !file.bytes.equals(observed.bytes)) throw new Error();
      } catch { failed = true; throw new PaymentOperationStoreError('unavailable'); }
    };
    const save = (stored: StoredOperation, ownerCurrent?: () => void) => {
      ownerCurrent?.();
      if (stored.version === 2) this.declareReconciliation();
      ownerCurrent?.();
      const contents = `${JSON.stringify(stored)}\n`;
      try {
        atomicWriteFileSync(path, contents, { mode: 0o600, assertCurrent: () => { ownerCurrent?.(); assertCurrent(); } });
        const file = readFileObservation(path);
        if (!file.bytes.equals(Buffer.from(contents))) throw new Error();
        row = stored; observed = file;
      } catch { failed = true; throw new PaymentOperationStoreError('unavailable'); }
      unindexed = stored.operation;
      repairIndex();
    };
    return Object.freeze({ purchaseId: id, principalId: initial.principalId, assertCurrent,
      read: () => { assertCurrent(); return row.operation; },
      reconciliation: () => { assertCurrent(); return row.reconciliation ?? null; },
      beginReconciliation: (input: PaymentReconciliationCheckpoint, ownerCurrent: () => void) => {
        assertCurrent(); const reconciliation = capturePaymentReconciliation(input);
        if (row.reconciliation || reconciliation.purchaseId !== id || reconciliation.operationId !== row.operation.operationId) throw new PaymentOperationStoreError('invalid');
        save({ ...row, version: 2, reconciliation, operation: { ...row.operation, state: 'uncertain',
          outcome: purchaseOutcomeText({ kind: 'owner-reconciliation-pending', finding: reconciliation.outcome }), updatedAtMs: reconciliation.atMs } }, ownerCurrent);
      },
      update: (operation: PaymentOperationView, ownerCurrent?: () => void) => {
        assertCurrent(); const next = readPaymentOperation(operation);
        if (next.purchaseId !== id || next.operationId !== initial.operation.operationId || next.createdAtMs !== initial.operation.createdAtMs) throw new PaymentOperationStoreError('invalid');
        save({ ...row, operation: next }, ownerCurrent);
      },
      release: () => { if (released) return; repairIndex(); released = true; releaseLease(); },
    });
  }
}
