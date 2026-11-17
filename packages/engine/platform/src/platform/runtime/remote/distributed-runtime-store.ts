import type { PersistentStore } from '../../state/persistent-store.js';
import { summarizeError } from '../../utils/error-display.js';
import { logger } from '../../utils/logger.js';
import type {
  DistributedPendingWork,
  DistributedRuntimeAuditRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  DistributedRuntimeSnapshotStore,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedRuntimeWaiter,
} from './distributed-runtime-types.js';
import {
  normalizeAudit,
  normalizePairRequest,
  normalizePeer,
  normalizeToken,
  normalizeWork,
  sanitizePairRequest,
  sanitizePeer,
  sortPairRequests,
  sortPeers,
  sortWork,
} from './distributed-runtime-utils.js';
import { isRecord } from '../../utils/record-coerce.js';
import { bridgeSettledDistributedWork, type DistributedBridgeName } from './distributed-runtime-bridges.js';
import { distributedWorkLifecycle, nextDistributedPeerStatus } from './distributed-runtime-lifecycles.js';

const MAX_AUDIT = 500;
const MAX_WORK_HISTORY = 500;
const MAX_PAIR_REQUESTS = 250;
/**
 * A peer is presented as connected only while it has been heard from within
 * this window: three missed heartbeats at the contract's recommended 30 s.
 * Every authenticated peer call (heartbeat, pull, complete) refreshes it.
 */
export const DISTRIBUTED_PEER_PRESENCE_WINDOW_MS = 90_000;
/** Lease expiries a unit of work survives before it expires instead of being offered again. */
export const MAX_DISTRIBUTED_WORK_REQUEUES = 5;
const DISTRIBUTED_PEER_KINDS = new Set<DistributedPeerKind>(['node', 'device']);
const PAIR_REQUEST_STATUSES = new Set<DistributedRuntimePairRequest['status']>([
  'pending',
  'approved',
  'verified',
  'rejected',
  'expired',
]);
const PAIR_REQUEST_ACTORS = new Set<DistributedRuntimePairRequest['requestedBy']>(['remote', 'operator']);
const PEER_STATUSES = new Set<DistributedPeerRecord['status']>(['paired', 'connected', 'idle', 'disconnected', 'revoked']);
const WORK_TYPES = new Set<DistributedPendingWork['type']>([
  'invoke',
  'status.request',
  'location.request',
  'session.message',
  'automation.run',
  'device.capability',
]);
const WORK_PRIORITIES = new Set<DistributedPendingWork['priority']>(['default', 'normal', 'high']);
const WORK_STATUSES = new Set<DistributedPendingWork['status']>(['queued', 'claimed', 'completed', 'failed', 'cancelled', 'expired']);
const AUDIT_ACTIONS = new Set<DistributedRuntimeAuditRecord['action']>([
  'pair-requested',
  'pair-approved',
  'pair-rejected',
  'pair-verified',
  'pair-expired',
  'token-rotated',
  'token-revoked',
  'peer-connected',
  'peer-disconnected',
  'work-queued',
  'work-claimed',
  'work-completed',
  'work-failed',
  'work-cancelled',
  'work-expired',
]);


function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidDistributedRuntimeSnapshot(): never {
  throw new Error('Distributed runtime store snapshot is invalid.');
}

