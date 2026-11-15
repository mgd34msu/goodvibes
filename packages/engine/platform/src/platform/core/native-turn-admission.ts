import { createHash } from 'node:crypto';
import type { ContentPart } from '../providers/interface.js';
import { defineLifecycle } from '../utils/lifecycle-machine.js';
import { logger } from '../utils/logger.js';
import { readNativeConversationTurnPermit, type NativeConversationTurnPermit, type NativeConversationTurnSource } from '../workflow/work-ledger/native-intake-client.js';

export type NativeConversationTurnStatus = 'unclaimed' | 'queued' | 'running' | 'settled' | 'retryable' | 'recovery_required';
/**
 * The legal moves of a native conversation turn. `unclaimed` is the absence of
 * a record (nothing is stored in it). `retryable -> queued` is a re-admission
 * (a new admission replaces the record); `retryable -> recovery_required` is a
 * failure reported again after a safe-to-retry one. `settled` and
 * `recovery_required` are final: a settled turn must never be failed back into
 * `retryable` (that re-admits the same input), and a turn that needs recovery
 * is never upgraded to retryable.
 */
export const nativeConversationTurnLifecycle = defineLifecycle<NativeConversationTurnStatus>('native conversation turn', {
  unclaimed: ['queued'],
  queued: ['running', 'settled', 'recovery_required'],
  running: ['settled', 'retryable', 'recovery_required'],
  settled: [],
  retryable: ['queued', 'recovery_required'],
  recovery_required: [],
});
export class NativeConversationTurnAdmissionError extends Error {
  constructor(readonly code: 'identity_mismatch' | 'recovery_required') {
    super(`Native conversation turn: ${code}`); this.name = 'NativeConversationTurnAdmissionError';
  }
}
export interface NativeConversationTurnAdmission {
  readonly permit: NativeConversationTurnPermit;
  readonly source: NativeConversationTurnSource;
  status: Exclude<NativeConversationTurnStatus, 'unclaimed'>;
}
/** A turn that reached a final state keeps only what refusing a replay needs. */
interface FinishedNativeConversationTurn {
  readonly status: 'settled' | 'recovery_required';
  /** sha256 of the turn's identity; the request text, context and permit are released. */
  readonly identity: string;
}
// The map refuses an in-process replay; durable restart ambiguity is owned by
// the product dispatch claim. Live turns keep their admission; a finished turn
// keeps its status and an identity hash, and only the newest finished turns
// are kept.
const MAX_FINISHED_TURNS = 4096;
const inputs = new Map<string, NativeConversationTurnAdmission | FinishedNativeConversationTurn>();
let finishedCount = 0;
const keyOf = (source: NativeConversationTurnSource) => JSON.stringify([source.projectId, source.sourceRef.inputId]);
const identityOf = (source: NativeConversationTurnSource) => JSON.stringify([source.projectId, source.requestId, source.sourceRef, source.route, source.text]);
const identityHash = (source: NativeConversationTurnSource) => createHash('sha256').update(identityOf(source)).digest('hex');
const isLive = (entry: NativeConversationTurnAdmission | FinishedNativeConversationTurn): entry is NativeConversationTurnAdmission => 'permit' in entry;
function sameIdentity(entry: NativeConversationTurnAdmission | FinishedNativeConversationTurn, source: NativeConversationTurnSource): boolean {
  return isLive(entry) ? identityOf(entry.source) === identityOf(source) : entry.identity === identityHash(source);
}

/** Replace a turn that reached a final state with its status and identity hash. */
function finish(admission: NativeConversationTurnAdmission, status: FinishedNativeConversationTurn['status']): void {
  const key = keyOf(admission.source);
  admission.status = status;
  inputs.delete(key);
  inputs.set(key, Object.freeze({ status, identity: identityHash(admission.source) }));
  finishedCount++;
  if (finishedCount <= MAX_FINISHED_TURNS) return;
  for (const [oldest, entry] of inputs) {
    if (isLive(entry)) continue;
    inputs.delete(oldest);
    if (--finishedCount <= MAX_FINISHED_TURNS) break;
  }
}

export function validateNativeConversationTurn(permit: NativeConversationTurnPermit, text: string, content?: readonly ContentPart[], projectId?: string): NativeConversationTurnSource {
  const source = readNativeConversationTurnPermit(permit);
  if (source.text !== text || (projectId !== undefined && source.projectId !== projectId)
    || (content !== undefined && (content.length !== 1 || content[0]?.type !== 'text' || content[0].text !== text))) {
    throw new NativeConversationTurnAdmissionError('identity_mismatch');
  }
  return source;
}

/** Validates before queueing; the same logical source cannot run twice. */
export function admitNativeConversationTurn(permit: NativeConversationTurnPermit, text: string, content?: readonly ContentPart[], projectId?: string): NativeConversationTurnAdmission | null {
  const source = validateNativeConversationTurn(permit, text, content, projectId);
  const key = keyOf(source), prior = inputs.get(key);
  if (prior) {
    if (!sameIdentity(prior, source)) throw new NativeConversationTurnAdmissionError('identity_mismatch');
    if (prior.status === 'recovery_required') throw new NativeConversationTurnAdmissionError('recovery_required');
    if (prior.status !== 'retryable' || !isLive(prior)) return null;
    // A turn that failed before any effect may run again for the same source;
    // the identity compared above is what binds it, whichever permit carries it.
  }
  const admission: NativeConversationTurnAdmission = { permit, source, status: 'queued' };
  inputs.set(key, admission);
  return admission;
}

export function readNativeConversationTurnStatus(permit: NativeConversationTurnPermit): NativeConversationTurnStatus {
  const source = readNativeConversationTurnPermit(permit);
  const prior = inputs.get(keyOf(source));
  if (prior && !sameIdentity(prior, source)) throw new NativeConversationTurnAdmissionError('identity_mismatch');
  return prior?.status ?? 'unclaimed';
}

export function startNativeConversationTurn(admission: NativeConversationTurnAdmission): void {
  if (inputs.get(keyOf(admission.source)) !== admission || !nativeConversationTurnLifecycle.can(admission.status, 'running')) throw new NativeConversationTurnAdmissionError('recovery_required');
  admission.status = 'running';
}
export function failNativeConversationTurn(admission: NativeConversationTurnAdmission, safelyRetryable: boolean): void {
  if (inputs.get(keyOf(admission.source)) !== admission) return;
  const to = safelyRetryable ? 'retryable' : 'recovery_required';
  if (admission.status === to) return;
  const move = nativeConversationTurnLifecycle.check(admission.status, to);
  // A refused move leaves the turn as it is: failing a settled turn would make
  // it admissible again, and a turn that needs recovery never becomes retryable.
  if (!move.ok) { logger.warn('Native conversation turn: failure report refused', { reason: move.reason, allowed: move.allowed }); return; }
  if (to === 'recovery_required') finish(admission, to);
  else admission.status = to;
}
export function settleNativeConversationTurn(admission: NativeConversationTurnAdmission): void {
  if (inputs.get(keyOf(admission.source)) === admission && nativeConversationTurnLifecycle.can(admission.status, 'settled')) finish(admission, 'settled');
}
