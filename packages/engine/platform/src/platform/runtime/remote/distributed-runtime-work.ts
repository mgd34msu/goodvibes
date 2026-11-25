import { randomUUID } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import type { AutomationRunTelemetry } from '../../automation/runs.js';
import type {
  DistributedPendingWork,
  DistributedWorkAdmission,
  DistributedWorkAdmissionOwner,
  DistributedPeerRecord,
  DistributedRuntimeManagerState,
  DistributedWorkPriority,
  DistributedWorkType,
} from './distributed-runtime-types.js';
import {
  buildAudit,
  sanitizePeer,
  sortWork,
  summarizeValue,
} from './distributed-runtime-utils.js';
import { bridgeQueuedDistributedWork } from './distributed-runtime-bridges.js';
import {
  DistributedRuntimeRefusalError,
  distributedWorkLifecycle,
  nextDistributedPeerStatus,
  refusalReason,
} from './distributed-runtime-lifecycles.js';
import {
  bridgeSettledAndRemember,
  persistDistributedRuntime,
  pruneAndPersistDistributedRuntime,
  publishDistributedRuntimeEvent,
  recordDistributedRuntimeAudit,
  requeueDistributedExpiredClaims,
  resolveDistributedRuntimeWaiters,
  standInBridgePeer,
  startDistributedRuntime,
  waitForDistributedWork,
  withOwedDistributedBridges,
} from './distributed-runtime-store.js';

// The marker survives restart; its executable owner deliberately does not.
const ADMISSION_REQUIRED = '__hostAdmissionRequired';
const reservedAdmissions = new WeakSet<object>();
function signature(work: DistributedPendingWork): string {
  return JSON.stringify([work.peerId, work.peerKind, work.type, work.command, work.payload,
    work.priority, work.timeoutMs, work.sessionId, work.routeId, work.automationRunId,
    work.automationJobId, work.approvalId]);
}
function releaseAdmission(state: DistributedRuntimeManagerState, id: string): void {
  state.workAdmissions.get(id)?.detach();
  state.workAdmissions.delete(id);
}
function assertAdmission(state: DistributedRuntimeManagerState, work: DistributedPendingWork,
  unclaimed: boolean): DistributedWorkAdmissionOwner | undefined {
  if (work.metadata[ADMISSION_REQUIRED] !== true && !state.workAdmissions.has(work.id)) return;
  const owner = state.workAdmissions.get(work.id);
  if (!owner) throw new Error('Distributed work has no current host admission.');
  const validate = () => {
    const current = state.work.get(work.id);
    const peer = state.peers.get(work.peerId);
    if (state.workAdmissions.get(work.id) !== owner || !current || !['queued', 'claimed'].includes(current.status)
      || (unclaimed && owner.claimed) || (owner.claimed && current.status !== 'claimed')
      || (current.status === 'claimed' && current.leaseExpiresAt !== undefined && current.leaseExpiresAt <= Date.now())
      || owner.requestSignature !== signature(current) || state.peerRevision(work.peerId) !== owner.peerRevision
      || state.peerMutationPending(work.peerId)
      || !peer || peer.status === 'revoked' || peer.activeTokenId !== owner.peerTokenId) {
      throw new Error('Distributed work has no current host admission.');
    }
  };
  validate();
  owner.signal.throwIfAborted(); owner.assertCurrent(); owner.signal.throwIfAborted();
  // A host snapshot guard can itself expire leases and detach this owner.
  validate();
  return owner;
}
function refuseAdmission(state: DistributedRuntimeManagerState, id: string): void {
  releaseAdmission(state, id);
  const current = state.work.get(id);
  if (!current || !['queued', 'claimed'].includes(current.status)) return;
  const cancelled: DistributedPendingWork = { ...current, status: 'cancelled',
    error: 'host-admission-no-longer-current', completedAt: Date.now(), updatedAt: Date.now(), leaseExpiresAt: undefined };
  state.work.set(id, cancelled);
  recordDistributedRuntimeAudit(state, buildAudit('work-cancelled', 'host-admission', { peerId: current.peerId, workId: id, note: cancelled.error }));
  resolveDistributedRuntimeWaiters(state, cancelled);
}
function persistRefusal(state: DistributedRuntimeManagerState): void {
  // An old queued snapshot is also fenced after restart by its persisted marker.
  void persistDistributedRuntime(state).catch(() => logger.warn('Distributed host-admission cancellation could not be persisted.'));
}
/** Read/start boundaries reap authority that cannot survive expiry or restart. */
export function reconcileDistributedWorkAdmissions(state: DistributedRuntimeManagerState): boolean {
  let changed = false;
  for (const [id, owner] of state.workAdmissions) {
    const work = state.work.get(id);
    if (!work || !['queued', 'claimed'].includes(work.status)) releaseAdmission(state, id);
    else if (work.status === 'queued' && owner.claimed) { refuseAdmission(state, id); changed = true; }
  }
  for (const work of state.work.values()) {
    if (work.metadata[ADMISSION_REQUIRED] === true && ['queued', 'claimed'].includes(work.status)
      && !state.workAdmissions.has(work.id)) { refuseAdmission(state, work.id); changed = true; }
  }
  return changed;
}

