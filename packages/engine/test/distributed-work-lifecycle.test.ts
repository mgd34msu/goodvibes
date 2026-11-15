import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { waitFor } from './_helpers/test-timeout.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DistributedRuntimeManager } from '../platform/src/platform/runtime/remote/distributed-runtime-manager.js';
import type { DistributedRuntimeSnapshotStore } from '../platform/src/platform/runtime/remote/distributed-runtime-types.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';
import {
  createDaemonRemoteRouteHandlers,
  handleRemotePairVerify,
  handleRemotePeerWorkComplete,
  type DistributedRuntimeRouteService,
} from '../daemon-api/src/remote-routes.js';

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

async function fixture() {
  const path = join(makeProjectTempDir('distributed-work-lifecycle'), 'remote.json');
  const manager = new DistributedRuntimeManager(path);
  cleanups.push(() => manager.writes.drain());
  const sessionMessages: string[] = [];
  manager.attachRuntime({
    sessionBridge: { appendSystemMessage: async (_session, body) => { sessionMessages.push(body); } },
  });
  await manager.start();
  const requested = await manager.requestPairing({ peerKind: 'node', label: 'Synthetic node' });
  await manager.approvePairRequest(requested.request.id);
  const verified = await manager.verifyPairRequest(requested.request.id, requested.challenge);
  if (!verified) throw new Error('fixture pairing failed');
  const auth = { peer: verified.peer, token: verified.token };
  return { manager, path, auth, peerId: auth.peer.id, sessionMessages };
}

function readDisk(path: string): DistributedRuntimeSnapshotStore {
  return JSON.parse(readFileSync(path, 'utf8')) as DistributedRuntimeSnapshotStore;
}

describe('a settled unit of remote work stays settled', () => {
  test('a peer report after an operator cancel leaves the work cancelled and reports it once', async () => {
    const f = await fixture();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build', sessionId: 's1' });
    expect((await f.manager.claimWork(f.auth))[0]?.id).toBe(work.id);
    await f.manager.cancelWork(work.id, { reason: 'operator-cancelled' });
    const late = await f.manager.completeWork(f.auth, work.id, { result: { ok: true } });
    expect(late?.status).toBe('cancelled');
    expect(late?.result).toBeUndefined();
    expect(f.manager.listWork().find((item) => item.id === work.id)?.status).toBe('cancelled');
    expect(f.sessionMessages.filter((body) => body.includes('cancelled'))).toHaveLength(1);
    expect(f.sessionMessages.some((body) => body.includes('completed'))).toBe(false);
  });

  test('a second report cannot flip completed to failed', async () => {
    const f = await fixture();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build' });
    await f.manager.claimWork(f.auth);
    expect((await f.manager.completeWork(f.auth, work.id, { result: 1 }))?.status).toBe('completed');
    expect((await f.manager.completeWork(f.auth, work.id, { error: 'boom' }))?.status).toBe('completed');
  });

  test('the claimer may still report work its lapsed lease put back in the queue', async () => {
    const f = await fixture();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build' });
    await f.manager.claimWork(f.auth, { leaseMs: 5_000 });
    advance(6_000);
    expect(f.manager.listWork().find((item) => item.id === work.id)?.status).toBe('queued');
    expect((await f.manager.completeWork(f.auth, work.id, { result: 'late' }))?.status).toBe('completed');
  });

  test('a bridge that throws does not strand the settled work', async () => {
    const f = await fixture();
    f.manager.attachRuntime({ sessionBridge: { appendSystemMessage: async () => { throw new Error('session store unavailable'); } } });
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build', sessionId: 's1' });
    await f.manager.claimWork(f.auth);
    const waiting = f.manager.invokePeer({ peerId: f.peerId, command: 'other', waitMs: 50 });
    expect((await f.manager.completeWork(f.auth, work.id, { result: 1 }))?.status).toBe('completed');
    await waiting;
    await f.manager.writes.drain();
    expect(readDisk(f.path).work.find((item) => item.id === work.id)?.status).toBe('completed');
  });
});

describe('queued work has a way out', () => {
  test('work outliving its timeout expires and wakes its waiter', async () => {
    const f = await fixture();
    const pending = f.manager.invokePeer({ peerId: f.peerId, command: 'build', timeoutMs: 1_000, waitMs: 10_000 });
    await waitFor(() => f.manager.listWork().length > 0);
    advance(2_000);
    const listed = f.manager.listWork()[0];
    expect(listed?.status).toBe('expired');
    expect(listed?.error).toContain('1000ms');
    expect((await pending).work.status).toBe('expired');
    expect(await f.manager.claimWork(f.auth)).toEqual([]);
  });

  test('work that keeps losing its lease expires instead of being offered forever', async () => {
    const f = await fixture();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build' });
    for (let round = 0; round < 10; round++) {
      await f.manager.claimWork(f.auth, { leaseMs: 5_000 });
      advance(6_000);
      f.manager.listWork();
    }
    expect(f.manager.listWork().find((item) => item.id === work.id)?.status).toBe('expired');
  });

  test('a heartbeat renews the leases its peer holds', async () => {
    const f = await fixture();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build' });
    await f.manager.claimWork(f.auth, { leaseMs: 5_000 });
    advance(4_000);
    await f.manager.heartbeatPeer(f.auth);
    advance(4_000);
    expect(f.manager.listWork().find((item) => item.id === work.id)?.status).toBe('claimed');
  });
});

