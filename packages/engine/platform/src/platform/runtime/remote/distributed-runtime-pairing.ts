import { randomUUID } from 'node:crypto';
import { defineLifecycle } from '../../utils/lifecycle-machine.js';
import type {
  DistributedPairRequestStatus,
  DistributedPeerAuth,
  DistributedPeerKind,
  DistributedPeerRecord,
  DistributedPeerTokenRecord,
  DistributedRuntimeManagerState,
  DistributedRuntimePairRequest,
  StoredPairRequest,
  StoredPeerRecord,
  StoredPeerTokenRecord,
} from './distributed-runtime-types.js';
import {
  buildAudit,
  createSecretMatcher,
  fingerprint,
  hashSecret,
  matchesSecret,
  randomSecret,
  sanitizePairRequest,
  sanitizePeer,
  sanitizeToken,
} from './distributed-runtime-utils.js';
import {
  DISTRIBUTED_PEER_PRESENCE_WINDOW_MS,
  expireDistributedPairRequests,
  pruneAndPersistDistributedRuntime,
  publishDistributedRuntimeEvent,
  recordDistributedRuntimeAudit,
  startDistributedRuntime,
} from './distributed-runtime-store.js';
import { DistributedRuntimeRefusalError, nextDistributedPeerStatus, refusalReason } from './distributed-runtime-lifecycles.js';

