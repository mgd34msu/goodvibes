/** Persisted checkout approvals. Every access refreshes the actual file under
 * one strict mutation lock: process-local copies cannot re-spend a grant.
 * Original v1 content bindings, five-minute expiry and weak-binding refusal
 * remain readable. Damaged evidence is unavailable, never replaced as empty.
 */
import { lstatSync } from 'node:fs';
import { atomicWriteFileSync } from '../../config/atomic-write.js';
import { readFileObservation, type FileObservation } from '../../utils/file-observation.js';
import { tryAcquireCrossProcessLock } from '../../workspace/checkpoint/cross-process-lock.js';
import { captureOwnedJson } from '../../gate/judgment-input.js';
import { checkOwnerApproval, grantOwnerApproval, type ApprovalMismatch, type OwnerApproval } from '../../security/owner-approval.js';

const APPROVALS_FILE_VERSION = 1, MAX_PENDING_APPROVALS = 16;
const missing = (error: unknown): boolean => error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

export class PaymentApprovalStoreError extends Error {
  override readonly name = 'PaymentApprovalStoreError';
  constructor(readonly kind: 'unavailable' | 'busy' | 'invalid-request' | 'write-uncertain') {
    super(kind === 'busy' ? 'Another payment owner is updating approvals. Refresh this purchase before trying again.'
      : kind === 'invalid-request' ? 'The purchase approval must name an action and its content fields.'
      : kind === 'write-uncertain' ? 'The approval write could not be confirmed. Inspect the original purchase and approval evidence before trying again.'
      : 'Purchase approvals are unreadable, unsupported or changed. Repair the original approval evidence and reopen the payment host.');
  }
}

interface ApprovalSnapshot {
  readonly observed: FileObservation | null;
  readonly envelope: Readonly<Record<string, unknown>>;
  readonly approvals: readonly OwnerApproval[];
}
function approval(value: unknown): value is OwnerApproval {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row['action'] === 'string' && row['action'].length > 0 && row['surface'] === 'owner-direct'
    && typeof row['grantedAt'] === 'string' && Number.isFinite(Date.parse(row['grantedAt']))
    && typeof row['expiresAt'] === 'string' && Number.isFinite(Date.parse(row['expiresAt']))
    && Date.parse(row['expiresAt']) > Date.parse(row['grantedAt'])
    && (row['contentFingerprint'] === null || typeof row['contentFingerprint'] === 'string');
}
/** Returned views expose only the existing approval contract, not file extensions. */
function view(value: OwnerApproval): OwnerApproval {
  return Object.freeze({ action: value.action, surface: value.surface, grantedAt: value.grantedAt,
    expiresAt: value.expiresAt, contentFingerprint: value.contentFingerprint });
}
function request(input: { readonly action: string; readonly content: Readonly<Record<string, string | undefined>> }) {
  try {
    const captured = captureOwnedJson(input) as typeof input;
    if (typeof captured.action !== 'string' || !captured.action || !captured.content || typeof captured.content !== 'object'
      || Array.isArray(captured.content) || Object.values(captured.content).some(value => value !== undefined && typeof value !== 'string')) throw new Error();
    return captured;
  } catch { throw new PaymentApprovalStoreError('invalid-request'); }
}

export interface ApprovalTakeMiss { readonly approval: null; readonly mismatch: ApprovalMismatch }
export interface ApprovalTakeHit { readonly approval: OwnerApproval }

/** A returned approval is spent durably before publication. No process-local
 * rollback can make an uncertain disk write spendable again. Reopen to inspect
 * its actual result. File extensions and valid unspent rows survive mutation. */
export class DaemonApprovalStore {
  private observedFile = false;
  private unavailable = false;
  constructor(private readonly filePath: string, private readonly now: () => Date = () => new Date()) {}

