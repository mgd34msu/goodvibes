/** Actual codec/election regressions, intentionally UNRUN during coding first. */
import { expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { compareStableRank, compareVersions } from '../platform/src/platform/cluster/ranking.js';
import { stableSurfaceHash } from '../platform/src/platform/cluster/surface-id.js';
import { CLUSTER_RANK_FEATURE, CLUSTER_V1_PEER_RANK_FEATURE, clusterProductVersion, clusterRankingWireVersion } from '../platform/src/platform/cluster/ranking-feature.js';
import { decodeMessage, encodeMessage } from '../platform/src/platform/cluster/protocol.js';
import { GroupWireRouter } from '../platform/src/platform/cluster/group-transport.js';
import type { ClusterMessage, ClusterTransport } from '../platform/src/platform/cluster/types.js';
import { addNode, advance, createWorld, holders, idFor, startNode } from './cluster-harness.js';

const secret = 'Synthetic shared cluster credential';
function oldRank(node: string, surface: string): string {
  return crypto.createHash('sha256').update('goodvibes/cluster/spread/v1').update('\u0000').update(node).update('\u0000').update(surface).digest('hex');
}
function message(version: string, seq = 7, ts = 100): ClusterMessage {
  return { v: 1, type: 'PROBE', surfaceId: null, nodeId: 'existing-peer', nodeVersion: version, seq, ts };
}

test('the signed wire feature preserves release precedence, prereleases and unrelated build metadata', () => {
  for (const original of ['3.1.2', 'v3.1.2-rc.4', '3.1.2-rc.4+vendor.trace']) {
    const wire = clusterRankingWireVersion(original), compatible = clusterRankingWireVersion(original, true);
    expect(wire.endsWith(CLUSTER_RANK_FEATURE)).toBe(true); expect(compatible.endsWith(CLUSTER_V1_PEER_RANK_FEATURE)).toBe(true);
    expect(clusterProductVersion(wire)).toBe(original); expect(clusterProductVersion(compatible)).toBe(original);
    expect(compareVersions(wire, original)).toBe(0); expect(compareVersions(compatible, original)).toBe(0);
  }
  const unrelated = '3.1.2+other.' + CLUSTER_RANK_FEATURE + '.vendor';
  expect(clusterProductVersion(unrelated)).toBe(unrelated);
});

test('existing v1 authentication covers the exact declaration and sequence without a second signature', () => {
  const outgoing = message(clusterRankingWireVersion('3.1.2-rc.4+vendor.trace'));
  const raw = encodeMessage(outgoing, secret), parsed = JSON.parse(raw) as Record<string, unknown>;
  // This is the deployed seven-field v1 canonical form, not the new helper.
  const expected = crypto.createHmac('sha256', secret).update(JSON.stringify([1, outgoing.type, outgoing.surfaceId, outgoing.nodeId, outgoing.nodeVersion, outgoing.seq, outgoing.ts])).digest('hex');
  expect(parsed['sig']).toBe(expected); expect(decodeMessage(raw, secret).message?.nodeVersion).toBe(outgoing.nodeVersion);
  for (const change of [{ nodeVersion: '3.1.2-rc.4+vendor.trace' }, { seq: 8 }]) {
    expect(decodeMessage(JSON.stringify({ ...parsed, ...change }), secret).message).toBeNull();
  }
});

test('new local rank and ordinary current comparisons use no cryptographic digest', () => {
  const hash = spyOn(crypto, 'createHash');
  try {
    const surface = 'a'.repeat(32), a = { nodeId: 'current-a', version: '3.1.2' }, b = { nodeId: 'current-b', version: '3.1.2' };
    expect(stableSurfaceHash(a.nodeId, surface)).toMatch(/^[0-9a-f]{8}$/);
    expect(compareStableRank(a, b, surface)).toBe(-compareStableRank(b, a, surface));
    expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); }
});

test('actual v1 compatibility reproduces both old tuple scores and caches repeated comparisons', () => {
  const surface = 'b'.repeat(32), a = { nodeId: 'cache-existing-v1-peer', version: '3.1.2', ranking: 'v1-peer' as const }, b = { nodeId: 'cache-current-peer', version: '3.1.2' };
  const expected = oldRank(a.nodeId, surface) < oldRank(b.nodeId, surface) ? -1 : 1;
  const hash = spyOn(crypto, 'createHash');
  try {
    for (let count = 0; count < 8; count += 1) {
      expect(compareStableRank(a, b, surface)).toBe(expected); expect(compareStableRank(b, a, surface)).toBe(-expected);
    }
    expect(hash).toHaveBeenCalledTimes(2);
  } finally { hash.mockRestore(); }
});

test('a fresh all-current split election heals with the noncryptographic order and no SHA ranking', async () => {
  const world = createWorld(), topic = 'ntfy-current-rank';
  const first = addNode(world, { id: 'fresh-current-a', version: '3.1.2', surfaces: [topic] }); world.bus.partition(first.transport, 'left');
  await startNode(world, first); await advance(world, 1100);
  const second = addNode(world, { id: 'fresh-current-b', version: '3.1.2', surfaces: [topic] }); world.bus.partition(second.transport, 'right');
  await startNode(world, second); await advance(world, 1100);
  const rank = compareStableRank({ nodeId: first.id, version: '3.1.2' }, { nodeId: second.id, version: '3.1.2' }, idFor(topic));
  const hash = spyOn(crypto, 'createHash');
  try {
    world.bus.heal(); await advance(world, 4000);
    expect<unknown>(holders(world, topic)).toEqual([rank < 0 ? first : second]); expect(hash).not.toHaveBeenCalled();
  } finally { hash.mockRestore(); await Promise.all(world.nodes.map(node => node.election.stop())); }
});