export async function enqueueDistributedWork(
  state: DistributedRuntimeManagerState,
  input: {
    readonly admission?: DistributedWorkAdmission | undefined;
    readonly peerId: string;
    readonly type?: DistributedWorkType | undefined;
    readonly command: string;
    readonly payload?: unknown | undefined;
    readonly priority?: DistributedWorkPriority | undefined;
    readonly actor?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly automationRunId?: string | undefined;
    readonly automationJobId?: string | undefined;
    readonly approvalId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  },
): Promise<DistributedPendingWork> {
  const originalAdmission = input.admission;
  const admission = originalAdmission ? { signal: originalAdmission.signal,
    assertCurrent: originalAdmission.assertCurrent.bind(originalAdmission), claim: originalAdmission.claim.bind(originalAdmission) } : undefined;
  if (admission && state.peerMutationPending(input.peerId)) throw new Error('Distributed peer mutation is pending.');
  const startingPeerRevision = admission && state.loaded ? state.peerRevision(input.peerId) : undefined;
  // Keep borrowed caller mutation out of the queued action during startup.
  if (admission) { const { admission: _owner, ...data } = input; input = { ...structuredClone(data), admission }; }
  await startDistributedRuntime(state);
  const peer = state.peers.get(input.peerId);
  if (!peer) throw new Error(`Unknown distributed peer: ${input.peerId}`);
  if (peer.status === 'revoked') {
    // A revoked peer holds no usable token, so it could never pull this work.
    throw new DistributedRuntimeRefusalError(
      `Remote peer ${peer.id} is revoked and cannot receive work; rotate its token or pair it again first.`,
      'REMOTE_PEER_REVOKED',
    );
  }
  if (!peer.tokens.some((token) => !token.revokedAt)) {
    // Only a verified device holds a token to pull with.
    throw new DistributedRuntimeRefusalError(
      `Remote peer ${peer.id} has not finished pairing (it holds no access token), so it could never pull this work. Ask the device to verify its pairing request, then send the work again.`,
      'REMOTE_PEER_NOT_PAIRED',
    );
  }
  if (admission) {
    admission.signal.throwIfAborted(); admission.assertCurrent(); admission.signal.throwIfAborted();
    if (startingPeerRevision !== undefined && state.peerRevision(input.peerId) !== startingPeerRevision) throw new Error('Distributed peer changed during admission startup.');
    if (state.peerMutationPending(input.peerId) || state.peers.get(input.peerId)?.status === 'revoked' || reservedAdmissions.has(originalAdmission!)) throw new Error('Distributed work admission is unavailable or already reserved.');
    reservedAdmissions.add(originalAdmission!);
  }
  const now = Date.now();
  const work: DistributedPendingWork = {
    id: `rwork-${randomUUID().slice(0, 8)}`,
    peerId: peer.id,
    peerKind: peer.kind,
    type: input.type ?? 'invoke',
    command: input.command.trim() || 'invoke',
    priority: input.priority ?? 'normal',
    status: 'queued',
    payload: input.payload,
    createdAt: now,
    updatedAt: now,
    queuedBy: input.actor ?? 'operator',
    timeoutMs: input.timeoutMs,
    sessionId: input.sessionId,
    routeId: input.routeId,
    automationRunId: input.automationRunId,
    automationJobId: input.automationJobId,
    approvalId: input.approvalId,
    metadata: { ...(input.metadata ?? {}), ...(admission ? { [ADMISSION_REQUIRED]: true } : {}) },
  };
  if (admission) {
    const abort = () => { refuseAdmission(state, work.id); persistRefusal(state); };
    const owner: DistributedWorkAdmissionOwner = { ...admission, requestSignature: signature(work), peerTokenId: peer.activeTokenId, peerRevision: state.peerRevision(peer.id),
      claimed: false, detach: () => admission.signal.removeEventListener('abort', abort) };
    state.workAdmissions.set(work.id, owner);
    admission.signal.addEventListener('abort', abort, { once: true });
  }
  state.work.set(work.id, work);
  recordDistributedRuntimeAudit(state, buildAudit('work-queued', input.actor ?? 'operator', {
    peerId: peer.id,
    workId: work.id,
    note: `${work.command} -> ${peer.label}`,
  }));
  try {
    if (admission) assertAdmission(state, work, true);
    await bridgeQueuedDistributedWork(state, peer, work);
    await pruneAndPersistDistributedRuntime(state);
    if (admission) {
      admission.signal.throwIfAborted(); admission.assertCurrent();
      const current = state.work.get(work.id)!;
      if (!['completed', 'failed'].includes(current.status)) assertAdmission(state, work, false);
    }
    publishDistributedRuntimeEvent(state, 'remote-work-queued', { peer: sanitizePeer(peer), work });
    if (admission) {
      admission.signal.throwIfAborted(); admission.assertCurrent();
      const current = state.work.get(work.id)!;
      if (!['completed', 'failed'].includes(current.status)) assertAdmission(state, work, false);
    }
    return state.work.get(work.id) ?? work;
  } catch (error) {
    if (admission) { refuseAdmission(state, work.id); await persistDistributedRuntime(state); }
    throw error;
  }
}

