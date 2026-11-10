import { expect, test } from 'bun:test';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { ConfigKey } from '../platform/src/platform/config/schema.js';
import { ConfigReplicationService, CONFIG_MESSAGE_TYPES, type ConfigReplicationHost } from '../platform/src/platform/cluster/config-replication.js';
import { CONFIG_BODY_LIMIT } from '../platform/src/platform/cluster/config-snapshot-transfer.js';
import { createConfigReplicaDocument, isReplicableValue, putReplicaEntry, type ConfigReplicaDocument } from '../platform/src/platform/cluster/config-replica.js';
import { listReplicatedConfigPaths } from '../platform/src/platform/cluster/config-replication-policy.js';
import { isSecretBearingConfigKey } from '../platform/src/platform/cluster/config-replication-privacy.js';
import type { ClusterEnvelope } from '../platform/src/platform/cluster/protocol-envelope.js';
import { makeProjectTempDir } from './_helpers/project-temp.js';

// Framing unit tests start at the already-authenticated service boundary. The
// daemon composition suite separately exercises actual group signatures/bus.
function fixture() {
  let generation = 0, now = 1000;
  const sent: Array<{ type: string; body: Record<string, unknown> }> = [];
  const persisted: ConfigReplicaDocument[] = [];
  const values = new Map<string, unknown>();
  const host: ConfigReplicationHost = { nodeId: 'receiver', logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: () => now, isMaster: () => true, groupState: () => null, nodeKeys: () => null, secrets: () => null,
    config: () => ({ get: key => values.get(key), set: (key, value) => { values.set(key, value); } }),
    captureAuthority: () => { const original = generation; return () => { if (generation !== original) throw Error('Original authenticated membership retired'); }; },
    async send(type, body) { sent.push({ type, body: structuredClone(body) }); }, persist(document) { persisted.push(document); } };
  return { service: new ConfigReplicationService(host, 'owned-group'), sent, persisted, values,
    retire() { generation++; }, advance(ms: number) { now += ms; } };
}
function envelope(body: Record<string, unknown>, seq = 1, type: string = CONFIG_MESSAGE_TYPES.snapshotPart, nodeId = 'sender'): ClusterEnvelope {
  return { v: 1, groupId: 'owned-group', keyGen: 1, surfaceId: null, type, nodeId, nodeVersion: '3.1.2', seq, ts: 1000, body };
}
function largeDocument(): ConfigReplicaDocument {
  const root = makeProjectTempDir('cluster-real-default-snapshot');
  const config = new ConfigManager({ workingDir: root, homeDir: root, surfaceRoot: 'tui' });
  let document = createConfigReplicaDocument('owned-group');
  for (const path of listReplicatedConfigPaths()) {
    if (isSecretBearingConfigKey(path)) continue;
    const value = config.get(path as ConfigKey); if (!isReplicableValue(value)) continue;
    document = putReplicaEntry(document, { path, value, origin: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', at: 1000 });
  }
  expect(Buffer.byteLength(JSON.stringify({ document }))).toBeGreaterThan(CONFIG_BODY_LIMIT);
  return document;
}
async function transfer(document: ConfigReplicaDocument) {
  const sender = fixture(); sender.service.adopt(document);
  await sender.service.handle(envelope({}, 1, CONFIG_MESSAGE_TYPES.request, 'requester'));
  expect(sender.sent.length).toBeGreaterThan(1);
  expect(sender.sent.every(row => row.type === CONFIG_MESSAGE_TYPES.snapshotPart && Buffer.byteLength(JSON.stringify(row.body)) < CONFIG_BODY_LIMIT)).toBe(true);
  return sender.sent;
}

test('ordinary snapshots keep their deployed single-envelope shape', async () => {
  const f = fixture();
  await f.service.handle(envelope({}, 1, CONFIG_MESSAGE_TYPES.request, 'requester'));
  expect(f.sent).toEqual([{ type: CONFIG_MESSAGE_TYPES.snapshot, body: { document: createConfigReplicaDocument('owned-group') } }]);
});

test('large real config defaults publish once only after all authenticated out-of-order parts; duplicate parts cannot replay', async () => {
  const document = largeDocument(), messages = await transfer(document), f = fixture();
  const ordered = [...messages].reverse();
  for (let index = 0; index < ordered.length - 1; index++) {
    await f.service.handle(envelope(ordered[index]!.body, index + 1));
    await f.service.handle(envelope(ordered[index]!.body, index + 1));
    expect(f.persisted).toHaveLength(0); expect(f.service.replica.revision).toBe(0); expect(f.values.size).toBe(0);
  }
  await f.service.handle(envelope(ordered.at(-1)!.body, ordered.length));
  expect(f.persisted).toHaveLength(1); expect(f.service.replica).toEqual(document);
  for (const message of messages) await f.service.handle(envelope(message.body, 100));
  expect(f.persisted).toHaveLength(1);
});

test('loss leaves the previous revision intact; a fresh complete resend replaces the incomplete original', async () => {
  const document = largeDocument(), first = await transfer(document), replacement = await transfer(document), f = fixture();
  for (const message of first.slice(1)) await f.service.handle(envelope(message.body, 2));
  expect(f.persisted).toHaveLength(0); expect(f.service.replica.revision).toBe(0);
  await f.service.handle(envelope(replacement[0]!.body, 100));
  // A delayed old noninitial part cannot replace the fresh original frame.
  await f.service.handle(envelope(first[1]!.body, 99));
  for (const message of replacement.slice(1)) await f.service.handle(envelope(message.body, 101));
  expect(f.persisted).toHaveLength(1); expect(f.service.replica).toEqual(document);
});

test.each(['conflicting-duplicate', 'key-generation', 'retired-owner', 'oversized-header', 'expired'] as const)('%s cannot publish a partial or borrowed snapshot', async failure => {
  const document = largeDocument(), messages = await transfer(document), f = fixture();
  await f.service.handle(envelope(messages[0]!.body));
  if (failure === 'conflicting-duplicate') {
    const bytes = Buffer.from(messages[0]!.body.data as string, 'base64'); bytes[0] = bytes[0]! ^ 1;
    await f.service.handle(envelope({ ...messages[0]!.body, data: bytes.toString('base64') }));
  } else if (failure === 'key-generation') {
    await f.service.handle({ ...envelope(messages[1]!.body), keyGen: 2 });
  } else if (failure === 'retired-owner') f.retire();
  else if (failure === 'oversized-header') await f.service.handle(envelope({ ...messages[0]!.body, bytes: Number.MAX_SAFE_INTEGER }));
  else f.advance(30_001);
  for (const message of messages.slice(1)) await f.service.handle(envelope(message.body, 3));
  if (failure === 'oversized-header') {
    // Invalid unrelated metadata does not revoke the still-valid original.
    expect(f.persisted).toHaveLength(1); expect(f.service.replica).toEqual(document);
  } else { expect(f.persisted).toHaveLength(0); expect(f.service.replica.revision).toBe(0); expect(f.values.size).toBe(0); }
});


test('parts from different authenticated peers cannot complete one another, and owner shutdown releases incomplete transfers', async () => {
  const document = largeDocument(), messages = await transfer(document), f = fixture();
  await f.service.handle(envelope(messages[0]!.body, 1, CONFIG_MESSAGE_TYPES.snapshotPart, 'sender-a'));
  for (const message of messages.slice(1)) await f.service.handle(envelope(message.body, 2, CONFIG_MESSAGE_TYPES.snapshotPart, 'sender-b'));
  expect(f.persisted).toHaveLength(0); expect(f.service.replica.revision).toBe(0);
  f.service.retireSnapshotTransfers();
  for (const message of messages.slice(1)) await f.service.handle(envelope(message.body, 3, CONFIG_MESSAGE_TYPES.snapshotPart, 'sender-a'));
  expect(f.persisted).toHaveLength(0);
  await f.service.handle(envelope(messages[0]!.body, 4, CONFIG_MESSAGE_TYPES.snapshotPart, 'sender-a'));
  expect(f.persisted).toHaveLength(1); expect(f.service.replica).toEqual(document);
});