function validateOptionalNumber(value: unknown): void {
  if (value !== undefined && !isFiniteNumber(value)) throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalRecord(value: unknown): void {
  if (value !== undefined && !isRecord(value)) throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalStringArray(value: unknown): void {
  if (value !== undefined && !isStringArray(value)) throwInvalidDistributedRuntimeSnapshot();
}

function validateOptionalEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): void {
  if (value !== undefined && (typeof value !== 'string' || !allowed.has(value as T))) throwInvalidDistributedRuntimeSnapshot();
}

function validateDistributedRuntimePairRequest(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['peerKind'], DISTRIBUTED_PEER_KINDS);
  validateOptionalEnum(record['requestedBy'], PAIR_REQUEST_ACTORS);
  validateOptionalEnum(record['status'], PAIR_REQUEST_STATUSES);
  validateOptionalStringArray(record['capabilities']);
  validateOptionalStringArray(record['commands']);
  validateOptionalString(record['challengeHash']);
  validateOptionalNumber(record['createdAt']);
  validateOptionalNumber(record['updatedAt']);
  validateOptionalNumber(record['approvedAt']);
  validateOptionalNumber(record['verifiedAt']);
  validateOptionalNumber(record['rejectedAt']);
  validateOptionalNumber(record['expiresAt']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimePeer(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['kind'], DISTRIBUTED_PEER_KINDS);
  validateOptionalEnum(record['status'], PEER_STATUSES);
  validateOptionalStringArray(record['capabilities']);
  validateOptionalStringArray(record['commands']);
  validateOptionalRecord(record['permissions']);
  validateOptionalNumber(record['pairedAt']);
  validateOptionalNumber(record['verifiedAt']);
  validateOptionalNumber(record['lastSeenAt']);
  validateOptionalNumber(record['lastConnectedAt']);
  validateOptionalNumber(record['lastDisconnectedAt']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimePeerTokens(peer: unknown): void {
  if (!isRecord(peer)) return;
  if (peer['tokens'] === undefined) return;
  if (!Array.isArray(peer['tokens'])) throwInvalidDistributedRuntimeSnapshot();
  for (const token of peer['tokens']) {
    if (isRecord(token)) validateOptionalStringArray(token['scopes']);
    if (!normalizeToken(token)) throwInvalidDistributedRuntimeSnapshot();
  }
}

function validateDistributedRuntimeWork(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['peerKind'], DISTRIBUTED_PEER_KINDS);
  validateOptionalEnum(record['type'], WORK_TYPES);
  validateOptionalEnum(record['priority'], WORK_PRIORITIES);
  validateOptionalEnum(record['status'], WORK_STATUSES);
  validateOptionalNumber(record['createdAt']);
  validateOptionalNumber(record['updatedAt']);
  validateOptionalNumber(record['claimedAt']);
  validateOptionalNumber(record['leaseExpiresAt']);
  validateOptionalNumber(record['completedAt']);
  validateOptionalNumber(record['timeoutMs']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimeAudit(record: unknown): void {
  if (!isRecord(record)) return;
  validateOptionalEnum(record['action'], AUDIT_ACTIONS);
  validateOptionalNumber(record['createdAt']);
  validateOptionalRecord(record['metadata']);
}

function validateDistributedRuntimeSnapshot(snapshot: DistributedRuntimeSnapshotStore | null): DistributedRuntimeSnapshotStore | null {
  if (!snapshot) return null;
  if (
    !isRecord(snapshot)
    || !Array.isArray(snapshot.pairRequests)
    || !Array.isArray(snapshot.peers)
    || !Array.isArray(snapshot.work)
    || !Array.isArray(snapshot.audit)
  ) {
    throwInvalidDistributedRuntimeSnapshot();
  }
  const check = (section: string, records: readonly unknown[], validate: (record: unknown) => void): void => {
    records.forEach((record, index) => {
      try { validate(record); } catch { throw new Error(`Distributed runtime store snapshot is invalid at ${section}[${index}].`); }
    });
  };
  check('pairRequests', snapshot.pairRequests, (request) => {
    validateDistributedRuntimePairRequest(request);
    requireDistributedRuntimeRecord(normalizePairRequest(request));
  });
  check('peers', snapshot.peers, (peer) => {
    validateDistributedRuntimePeer(peer);
    validateDistributedRuntimePeerTokens(peer);
    requireDistributedRuntimeRecord(normalizePeer(peer));
  });
  check('work', snapshot.work, (item) => {
    validateDistributedRuntimeWork(item);
    requireDistributedRuntimeRecord(normalizeWork(item));
  });
  check('audit', snapshot.audit, (record) => {
    validateDistributedRuntimeAudit(record);
    requireDistributedRuntimeRecord(normalizeAudit(record));
  });
  return snapshot;
}

function requireDistributedRuntimeRecord<T>(record: T | null): T {
  if (!record) throwInvalidDistributedRuntimeSnapshot();
  return record;
}

export function attachDistributedRuntime(
  state: DistributedRuntimeManagerState,
  input: {
    readonly sessionBridge?: DistributedRuntimeManagerState['sessionBridge'] | undefined;
    readonly approvalBridge?: DistributedRuntimeManagerState['approvalBridge'] | undefined;
    readonly automationBridge?: DistributedRuntimeManagerState['automationBridge'] | undefined;
    readonly eventPublisher?: DistributedRuntimeManagerState['eventPublisher'] | undefined;
  },
): void {
  if (input.sessionBridge) state.sessionBridge = input.sessionBridge;
  if (input.approvalBridge) state.approvalBridge = input.approvalBridge;
  if (input.automationBridge) state.automationBridge = input.automationBridge;
  if (input.eventPublisher) state.eventPublisher = input.eventPublisher;
  if (state.loaded) retryPendingDistributedBridgesInBackground(state);
}

// A second caller that arrives while the first load is awaiting the store
// joins it; starting again would clear the maps the first load is filling.
const starting = new WeakMap<DistributedRuntimeManagerState, Promise<void>>();

export async function startDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  if (state.loaded) return;
  const inFlight = starting.get(state);
  if (inFlight) return inFlight;
  const load = loadDistributedRuntime(state).finally(() => { starting.delete(state); });
  starting.set(state, load);
  return load;
}

async function loadDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  const loaded = await state.store.load();
  let snapshot: DistributedRuntimeSnapshotStore | null;
  try {
    snapshot = validateDistributedRuntimeSnapshot(loaded);
  } catch (error) {
    // The store keeps its path private; its lock path is the path plus a suffix.
    const file = state.store.lockPath?.replace(/\.lock$/, '');
    throw new Error(`${summarizeError(error)}${file ? ` Remove or repair ${file} to start the remote runtime again.` : ''}`);
  }
  state.pairRequests.clear();
  state.peers.clear();
  state.work.clear();
  state.audit.length = 0;
  for (const request of snapshot?.pairRequests ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizePairRequest(request));
    state.pairRequests.set(normalized.id, normalized);
  }
  for (const peer of snapshot?.peers ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizePeer(peer));
    // Earlier versions stored a peer when a request was approved, and a stand-in
    // peer when work settled for one that was gone. A peer that never received a
    // token never verified and can never pull; a later verification creates it.
    if (normalized.tokens.length === 0 && normalized.verifiedAt === undefined) continue;
    state.peers.set(normalized.id, normalized);
  }
  for (const item of snapshot?.work ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizeWork(item));
    state.work.set(normalized.id, normalized);
  }
  for (const record of snapshot?.audit ?? []) {
    const normalized = requireDistributedRuntimeRecord(normalizeAudit(record));
    state.audit.push(normalized);
  }
  state.loaded = true;
  await pruneAndPersistDistributedRuntime(state);
  retryPendingDistributedBridgesInBackground(state);
}

