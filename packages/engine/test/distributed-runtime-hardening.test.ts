import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.js';
import { MAX_DISTRIBUTED_WORK_REQUEUES } from '../platform/src/platform/runtime/remote/distributed-runtime-store.js';
import type { DistributedRuntimeSnapshotStore } from '../platform/src/platform/runtime/remote/distributed-runtime-types.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

const realNow = Date.now;
let offset = 0;
function advance(ms: number): void {
  offset += ms;
  Date.now = () => realNow() + offset;
}
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  Date.now = realNow;
  offset = 0;
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function newManager(name = 'remote.json') {
  const path = join(makeProjectTempDir('distributed-hardening'), name);
  const manager = new DistributedRuntimeManager(path);
  cleanups.push(() => manager.writes.drain());
  return { manager, path };
}

async function pairedPeer(manager: DistributedRuntimeManager, input: { kind?: 'node' | 'device'; requestedId?: string; capabilities?: string[] } = {}) {
  const requested = await manager.requestPairing({
    peerKind: input.kind ?? 'node',
    label: 'Synthetic peer',
    ...(input.requestedId ? { requestedId: input.requestedId } : {}),
    ...(input.capabilities ? { capabilities: input.capabilities } : {}),
  });
  await manager.approvePairRequest(requested.request.id);
  const verified = await manager.verifyPairRequest(requested.request.id, requested.challenge);
  if (!verified) throw new Error('fixture pairing failed');
  return { auth: { peer: verified.peer, token: verified.token }, peerId: verified.peer.id };
}

describe('claiming work past its deadline', () => {
  test('work whose timeout passed before the pull is expired, not handed to the peer', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    const work = await manager.enqueueWork({ peerId, command: 'build', timeoutMs: 1_000 });
    advance(5_000); // no list, heartbeat or prune runs in between
    expect(await manager.claimWork(auth)).toEqual([]);
    const settled = manager.listWork().find((item) => item.id === work.id);
    expect(settled?.status).toBe('expired');
  });
});

describe('work that keeps losing its lease', () => {
  test('expires after the requeue limit and is not offered again', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    const work = await manager.enqueueWork({ peerId, command: 'build' });
    let offered = 0;
    for (let round = 0; round < MAX_DISTRIBUTED_WORK_REQUEUES + 3; round++) {
      offered += (await manager.claimWork(auth, { leaseMs: 5_000 })).length;
      advance(6_000);
      manager.listWork();
    }
    // It survives MAX lease expiries, so it is offered one more time than that, and then never again.
    expect(offered).toBe(MAX_DISTRIBUTED_WORK_REQUEUES + 1);
    expect(manager.listWork().find((item) => item.id === work.id)?.status).toBe('expired');
  });
});

describe('re-pairing under an id that already belongs to a peer', () => {
  test('approval leaves the existing peer and its tokens alone until the device verifies', async () => {
    const { manager } = newManager();
    await manager.start();
    const original = await pairedPeer(manager, { requestedId: 'shared-id', capabilities: ['device.screen.capture'] });
    const impostor = await manager.requestPairing({
      peerKind: 'node', label: 'Impostor', requestedId: 'shared-id', capabilities: ['everything'], commands: ['rm'],
    });
    expect(impostor.request.replacesPeerId).toBe(original.peerId);
    expect(manager.listPairRequests().find((entry) => entry.id === impostor.request.id)?.replacesPeerId).toBe(original.peerId);
    await expect(manager.approvePairRequest(impostor.request.id)).rejects.toMatchObject({ code: 'REMOTE_PAIR_REPLACES_PEER' });
    expect(manager.listPairRequests().find((entry) => entry.id === impostor.request.id)?.status).toBe('pending');
    const approved = await manager.approvePairRequest(impostor.request.id, { confirmReplace: true });
    expect(approved?.peer.id).toBe(original.peerId);
    expect(approved?.request.replacesPeerId).toBe(original.peerId);

    const before = manager.listPeers().find((peer) => peer.id === original.peerId);
    expect(before?.capabilities).toEqual(['device.screen.capture']);
    expect(before?.commands).toEqual([]);
    expect(await manager.authenticatePeerToken(original.auth.token.value)).not.toBeNull();

    // The challenge holder verifies: only now do its fields and tokens replace the old ones.
    await manager.verifyPairRequest(impostor.request.id, impostor.challenge);
    const after = manager.listPeers().find((peer) => peer.id === original.peerId);
    expect(after?.capabilities).toEqual(['everything']);
    expect(await manager.authenticatePeerToken(original.auth.token.value)).toBeNull();
  });

  test('approving a verified request again does not re-apply the old request over the current peer', async () => {
    const { manager } = newManager();
    await manager.start();
    const first = await manager.requestPairing({ peerKind: 'node', label: 'Node', requestedId: 'again-id', capabilities: ['a'] });
    await manager.approvePairRequest(first.request.id);
    const verified = await manager.verifyPairRequest(first.request.id, first.challenge);
    if (!verified) throw new Error('fixture pairing failed');
    await manager.heartbeatPeer({ peer: verified.peer, token: verified.token }, { capabilities: ['b'] });
    await manager.approvePairRequest(first.request.id);
    expect(manager.listPeers().find((peer) => peer.id === verified.peer.id)?.capabilities).toEqual(['b']);
  });

  test('a request naming no existing peer needs no confirmation', async () => {
    const { manager } = newManager();
    await manager.start();
    const fresh = await manager.requestPairing({ peerKind: 'node', label: 'New', requestedId: 'brand-new' });
    expect(fresh.request.replacesPeerId).toBeUndefined();
    expect((await manager.approvePairRequest(fresh.request.id))?.request.status).toBe('approved');
  });
});

