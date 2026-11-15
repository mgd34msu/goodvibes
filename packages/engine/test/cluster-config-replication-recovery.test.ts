/**
 * cluster-config-replication-recovery.test.ts, a settings replica that missed
 * something, or was told something it should not believe.
 *
 * These drive one ConfigReplicationService through its host seam (no transport,
 * no group runtime), so every message is delivered exactly as the test says and
 * a lost datagram is simply one that is never handed over.
 */
import { describe, expect, test } from 'bun:test';
import { ConfigReplicationService, CONFIG_MESSAGE_TYPES, type ConfigReplicationHost, type ReplicatedConfigStore, type ReplicatedSecretStore } from '../platform/src/platform/cluster/config-replication.js';
import { ConfigSnapshotTransfers, MAX_SENDER_BYTES, prepareConfigSnapshotTransfer, CONFIG_SNAPSHOT_PART } from '../platform/src/platform/cluster/config-snapshot-transfer.js';
import {
  CONFIG_TOMBSTONE_MAX_AGE_MS,
  MAX_REVISION_ADVANCE,
  createConfigReplicaDocument,
  findReplicaEntry,
  mergeConfigReplica,
  readConfigReplicaDocument,
  replicaDigest,
  sweepConfigReplica,
  type ConfigReplicaDocument,
} from '../platform/src/platform/cluster/config-replica.js';
import { isReplicatedConfigPath, listReplicatedConfigPaths, replicatedSecretKeyFor } from '../platform/src/platform/cluster/config-replication-policy.js';
import { isSecretBearingConfigKey } from '../platform/src/platform/cluster/config-replication-privacy.js';
import { generateNodeKeyMaterial, sealForMember } from '../platform/src/platform/cluster/group-crypto.js';
import type { GroupStateDocument } from '../platform/src/platform/cluster/group-state.js';
import type { ClusterEnvelope } from '../platform/src/platform/cluster/protocol-envelope.js';

const GROUP = 'recovery-group';
const PLAIN_PATHS = listReplicatedConfigPaths().filter((path) => !isSecretBearingConfigKey(path));
const PATH_A = PLAIN_PATHS[0]!;
const PATH_B = PLAIN_PATHS[1]!;
const PATH_C = PLAIN_PATHS[2]!;

interface Fixture {
  readonly service: ConfigReplicationService;
  readonly sent: Array<{ type: string; body: Record<string, unknown> }>;
  readonly values: Map<string, unknown>;
  readonly secretValues: Map<string, string>;
  readonly logs: { info: string[]; warn: string[] };
  readonly keys: ReturnType<typeof generateNodeKeyMaterial>;
  readonly nodeId: string;
  advance(ms: number): void;
  /** Adopt a document and mark this copy as holding the group's settings (a peer gossiped the same digest). */
  adoptInStep(document: ConfigReplicaDocument): Promise<void>;
}

const PEER_KEYS = generateNodeKeyMaterial();