export function listDistributedRuntimePairRequests(
  state: DistributedRuntimeManagerState,
  limit = 100,
): DistributedRuntimePairRequest[] {
  expireDistributedPairRequests(state);
  return sortPairRequests(state.pairRequests.values()).slice(0, Math.max(1, limit)).map(sanitizePairRequest);
}

export function listDistributedRuntimePeers(
  state: DistributedRuntimeManagerState,
  kind?: DistributedPeerKind,
  limit = 200,
): DistributedPeerRecord[] {
  const now = Date.now();
  return sortPeers(state.peers.values())
    .filter((peer) => !kind || peer.kind === kind)
    .slice(0, Math.max(1, limit))
    .map((peer) => presentPeer(sanitizePeer(peer), now));
}

/** One peer as the list presents it, or null when no peer has that id. */
export function getDistributedRuntimePeer(state: DistributedRuntimeManagerState, peerId: string): DistributedPeerRecord | null {
  const peer = state.peers.get(peerId);
  return peer ? presentPeer(sanitizePeer(peer), Date.now()) : null;
}

/**
 * `connected` is stored when a peer calls in and nothing stores its absence,
 * so a peer that silently went away would read as connected forever. Read it
 * against the last contact instead. Only the presented record changes; the
 * stored status, and every authority check made on it, stay as they are.
 */
function presentPeer(peer: DistributedPeerRecord, now: number): DistributedPeerRecord {
  if (peer.status !== 'connected') return peer;
  if (peer.lastSeenAt !== undefined && now - peer.lastSeenAt <= DISTRIBUTED_PEER_PRESENCE_WINDOW_MS) return peer;
  return { ...peer, status: 'disconnected' };
}

export function listDistributedRuntimeWork(
  state: DistributedRuntimeManagerState,
  limit = 200,
  peerId?: string,
): DistributedPendingWork[] {
  requeueDistributedExpiredClaims(state);
  return sortWork(state.work.values())
    .filter((item) => !peerId || item.peerId === peerId)
    .slice(0, Math.max(1, limit));
}