describe('a flood of pair requests', () => {
  test('does not evict an approved request that is waiting for its device to verify', async () => {
    const { manager } = newManager();
    await manager.start();
    const waiting = await manager.requestPairing({ peerKind: 'node', label: 'Waiting device' });
    await manager.approvePairRequest(waiting.request.id);
    for (let index = 0; index < 270; index++) {
      advance(1);
      await manager.requestPairing({ peerKind: 'node', label: `flood ${index}` });
    }
    expect(manager.listPairRequests(500).length).toBeLessThanOrEqual(250);
    const verified = await manager.verifyPairRequest(waiting.request.id, waiting.challenge);
    expect(verified?.token.value).toBeTruthy();
  });
});

describe('host admission and volatile peer data', () => {
  test('a heartbeat that changes only metadata and address does not cancel admitted work', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager, { kind: 'device' });
    const lifetime = new AbortController();
    cleanups.push(() => lifetime.abort());
    let claims = 0;
    const work = await manager.enqueueWork({
      peerId,
      command: 'device.screen.capture',
      admission: { signal: lifetime.signal, assertCurrent() {}, claim() { claims++; } },
    });
    await manager.heartbeatPeer(auth, { remoteAddress: '203.0.113.9', metadata: { load: 0.7 } });
    const claimed = await manager.claimWork(auth);
    expect(claimed.map((item) => item.id)).toEqual([work.id]);
    expect(claims).toBe(1);
  });

  test('a heartbeat that renews a lease during the claim write does not lose the delivery', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    const work = await manager.enqueueWork({ peerId, command: 'build' });
    const persist = manager.store.persist.bind(manager.store);
    let armed = true;
    manager.store.persist = async (snapshot: DistributedRuntimeSnapshotStore) => {
      if (armed) {
        armed = false;
        advance(50);
        void manager.heartbeatPeer(auth, {});
        // Let the heartbeat's synchronous part (the lease renewal) run while the claim write is pending.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      await persist(snapshot);
    };
    const claimed = await manager.claimWork(auth, { leaseMs: 5_000 });
    expect(claimed.map((item) => item.id)).toEqual([work.id]);
    expect(claimed[0]?.status).toBe('claimed');
    expect(claimed[0]?.claimTokenId).toBe(auth.token.id);
  });

  test('a peer metadata value or total over the size limit is not stored', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    await manager.heartbeatPeer(auth, { metadata: { huge: 'x'.repeat(1_000_000), small: 'ok' } });
    const metadata = manager.listPeers().find((entry) => entry.id === peerId)?.metadata ?? {};
    expect(metadata['huge']).toBeUndefined();
    expect(metadata['small']).toBe('ok');
    const many: Record<string, unknown> = {};
    for (let index = 0; index < 64; index++) many[`k${index}`] = 'y'.repeat(3_000);
    await manager.heartbeatPeer(auth, { metadata: many });
    const stored = manager.listPeers().find((entry) => entry.id === peerId)?.metadata ?? {};
    expect(JSON.stringify(stored).length).toBeLessThan(70_000);
  });

  test('peer metadata stays bounded across heartbeats', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    const metadata: Record<string, unknown> = {};
    for (let index = 0; index < 200; index++) metadata[`key${index}`] = index;
    await manager.heartbeatPeer(auth, { metadata });
    const peer = manager.listPeers().find((entry) => entry.id === peerId);
    expect(Object.keys(peer?.metadata ?? {}).length).toBeLessThanOrEqual(64);
  });
});

