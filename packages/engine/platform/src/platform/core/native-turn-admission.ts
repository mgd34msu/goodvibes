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
// Intentionally retained for the process lifetime, including settled attempts.
// Durable restart ambiguity is owned by the product dispatch claim, not this map.
const inputs = new Map<string, NativeConversationTurnAdmission>();
const keyOf = (source: NativeConversationTurnSource) => JSON.stringify([source.projectId, source.sourceRef.inputId]);
const identityOf = (source: NativeConversationTurnSource) => JSON.stringify([source.projectId, source.requestId, source.sourceRef, source.route, source.text]);

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
    if (identityOf(prior.source) !== identityOf(source)) throw new NativeConversationTurnAdmissionError('identity_mismatch');
    if (prior.status === 'recovery_required') throw new NativeConversationTurnAdmissionError('recovery_required');
    if (prior.status !== 'retryable') return null;
    // Failover must preserve the original opaque binding, not reconstruct it.
    if (prior.permit !== permit) throw new NativeConversationTurnAdmissionError('recovery_required');
  }
  const admission: NativeConversationTurnAdmission = { permit, source, status: 'queued' };
  inputs.set(key, admission);
  return admission;
}

export function readNativeConversationTurnStatus(permit: NativeConversationTurnPermit): NativeConversationTurnStatus {
  const source = readNativeConversationTurnPermit(permit);
  const prior = inputs.get(keyOf(source));
  if (prior && identityOf(prior.source) !== identityOf(source)) throw new NativeConversationTurnAdmissionError('identity_mismatch');
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
  admission.status = to;
}
export function settleNativeConversationTurn(admission: NativeConversationTurnAdmission): void {
  if (inputs.get(keyOf(admission.source)) === admission && nativeConversationTurnLifecycle.can(admission.status, 'settled')) admission.status = 'settled';
}