export function listDistributedRuntimeAudit(
  state: DistributedRuntimeManagerState,
  limit = 100,
): DistributedRuntimeAuditRecord[] {
  return state.audit.slice(0, Math.max(1, limit));
}

export function getDistributedRuntimeSnapshot(state: DistributedRuntimeManagerState): Record<string, unknown> {
  expireDistributedPairRequests(state);
  requeueDistributedExpiredClaims(state);
  return {
    pairRequests: listDistributedRuntimePairRequests(state, 100),
    peers: listDistributedRuntimePeers(state, undefined, 500),
    work: listDistributedRuntimeWork(state, 500),
    audit: listDistributedRuntimeAudit(state, 100),
  };
}

export function publishDistributedRuntimeEvent(state: DistributedRuntimeManagerState, event: string, payload: unknown): void {
  state.eventPublisher?.(event, payload);
}

export function recordDistributedRuntimeAudit(
  state: DistributedRuntimeManagerState,
  record: DistributedRuntimeAuditRecord,
): void {
  state.audit.unshift(record);
  if (state.audit.length > MAX_AUDIT) {
    state.audit.length = MAX_AUDIT;
  }
}

export function expireDistributedPairRequests(state: DistributedRuntimeManagerState, now = Date.now()): void {
  let changed = false;
  for (const [requestId, request] of state.pairRequests.entries()) {
    if (request.status === 'pending' || request.status === 'approved') {
      if (request.expiresAt <= now) {
        state.pairRequests.set(requestId, {
          ...request,
          status: 'expired',
          updatedAt: now,
        });
        recordDistributedRuntimeAudit(state, {
          id: `drt-audit-${requestId}-${now}`,
          action: 'pair-expired',
          actor: 'distributed-runtime',
          requestId,
          createdAt: now,
          note: request.label,
          metadata: {},
        });
        changed = true;
      }
    }
  }
  if (changed) {
    persistDistributedRuntimeAsync(state, 'expired pair cleanup');
  }
}