function fixture(options: {
  readonly nodeId?: string;
  readonly reset?: boolean;
  readonly members?: readonly { nodeId: string; agreementKey: string }[];
  readonly failSecretGet?: ReadonlySet<string>;
} = {}): Fixture {
  const nodeId = options.nodeId ?? 'self';
  let now = 1_000_000;
  const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
  const values = new Map<string, unknown>();
  const secretValues = new Map<string, string>();
  const logs = { info: [] as string[], warn: [] as string[] };
  const keys = generateNodeKeyMaterial();
  const config: ReplicatedConfigStore = {
    get: (path) => values.get(path),
    set: (path, value) => { values.set(path, value); },
    ...(options.reset === false ? {} : { reset: (path: string) => { values.delete(path); } }),
  };
  const secrets: ReplicatedSecretStore = {
    async get(key) {
      if (options.failSecretGet?.has(key)) throw new Error('secret store unavailable');
      return secretValues.get(key) ?? null;
    },
    async set(key, value) { secretValues.set(key, value); },
    async delete(key) { secretValues.delete(key); },
  };
  const members = [{ nodeId, agreementKey: keys.agreement.publicKey }, ...(options.members ?? [{ nodeId: 'master', agreementKey: PEER_KEYS.agreement.publicKey }])];
  const group = { members: members.map((member) => ({ ...member, displayName: member.nodeId, identityKey: 'k', admittedAt: 0, lastSeenAt: 0, gen: 1 })) } as unknown as GroupStateDocument;
  const host: ConfigReplicationHost = {
    nodeId,
    logger: { debug() {}, info: (message) => { logs.info.push(message); }, warn: (message) => { logs.warn.push(message); }, error() {} },
    now: () => now,
    groupState: () => group,
    answersFor: () => true,
    captureAuthority: () => () => {},
    nodeKeys: () => keys,
    config: () => config,
    secrets: () => secrets,
    async send(type, body) { sent.push({ type, body: structuredClone(body) }); },
    persist() {},
  };
  const service = new ConfigReplicationService(host, GROUP);
  return {
    service, sent, values, secretValues, logs, keys, nodeId,
    advance(ms) { now += ms; },
    async adoptInStep(document) { service.adopt(document); await service.notePeerReplica('master', document.revision, service.digest); },
  };
}

function envelope(type: string, body: Record<string, unknown>, nodeId = 'master', seq = 1): ClusterEnvelope {
  return { v: 1, groupId: GROUP, keyGen: 1, surfaceId: null, type, nodeId, nodeVersion: '3.3.0', seq, ts: 1, body };
}

function documentAt(revision: number, entries: ReadonlyArray<{ path: string; value: unknown; revision: number; origin?: string; secret?: boolean }>): ConfigReplicaDocument {
  return {
    version: 1, groupId: GROUP, revision, tombstones: [],
    entries: entries.map((entry) => ({ path: entry.path, value: entry.value, revision: entry.revision, origin: entry.origin ?? 'master', at: 1, secret: entry.secret === true })),
  };
}

const delta = (entries: ReadonlyArray<{ path: string; value: unknown; revision: number; origin?: string }>) =>
  ({ entries: entries.map((entry) => ({ path: entry.path, value: entry.value, revision: entry.revision, origin: entry.origin ?? 'master', at: 1, secret: false })) });

describe('a replica that missed a change', () => {
  test('a delta that skips a revision is noticed even though the revisions then match, and a snapshot closes it', async () => {
    const f = fixture();
    await f.adoptInStep(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    // Revision 11 was lost; 12 arrives.
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'b', revision: 12 }])));
    expect(f.service.replica.revision).toBe(12);
    expect(f.service.status().awaitingSync).toBe(true);
    expect(f.service.needsSnapshot).toBe(true);
    const requests = () => f.sent.filter((message) => message.type === CONFIG_MESSAGE_TYPES.request);
    // Asked of the member that sent the change, which saw what was missed.
    expect(requests().map((message) => message.body)).toEqual([{ to: 'master' }]);

    const full = documentAt(12, [
      { path: PATH_A, value: 'a', revision: 10 },
      { path: PATH_C, value: 'the one that was lost', revision: 11 },
      { path: PATH_B, value: 'b', revision: 12 },
    ]);
    // The peer's gossip says revision 12, which equals ours; its digest still shows the difference.
    await f.service.notePeerReplica('master', 12, replicaDigest(full));
    expect(requests()).toHaveLength(2);
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.snapshot, { document: full }));
    expect(f.service.status().awaitingSync).toBe(false);
    expect(f.service.needsSnapshot).toBe(false);
    expect(f.values.get(PATH_C)).toBe('the one that was lost');
  });

  test('a snapshot older than the revision known to exist does not close the gap', async () => {
    const f = fixture();
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'b', revision: 15 }])));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.snapshot, { document: documentAt(12, [{ path: PATH_A, value: 'a', revision: 10 }]) }));
    expect(f.service.status().awaitingSync).toBe(true);
  });

  test('consecutive deltas never ask for a snapshot', async () => {
    const f = fixture();
    await f.adoptInStep(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'b', revision: 11 }])));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_C, value: 'c', revision: 12 }]), 'master', 2));
    expect(f.service.status().awaitingSync).toBe(false);
    expect(f.sent).toEqual([]);
  });
});