  private read(): ApprovalSnapshot {
    if (this.unavailable) throw new PaymentApprovalStoreError('unavailable');
    try {
      const observed = readFileObservation(this.filePath);
      const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(observed.bytes), (_key, value: unknown) => {
        if (typeof value === 'number' && !Number.isFinite(value)) throw new Error();
        return value;
      });
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
      const envelope = raw as Readonly<Record<string, unknown>>, rows = envelope['approvals'];
      if (envelope['version'] !== APPROVALS_FILE_VERSION || !Array.isArray(rows) || rows.length > MAX_PENDING_APPROVALS
        || !rows.every(approval)) throw new Error();
      this.observedFile = true;
      return { observed, envelope, approvals: rows };
    } catch (error) {
      if (missing(error) && !this.observedFile) {
        try { lstatSync(this.filePath); } catch (absent) {
          if (missing(absent)) return { observed: null, envelope: {}, approvals: [] };
        }
      }
      this.unavailable = true; throw new PaymentApprovalStoreError('unavailable');
    }
  }
  private assertFileCurrent(observed: FileObservation | null): void {
    try {
      if (observed === null) {
        try { lstatSync(this.filePath); } catch (error) { if (missing(error)) return; throw error; }
        throw new Error();
      }
      const current = readFileObservation(this.filePath);
      if (current.physical !== observed.physical || !current.bytes.equals(observed.bytes)) throw new Error();
    } catch { throw new PaymentApprovalStoreError('unavailable'); }
  }
  private mutate<T>(operation: (snapshot: ApprovalSnapshot) => { readonly approvals: readonly OwnerApproval[]; readonly result: T; readonly changed: boolean }): T {
    if (this.unavailable) throw new PaymentApprovalStoreError('unavailable');
    let release: (() => void) | null;
    try { release = tryAcquireCrossProcessLock(`${this.filePath}.mutation.lock`); }
    catch { throw new PaymentApprovalStoreError('unavailable'); }
    if (!release) throw new PaymentApprovalStoreError('busy');
    try {
      const leasePath = `${this.filePath}.mutation.lock`, lease = readFileObservation(leasePath);
      const currentLease = () => {
        const current = readFileObservation(leasePath);
        if (current.physical !== lease.physical || !current.bytes.equals(lease.bytes)) throw new PaymentApprovalStoreError('unavailable');
      };
      const snapshot = this.read(), next = operation(snapshot);
      currentLease();
      if (next.changed) {
        const contents = `${JSON.stringify({ ...snapshot.envelope, version: APPROVALS_FILE_VERSION, approvals: next.approvals }, null, 2)}\n`;
        try {
          atomicWriteFileSync(this.filePath, contents, { mode: 0o600, mkdirp: true,
            assertCurrent: () => { currentLease(); this.assertFileCurrent(snapshot.observed); } });
          if (!readFileObservation(this.filePath).bytes.equals(Buffer.from(contents, 'utf8'))) throw new Error();
          currentLease();
          this.observedFile = true;
        } catch {
          this.unavailable = true; throw new PaymentApprovalStoreError('write-uncertain');
        }
      }
      return next.result;
    } catch (error) {
      this.unavailable = true;
      throw error instanceof PaymentApprovalStoreError ? error : new PaymentApprovalStoreError('unavailable');
    } finally {
      try { release(); } catch { this.unavailable = true; throw new PaymentApprovalStoreError('write-uncertain'); }
    }
  }

  grant(input: { readonly action: string; readonly content: Readonly<Record<string, string | undefined>> }): OwnerApproval {
    const captured = request(input);
    return this.mutate(snapshot => {
      const at = this.now(), nowMs = at.getTime();
      const granted = grantOwnerApproval({ action: captured.action, content: captured.content, surface: 'owner-direct', now: () => at });
      if (granted === null) throw new PaymentApprovalStoreError('invalid-request');
      const approvals = snapshot.approvals.filter(row => Date.parse(row.expiresAt) > nowMs);
      if (approvals.length >= MAX_PENDING_APPROVALS) approvals.shift();
      approvals.push(granted);
      return { approvals, result: view(granted), changed: true };
    });
  }

  take(input: { readonly action: string; readonly content: Readonly<Record<string, string | undefined>> }): ApprovalTakeHit | ApprovalTakeMiss {
    const captured = request(input);
    return this.mutate<ApprovalTakeHit | ApprovalTakeMiss>(snapshot => {
      const at = this.now(), nowMs = at.getTime();
      let closest: ApprovalMismatch = 'none';
      for (const [index, candidate] of snapshot.approvals.entries()) {
        const verdict = checkOwnerApproval({ approval: candidate, action: captured.action,
          contentInQuestion: captured.content, clearingContentTaint: true, now: () => at });
        if (verdict.authorized) {
          const approvals = snapshot.approvals.filter((row, position) => position !== index && Date.parse(row.expiresAt) > nowMs);
          return { approvals, result: { approval: view(candidate) }, changed: true };
        }
        closest = closerMismatch(closest, verdict.mismatch);
      }
      // Compare before sweeping so the immediate caller still learns expired.
      const approvals = snapshot.approvals.filter(row => Date.parse(row.expiresAt) > nowMs);
      return { approvals, result: { approval: null, mismatch: closest }, changed: approvals.length !== snapshot.approvals.length };
    });
  }

  pendingCount(): number {
    return this.mutate(snapshot => {
      const nowMs = this.now().getTime(), approvals = snapshot.approvals.filter(row => Date.parse(row.expiresAt) > nowMs);
      return { approvals, result: approvals.length, changed: approvals.length !== snapshot.approvals.length };
    });
  }
}

function closerMismatch(current: ApprovalMismatch, candidate: ApprovalMismatch): ApprovalMismatch {
  const rank: Record<ApprovalMismatch, number> = { none: 0, 'different-action': 1, expired: 2, 'invalid-window': 2, 'no-content-binding': 3, 'different-content': 4 };
  return rank[candidate] > rank[current] ? candidate : current;
}