function readRequeueCount(item: DistributedPendingWork): number {
  const value = item.metadata['leaseRequeues'];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Time-driven moves on the work queue: a claim whose lease ran out goes back
 * to the queue, and work that has outlived its `timeoutMs` (counted from when
 * it was queued) or lost its lease too many times expires. Expiry settles the
 * work like any other final state: waiters wake and the bridges hear of it.
 */
export function requeueDistributedExpiredClaims(state: DistributedRuntimeManagerState, now = Date.now()): void {
  let changed = false;
  const expired: DistributedPendingWork[] = [];
  for (const [workId, item] of state.work.entries()) {
    if (item.status !== 'queued' && item.status !== 'claimed') continue;
    const deadlinePassed = item.timeoutMs !== undefined && item.timeoutMs > 0 && item.createdAt + item.timeoutMs <= now;
    const leaseLapsed = item.status === 'claimed' && item.leaseExpiresAt !== undefined && item.leaseExpiresAt <= now;
    if (!deadlinePassed && !leaseLapsed) continue;
    const requeues = readRequeueCount(item) + (leaseLapsed ? 1 : 0);
    if (deadlinePassed || requeues > MAX_DISTRIBUTED_WORK_REQUEUES) {
      if (!distributedWorkLifecycle.can(item.status, 'expired')) continue;
      const settled: DistributedPendingWork = {
        ...item,
        status: 'expired',
        error: deadlinePassed
          ? `Remote work was not completed within its ${item.timeoutMs}ms timeout.`
          : `Remote work lost its lease ${requeues} times without being completed; it was not offered again.`,
        completedAt: now,
        updatedAt: now,
        leaseExpiresAt: undefined,
        metadata: { ...item.metadata, leaseRequeues: requeues },
      };
      state.work.set(workId, settled);
      state.workAdmissions.get(workId)?.detach();
      state.workAdmissions.delete(workId);
      expired.push(settled);
    } else {
      state.work.set(workId, {
        ...item,
        status: 'queued',
        claimTokenId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now,
        metadata: {
          ...item.metadata,
          lastLeaseExpiryAt: now,
          leaseRequeues: requeues,
        },
      });
    }
    recordDistributedRuntimeAudit(state, {
      id: `drt-audit-${workId}-${now}`,
      action: 'work-expired',
      actor: 'distributed-runtime',
      peerId: item.peerId,
      workId,
      createdAt: now,
      note: item.command,
      metadata: {},
    });
    const peer = state.peers.get(item.peerId);
    // A lapsed lease counts as the peer going away (a heartbeat renews the
    // leases of a peer that is still working), but never un-revokes it.
    if (leaseLapsed && peer) {
      state.peers.set(peer.id, {
        ...peer,
        status: nextDistributedPeerStatus(peer.status, 'disconnected'),
        lastSeenAt: now,
        lastDisconnectedAt: now,
      });
    }
    changed = true;
  }
  if (changed) {
    persistDistributedRuntimeAsync(state, 'expired work requeue');
  }
  for (const work of expired) settleExpiredWork(state, work);
}

function settleExpiredWork(state: DistributedRuntimeManagerState, work: DistributedPendingWork): void {
  const peer = state.peers.get(work.peerId);
  publishDistributedRuntimeEvent(state, 'remote-work-settled', { peer: peer ? sanitizePeer(peer) : null, work });
  resolveDistributedRuntimeWaiters(state, work);
  if (peer) void bridgeSettledAndRemember(state, sanitizePeer(peer), work);
}

const BRIDGE_PENDING = 'bridgePending';
const BRIDGE_NAMES: ReadonlyArray<DistributedBridgeName> = ['session', 'approval', 'automation'];

function readBridgePending(work: DistributedPendingWork): DistributedBridgeName[] {
  const value = work.metadata[BRIDGE_PENDING];
  return Array.isArray(value) ? BRIDGE_NAMES.filter((name) => value.includes(name)) : [];
}

/**
 * Tell the bridges that work settled. A bridge that could not deliver is recorded on the stored
 * work (`metadata.bridgePending`) so the next start delivers it again, instead of the session,
 * approval or automation run staying unaware of a result the work record already holds.
 * A retry (`only`) also keeps a bridge that is still not attached.
 */
export async function bridgeSettledAndRemember(
  state: DistributedRuntimeManagerState,
  peer: DistributedPeerRecord,
  work: DistributedPendingWork,
  only?: ReadonlyArray<DistributedBridgeName>,
): Promise<void> {
  const report = await bridgeSettledDistributedWork(state, peer, work, only);
  const stored = state.work.get(work.id);
  if (!stored) return;
  const pending = BRIDGE_NAMES.filter((name) => report.failed.includes(name) || report.absent.includes(name));
  const before = readBridgePending(stored);
  if (pending.length === before.length && pending.every((name, index) => name === before[index])) return;
  const { [BRIDGE_PENDING]: _previous, ...rest } = stored.metadata;
  state.work.set(work.id, { ...stored, metadata: pending.length > 0 ? { ...rest, [BRIDGE_PENDING]: pending } : rest });
  try {
    await persistDistributedRuntime(state);
  } catch (error) {
    logger.warn('Distributed runtime bridge retry marker was not saved', { workId: work.id, error: summarizeError(error) });
  }
}

const retrying = new WeakSet<DistributedRuntimeManagerState>();

/** Deliver again the settled work whose bridges failed (or were not attached) the last time. */
export async function retryPendingDistributedBridges(state: DistributedRuntimeManagerState): Promise<void> {
  if (!state.loaded || retrying.has(state)) return;
  retrying.add(state);
  try {
    for (const work of [...state.work.values()]) {
      if (work.status === 'queued' || work.status === 'claimed') continue;
      const pending = readBridgePending(work);
      if (pending.length === 0) continue;
      const peer = state.peers.get(work.peerId);
      const bridgePeer = sanitizePeer(peer ?? {
        id: work.peerId, kind: work.peerKind, label: work.peerId, requestedId: work.peerId,
        capabilities: [], commands: [], permissions: undefined, status: 'idle', pairedAt: work.createdAt, tokens: [], metadata: {},
      });
      await bridgeSettledAndRemember(state, bridgePeer, work, pending);
    }
  } finally {
    retrying.delete(state);
  }
}

function retryPendingDistributedBridgesInBackground(state: DistributedRuntimeManagerState): void {
  void retryPendingDistributedBridges(state).catch((error: unknown) => {
    logger.warn('Distributed runtime bridge retry failed', { error: summarizeError(error) });
  });
}

function persistDistributedRuntimeAsync(state: DistributedRuntimeManagerState, reason: string): void {
  void persistDistributedRuntime(state).catch((error: unknown) => {
    logger.warn('Distributed runtime state persistence failed', {
      reason,
      error: summarizeError(error),
    });
  });
}

export async function waitForDistributedWork(
  state: DistributedRuntimeManagerState,
  workId: string,
  timeoutMs: number,
): Promise<DistributedPendingWork | null> {
  const existing = state.work.get(workId);
  if (existing && existing.status !== 'queued' && existing.status !== 'claimed') {
    return existing;
  }
  return await new Promise<DistributedPendingWork | null>((resolve) => {
    const timer = setTimeout(() => {
      removeDistributedRuntimeWaiter(state, workId, resolve);
      resolve(null);
    }, timeoutMs);
    timer.unref?.();
    const bucket = state.waiters.get(workId) ?? [];
    bucket.push({ resolve, timer });
    state.waiters.set(workId, bucket);
  });
}

export function resolveDistributedRuntimeWaiters(state: DistributedRuntimeManagerState, work: DistributedPendingWork): void {
  const bucket = state.waiters.get(work.id);
  if (!bucket) return;
  state.waiters.delete(work.id);
  for (const waiter of bucket) {
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.resolve(work);
  }
}

export function removeDistributedRuntimeWaiter(
  state: DistributedRuntimeManagerState,
  workId: string,
  resolve: DistributedRuntimeWaiter['resolve'],
): void {
  const bucket = state.waiters.get(workId);
  if (!bucket) return;
  const next = bucket.filter((waiter) => waiter.resolve !== resolve);
  if (next.length === 0) state.waiters.delete(workId);
  else state.waiters.set(workId, next);
}

export async function pruneAndPersistDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  expireDistributedPairRequests(state);
  requeueDistributedExpiredClaims(state);
  // Settled requests go first, then pending ones; an approved request is what a
  // device is about to verify, so a flood of new requests must not displace it.
  const pairRequestRank = (status: DistributedRuntimePairRequest['status']): number =>
    status === 'approved' ? 2 : status === 'pending' ? 1 : 0;
  const pairRequests = sortPairRequests(state.pairRequests.values())
    .sort((a, b) => pairRequestRank(b.status) - pairRequestRank(a.status));
  for (const request of pairRequests.slice(MAX_PAIR_REQUESTS)) {
    state.pairRequests.delete(request.id);
  }
  const work = sortWork(state.work.values());
  const keep = new Set(
    work
      .filter((item) => item.status === 'queued' || item.status === 'claimed')
      .concat(work.filter((item) => item.status !== 'queued' && item.status !== 'claimed').slice(0, MAX_WORK_HISTORY))
      .map((item) => item.id),
  );
  for (const workId of [...state.work.keys()]) {
    if (!keep.has(workId)) state.work.delete(workId);
  }
  await persistDistributedRuntime(state);
}