describe('what a member may tell the group', () => {
  test('changes the sender did not originate are not applied', async () => {
    const f = fixture();
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'planted', revision: 11, origin: 'someone-else' }]), 'member'));
    expect(f.values.has(PATH_B)).toBe(false);
    expect(f.service.replica.revision).toBe(10);
  });

  test('a revision that is not a safe integer cannot take over the counter', async () => {
    const f = fixture();
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'huge', revision: 1e300, origin: 'member' }]), 'member'));
    expect(f.values.has(PATH_B)).toBe(false);
    expect(f.service.replica.revision).toBe(10);
    expect(readConfigReplicaDocument({ version: 1, groupId: GROUP, revision: 1e300, entries: [], tombstones: [] }, isReplicatedConfigPath)).toBeNull();
  });

  test('a delta or snapshot far ahead of this copy is ignored', async () => {
    const f = fixture();
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    const far = 10 + MAX_REVISION_ADVANCE + 1;
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'far', revision: far, origin: 'member' }]), 'member'));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.snapshot, { document: documentAt(far, [{ path: PATH_C, value: 'far', revision: far }]) }));
    expect(f.values.size).toBe(0);
    expect(f.service.replica.revision).toBe(10);
    expect(f.logs.warn).toContain('cluster: ignored replicated settings claiming an implausible revision');
  });

  test('the master\'s own delta, at the next revision, still applies', async () => {
    const f = fixture();
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, delta([{ path: PATH_B, value: 'ok', revision: 11 }])));
    expect(f.values.get(PATH_B)).toBe('ok');
  });
});

describe('credentials that travel separately from their markers', () => {
  const [SECRET_A, SECRET_B] = PLAIN_PATHS.slice(3, 5) as [string, string];

  test('a credential that cannot be sent does not stop the ones after it', async () => {
    const asker = generateNodeKeyMaterial();
    const f = fixture({
      members: [{ nodeId: 'asker', agreementKey: asker.agreement.publicKey }],
      failSecretGet: new Set([replicatedSecretKeyFor(SECRET_A)]),
    });
    f.secretValues.set(replicatedSecretKeyFor(SECRET_B), 'second-value');
    f.service.adopt(documentAt(8, [
      { path: SECRET_A, value: { secretRevision: 7 }, revision: 7, secret: true },
      { path: SECRET_B, value: { secretRevision: 8 }, revision: 8, secret: true },
    ]));
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.request, {}, 'asker'));
    const credentials = f.sent.filter((message) => typeof message.body['secretPath'] === 'string');
    expect(credentials.map((message) => message.body['secretPath'])).toEqual([SECRET_B]);
    expect(f.logs.warn).toContain('cluster: a credential could not be sent to a joining machine and was skipped');
  });

  test('a marker without its credential is reported, asked for again at a bounded rate, and cleared when the value arrives', async () => {
    const f = fixture();
    await f.adoptInStep(documentAt(8, [{ path: SECRET_A, value: { secretRevision: 8 }, revision: 8, secret: true }]));
    await f.service.retryPendingEffects();
    expect(f.service.status().secrets).toBe(1);
    expect(f.service.status().credentialsMissing).toBe(1);
    expect(f.service.needsSnapshot).toBe(true);
    await f.service.requestSnapshot();
    expect(f.service.needsSnapshot).toBe(false);
    f.advance(61_000);
    expect(f.service.needsSnapshot).toBe(true);

    const sealed = sealForMember(f.keys.agreement.publicKey, 'the-credential', 'goodvibes-cluster-config-secret-v1');
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, { secretPath: SECRET_A, origin: 'master', revision: 8, sealed: { self: sealed } }));
    expect(f.secretValues.get(replicatedSecretKeyFor(SECRET_A))).toBe('the-credential');
    expect(f.service.status().credentialsMissing).toBe(0);
    await f.service.retryPendingEffects();
    expect(f.service.status().credentialsMissing).toBe(0);
    expect(f.service.needsSnapshot).toBe(false);
  });
});