export async function invokeDistributedPeer(
  state: DistributedRuntimeManagerState,
  input: {
    readonly admission?: DistributedWorkAdmission | undefined;
    readonly peerId: string;
    /**
     * Work type. Defaults to 'invoke'; a caller with a typed family of its own
     * (e.g. 'device.capability') names it so the peer can route on type rather
     * than on the command string.
     */
    readonly type?: DistributedWorkType | undefined;
    readonly command: string;
    readonly payload?: unknown | undefined;
    readonly priority?: DistributedWorkPriority | undefined;
    readonly actor?: string | undefined;
    readonly waitMs?: number | undefined;
    readonly timeoutMs?: number | undefined;
    readonly sessionId?: string | undefined;
    readonly routeId?: string | undefined;
    readonly automationRunId?: string | undefined;
    readonly automationJobId?: string | undefined;
    readonly approvalId?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    /** The asking client's request: when it goes away, the wait for the result ends. */
    readonly signal?: AbortSignal | undefined;
  },
): Promise<{ work: DistributedPendingWork; completed: boolean }> {
  const work = await enqueueDistributedWork(state, {
    admission: input.admission,
    peerId: input.peerId,
    type: input.type,
    command: input.command,
    payload: input.payload,
    priority: input.priority,
    actor: input.actor,
    timeoutMs: input.timeoutMs,
    sessionId: input.sessionId,
    routeId: input.routeId,
    automationRunId: input.automationRunId,
    automationJobId: input.automationJobId,
    approvalId: input.approvalId,
    metadata: input.metadata,
  });
  if (!input.waitMs || input.waitMs <= 0) {
    return { work, completed: false };
  }
  const settled = await waitForDistributedWork(state, work.id, input.waitMs, input.signal);
  if (!settled && input.admission) {
    refuseAdmission(state, work.id); await persistDistributedRuntime(state);
    return { work: state.work.get(work.id) ?? work, completed: false };
  }
  return {
    work: settled ?? work,
    completed: Boolean(settled && settled.status !== 'queued' && settled.status !== 'claimed'),
  };
}

