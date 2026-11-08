/** One durable metadata file per checkout identity. Populated exclusive
 * publication prevents another process/retry replacing an admitted request.
 * A strict execution lease spans its actual work, independently of its socket.
 * Status files contain no raw request/page text, card data or credentials. */
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../../utils/atomic-json-store.js';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import { readPaymentOperation, type PaymentOperationView } from '../operation-view.js';

export class PaymentOperationStoreError extends Error {
  override readonly name = 'PaymentOperationStoreError';
  constructor(readonly kind: 'invalid' | 'exists' | 'busy' | 'unavailable') {
    super(kind === 'exists' ? 'This checkout identity was already admitted. Read its purchase status; do not begin it again.'
      : kind === 'busy' ? 'This checkout is owned by an active payment host. Read its status on that host.'
      : kind === 'invalid' ? 'Use a stable checkout requestId containing 1–128 letters, digits, dots, colons, underscores or hyphens.'
      : 'Purchase-operation evidence is unavailable or changed. Inspect the original payment state before retrying.');
  }
}
export function checkoutRequestId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) throw new PaymentOperationStoreError('invalid');
  return value;
}
const absent = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
interface StoredOperation { readonly version: 1; readonly principalId: string | null; readonly operation: PaymentOperationView }
function parse(bytes: Uint8Array): StoredOperation {
  const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new PaymentOperationStoreError('unavailable');
  const row = raw as Record<string, unknown>;
  if (Object.keys(row).length !== 3 || row['version'] !== 1 || !(row['principalId'] === null || (typeof row['principalId'] === 'string' && row['principalId']))) throw new PaymentOperationStoreError('unavailable');
  return Object.freeze({ version: 1, principalId: row['principalId'] as string | null, operation: readPaymentOperation(row['operation']) });
}
function flushDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }

/** This writer is evidence ownership, never purchase authority. It remains
 * usable for final accounting after cancellation, until release() drains it. */
export interface PaymentOperationWriter {
  readonly purchaseId: string;
  readonly principalId: string | null;
  read(): PaymentOperationView;
  update(operation: PaymentOperationView): void;
  assertCurrent(): void;
  release(): void;
}
export interface PaymentRecoveryLease { assertCurrent(): void; release(): void }
export class DurablePaymentOperations {
  private readonly known = new Set<string>();
  private observedIndex = false;
  constructor(private readonly directory: string) {}
  private path(id: string): string { return join(this.directory, `${Buffer.from(checkoutRequestId(id)).toString('base64url')}.json`); }
  private lock(id: string): string { return join(this.directory, '.owners', `${Buffer.from(checkoutRequestId(id)).toString('base64url')}.lock`); }

  get(id: string): PaymentOperationView | null {
    try {
      const row = parse(readFileObservation(this.path(id)).bytes);
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
    const { value } = this.index();
    return [...new Set([...value.open, ...value.recent])].map(key => {
      const operation = this.get(key); if (!operation) throw new PaymentOperationStoreError('unavailable');
      return operation;
    }).sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.purchaseId.localeCompare(b.purchaseId));
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
          if (files.some(file => file.endsWith('.json'))) throw new Error();
          return { value: { version: 1, open: [], recent: [] }, observed: null };
        } catch { /* Existing evidence cannot become an empty index. */ }
      }
      throw new PaymentOperationStoreError('unavailable');
    }
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
      const retained = ['accepted', 'running', 'cancelling', 'attention', 'uncertain'].includes(operation.state);
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
      unlinkSync(staged); staged = undefined; flushDirectory(this.directory);
      const observation = readFileObservation(path), persisted = parse(observation.bytes);
      if (JSON.stringify(persisted) !== JSON.stringify(row)) throw new Error();
      this.indexOperation(operation);
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
    const assertCurrent = () => {
      if (released || failed) throw new PaymentOperationStoreError('unavailable');
      try {
        const current = lstatSync(lock, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() || current.dev !== owner.dev || current.ino !== owner.ino) throw new Error();
        const file = readFileObservation(path);
        if (file.physical !== observed.physical || !file.bytes.equals(observed.bytes)) throw new Error();
      } catch { failed = true; throw new PaymentOperationStoreError('unavailable'); }
    };
    return Object.freeze({ purchaseId: id, principalId: initial.principalId, assertCurrent,
      read: () => { assertCurrent(); return row.operation; },
      update: (operation: PaymentOperationView) => {
        assertCurrent(); const next = readPaymentOperation(operation);
        if (next.purchaseId !== id || next.operationId !== initial.operation.operationId || next.createdAtMs !== initial.operation.createdAtMs) throw new PaymentOperationStoreError('invalid');
        const stored: StoredOperation = { ...row, operation: next }, contents = `${JSON.stringify(stored)}\n`;
        try {
          atomicWriteFileSync(path, contents, { mode: 0o600, assertCurrent });
          const file = readFileObservation(path);
          if (!file.bytes.equals(Buffer.from(contents))) throw new Error();
          row = stored; observed = file;
          this.indexOperation(next);
        } catch { failed = true; throw new PaymentOperationStoreError('unavailable'); }
      },
      release: () => { if (released) return; released = true; releaseLease(); },
    });
  }
}