/**
 * Write the whole distributed-runtime state as it stands at THIS call, after
 * every write already queued has finished.
 *
 * `PersistentStore.persist` is atomic but unordered, and this store is written
 * from three directions at once: awaited writes at the end of every pairing and
 * work verb, and two UNAWAITED ones, `expireDistributedPairRequests` and
 * `requeueDistributedExpiredClaims` both fire `persistDistributedRuntimeAsync`,
 * and both are reached from ordinary list/read calls, so a plain `GET` starts a
 * background write. Unordered, that background write's rename could land after
 * a verb's and put its older view back on disk: a pair request rejected or
 * revoked seconds earlier reads back as 'pending', which is a peer somebody
 * turned away still able to complete pairing; and a completed unit of work
 * reads back as 'queued', which is that work dispatched to a peer a second time.
 *
 * The snapshot is still built here, synchronously, every caller mutates the
 * maps and then persists, so each snapshot is at least as new as the one queued
 * before it.
 */
export async function persistDistributedRuntime(state: DistributedRuntimeManagerState): Promise<void> {
  const snapshot = {
    pairRequests: [...state.pairRequests.values()],
    peers: [...state.peers.values()],
    work: [...state.work.values()],
    audit: [...state.audit],
  };
  await state.writes.run(() => state.store.persist(snapshot));
  state.writtenLeases.clear();
  for (const item of snapshot.work) {
    if (item.status === 'claimed' && item.leaseExpiresAt !== undefined) state.writtenLeases.set(item.id, item.leaseExpiresAt);
  }
}