export async function claimDistributedWork(
  state: DistributedRuntimeManagerState,
  auth: { readonly peer: DistributedPeerRecord; readonly token: { readonly id: string } },
  input: {
    readonly maxItems?: number | undefined;
    readonly leaseMs?: number | undefined;
  } = {},
): Promise<DistributedPendingWork[]> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(auth.peer.id);
  if (!peer) return [];
  const maxItems = Math.min(10, Math.max(1, Math.trunc(input.maxItems ?? 4)));
  const leaseMs = Math.max(5_000, Math.trunc(input.leaseMs ?? 45_000));
  // Work past its deadline expires here, before it can be claimed and offered to the peer.
  // This is the pull's one expiry pass; the write below does not repeat it.
  requeueDistributedExpiredClaims(state);
  let refused = false;
  const queued = sortWork(state.work.values())
    .filter((item) => item.peerId === peer.id && item.status === 'queued')
    .slice(0, maxItems);
  const now = Date.now();
  const claimed: DistributedPendingWork[] = [];
  for (const item of queued) {
    try {
      const owner = assertAdmission(state, item, true);
      // A stale pull cannot acquire fresh work, but genuinely stale owners are reaped first.
      if (owner && owner.peerTokenId !== auth.token.id) continue;
    }
    catch { refuseAdmission(state, item.id); refused = true; continue; }
    const next: DistributedPendingWork = {
      ...item,
      status: 'claimed',
      claimTokenId: auth.token.id,
      claimedAt: now,
      leaseExpiresAt: now + leaseMs,
      updatedAt: now,
      // Kept so a heartbeat can renew the lease by the length the peer asked for.
      metadata: { ...item.metadata, leaseMs },
    };
    state.work.set(item.id, next);
    claimed.push(next);
    recordDistributedRuntimeAudit(state, buildAudit('work-claimed', peer.id, {
      peerId: peer.id,
      workId: item.id,
      note: item.command,
    }));
  }
  // A pull that claimed and refused nothing changed nothing worth writing.
  if (claimed.length > 0 || refused) await persistDistributedRuntime(state);
  if (claimed.length > 0) {
    publishDistributedRuntimeEvent(state, 'remote-work-claimed', {
      peer: sanitizePeer(state.peers.get(peer.id) ?? peer),
      workIds: claimed.map((item) => item.id),
    });
  }
  const delivered: DistributedPendingWork[] = [];
  for (const claimedItem of claimed) {
    // Another call during the write above can settle or requeue a claim; never offer settled work.
    // A heartbeat landing during that await legitimately replaces the record with an extended lease, so
    // work without a host admission is delivered from the stored record while this token still holds it.
    const stored = state.work.get(claimedItem.id);
    const admissionOwned = claimedItem.metadata[ADMISSION_REQUIRED] === true || state.workAdmissions.has(claimedItem.id);
    if (!stored) continue;
    if (admissionOwned ? stored !== claimedItem : (stored.status !== 'claimed' || stored.claimTokenId !== auth.token.id)) continue;
    const item = stored;
    try {
      const owner = assertAdmission(state, item, true);
      if (owner) {
        if (owner.peerTokenId !== auth.token.id) throw new Error('Distributed pull token does not own this admission.');
        if (state.work.get(item.id) !== item) throw new Error('Distributed claim was replaced.');
        owner.claimed = true; // Fence reentrant/duplicate claims before the host callback.
        owner.claim(); assertAdmission(state, item, false);
      }
      delivered.push(item);
    } catch { refuseAdmission(state, item.id); persistRefusal(state); }
  }
  // No awaits after final validation and before returning peer work.
  return delivered.filter(item => {
    if (state.work.get(item.id) !== item) return false;
    try {
      const owner = assertAdmission(state, item, false);
      if (owner && owner.peerTokenId !== auth.token.id) throw new Error('Distributed pull token changed.');
      return true;
    }
    catch { refuseAdmission(state, item.id); persistRefusal(state); return false; }
  });
}