export async function requestDistributedPairing(
  state: DistributedRuntimeManagerState,
  input: {
    readonly peerKind: DistributedPeerKind;
    readonly requestedId?: string | undefined;
    readonly label: string;
    readonly platform?: string | undefined;
    readonly deviceFamily?: string | undefined;
    readonly version?: string | undefined;
    readonly clientMode?: string | undefined;
    readonly capabilities?: readonly string[] | undefined;
    readonly commands?: readonly string[] | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    readonly requestedBy?: 'remote' | 'operator' | undefined;
    readonly remoteAddress?: string | undefined;
    readonly ttlMs?: number | undefined;
  },
): Promise<{ request: DistributedRuntimePairRequest; challenge: string }> {
  await startDistributedRuntime(state);
  const now = Date.now();
  const challenge = randomSecret('gvpair');
  const requestedId = input.requestedId?.trim() || `${input.peerKind}-${randomUUID().slice(0, 8)}`;
  // Anyone can name an existing peer's id; the operator is told before approving.
  const replacesPeer = [...state.peers.values()].find((peer) => peer.requestedId === requestedId);
  const request: StoredPairRequest = {
    id: `pair-${randomUUID().slice(0, 8)}`,
    peerKind: input.peerKind,
    requestedId,
    ...(replacesPeer ? { replacesPeerId: replacesPeer.id } : {}),
    label: input.label.trim() || `${input.peerKind} peer`,
    platform: input.platform,
    deviceFamily: input.deviceFamily,
    version: input.version,
    clientMode: input.clientMode,
    capabilities: [...(input.capabilities ?? [])],
    commands: [...(input.commands ?? [])],
    requestedBy: input.requestedBy ?? 'remote',
    status: 'pending',
    challengePreview: fingerprint(challenge),
    challengeHash: hashSecret(challenge),
    createdAt: now,
    updatedAt: now,
    expiresAt: now + Math.max(30_000, Math.trunc(input.ttlMs ?? 10 * 60_000)),
    remoteAddress: input.remoteAddress,
    metadata: input.metadata ?? {},
  };
  state.pairRequests.set(request.id, request);
  recordDistributedRuntimeAudit(state, buildAudit('pair-requested', input.requestedBy ?? 'remote', {
    requestId: request.id,
    note: `${request.peerKind}:${request.label}`,
    metadata: request.metadata,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-requested', sanitizePairRequest(request));
  return { request: sanitizePairRequest(request), challenge };
}

/**
 * The pair-request lifecycle, from the moves in this file and the store:
 * approve (pending -> approved), verify (approved -> verified), reject
 * (pending | approved -> rejected), expiry (pending | approved -> expired).
 * Verified, rejected and expired are final.
 */
export const pairRequestLifecycle = defineLifecycle<DistributedPairRequestStatus>('pair request', {
  pending: ['approved', 'rejected', 'expired'],
  approved: ['verified', 'rejected', 'expired'],
  verified: [],
  rejected: [],
  expired: [],
});

export async function approveDistributedPairRequest(
  state: DistributedRuntimeManagerState,
  requestId: string,
  input: {
    readonly actor?: string | undefined;
    readonly note?: string | undefined;
    readonly label?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
    /** Required when the request names an existing peer: verifying it replaces that peer's fields and tokens. */
    readonly confirmReplace?: boolean | undefined;
  } = {},
): Promise<{ request: DistributedRuntimePairRequest; peer: DistributedPeerRecord } | null> {
  await startDistributedRuntime(state);
  if (!state.pairRequests.has(requestId)) return null;
  expireDistributedPairRequests(state);
  // Expiry replaces the stored record, so read it again after expiring.
  const request = state.pairRequests.get(requestId);
  if (!request) return null;
  if (request.status === 'verified') {
    // Approving again is idempotent: the device already holds its peer.
    const held = findPeerForRequest(state, request);
    if (held) return { request: sanitizePairRequest(request), peer: sanitizePeer(applyOperatorEdits(state, held, input.label, input.metadata)) };
  }
  if (request.status !== 'approved' && !pairRequestLifecycle.can(request.status, 'approved')) {
    // A rejected or expired request gets no peer: the device could never
    // verify it, and the operator must not be told it was approved.
    throw new DistributedRuntimeRefusalError(
      `${refusalReason(pairRequestLifecycle.check(request.status, 'approved'))}. Ask the device to request pairing again.`,
      'REMOTE_PAIR_REQUEST_SETTLED',
    );
  }
  // Only a peer that verified exists: approval creates nothing, so a request
  // that expires or is rejected leaves no peer behind.
  const replaces = [...state.peers.values()].find((peer) => peer.requestedId === request.requestedId);
  if (replaces && request.status !== 'approved' && !input.confirmReplace) {
    throw new DistributedRuntimeRefusalError(
      `This request names the existing peer ${replaces.id} (${replaces.label}). Verifying it replaces that peer's capabilities, commands and tokens. Approve again with confirmReplace: true only if this is the same device re-pairing.`,
      'REMOTE_PAIR_REPLACES_PEER',
    );
  }
  // The operator's label and metadata apply to a peer that already exists; for
  // a new device they are kept on the request and the peer is created from it
  // when the device verifies, under the id returned here.
  const peer = replaces
    ? applyOperatorEdits(state, replaces, input.label, input.metadata)
    : peerFromRequest(request, request.peerId ?? newPeerId(request.peerKind), input.label, input.metadata);
  const updated: StoredPairRequest = {
    ...request,
    status: 'approved',
    approvedAt: request.approvedAt ?? Date.now(),
    updatedAt: Date.now(),
    peerId: peer.id,
    ...(!replaces && input.label?.trim() ? { label: input.label.trim() } : {}),
    ...(replaces ? { replacesPeerId: replaces.id } : {}),
    metadata: {
      ...request.metadata,
      ...(input.metadata ?? {}),
    },
  };
  state.pairRequests.set(requestId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('pair-approved', input.actor ?? 'operator', {
    requestId,
    peerId: peer.id,
    note: replaces
      ? `${input.note ?? peer.label} (the device named an existing peer, ${replaces.id}; its fields and tokens change only when the device verifies)`
      : input.note ?? peer.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-approved', {
    request: sanitizePairRequest(updated),
    peer: sanitizePeer(peer),
  });
  return { request: sanitizePairRequest(updated), peer: sanitizePeer(peer) };
}

export async function rejectDistributedPairRequest(
  state: DistributedRuntimeManagerState,
  requestId: string,
  input: {
    readonly actor?: string | undefined;
    readonly note?: string | undefined;
  } = {},
): Promise<DistributedRuntimePairRequest | null> {
  await startDistributedRuntime(state);
  const request = state.pairRequests.get(requestId);
  if (!request) return null;
  expireDistributedPairRequests(state);
  const current = state.pairRequests.get(requestId) ?? request;
  // Same contract as approve on a settled request: hand back the record as it
  // truly is (verified, expired, already rejected) instead of overwriting it.
  if (!pairRequestLifecycle.can(current.status, 'rejected')) return sanitizePairRequest(current);
  const updated: StoredPairRequest = {
    ...current,
    status: 'rejected',
    rejectedAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.pairRequests.set(requestId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('pair-rejected', input.actor ?? 'operator', {
    requestId,
    note: input.note ?? updated.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-pair-rejected', sanitizePairRequest(updated));
  return sanitizePairRequest(updated);
}

export async function verifyDistributedPairRequest(
  state: DistributedRuntimeManagerState,
  requestId: string,
  challenge: string,
  input: {
    readonly remoteAddress?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  } = {},
): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
  await startDistributedRuntime(state);
  expireDistributedPairRequests(state);
  const request = state.pairRequests.get(requestId);
  if (!request) return null;
  if (!matchesSecret(challenge, request.challengeHash)) return null;
  // Pending keeps answering "not yet" (null) so a device can poll until the
  // operator decides. A request that can no longer be verified says why, to
  // the holder of its challenge only, so the device stops polling.
  if (request.status === 'pending') return null;
  if (request.status !== 'approved') {
    throw new DistributedRuntimeRefusalError(
      `${refusalReason(pairRequestLifecycle.check(request.status, 'verified'))}. Request pairing again.`,
      'REMOTE_PAIR_REQUEST_SETTLED',
      410,
    );
  }
  const peerBefore = findPeerForRequest(state, request);
  const peer = ensurePeerFromRequest(state, request, input.metadata);
  const issued = issueToken(state, peer.id, 'pair-verified-token');
  const verifiedRequest: StoredPairRequest = {
    ...request,
    status: 'verified',
    verifiedAt: Date.now(),
    updatedAt: Date.now(),
    peerId: peer.id,
    remoteAddress: input.remoteAddress ?? request.remoteAddress,
    metadata: {
      ...request.metadata,
      ...(input.metadata ?? {}),
    },
  };
  state.pairRequests.set(requestId, verifiedRequest);
  const connectedPeer = updatePeerConnectionState(state, peer.id, 'connected', {
    remoteAddress: input.remoteAddress,
  }) ?? peer;
  recordDistributedRuntimeAudit(state, buildAudit('pair-verified', 'remote-peer', {
    requestId,
    peerId: peer.id,
    note: connectedPeer.label,
  }));
  try {
    await pruneAndPersistDistributedRuntime(state);
  } catch (error) {
    // Disk still holds the approved request and the old tokens; memory must too,
    // or the device's retry would be refused as already verified.
    state.pairRequests.set(requestId, request);
    if (peerBefore) state.peers.set(peerBefore.id, peerBefore);
    else state.peers.delete(peer.id);
    throw error;
  }
  publishDistributedRuntimeEvent(state, 'remote-pair-verified', {
    request: sanitizePairRequest(verifiedRequest),
    peer: sanitizePeer(connectedPeer),
  });
  return {
    peer: sanitizePeer(connectedPeer),
    token: {
      ...sanitizeToken(issued.token),
      value: issued.value,
    },
  };
}

export async function rotateDistributedPeerToken(
  state: DistributedRuntimeManagerState,
  peerId: string,
  input: {
    readonly actor?: string | undefined;
    readonly label?: string | undefined;
    readonly scopes?: readonly string[] | undefined;
  } = {},
): Promise<{ peer: DistributedPeerRecord; token: DistributedPeerTokenRecord & { value: string } } | null> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(peerId);
  if (!peer) return null;
  const issued = issueToken(state, peerId, input.label ?? 'rotated-access-token', input.scopes);
  recordDistributedRuntimeAudit(state, buildAudit('token-rotated', input.actor ?? 'operator', {
    peerId,
    note: issued.token.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  const updatedPeer = state.peers.get(peerId)!;
  publishDistributedRuntimeEvent(state, 'remote-token-rotated', {
    peer: sanitizePeer(updatedPeer),
    tokenId: issued.token.id,
  });
  return {
    peer: sanitizePeer(updatedPeer),
    token: {
      ...sanitizeToken(issued.token),
      value: issued.value,
    },
  };
}

export async function revokeDistributedPeerToken(
  state: DistributedRuntimeManagerState,
  peerId: string,
  input: {
    readonly actor?: string | undefined;
    readonly tokenId?: string | undefined;
    readonly note?: string | undefined;
  } = {},
): Promise<DistributedPeerRecord | null> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(peerId);
  if (!peer) return null;
  const now = Date.now();
  let changed = false;
  const nextTokens = peer.tokens.map((token) => {
    if (input.tokenId && token.id !== input.tokenId) return token;
    if (token.revokedAt) return token;
    changed = true;
    return {
      ...token,
      revokedAt: now,
    };
  });
  if (!changed) return sanitizePeer(peer);
  const activeToken = nextTokens.find((token) => !token.revokedAt && token.id !== input.tokenId) ?? null;
  const updated: StoredPeerRecord = {
    ...peer,
    status: activeToken ? peer.status : 'revoked',
    activeTokenId: activeToken?.id,
    tokens: nextTokens,
  };
  state.peers.set(peerId, updated);
  recordDistributedRuntimeAudit(state, buildAudit('token-revoked', input.actor ?? 'operator', {
    peerId,
    note: input.note ?? input.tokenId ?? updated.label,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-token-revoked', { peer: sanitizePeer(updated), tokenId: input.tokenId ?? null });
  return sanitizePeer(updated);
}

/**
 * Marks the peer disconnected and requeues its claimed work. Its tokens stay
 * valid, so its next authenticated call connects it again; revoke the token to
 * keep it out.
 */
export async function disconnectDistributedPeer(
  state: DistributedRuntimeManagerState,
  peerId: string,
  input: {
    readonly actor?: string | undefined;
    readonly note?: string | undefined;
    readonly requeueClaimedWork?: boolean | undefined;
  } = {},
): Promise<DistributedPeerRecord | null> {
  await startDistributedRuntime(state);
  const peer = updatePeerConnectionState(state, peerId, 'disconnected');
  if (!peer) return null;
  if (input.requeueClaimedWork !== false) {
    for (const item of state.work.values()) {
      if (item.peerId !== peerId || item.status !== 'claimed') continue;
      state.work.set(item.id, {
        ...item,
        status: 'queued',
        claimTokenId: undefined,
        claimedAt: undefined,
        leaseExpiresAt: undefined,
        updatedAt: Date.now(),
        metadata: {
          ...item.metadata,
          requeuedReason: input.note ?? 'peer-disconnected',
        },
      });
    }
  }
  recordDistributedRuntimeAudit(state, buildAudit('peer-disconnected', input.actor ?? 'operator', {
    peerId,
    note: `${input.note ?? peer.label} (tokens stay valid; the peer reconnects on its next authenticated call unless a token is revoked)`,
  }));
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-peer-disconnected', sanitizePeer(peer));
  return sanitizePeer(peer);
}

export async function authenticateDistributedPeerToken(
  state: DistributedRuntimeManagerState,
  tokenValue: string,
  remoteAddress?: string,
): Promise<DistributedPeerAuth | null> {
  await startDistributedRuntime(state);
  if (!tokenValue.trim()) return null;
  const matches = createSecretMatcher(tokenValue);
  for (const peer of state.peers.values()) {
    for (const token of peer.tokens) {
      if (token.revokedAt) continue;
      if (!matches(token.secretHash)) continue;
      const now = Date.now();
      const updatedToken: StoredPeerTokenRecord = {
        ...token,
        lastUsedAt: now,
      };
      const updatedPeer: StoredPeerRecord = {
        ...peer,
        status: nextDistributedPeerStatus(peer.status, 'connected'),
        lastSeenAt: now,
        lastConnectedAt: now,
        lastRemoteAddress: remoteAddress ?? peer.lastRemoteAddress,
        activeTokenId: updatedToken.id,
        tokens: peer.tokens.map((entry) => entry.id === updatedToken.id ? updatedToken : entry),
      };
      // Last-use times ride along with the next real write (a claim, a
      // completion, a pairing change); a write per call would rewrite every
      // record for a timestamp.
      state.peers.set(peer.id, updatedPeer);
      return {
        peer: sanitizePeer(updatedPeer),
        token: updatedToken,
        cameBack: !isPresentlyConnected(peer, now),
      };
    }
  }
  return null;
}

export async function heartbeatDistributedPeer(
  state: DistributedRuntimeManagerState,
  auth: DistributedPeerAuth,
  input: {
    readonly remoteAddress?: string | undefined;
    readonly capabilities?: readonly string[] | undefined;
    readonly commands?: readonly string[] | undefined;
    readonly version?: string | undefined;
    readonly clientMode?: string | undefined;
    readonly metadata?: Record<string, unknown> | undefined;
  } = {},
): Promise<DistributedPeerRecord> {
  await startDistributedRuntime(state);
  const peer = state.peers.get(auth.peer.id);
  if (!peer) throw new Error(`Unknown distributed peer: ${auth.peer.id}`);
  const now = Date.now();
  const updated: StoredPeerRecord = {
    ...peer,
    status: nextDistributedPeerStatus(peer.status, 'connected'),
    lastSeenAt: now,
    lastConnectedAt: now,
    lastRemoteAddress: input.remoteAddress ?? peer.lastRemoteAddress,
    capabilities: input.capabilities ? [...input.capabilities] : peer.capabilities,
    commands: input.commands ? [...input.commands] : peer.commands,
    version: input.version ?? peer.version,
    clientMode: input.clientMode ?? peer.clientMode,
    metadata: mergeBoundedPeerMetadata(peer.metadata, input.metadata),
  };
  state.peers.set(peer.id, updated);
  renewDistributedWorkLeases(state, peer.id, auth.token.id);
  // Presence (last seen, renewed leases) stays in memory and rides the next
  // real write, as authentication does. Only a peer coming back (it was not
  // presented as connected) or a changed description is audited, written and
  // published, so heartbeats neither rewrite the store nor push the approval
  // and token records out of the bounded audit list.
  // Authentication already marked the peer connected, so whether it came back
  // is read from what authentication saw; a caller holding an older auth falls
  // back to the record as it stands.
  const cameBack = auth.cameBack === true || !isPresentlyConnected(peer, now);
  const described = updated.metadata !== peer.metadata
    || updated.version !== peer.version
    || updated.clientMode !== peer.clientMode
    || !sameList(updated.capabilities, peer.capabilities)
    || !sameList(updated.commands, peer.commands);
  if (!cameBack && !described) return sanitizePeer(updated);
  if (cameBack) {
    recordDistributedRuntimeAudit(state, buildAudit('peer-connected', peer.id, {
      peerId: peer.id,
      note: updated.label,
    }));
  }
  await pruneAndPersistDistributedRuntime(state);
  publishDistributedRuntimeEvent(state, 'remote-peer-heartbeat', sanitizePeer(updated));
  return sanitizePeer(updated);
}

function isPresentlyConnected(peer: StoredPeerRecord, now: number): boolean {
  return peer.status === 'connected'
    && peer.lastSeenAt !== undefined
    && now - peer.lastSeenAt <= DISTRIBUTED_PEER_PRESENCE_WINDOW_MS;
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

/** Free-form peer metadata is merged on every heartbeat, so its size is bounded. */
const MAX_PEER_METADATA_KEYS = 64;
/** Serialized size of one metadata value, and of all values together; larger values are skipped. */
const MAX_PEER_METADATA_VALUE_BYTES = 4_096;
const MAX_PEER_METADATA_TOTAL_BYTES = 64 * 1_024;
function serialized(value: unknown): string | undefined {
  try { return JSON.stringify(value) ?? ''; } catch { return undefined; }
}
/** The merged metadata, or `current` itself when the heartbeat changed nothing. */
function mergeBoundedPeerMetadata(
  current: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!incoming) return current;
  const merged = { ...current };
  let changed = false;
  let total = serialized(merged)?.length ?? 0;
  for (const [key, value] of Object.entries(incoming)) {
    if (!(key in merged) && Object.keys(merged).length >= MAX_PEER_METADATA_KEYS) continue;
    const next = serialized(value);
    if (next === undefined || next.length > MAX_PEER_METADATA_VALUE_BYTES) continue;
    const held = key in merged ? serialized(merged[key]) : undefined;
    if (held === next) continue;
    const replaced = held?.length ?? 0;
    if (total - replaced + next.length > MAX_PEER_METADATA_TOTAL_BYTES) continue;
    total += next.length - replaced;
    merged[key] = value;
    changed = true;
  }
  return changed ? merged : current;
}

/**
 * A heartbeat proves the peer is alive and still working, so the leases it
 * holds are renewed by the length it asked for when it pulled. Without this a
 * slow first item lets the lease on the items pulled with it lapse, and they
 * are offered again while the peer is about to run them.
 */
function renewDistributedWorkLeases(state: DistributedRuntimeManagerState, peerId: string, tokenId: string): void {
  const now = Date.now();
  for (const item of state.work.values()) {
    if (item.peerId !== peerId || item.status !== 'claimed' || item.claimTokenId !== tokenId) continue;
    if (item.leaseExpiresAt === undefined || item.leaseExpiresAt <= now) continue;
    // A host-admitted claim still being handed over is compared by identity;
    // replacing the record then would refuse the handover.
    const owner = state.workAdmissions.get(item.id);
    if (owner && !owner.claimed) continue;
    const leaseMs = item.metadata['leaseMs'];
    if (typeof leaseMs !== 'number' || !Number.isFinite(leaseMs) || now + leaseMs <= item.leaseExpiresAt) continue;
    state.work.set(item.id, { ...item, leaseExpiresAt: now + leaseMs, updatedAt: now });
  }
}

function newPeerId(kind: DistributedPeerKind): string {
  return `${kind}-${randomUUID().slice(0, 8)}`;
}

/** The peer a request names: the one it was approved for, else the one with its requested id. */
function findPeerForRequest(state: DistributedRuntimeManagerState, request: StoredPairRequest): StoredPeerRecord | undefined {
  return (request.peerId ? state.peers.get(request.peerId) : undefined)
    ?? [...state.peers.values()].find((peer) => peer.requestedId === request.requestedId);
}

/** An operator's label and metadata on an existing peer; the unauthenticated request changes nothing on it. */
function applyOperatorEdits(
  state: DistributedRuntimeManagerState,
  existing: StoredPeerRecord,
  label: string | undefined,
  metadata: Record<string, unknown> | undefined,
): StoredPeerRecord {
  if (!label?.trim() && !metadata) return existing;
  const edited: StoredPeerRecord = {
    ...existing,
    label: label?.trim() || existing.label,
    metadata: { ...existing.metadata, ...(metadata ?? {}) },
  };
  state.peers.set(existing.id, edited);
  return edited;
}

/** The peer a request describes, not stored. */
function peerFromRequest(
  request: StoredPairRequest,
  id: string,
  labelOverride?: string,
  metadata?: Record<string, unknown>,
): StoredPeerRecord {
  return {
    id,
    kind: request.peerKind,
    label: labelOverride?.trim() || request.label,
    requestedId: request.requestedId,
    platform: request.platform,
    deviceFamily: request.deviceFamily,
    version: request.version,
    clientMode: request.clientMode,
    capabilities: request.capabilities,
    commands: request.commands,
    permissions: undefined,
    status: 'paired',
    pairedAt: Date.now(),
    verifiedAt: undefined,
    lastSeenAt: undefined,
    lastConnectedAt: undefined,
    lastDisconnectedAt: undefined,
    lastRemoteAddress: request.remoteAddress,
    activeTokenId: undefined,
    tokens: [],
    metadata: {
      ...request.metadata,
      ...(metadata ?? {}),
    },
  };
}

/**
 * At verification, once the device has proved it holds the challenge: the
 * request's fields replace those of the peer it names, or a new peer is
 * created under the id its approval returned.
 */
function ensurePeerFromRequest(
  state: DistributedRuntimeManagerState,
  request: StoredPairRequest,
  metadata?: Record<string, unknown>,
): StoredPeerRecord {
  const existing = findPeerForRequest(state, request);
  if (existing) {
    const merged: StoredPeerRecord = {
      ...existing,
      platform: request.platform ?? existing.platform,
      deviceFamily: request.deviceFamily ?? existing.deviceFamily,
      version: request.version ?? existing.version,
      clientMode: request.clientMode ?? existing.clientMode,
      capabilities: request.capabilities.length > 0 ? request.capabilities : existing.capabilities,
      commands: request.commands.length > 0 ? request.commands : existing.commands,
      metadata: {
        ...existing.metadata,
        ...request.metadata,
        ...(metadata ?? {}),
      },
    };
    state.peers.set(existing.id, merged);
    return merged;
  }
  const peer = peerFromRequest(request, request.peerId ?? newPeerId(request.peerKind), undefined, metadata);
  state.peers.set(peer.id, peer);
  return peer;
}

function issueToken(
  state: DistributedRuntimeManagerState,
  peerId: string,
  label: string,
  scopes: readonly string[] = ['remote:pull', 'remote:complete', 'remote:heartbeat'],
): { token: StoredPeerTokenRecord; value: string } {
  const peer = state.peers.get(peerId);
  if (!peer) throw new Error(`Unknown distributed peer: ${peerId}`);
  const value = randomSecret('gvrt');
  const issuedAt = Date.now();
  const token: StoredPeerTokenRecord = {
    id: `dtoken-${randomUUID().slice(0, 8)}`,
    label,
    scopes: [...scopes],
    issuedAt,
    lastUsedAt: undefined,
    rotatedAt: issuedAt,
    revokedAt: undefined,
    fingerprint: fingerprint(value),
    secretHash: hashSecret(value),
  };
  const nextTokens = peer.tokens.map((entry) => entry.revokedAt ? entry : { ...entry, revokedAt: issuedAt });
  nextTokens.push(token);
  state.peers.set(peerId, {
    ...peer,
    status: peer.status === 'revoked' ? 'paired' : peer.status,
    verifiedAt: issuedAt,
    activeTokenId: token.id,
    tokens: nextTokens,
  });
  return { token, value };
}

function updatePeerConnectionState(
  state: DistributedRuntimeManagerState,
  peerId: string,
  status: 'connected' | 'disconnected',
  input: {
    readonly remoteAddress?: string | undefined;
  } = {},
): StoredPeerRecord | null {
  const peer = state.peers.get(peerId);
  if (!peer) return null;
  const now = Date.now();
  const updated: StoredPeerRecord = {
    ...peer,
    status: nextDistributedPeerStatus(peer.status, status),
    lastSeenAt: now,
    ...(status === 'connected' ? { lastConnectedAt: now } : { lastDisconnectedAt: now }),
    ...(input.remoteAddress ? { lastRemoteAddress: input.remoteAddress } : {}),
  };
  state.peers.set(peerId, updated);
  return updated;
}
