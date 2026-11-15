/**
 * cluster-group-removal-and-recovery.test.ts
 *
 * Removing a machine takes the join key away from it too, a member that missed
 * a key rotation is brought back by the repeated announcement, a rotation is
 * only taken from a machine on the roster, operator verbs answer with
 * structured results, and the pieces of group state that travel in a datagram
 * stay inside one.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from './_helpers/test-timeout.js';
import {
  addGroupNode,
  advance,
  createGroupWorld,
  datagramsOfType,
  destroyGroupWorld,
  resolveWithClock,
  settle,
  stopGroupWorld,
  type GroupTestNode,
  type GroupTestWorld,
} from './cluster-group-harness.js';
import {
  createGroup,
  forgetNode,
  groupNodes,
  joinGroup,
  joinKeyForGroup,
  renameGroupTo,
  rotateGroupKey,
} from '../platform/src/platform/cluster/group-operations.js';
import {
  deriveJoinSalt,
  deriveJoinVerifier,
  generateGroupId,
  generateNodeKeyMaterial,
  sealForMember,
} from '../platform/src/platform/cluster/group-crypto.js';
import {
  admitMember,
  createGroupStateDocument,
  findTombstone,
  fitStateToBytes,
  mergeGroupState,
  readmitMember,
  removeMember,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_TOMBSTONES,
  type GroupStateDocument,
} from '../platform/src/platform/cluster/group-state.js';
import { decideAdmission, GRANT_STATE_MAX_BYTES, openGrant, sealGrant } from '../platform/src/platform/cluster/group-membership.js';
import { ClusterMembershipOperationError } from '../platform/src/platform/cluster/membership-operation.js';
import { MAX_ENVELOPE_BYTES, encodeEnvelope, type ClusterKeyring } from '../platform/src/platform/cluster/protocol-envelope.js';
import { GroupWireRouter } from '../platform/src/platform/cluster/group-transport.js';
import { decodeMessage, encodeMessage, MAX_DATAGRAM_SKEW_MS } from '../platform/src/platform/cluster/protocol.js';
import { compareVersions } from '../platform/src/platform/cluster/ranking.js';
import { CLUSTER_PROTOCOL_VERSION } from '../platform/src/platform/cluster/types.js';
import type { ClusterLogger, ClusterTransport } from '../platform/src/platform/cluster/types.js';

let world: GroupTestWorld | null = null;

afterEach(async () => {
  if (world) {
    await stopGroupWorld(world);
    destroyGroupWorld(world);
    world = null;
  }
});

interface Pair { readonly world: GroupTestWorld; readonly first: GroupTestNode; readonly groupId: string; readonly joinKey: string }

async function makeGroup(options: { readonly nodes?: readonly string[]; readonly onKeyGenerationLost?: () => void } = {}): Promise<Pair & { readonly others: GroupTestNode[] }> {
  const created = createGroupWorld();
  world = created;
  const first = await addGroupNode(created, 'node-a');
  const result = await createGroup(first.context, { displayName: 'the workshop' });
  if (!result.ok) throw new Error(result.error);
  const others: GroupTestNode[] = [];
  for (const label of options.nodes ?? []) {
    const node = await addGroupNode(created, label, { onKeyGenerationLost: options.onKeyGenerationLost });
    const joined = await joinGroup(node.context, { groupId: result.data.groupId, joinKey: result.data.joinKey });
    if (!joined.ok) throw new Error(joined.error);
    others.push(node);
  }
  await settle();
  return { world: created, first, groupId: result.data.groupId, joinKey: result.data.joinKey, others };
}

describe('removal takes the join key away from the removed machine', () => {
  test('a removed machine cannot rejoin with the join key it still holds', async () => {
    const { world: w, first, groupId, joinKey, others } = await makeGroup({ nodes: ['node-b'] });
    const removed = others[0]!;
    const forgotten = await forgetNode(first.context, 'node-b');
    expect(forgotten.ok).toBe(true);
    if (!forgotten.ok) return;
    expect(forgotten.data.joinKeyReplaced).toBe(true);
    await settle();

    const current = joinKeyForGroup(first.context);
    expect(current.ok && current.data.joinKey).not.toBe(joinKey);

    const acceptedBefore = datagramsOfType(w, 'JOIN_ACCEPT').length;
    const attempt = await resolveWithClock(w, removed.runtime.requestJoin({
      groupId, joinKey, joinSalt: deriveJoinSalt(groupId), timeoutMs: 30_000,
    }));
    expect(attempt.ok).toBe(false);
    // The group heard the request and said no; it was not merely silent.
    expect(datagramsOfType(w, 'JOIN_REFUSE').length).toBeGreaterThan(0);
    expect(datagramsOfType(w, 'JOIN_ACCEPT')).toHaveLength(acceptedBefore);
    const roster = groupNodes(first.context);
    expect(roster.ok && roster.data.members.map((member) => member.nodeId)).toEqual(['node-a']);
    expect(roster.ok && roster.data.removed.map((entry) => entry.nodeId)).toEqual(['node-b']);
  });

  test('the operator can still put a machine back by giving it the new join key', async () => {
    const { world: w, first, groupId, others } = await makeGroup({ nodes: ['node-b'] });
    const removed = others[0]!;
    await forgetNode(first.context, 'node-b');
    await settle();
    const current = joinKeyForGroup(first.context);
    if (!current.ok) throw new Error(current.error);

    // The group answers in microtasks once the proof is derived, so no clock is moved:
    // a beacon timer firing mid-admission is a different test's subject.
    const attempt = await removed.runtime.requestJoin({
      groupId, joinKey: current.data.joinKey, joinSalt: deriveJoinSalt(groupId), timeoutMs: 30_000,
    });
    expect(attempt.ok).toBe(true);
    const roster = groupNodes(first.context);
    expect(roster.ok && roster.data.members.map((member) => member.nodeId).sort()).toEqual(['node-a', 'node-b']);
  });

  test('the remaining members adopt the same new join key, which verifies under the group salt', async () => {
    const { first, groupId, others } = await makeGroup({ nodes: ['node-b', 'node-c'] });
    const remaining = others[1]!;
    await forgetNode(first.context, 'node-b');
    // Taking the new join key checks its verifier with scrypt, which runs on the thread pool.
    await waitFor(() => remaining.runtime.keyMaterial?.currentGeneration === first.runtime.keyMaterial?.currentGeneration);
    const fromFirst = first.runtime.keyMaterial!;
    const fromRemaining = remaining.runtime.keyMaterial!;
    expect(fromRemaining.joinKey).toBe(fromFirst.joinKey);
    expect(fromRemaining.joinVerifier).toBe(fromFirst.joinVerifier);
    expect(await deriveJoinVerifier(fromRemaining.joinKey, deriveJoinSalt(groupId))).toBe(fromRemaining.joinVerifier);
  });
});

describe('a member that missed the rotation announcement', () => {
  test('catches up from the repeated announcement without a restart', async () => {
    const { world: w, first, others } = await makeGroup({ nodes: ['node-b', 'node-c'] });
    const straggler = others[0]!;
    const before = first.runtime.keyMaterial!.currentGeneration;

    w.bus.partition(straggler.transport, 'unplugged');
    await first.runtime.rotate('scheduled', 'test rotation');
    await settle();
    w.bus.heal();
    expect(straggler.runtime.keyMaterial?.currentGeneration).toBe(before);
    expect(others[1]!.runtime.keyMaterial?.currentGeneration).toBe(before + 1);

    await advance(w, 31_000);
    await first.runtime.runHousekeeping();
    await settle();
    expect(straggler.runtime.keyMaterial?.currentGeneration).toBe(before + 1);
    expect(straggler.runtime.keyMaterial?.keys.find((entry) => entry.generation === before + 1)?.key)
      .toBe(first.runtime.keyMaterial?.keys.find((entry) => entry.generation === before + 1)?.key);
  });

  test('a repeat of an announcement a member already adopted changes nothing', async () => {
    const { first, others } = await makeGroup({ nodes: ['node-b'] });
    await first.runtime.rotate('scheduled', 'test rotation');
    await settle();
    const adopted = others[0]!.runtime.keyMaterial;
    await first.runtime.runHousekeeping();
    await settle();
    expect(others[0]!.runtime.keyMaterial).toBe(adopted);
  });
});

describe('who may announce a rotation', () => {
  function announce(world: GroupTestWorld, from: GroupTestNode, to: GroupTestNode, input: { readonly nodeId: string; readonly generation: number }): string {
    const material = from.runtime.keyMaterial!;
    const wrap = sealForMember(to.runtime.keyMaterial!.node.agreement.publicKey, JSON.stringify({ key: 'attacker-chosen-key' }), 'goodvibes-cluster-rekey-v1');
    return encodeEnvelope({
      type: 'REKEY', nodeId: input.nodeId, nodeVersion: '1.0.0', seq: 1, ts: world.clock.now(), surfaceId: null,
      body: { cause: 'scheduled', generation: input.generation, createdAt: world.clock.now(), mintedBy: '', wraps: { [to.id]: wrap } },
    }, from.runtime.keyring());
  }

  test('a machine that is not on the roster cannot move the group to a new key', async () => {
    const { world: w, first, others } = await makeGroup({ nodes: ['node-b'] });
    const target = others[0]!;
    const generation = target.runtime.keyMaterial!.currentGeneration;
    const stray = w.bus.createTransport('stray');
    await stray.start(() => {});
    await stray.send(announce(w, first, target, { nodeId: 'ghost', generation: generation + 1 }));
    await settle();
    expect(target.runtime.keyMaterial?.currentGeneration).toBe(generation);
  });

  test('a roster member cannot skip generations', async () => {
    const { world: w, first, others } = await makeGroup({ nodes: ['node-b'] });
    const target = others[0]!;
    const generation = target.runtime.keyMaterial!.currentGeneration;
    const stray = w.bus.createTransport('stray');
    await stray.start(() => {});
    await stray.send(announce(w, first, target, { nodeId: 'node-a', generation: generation + 5 }));
    await settle();
    expect(target.runtime.keyMaterial?.currentGeneration).toBe(generation);
  });

  test('a rotation that skips a generation tells the composition the group key moved on', async () => {
    let lost = 0;
    const { world: w, first, others } = await makeGroup({ nodes: ['node-b'], onKeyGenerationLost: () => { lost += 1; } });
    const target = others[0]!;
    const generation = target.runtime.keyMaterial!.currentGeneration;
    const stray = w.bus.createTransport('stray');
    await stray.start(() => {});
    await stray.send(announce(w, first, target, { nodeId: 'node-a', generation: generation + 5 }));
    await settle();
    expect(lost).toBe(1);
    await stray.send(announce(w, first, target, { nodeId: 'node-a', generation: generation + 1 }));
    await settle();
    expect(lost).toBe(1);
  });

  test('a datagram under a key generation this machine never held tells the composition the group key moved on', async () => {
    let lost = 0;
    const { world: w, first, others } = await makeGroup({ nodes: ['node-b'], onKeyGenerationLost: () => { lost += 1; } });
    const generation = others[0]!.runtime.keyMaterial!.currentGeneration;
    const ahead: ClusterKeyring = {
      groupId: first.runtime.keyring().groupId,
      currentGeneration: generation + 4,
      keyForGeneration: () => 'a-key-this-member-never-received',
      acceptedGenerations: () => [generation + 4],
    };
    const stray = w.bus.createTransport('stray');
    await stray.start(() => {});
    await stray.send(encodeEnvelope({ type: 'BEACON', nodeId: 'ghost', nodeVersion: '1', seq: 1, ts: w.clock.now(), surfaceId: null, body: {} }, ahead));
    await settle();
    expect(lost).toBe(1);
    expect(others[0]!.runtime.keyMaterial?.currentGeneration).toBe(generation);
  });
});

describe('a machine that does not know its roster', () => {
  test('does not take itself for the minter and rotate the group key alone', async () => {
    const { world: w, first } = await makeGroup();
    await first.runtime.stop();
    rmSync(join(first.stateDirectory, 'group-state.json'), { force: true });
    const restarted = await addGroupNode(w, 'node-a-again', { reuse: first, nodeId: 'node-a' });
    expect(restarted.runtime.groupState?.members).toEqual([]);

    w.clock.advance(2 * 60 * 60 * 1_000);
    // The pass ends in an error of its own once it reaches replication, with no roster to check against.
    await restarted.runtime.runHousekeeping().catch(() => undefined);
    await settle();
    expect(datagramsOfType(w, 'REKEY')).toHaveLength(0);
    expect(restarted.runtime.keyMaterial?.currentGeneration).toBe(0);
  });
});

describe('a rotation prepared while another is adopted', () => {
  test('is abandoned instead of overwriting the adopted material', async () => {
    const { first } = await makeGroup();
    const rotating = first.runtime.rotate('revocation', 'test');
    const interleaved = { ...first.runtime.keyMaterial!, previousAcceptedUntil: 123 };
    await first.runtime.commitMaterial(interleaved);
    await expect(rotating).rejects.toBeInstanceOf(ClusterMembershipOperationError);
    expect(first.runtime.keyMaterial).toBe(interleaved);
  });
});

describe('operator verbs answer with structured results', () => {
  test('forget and rename refuse while sharing is switched off', async () => {
    const created = createGroupWorld();
    world = created;
    const node = await addGroupNode(created, 'node-a', { settings: { enabled: false } });
    const made = await createGroup(node.context, { displayName: 'workshop' });
    expect(made.ok).toBe(true);
    const forgotten = await forgetNode(node.context, 'node-b');
    expect(forgotten.ok).toBe(false);
    if (!forgotten.ok) expect(forgotten.error).toContain('switched off');
    const renamed = await renameGroupTo(node.context, 'new name');
    expect(renamed.ok).toBe(false);
    expect(node.runtime.groupState?.displayName).toBe('workshop');
  });

  test('a removal whose key replacement fails says it is half done and how to finish it', async () => {
    const { first } = await makeGroup({ nodes: ['node-b'] });
    const failing = spyOn(first.runtime, 'commitMaterial').mockRejectedValue(new ClusterMembershipOperationError('abandoned'));
    const result = await forgetNode(first.context, 'node-b');
    failing.mockRestore();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('taken off the roster');
    expect(result.fix).toContain('cluster rotate --now');
    expect(result.failure).toBe('abandoned');
    const roster = groupNodes(first.context);
    expect(roster.ok && roster.data.removed.map((entry) => entry.nodeId)).toEqual(['node-b']);

    const finished = await rotateGroupKey(first.context, { immediate: true });
    expect(finished.ok).toBe(true);
  });

  test('a join whose first settings request fails is still a join, with a warning', async () => {
    const { first, groupId, joinKey } = await makeGroup();
    expect(first.runtime.membership).toBe('member');
    const second = await addGroupNode(world!, 'node-b');
    const failing = spyOn(second.runtime, 'requestConfigSnapshot').mockRejectedValue(new Error('udp down'));
    const joined = await joinGroup(second.context, { groupId, joinKey });
    failing.mockRestore();
    expect(joined.ok).toBe(true);
    if (!joined.ok) return;
    expect(joined.data.warning).toContain('udp down');
    expect(second.runtime.membership).toBe('member');
  });
});

describe('what the runtime writes to its log and remembers', () => {
  test('group work that fails with an unexpected error logs what the error was', async () => {
    const created = createGroupWorld();
    world = created;
    const lines: { message: string; fields: unknown }[] = [];
    const logger: ClusterLogger = {
      debug: () => {}, info: () => {}, error: () => {},
      warn: (message, fields) => { lines.push({ message, fields }); },
    };
    const node = await addGroupNode(created, 'node-a', { logger });
    const runGroupWork = Reflect.get(node.runtime, 'runGroupWork') as (work: () => Promise<void>) => Promise<void>;
    await runGroupWork.call(node.runtime, async () => { throw new Error('replica disk exploded'); }).catch(() => undefined);
    await settle();
    const line = lines.find((entry) => entry.message === 'cluster: owned group work failed');
    expect(JSON.stringify(line?.fields)).toContain('replica disk exploded');
  });

  test('groups seen in beacons are bounded and a malformed group id is never listed', async () => {
    const { world: w, first } = await makeGroup();
    const stray = w.bus.createTransport('stray');
    await stray.start(() => {});
    const beacon = (groupId: string, index: number): string => encodeEnvelope(
      { type: 'BEACON', nodeId: 'stranger', nodeVersion: '1.0.0', seq: index, ts: w.clock.now(), surfaceId: null, body: { displayName: `group ${index}`, nodeCount: 1 } },
      { groupId, currentGeneration: 0, keyForGeneration: () => 'k', acceptedGenerations: () => [0] },
    );
    let newest = '';
    for (let index = 0; index < 100; index += 1) {
      newest = generateGroupId();
      await stray.send(beacon(newest, index));
    }
    await stray.send(beacon('not a group id', 1_000));
    await settle();
    const listed = first.runtime.groupsOnTheNetwork();
    expect(listed.length).toBeLessThanOrEqual(32);
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.some((entry) => entry.groupId === newest)).toBe(true);
    expect(listed.some((entry) => entry.groupId === 'not a group id')).toBe(false);
  });
});

describe('a removal and a return are not undone by an older copy of the roster', () => {
  const identity = { identityKey: 'k'.repeat(43), agreementKey: 'a'.repeat(43) };
  const input = { nodeId: 'machine-x', displayName: 'x', ...identity, now: 1_000 };

  test('a copy that still carries the older removal does not count the machine as removed again', () => {
    const empty = createGroupStateDocument('gTESTTESTTESTTEST', 'group');
    const joined = admitMember(empty, input).state;
    const removed = removeMember(joined, 'machine-x', 'gone', 2_000);
    const returned = readmitMember(removed, { ...input, now: 3_000 }).state;
    const merged = mergeGroupState(returned, removed);
    expect(merged.members.some((member) => member.nodeId === 'machine-x')).toBe(true);
    expect(merged.tombstones).toEqual([]);
    expect(findTombstone(merged, 'machine-x')).toBeNull();
    expect(decideAdmission(merged, { nodeId: 'machine-x', ts: 5_000, now: 5_000, provedCurrentJoinKey: false, provedHistoricalKey: true }, MAX_GROUP_MEMBERS))
      .toEqual({ admit: true, path: 'rejoin' });
  });

  test('a removal at the same generation as the machine still wins', () => {
    const empty = createGroupStateDocument('gTESTTESTTESTTEST', 'group');
    const removed = removeMember(admitMember(empty, input).state, 'machine-x', 'gone', 2_000);
    expect(removed.members).toEqual([]);
    expect(findTombstone(removed, 'machine-x')).not.toBeNull();
  });
});

describe('roster and grant stay inside one datagram', () => {
  function fullState(): GroupStateDocument {
    let state = createGroupStateDocument(generateGroupId(), 'a group with a long enough name to count');
    for (let index = 0; index < MAX_GROUP_MEMBERS; index += 1) {
      const node = generateNodeKeyMaterial();
      state = admitMember(state, {
        nodeId: `machine-${String(index).padStart(3, '0')}-${'n'.repeat(60)}`,
        displayName: `machine number ${index} with a descriptive label`,
        identityKey: node.identity.publicKey, agreementKey: node.agreement.publicKey, now: 1_000 + index,
      }).state;
    }
    for (let index = 0; index < MAX_GROUP_TOMBSTONES; index += 1) {
      state = removeMember(
        { ...state, tombstones: state.tombstones },
        `retired-${String(index).padStart(3, '0')}-${'r'.repeat(60)}`, 'removed by the operator', 10_000 + index,
      );
    }
    return state;
  }

  test('a full roster is trimmed to fit, keeping every member and the newest removals', () => {
    const state = fullState();
    expect(Buffer.byteLength(JSON.stringify(state), 'utf8')).toBeGreaterThan(MAX_ENVELOPE_BYTES);
    const fitted = fitStateToBytes(state, 24_000);
    expect(Buffer.byteLength(JSON.stringify(fitted.state), 'utf8')).toBeLessThanOrEqual(24_000);
    expect(fitted.state.members).toHaveLength(MAX_GROUP_MEMBERS);
    expect(fitted.droppedTombstones).toBeGreaterThan(0);
    const newest = [...state.tombstones].sort((a, b) => b.at - a.at)[0]!;
    expect(fitted.state.tombstones.some((entry) => entry.nodeId === newest.nodeId)).toBe(true);
    expect(state.tombstones.length).toBe(MAX_GROUP_TOMBSTONES);
    expect(() => encodeEnvelope(
      { type: 'ROSTER', nodeId: 'n', nodeVersion: '1', seq: 1, ts: 1, surfaceId: null, body: { state: fitted.state, configRevision: 0 } },
      { groupId: state.groupId, currentGeneration: 0, keyForGeneration: () => 'key', acceptedGenerations: () => [0] },
    )).not.toThrow();
  });

  test('a sealed grant for a full group fits a datagram and opens', () => {
    const state = fullState();
    const node = generateNodeKeyMaterial();
    const keys = Array.from({ length: 16 }, (_, generation) => ({ generation, key: 'k'.repeat(43), createdAt: 1, mintedBy: 'node-a' }));
    const sealed = sealGrant({
      joinKey: 'gvj1-AAAA-BBBB-CCCC-DDDD-EEEE', joinSalt: 's'.repeat(22), joinVerifier: 'v'.repeat(64), keys, currentGeneration: 15, state,
      groupSigning: { ...node.identity, generation: 3 },
    }, node.agreement.publicKey, 'join');
    expect(Buffer.byteLength(JSON.stringify({ body: { forNodeId: 'x', sealed } }), 'utf8')).toBeLessThan(MAX_ENVELOPE_BYTES - 2_000);
    const opened = openGrant(node, sealed, 'join');
    expect(opened?.state.members).toHaveLength(MAX_GROUP_MEMBERS);
    expect(opened?.state.tombstones.length).toBeLessThan(MAX_GROUP_TOMBSTONES);
    expect(GRANT_STATE_MAX_BYTES).toBeLessThan(MAX_ENVELOPE_BYTES / 1.5);
  });
});

describe('a datagram is only as fresh as its timestamp', () => {
  const surfaceId = null;
  const message = (ts: number) => ({
    v: CLUSTER_PROTOCOL_VERSION, type: 'HEARTBEAT' as const, surfaceId, nodeId: 'node-a', nodeVersion: '1.0.0', seq: 5, ts,
  });

  test('a signed election datagram an hour old is rejected, a current one is not', () => {
    const now = 1_700_000_000_000;
    const old = encodeMessage(message(now - 60 * 60 * 1_000), 'phrase');
    expect(decodeMessage(old, 'phrase', now).message).toBeNull();
    expect(decodeMessage(old, 'phrase', now).rejected).toContain('timestamp');
    const fresh = encodeMessage(message(now - 1_000), 'phrase');
    expect(decodeMessage(fresh, 'phrase', now).message).not.toBeNull();
    // Without a clock to compare with, nothing changes for existing callers.
    expect(decodeMessage(old, 'phrase').message).not.toBeNull();
    expect(MAX_DATAGRAM_SKEW_MS).toBeGreaterThan(60_000);
  });

  test('a replayed group datagram an hour old is dropped before anything acts on it', () => {
    const ring: ClusterKeyring = { groupId: 'gTESTTESTTESTTEST', currentGeneration: 1, keyForGeneration: () => 'key', acceptedGenerations: () => [1] };
    const now = 1_700_000_000_000;
    const delivered: string[] = [];
    const inner: ClusterTransport = {
      start: async () => {}, send: async () => {}, stop: async () => {},
      describe: () => ({ mode: 'in-memory', group: 'memory', port: 0, peers: [] }),
    };
    const router = new GroupWireRouter({
      inner, keyring: ring, now: () => now,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      onGroupMessage: (envelope) => { delivered.push(envelope.type); },
      onOutOfBandMessage: () => {}, onForeignBeacon: () => {},
    });
    const receive = (raw: string): void => (router as unknown as { receive(raw: string): void }).receive(raw);
    const datagram = (ts: number): string => encodeEnvelope({ type: 'BEACON', nodeId: 'n', nodeVersion: '1', seq: 1, ts, surfaceId: null, body: {} }, ring);

    receive(datagram(now - 60 * 60 * 1_000));
    expect(delivered).toEqual([]);
    expect(router.counters.droppedMalformed).toBe(1);
    receive(datagram(now - 1_000));
    expect(delivered).toEqual(['BEACON']);
  });
});

describe('release candidates are ordered as versions', () => {
  test('rc.10 is newer than rc.9, and a longer tag is newer than its prefix', () => {
    expect(compareVersions('1.0.0-rc.10', '1.0.0-rc.9')).toBe(1);
    expect(compareVersions('1.0.0-rc.9', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-rc.1.1', '1.0.0-rc.1')).toBe(1);
    expect(compareVersions('1.0.0-rc.1', '1.0.0-beta.1')).toBe(1);
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(-1);
    expect(compareVersions('1.0.0', '1.0.0-rc.10')).toBe(1);
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.2')).toBe(0);
  });
});