test('a v1 wire peer and two current peers converge on one old total order after a partition heals', async () => {
  const world = createWorld(), topic = 'ntfy-mixed-rank';
  const old = addNode(world, { id: 'mixed-existing-a', version: '3.1.2', surfaces: [topic], settings: { secret } });
  // The historical wire peer emits its plain version and uses the deployed v1
  // ordering. Drive that mode through a genuine accepted v1 packet; no private
  // ranking state or production feature flag is changed by this test.
  const send = old.transport.send.bind(old.transport);
  old.transport.send = raw => {
    const decoded = decodeMessage(raw, secret).message;
    return send(decoded ? encodeMessage({ ...decoded, nodeVersion: clusterProductVersion(decoded.nodeVersion) }, secret) : raw);
  };
  world.bus.partition(old.transport, 'old'); await startNode(world, old);
  await old.transport.send(encodeMessage(message('3.1.2', 1, world.clock.now()), secret)); await advance(world, 1100);
  const first = addNode(world, { id: 'mixed-current-b', version: '3.1.2', surfaces: [topic], settings: { secret } }); world.bus.partition(first.transport, 'first');
  await startNode(world, first); await advance(world, 1100);
  const second = addNode(world, { id: 'mixed-current-c', version: '3.1.2', surfaces: [topic], settings: { secret } }); world.bus.partition(second.transport, 'second');
  await startNode(world, second); await advance(world, 1100);
  const surface = idFor(topic), expected = [old, first, second].map(node => ({ node, rank: oldRank(node.id, surface) }))
    .sort((a, b) => a.rank.localeCompare(b.rank))[0]?.node;
  world.bus.heal(); await advance(world, 5000);
  expect<unknown>(holders(world, topic)).toEqual([expected]);
  for (const node of [first, second]) {
    const latest = world.bus.sent.filter(sent => sent.from === node.id).at(-1);
    expect(latest && decodeMessage(latest.raw, secret).message?.nodeVersion.endsWith(CLUSTER_V1_PEER_RANK_FEATURE)).toBe(true);
    expect(node.election.status().peers.every(peer => peer.version === '3.1.2')).toBe(true);
  }
  await Promise.all(world.nodes.map(node => node.election.stop()));
});

test('invalid or stale old-style announcements cannot downgrade a current election ranking', async () => {
  const world = createWorld(), node = addNode(world, { id: 'replay-current-node', version: '3.1.2+vendor.trace', surfaces: ['ntfy-replay-rank'], settings: { secret } });
  await startNode(world, node); await advance(world, 1100);
  const timestamp = world.clock.now(), current = encodeMessage(message(clusterRankingWireVersion('3.1.2'), 10, timestamp), secret);
  await node.transport.send(current);
  await node.transport.send(encodeMessage(message('3.1.2', 9, timestamp), secret));
  await node.transport.send(JSON.stringify({ ...JSON.parse(current), nodeVersion: '3.1.2', seq: 11 }));
  await advance(world, 1100);
  const latest = () => decodeMessage(world.bus.sent.filter(sent => sent.from === node.id).at(-1)!.raw, secret).message!.nodeVersion;
  expect(latest()).toBe(clusterRankingWireVersion('3.1.2+vendor.trace'));
  await node.transport.send(encodeMessage(message('3.1.2', 11, timestamp), secret)); await advance(world, 1100);
  expect(latest()).toBe(clusterRankingWireVersion('3.1.2+vendor.trace', true));
  await node.election.stop();
});


test('the actual group wrapper preserves and authenticates the election feature declaration', async () => {
  let receive: ((raw: string) => void) | undefined; const outgoing: string[] = [], delivered: string[] = [];
  const inner: ClusterTransport = {
    async start(reader) { receive = reader; }, async send(raw) { outgoing.push(raw); }, async stop() {},
    describe: () => ({ mode: 'in-memory', group: 'memory', port: 0, peers: [] }),
  };
  const router = new GroupWireRouter({ inner, keyring: {
    groupId: 'gTESTTESTTESTTEST', currentGeneration: 1,
    keyForGeneration: generation => generation === 1 ? 'Synthetic group signing key' : null,
    acceptedGenerations: () => [1],
  }, logger: { debug() {}, info() {}, warn() {}, error() {} }, now: () => 100,
    onGroupMessage() {}, onOutOfBandMessage() {}, onForeignBeacon() {},
  });
  const wireVersion = clusterRankingWireVersion('3.1.2-rc.1+vendor.trace'), transport = router.electionTransport('3.1.2-rc.1+vendor.trace');
  try {
    await transport.start(raw => delivered.push(raw)); await transport.send(encodeMessage(message(wireVersion), secret));
    const raw = outgoing[0]; if (!raw || !receive) throw new Error('Actual group wrapper did not publish its datagram');
    expect(JSON.parse(raw).nodeVersion).toBe(wireVersion); receive(raw);
    expect(delivered).toHaveLength(1); expect(decodeMessage(delivered[0]!, secret).message?.nodeVersion).toBe(wireVersion);
    receive(JSON.stringify({ ...JSON.parse(raw), nodeVersion: clusterProductVersion(wireVersion) }));
    expect(delivered).toHaveLength(1); expect(router.counters.droppedBadSignature).toBe(1);
  } finally { await router.stop(); }
});