describe('an unreadable store names itself', () => {
  test('a record that does not validate is named with its file and position', async () => {
    const { manager, path } = newManager();
    writeFileSync(path, JSON.stringify({ pairRequests: [], peers: [{ id: 'p', kind: 'spaceship' }], work: [], audit: [] }));
    const failure = await manager.start().then(() => null, (error: unknown) => error as Error);
    expect(failure?.message).toContain('peers[0]');
    expect(failure?.message).toContain(path);
  });
});

describe('verifying a pairing when the store cannot be written', () => {
  test('a failed write leaves the request approved so the device can retry', async () => {
    const { manager } = newManager();
    await manager.start();
    const requested = await manager.requestPairing({ peerKind: 'node', label: 'Retrying device' });
    await manager.approvePairRequest(requested.request.id);
    const persist = manager.store.persist.bind(manager.store);
    let failNext = true;
    manager.store.persist = async (snapshot: DistributedRuntimeSnapshotStore) => {
      if (failNext) { failNext = false; throw new Error('disk full'); }
      await persist(snapshot);
    };
    await expect(manager.verifyPairRequest(requested.request.id, requested.challenge)).rejects.toThrow('disk full');
    expect(manager.listPairRequests().find((entry) => entry.id === requested.request.id)?.status).toBe('approved');
    const retried = await manager.verifyPairRequest(requested.request.id, requested.challenge);
    expect(retried?.token.value).toBeTruthy();
  });
});

describe('a device capture result', () => {
  test('carries its media to the waiting caller only, never to the stored or published record', async () => {
    const { manager, path } = newManager();
    const published: Array<{ event: string; payload: unknown }> = [];
    manager.attachRuntime({ eventPublisher: (event, payload) => { published.push({ event, payload }); } });
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager, { kind: 'device' });
    const pending = manager.invokePeer({ peerId, type: 'device.capability', command: 'device.camera.capture', waitMs: 10_000 });
    while (manager.listWork().length === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    const [claimed] = await manager.claimWork(auth);
    const result = { capabilityId: 'device.camera.capture', ok: true, mediaBase64: 'QUJD', mediaType: 'image/jpeg' };
    await manager.completeWork(auth, claimed!.id, { result });

    const waited = await pending;
    expect((waited.work.result as { mediaBase64?: string }).mediaBase64).toBe('QUJD');

    await manager.writes.drain();
    const disk = readFileSync(path, 'utf8');
    expect(disk).not.toContain('QUJD');
    expect(JSON.stringify(manager.listWork())).not.toContain('QUJD');
    expect(JSON.stringify(published)).not.toContain('QUJD');
    const stored = manager.listWork().find((item) => item.id === claimed!.id);
    expect((stored?.result as { mediaOmitted?: boolean }).mediaOmitted).toBe(true);
  });
});

describe('disconnecting a peer', () => {
  test('its tokens stay valid and the audit record says the peer can reconnect', async () => {
    const { manager } = newManager();
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    await manager.disconnectPeer(peerId);
    expect(manager.listAudit().find((entry) => entry.action === 'peer-disconnected')?.note).toContain('tokens stay valid');
    expect(await manager.authenticatePeerToken(auth.token.value)).not.toBeNull();
  });
});

describe('a bridge that could not hear of settled work', () => {
  test('is told again after a restart, once, and the marker is cleared', async () => {
    const { manager, path } = newManager();
    manager.attachRuntime({ sessionBridge: { appendSystemMessage: async () => { throw new Error('session store busy'); } } });
    await manager.start();
    const { auth, peerId } = await pairedPeer(manager);
    const queued = await manager.enqueueWork({ peerId, command: 'build', sessionId: 'session-1' });
    const [claimed] = await manager.claimWork(auth);
    await manager.completeWork(auth, claimed!.id, { result: { ok: true } });
    await manager.writes.drain();
    expect(JSON.parse(readFileSync(path, 'utf8')).work.find((item: { id: string }) => item.id === queued.id).metadata.bridgePending).toEqual(['session']);

    const restarted = new DistributedRuntimeManager(path);
    cleanups.push(() => restarted.writes.drain());
    await restarted.start();
    // Not attached yet: the marker must survive the retry.
    for (let i = 0; i < 20; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(restarted.listWork().find((item) => item.id === queued.id)?.metadata['bridgePending']).toEqual(['session']);

    const messages: string[] = [];
    restarted.attachRuntime({ sessionBridge: { appendSystemMessage: async (_id, body) => { messages.push(body); } } });
    while (restarted.listWork().find((item) => item.id === queued.id)?.metadata['bridgePending'] !== undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await restarted.writes.drain();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('completed');
    expect(JSON.parse(readFileSync(path, 'utf8')).work.find((item: { id: string }) => item.id === queued.id).metadata.bridgePending).toBeUndefined();
  });
});
