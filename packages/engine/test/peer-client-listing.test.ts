import { describe, expect, test } from 'bun:test';
import { createPeerClient } from '../platform/src/platform/runtime/peer-client.ts';

/** Stand-ins that slice by `limit` the way the real manager does. */
function makeClient(peerCount: number, requestCount: number) {
  const peers = Array.from({ length: peerCount }, (_, i) => ({ id: `peer-${i}`, kind: 'node' }));
  const requests = Array.from({ length: requestCount }, (_, i) => ({
    id: `req-${i}`, peerId: `peer-${i % peerCount}`, status: i % 2 === 0 ? 'pending' : 'approved',
  }));
  let listCalls = 0;
  const client = createPeerClient({
    distributedRuntime: {
      listPeers: (_kind: unknown, limit = 200) => { listCalls++; return peers.slice(0, Math.max(1, limit)); },
      listPairRequests: (limit = 100) => requests.slice(0, Math.max(1, limit)),
      listWork: (limit = 200) => [].slice(0, Math.max(1, limit)),
      getNodeHostContract: () => ({}),
    },
    remoteRunnerRegistry: {
      ensureContractsFromStore: () => {},
      listPools: () => [], listContracts: () => [], listArtifacts: () => [], getContract: () => null,
    },
    remoteSupervisor: { getSnapshot: () => ({ sessions: [] }) },
    runtimeStore: { getState: () => ({ acp: { managerTransportState: 'idle', totalMessages: 0, activeConnectionIds: [], connections: new Map() } }) },
  } as never);
  return { client, listCalls: () => listCalls };
}

describe('peer client listing', () => {
  test('get finds a peer beyond the first 500', () => {
    const { client } = makeClient(600, 0);
    expect(client.peers.get('peer-550')?.id).toBe('peer-550');
  });

  test('pairing counts cover every request, not the first 250', () => {
    const { client } = makeClient(10, 400);
    const { pairing } = client.getSnapshot();
    expect(pairing.total).toBe(400);
    expect(pairing.pending).toBe(200);
    expect(pairing.requests).toHaveLength(250);
  });

  test('peer snapshots come from one listing, not one per peer', () => {
    const { client, listCalls } = makeClient(50, 0);
    const snapshot = client.getSnapshot();
    expect(snapshot.peerSnapshots).toHaveLength(50);
    expect(listCalls()).toBe(1);
  });
});