describe('an edit made on any machine', () => {
  test('is issued by that machine at the next revision and sent to the group', async () => {
    const f = fixture();
    await f.adoptInStep(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    f.values.set(PATH_B, 'edited-here');
    await f.service.announceLocalChange(PATH_B);
    const deltas = f.sent.filter((message) => message.type === CONFIG_MESSAGE_TYPES.delta);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.body['entries']).toMatchObject([{ path: PATH_B, value: 'edited-here', revision: 11, origin: 'self' }]);
  });

  test('made before this machine holds the group\'s settings, it is held, not lost, and sent above them once it does', async () => {
    const f = fixture();
    f.service.adopt(createConfigReplicaDocument(GROUP));
    f.values.set(PATH_B, 'edited-here');
    await f.service.announceLocalChange(PATH_B);
    expect(f.sent.filter((message) => message.type === CONFIG_MESSAGE_TYPES.delta)).toHaveLength(0);
    expect(f.service.status().localChangesHeld).toBe(1);

    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.snapshot, { document: documentAt(12, [{ path: PATH_B, value: 'group', revision: 12 }]) }));
    expect(f.service.status().localChangesHeld).toBe(0);
    expect(f.values.get(PATH_B)).toBe('edited-here');
    expect(findReplicaEntry(f.service.replica, PATH_B)).toMatchObject({ value: 'edited-here', revision: 13, origin: 'self' });
  });

  test('two copies at the same revision holding different changes exchange them and end equal', async () => {
    const a = fixture({ nodeId: 'node-a', members: [{ nodeId: 'node-b', agreementKey: PEER_KEYS.agreement.publicKey }] });
    const b = fixture({ nodeId: 'node-b', members: [{ nodeId: 'node-a', agreementKey: PEER_KEYS.agreement.publicKey }] });
    await a.adoptInStep(createConfigReplicaDocument(GROUP));
    await b.adoptInStep(createConfigReplicaDocument(GROUP));
    a.values.set(PATH_A, 'from-a'); await a.service.announceLocalChange(PATH_A);
    b.values.set(PATH_B, 'from-b'); await b.service.announceLocalChange(PATH_B);
    // Both deltas were lost; both copies report revision 1.
    a.sent.length = 0; b.sent.length = 0;
    expect(a.service.replica.revision).toBe(b.service.replica.revision);

    const deliver = async (from: Fixture, to: Fixture) => {
      const messages = from.sent.splice(0);
      for (const [index, message] of messages.entries()) await to.service.handle(envelope(message.type, message.body, from.nodeId, index + 1));
    };
    await b.service.notePeerReplica('node-a', a.service.replica.revision, a.service.digest);
    await deliver(b, a);
    await deliver(a, b);
    expect(a.service.digest).toBe(b.service.digest);
    expect(a.values.get(PATH_B)).toBe('from-b');
    expect(b.values.get(PATH_A)).toBe('from-a');
    expect(a.service.status().awaitingSync).toBe(false);
    expect(b.service.status().awaitingSync).toBe(false);
  });
});