describe('peer presence', () => {
  test('a revoked peer stays revoked through a disconnect and a lapsed lease, and refuses new work', async () => {
    const f = await fixture();
    await f.manager.enqueueWork({ peerId: f.peerId, command: 'build' });
    await f.manager.claimWork(f.auth, { leaseMs: 5_000 });
    await f.manager.revokePeerToken(f.peerId);
    await f.manager.disconnectPeer(f.peerId);
    advance(200_000);
    f.manager.listWork();
    expect(f.manager.listPeers().find((peer) => peer.id === f.peerId)?.status).toBe('revoked');
    await expect(f.manager.enqueueWork({ peerId: f.peerId, command: 'again' })).rejects.toThrow('revoked');
  });

  test('a peer that stopped calling in is not presented as connected', async () => {
    const f = await fixture();
    await f.manager.heartbeatPeer(f.auth);
    expect(f.manager.listPeers().find((peer) => peer.id === f.peerId)?.status).toBe('connected');
    advance(10 * 60_000);
    expect(f.manager.listPeers().find((peer) => peer.id === f.peerId)?.status).toBe('disconnected');
  });
});

describe('approving a pair request that can no longer be approved', () => {
  test('an expired request gets no peer and the refusal says why', async () => {
    const path = join(makeProjectTempDir('distributed-work-lifecycle'), 'remote.json');
    const manager = new DistributedRuntimeManager(path);
    cleanups.push(() => manager.writes.drain());
    const { request } = await manager.requestPairing({ peerKind: 'node', label: 'late', ttlMs: 30_000 });
    advance(10 * 60_000);
    await expect(manager.approvePairRequest(request.id)).rejects.toThrow('expired');
    expect(manager.listPeers()).toEqual([]);
    expect(manager.listPairRequests().find((entry) => entry.id === request.id)?.status).toBe('expired');
  });

  test('a rejected request gets no peer; approving an approved request stays idempotent', async () => {
    const path = join(makeProjectTempDir('distributed-work-lifecycle'), 'remote.json');
    const manager = new DistributedRuntimeManager(path);
    cleanups.push(() => manager.writes.drain());
    const rejected = await manager.requestPairing({ peerKind: 'node', label: 'no' });
    await manager.rejectPairRequest(rejected.request.id);
    await expect(manager.approvePairRequest(rejected.request.id)).rejects.toThrow('rejected');
    expect(manager.listPeers()).toEqual([]);
    const ok = await manager.requestPairing({ peerKind: 'node', label: 'yes' });
    const first = await manager.approvePairRequest(ok.request.id);
    const second = await manager.approvePairRequest(ok.request.id);
    expect(second?.peer.id).toBe(first?.peer.id);
    expect(manager.listPeers()).toHaveLength(1);
  });
});

describe('startup', () => {
  test('two concurrent starts load the store once', async () => {
    const path = join(makeProjectTempDir('distributed-work-lifecycle'), 'remote.json');
    const manager = new DistributedRuntimeManager(path);
    cleanups.push(() => manager.writes.drain());
    const load = spyOn(manager.store, 'load');
    cleanups.push(() => load.mockRestore());
    await Promise.all([manager.start(), manager.start()]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('remote routes name the state a refusal comes from', () => {
  function routeContext(manager: DistributedRuntimeManager, auth: unknown) {
    return {
      parseJsonBody: async (req: Request) => await req.json() as Record<string, unknown>,
      requireAdmin: () => null,
      requireRemotePeer: async () => auth,
      requireAuthenticatedSession: () => null,
      distributedRuntime: manager as unknown as DistributedRuntimeRouteService,
    };
  }
  const post = (body: unknown) => new Request('http://local/x', { method: 'POST', body: JSON.stringify(body) });

  test('a report on cancelled work answers 409 with the state, not success', async () => {
    const f = await fixture();
    const work = await f.manager.enqueueWork({ peerId: f.peerId, command: 'build' });
    await f.manager.claimWork(f.auth);
    await f.manager.cancelWork(work.id);
    const response = await handleRemotePeerWorkComplete(routeContext(f.manager, f.auth), work.id, post({ status: 'completed', result: 1 }));
    expect(response.status).toBe(409);
    const body = await response.json() as { error: string; code: string; work: { status: string } };
    expect(body.error).toContain('cancelled');
    expect(body.code).toBe('REMOTE_WORK_SETTLED');
    expect(body.work.status).toBe('cancelled');
  });

  test('approving an expired request answers 409 with the reason; verifying it answers 410', async () => {
    const path = join(makeProjectTempDir('distributed-work-lifecycle'), 'remote.json');
    const manager = new DistributedRuntimeManager(path);
    cleanups.push(() => manager.writes.drain());
    const { request, challenge } = await manager.requestPairing({ peerKind: 'node', label: 'late', ttlMs: 30_000 });
    advance(10 * 60_000);
    const routes = createDaemonRemoteRouteHandlers(routeContext(manager, null));
    const approved = await routes.approveRemotePairRequest(request.id, post({}));
    expect(approved.status).toBe(409);
    expect(((await approved.json()) as { error: string }).error).toContain('expired');
    const verified = await handleRemotePairVerify(routeContext(manager, null), post({ requestId: request.id, challenge }));
    expect(verified.status).toBe(410);
  });

  test('a pending request still answers verify with 404 so a device can keep polling', async () => {
    const path = join(makeProjectTempDir('distributed-work-lifecycle'), 'remote.json');
    const manager = new DistributedRuntimeManager(path);
    cleanups.push(() => manager.writes.drain());
    const { request, challenge } = await manager.requestPairing({ peerKind: 'node', label: 'waiting' });
    const verified = await handleRemotePairVerify(routeContext(manager, null), post({ requestId: request.id, challenge }));
    expect(verified.status).toBe(404);
  });
});