export async function completeDistributedWork(
  state: DistributedRuntimeManagerState,
  auth: { readonly peer: DistributedPeerRecord; readonly token: { readonly id: string } },
  workId: string,
  input: {
    readonly status?: 'completed' | 'failed' | 'cancelled' | undefined;
    readonly result?: unknown | undefined;
    readonly error?: string | undefined;
    readonly telemetry?: AutomationRunTelemetry | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  } = {},
): Promise<DistributedPendingWork | null> {
  await startDistributedRuntime(state);
  const current = state.work.get(workId);
  if (!current || current.peerId !== auth.peer.id) return null;
  if (current.claimTokenId && current.claimTokenId !== auth.token.id) return null;
  if (current.metadata[ADMISSION_REQUIRED] === true || state.workAdmissions.has(workId)) {
    try {
      const owner = assertAdmission(state, current, false);
      if (current.status !== 'claimed' || !owner?.claimed) throw new Error('Host work was not admitted to the peer.');
    } catch { refuseAdmission(state, workId); await persistDistributedRuntime(state); return state.work.get(workId) ?? null; }
  }
  const status = input.status ?? (input.error ? 'failed' : 'completed');
  // A settled record is final: a repeated report, a report on work an operator
  // cancelled, or one that arrives after the work expired leaves it as it is,
  // and none of them reaches the bridges a second time.
  if (!distributedWorkLifecycle.can(current.status, status)) {
    if (current.status !== status) {
      logger.info('Distributed work completion refused', {
        workId,
        reason: refusalReason(distributedWorkLifecycle.check(current.status, status)),
      });
    }
    return current;
  }
  const updated: DistributedPendingWork = {
    ...current,
    status,
    result: input.result,
    error: input.error,
    telemetry: input.telemetry as DistributedPendingWork['telemetry'],
    completedAt: Date.now(),
    updatedAt: Date.now(),
    leaseExpiresAt: undefined,
    metadata: {
      ...current.metadata,
      ...(input.metadata ?? {}),
      ...(current.metadata[ADMISSION_REQUIRED] === true ? { [ADMISSION_REQUIRED]: true } : {}),
    },
  };
  releaseAdmission(state, workId);
  // The record that is stored, published and bridged carries no capture bytes;
  // only the caller waiting on this work gets them, in memory. It is stored
  // naming the bridges it owes, so the persist below makes them durable.
  const recorded = withoutCaptureMedia(updated);
  state.work.set(workId, withOwedDistributedBridges(recorded));
  const peer = state.peers.get(auth.peer.id);
  if (peer) {
    state.peers.set(peer.id, {
      ...peer,
      status: nextDistributedPeerStatus(peer.status, 'connected'),
      lastSeenAt: Date.now(),
      lastConnectedAt: Date.now(),
    });
  }
  const actor = auth.peer.id;
  recordDistributedRuntimeAudit(state, buildAudit(
    status === 'completed' ? 'work-completed' : status === 'failed' ? 'work-failed' : 'work-cancelled',
    actor,
    {
      peerId: auth.peer.id,
      workId,
      note: status === 'completed' ? summarizeValue(recorded.result) || 'no result' : (input.error ?? status),
    },
  ));
  const bridgePeer = state.peers.get(auth.peer.id) ?? standInBridgePeer(auth.peer.id, current.peerKind, Date.now());
  await pruneAndPersistDistributedRuntime(state);
  await bridgeSettledAndRemember(state, bridgePeer, recorded);
  const settled = state.work.get(workId) ?? recorded;
  publishDistributedRuntimeEvent(state, 'remote-work-settled', {
    peer: sanitizePeer(state.peers.get(auth.peer.id) ?? bridgePeer),
    work: settled,
  });
  resolveDistributedRuntimeWaiters(state, updated);
  return settled;
}

/**
 * A device capture's bytes belong to the device service that took them (which
 * applies its own consent and retention). They must not also sit in the work
 * history on disk or ride an event to every control-plane subscriber.
 */
function withoutCaptureMedia(work: DistributedPendingWork): DistributedPendingWork {
  if (work.type !== 'device.capability') return work;
  const result = work.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return work;
  const { mediaBase64, ...rest } = result as Record<string, unknown>;
  if (typeof mediaBase64 !== 'string') return work;
  return { ...work, result: { ...rest, mediaOmitted: true } };
}

export async function cancelDistributedWork(
  state: DistributedRuntimeManagerState,
  workId: string,
  input: {
    readonly actor?: string | undefined;
    readonly reason?: string | undefined;
  } = {},
): Promise<DistributedPendingWork | null> {
  await startDistributedRuntime(state);
  const current = state.work.get(workId);
  if (!current) return null;
  releaseAdmission(state, workId);
  if (!distributedWorkLifecycle.can(current.status, 'cancelled')) {
    return current;
  }
  const updated: DistributedPendingWork = {
    ...current,
    status: 'cancelled',
    error: input.reason ?? current.error ?? 'operator-cancelled',
    completedAt: Date.now(),
    updatedAt: Date.now(),
    leaseExpiresAt: undefined,
  };
  // Stored naming the bridges it owes, so the persist below makes them durable.
  state.work.set(workId, withOwedDistributedBridges(updated));
  recordDistributedRuntimeAudit(state, buildAudit('work-cancelled', input.actor ?? 'operator', {
    peerId: updated.peerId,
    workId,
    note: updated.error,
  }));
  const bridgePeer = state.peers.get(updated.peerId) ?? standInBridgePeer(updated.peerId, updated.peerKind, Date.now());
  await pruneAndPersistDistributedRuntime(state);
  await bridgeSettledAndRemember(state, bridgePeer, updated);
  const settled = state.work.get(workId) ?? updated;
  publishDistributedRuntimeEvent(state, 'remote-work-cancelled', settled);
  resolveDistributedRuntimeWaiters(state, settled);
  return settled;
}