describe('a deletion made by another machine', () => {
  const deletion = { deletes: [{ path: PATH_A, revision: 11, origin: 'master', at: 1, secret: false }] };

  test('is applied and logged as applied when the store can reset the setting', async () => {
    const f = fixture();
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    f.values.set(PATH_A, 'a');
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, deletion));
    expect(f.values.has(PATH_A)).toBe(false);
    expect(f.logs.info).toContain('cluster: a setting was deleted by another machine in the group');
  });

  test('is not logged as applied when the store cannot reset it, and the local value stays', async () => {
    const f = fixture({ reset: false });
    f.service.adopt(documentAt(10, [{ path: PATH_A, value: 'a', revision: 10 }]));
    f.values.set(PATH_A, 'a');
    await f.service.handle(envelope(CONFIG_MESSAGE_TYPES.delta, deletion));
    expect(f.values.get(PATH_A)).toBe('a');
    expect(f.logs.info).not.toContain('cluster: a setting was deleted by another machine in the group');
    expect(f.logs.warn.some((message) => message.includes('cannot reset it'))).toBe(true);
  });
});

describe('the replica document', () => {
  const tombstone = (origin: string, at = 1) => ({ path: PATH_A, revision: 5, origin, at, secret: false });
  const base = createConfigReplicaDocument(GROUP);

  test('two deletions at one revision resolve the same way whichever copy hears them first', () => {
    const left: ConfigReplicaDocument = { ...base, revision: 5, tombstones: [tombstone('node-b')] };
    const right: ConfigReplicaDocument = { ...base, revision: 5, tombstones: [tombstone('node-a')] };
    expect(mergeConfigReplica(left, right)).toEqual(mergeConfigReplica(right, left));
    expect(mergeConfigReplica(left, right).tombstones[0]?.origin).toBe('node-a');
  });

  test('a deletion with no recorded time survives the sweep, so it still blocks an older value from a partitioned copy', () => {
    const deleted: ConfigReplicaDocument = { ...base, revision: 5, tombstones: [tombstone('node-a', 0)] };
    const swept = sweepConfigReplica(deleted, CONFIG_TOMBSTONE_MAX_AGE_MS * 2);
    expect(swept.droppedTombstones).toBe(0);
    const stale = documentAt(3, [{ path: PATH_A, value: 'old', revision: 3 }]);
    expect(mergeConfigReplica(swept.document, stale).entries).toEqual([]);
  });

  test('a deletion older than the age limit is still dropped', () => {
    const deleted: ConfigReplicaDocument = { ...base, revision: 5, tombstones: [tombstone('node-a', 10)] };
    expect(sweepConfigReplica(deleted, CONFIG_TOMBSTONE_MAX_AGE_MS + 1_000).droppedTombstones).toBe(1);
  });
});

describe('snapshot transfer buffering', () => {
  function partEnvelope(body: Record<string, unknown>, nodeId: string, seq: number): ClusterEnvelope {
    return envelope(CONFIG_SNAPSHOT_PART, body, nodeId, seq);
  }
  function feed(transfers: ConfigSnapshotTransfers, parts: readonly Readonly<Record<string, unknown>>[], nodeId: string): number {
    let completed = 0;
    parts.forEach((part, index) => {
      if (transfers.accept(partEnvelope({ ...part }, nodeId, index + 1), 1_000, () => {})) completed += 1;
    });
    return completed;
  }

  test('a sender announcing more than its share is refused, so it cannot fill the buffer against everyone else', () => {
    const transfers = new ConfigSnapshotTransfers();
    const hog = prepareConfigSnapshotTransfer({ blob: 'x'.repeat(MAX_SENDER_BYTES + 1024 * 1024) }, 1);
    expect(feed(transfers, hog, 'hog')).toBe(0);
    const honest = prepareConfigSnapshotTransfer({ blob: 'y'.repeat(64 * 1024) }, 1);
    expect(feed(transfers, honest, 'honest')).toBe(1);
  });

  test('a snapshot within the share completes', () => {
    const transfers = new ConfigSnapshotTransfers();
    expect(feed(transfers, prepareConfigSnapshotTransfer({ blob: 'z'.repeat(1024 * 1024) }, 1), 'sender')).toBe(1);
  });
});
