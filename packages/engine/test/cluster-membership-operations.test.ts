/** Actual runtime/store operation regressions, authored and UNRUN. */
import { expect, spyOn, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClusterGroupVerbs, createGroup, joinGroup, leaveGroup } from '../platform/src/platform/cluster/group-operations.ts';
import { GROUP_MATERIAL_SECRET_KEY, GROUP_STATE_FILENAME, GROUP_REPLICA_FILENAME, observeGroupKeyMaterial, rotateGroupKeyMaterial } from '../platform/src/platform/cluster/group-store.ts';
import { listReplicatedConfigPaths, replicatedSecretKeyFor } from '../platform/src/platform/cluster/config-replication-policy.ts';
import { dispatchClusterGroupRoutes } from '../platform/src/platform/daemon/http/cluster-group-routes.ts';
import { ClusterMembershipOperationError } from '../platform/src/platform/cluster/membership-operation.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, MemorySecretStore, stopGroupWorld } from './cluster-group-harness.ts';
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
class ControlledSecrets extends MemorySecretStore {
  writes = 0; deletes = 0;
  writeWait: ((key: string) => Promise<void>) | undefined;
  deleteWait: (() => Promise<void>) | undefined;
  failWriteAfterEffect = false; failDeleteAfterEffect = false;
  override async set(key: string, value: string) {
    this.writes += 1; await super.set(key, value); await this.writeWait?.(key);
    if (this.failWriteAfterEffect) throw Error('fixture acknowledgement lost');
  }
  override async delete(key: string) {
    this.deletes += 1; await super.delete(key); await this.deleteWait?.();
    if (this.failDeleteAfterEffect) throw Error('fixture acknowledgement lost');
  }
}
test('create reserves before real scrypt; immediate stop drains it without later persistence', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets();
  try {
    const node = await addGroupNode(world, 'create-stop', { secrets });
    const creating = createGroup(node.context, {}); await node.runtime.stop();
    expect(await creating).toMatchObject({ ok: false, failure: 'abandoned' }); expect(secrets.writes).toBe(0);
    expect(await secrets.get(GROUP_MATERIAL_SECRET_KEY)).toBeNull(); expect(existsSync(join(node.stateDirectory, GROUP_STATE_FILENAME))).toBe(false);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('concurrent creates cannot both pass no-group checks and race persistence', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets();
  try {
    const node = await addGroupNode(world, 'concurrent-create', { secrets });
    const first = createGroup(node.context, {}), second = createGroup(node.context, {});
    expect(await second).toMatchObject({ ok: false, failure: 'not-sent' });
    await node.runtime.stop(); expect(await first).toMatchObject({ ok: false, failure: 'abandoned' }); expect(secrets.writes).toBe(0);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('stop drains an entered acknowledged set and its matching roster without re-enabling the stopped keyring', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(), entered = deferred<void>(), release = deferred<void>();
  try {
    const node = await addGroupNode(world, 'entered-create', { secrets });
    secrets.writeWait = async () => { entered.resolve(); await release.promise; };
    const creating = createGroup(node.context, {}); await entered.promise;
    expect(node.runtime.membership).toBe('no-group');
    let stopped = false; const stopping = node.runtime.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(node.runtime.keyring().groupId).toBe('');
    release.resolve(); const result = await creating; expect(result.ok).toBe(true); await stopping;
    const saved = JSON.parse((await secrets.get(GROUP_MATERIAL_SECRET_KEY))!) as { groupId: string };
    const rosterPath = join(node.stateDirectory, GROUP_STATE_FILENAME), roster = JSON.parse(readFileSync(rosterPath, 'utf8')) as { groupId: string };
    expect(roster.groupId).toBe(saved.groupId); expect(statSync(rosterPath).mode & 0o777).toBe(0o600); expect(node.runtime.keyring().groupId).toBe('');
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('a lost set acknowledgement is explicit unknown, preserves actual data and never blindly retries', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets();
  try {
    const node = await addGroupNode(world, 'unknown-create', { secrets }); secrets.failWriteAfterEffect = true;
    const result = await createGroup(node.context, {}); expect(result).toMatchObject({ ok: false, failure: 'persistence-unknown' });
    expect(await secrets.get(GROUP_MATERIAL_SECRET_KEY)).not.toBeNull(); expect(node.runtime.membership).toBe('unreadable-key-material');
    expect(node.runtime.keyring().groupId).toBe(''); expect(node.runtime.keyMaterial).toBeNull();
    expect(createClusterGroupVerbs(node.context).status()).toMatchObject({ ok: true, data: { advice: expect.stringContaining('restart') } });
    expect(await createGroup(node.context, {})).toMatchObject({ ok: false, failure: 'persistence-unknown' }); expect(secrets.writes).toBe(1);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('stop after a real successful JOIN response prevents its unowned continuation from adopting membership', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(); let stopping: Promise<void> | undefined;
  try {
    const owner = await addGroupNode(world, 'join-owner'), creating = await createGroup(owner.context, {}); if (!creating.ok) throw Error(creating.error);
    const node = await addGroupNode(world, 'join-stop', { secrets }), original = node.runtime.requestJoin.bind(node.runtime);
    const intercepted = spyOn(node.runtime, 'requestJoin').mockImplementation(async input => {
      const outcome = await original(input); stopping = node.runtime.stop(); return outcome;
    });
    try {
      expect(await joinGroup(node.context, { groupId: creating.data.groupId, joinKey: creating.data.joinKey })).toMatchObject({ ok: false, failure: 'abandoned' });
      await stopping; expect(secrets.writes).toBe(0); expect(await secrets.get(GROUP_MATERIAL_SECRET_KEY)).toBeNull();
    } finally { intercepted.mockRestore(); }
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('leave deletes only from the actual runtime-owned store, not a mismatched context store', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(), other = new MemorySecretStore();
  try {
    const node = await addGroupNode(world, 'leave-owner', { secrets }), created = await createGroup(node.context, {}); expect(created.ok).toBe(true);
    await other.set(GROUP_MATERIAL_SECRET_KEY, 'unrelated store sentinel');
    expect((await leaveGroup({ ...node.context, secrets: other })).ok).toBe(true);
    expect(await secrets.get(GROUP_MATERIAL_SECRET_KEY)).toBeNull(); expect(await other.get(GROUP_MATERIAL_SECRET_KEY)).toBe('unrelated store sentinel');
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('stop drains an entered delete; a lost delete acknowledgement is unknown without restoring deleted keys', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(), entered = deferred<void>(), release = deferred<void>();
  try {
    const node = await addGroupNode(world, 'leave-unknown', { secrets }); expect((await createGroup(node.context, {})).ok).toBe(true);
    secrets.deleteWait = async () => { entered.resolve(); await release.promise; }; secrets.failDeleteAfterEffect = true;
    const leaving = leaveGroup(node.context); await entered.promise; const stopping = node.runtime.stop(); release.resolve();
    expect(await leaving).toMatchObject({ ok: false, failure: 'persistence-unknown' }); await stopping;
    expect(await secrets.get(GROUP_MATERIAL_SECRET_KEY)).toBeNull(); expect(secrets.writes).toBe(1); expect(secrets.deletes).toBe(1);
    expect(node.runtime.keyring().groupId).toBe(''); expect(node.runtime.membership).toBe('unreadable-key-material');
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});
test('queued material writes preserve the original observed source and reject stale replacements before writing', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(), entered = deferred<void>(), release = deferred<void>();
  try {
    const node = await addGroupNode(world, 'queued-material', { secrets }); expect((await createGroup(node.context, {})).ok).toBe(true);
    const original = node.runtime.keyMaterial!, rotated = rotateGroupKeyMaterial(original, 'scheduled', node.id, world.clock.now(), 1000);
    secrets.writeWait = async () => { entered.resolve(); await release.promise; };
    const first = node.runtime.commitMaterial(rotated);
    // Observe early failure as well as entry, so a regression before the store
    // boundary cannot strand the held-write fixture during teardown.
    await Promise.race([entered.promise, first.then(() => { throw new Error('Material write settled before entering the store'); })]);
    const stale = node.runtime.commitMaterial({ ...original, keys: [...original.keys] });
    // Bun's promise matcher waits for settlement. Observe rejection without a
    // matcher until the original write is released and the queue can advance.
    const outcome = stale.then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
    release.resolve(); await first;
    const rejected = await outcome;
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error('Stale material unexpectedly persisted');
    expect(rejected.error).toBeInstanceOf(ClusterMembershipOperationError);
    if (!(rejected.error instanceof ClusterMembershipOperationError)) throw rejected.error;
    expect(rejected.error.kind).toBe('abandoned');
    expect(secrets.writes).toBe(2);
    expect(node.runtime.keyMaterial?.currentGeneration).toBe(rotated.currentGeneration);
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});


test('replacing the original state parent during an entered secret set preserves the foreign tree and reports unknown', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(), entered = deferred<void>(), release = deferred<void>();
  try {
    const node = await addGroupNode(world, 'replaced-public-parent', { secrets });
    secrets.writeWait = async () => { entered.resolve(); await release.promise; };
    const creating = createGroup(node.context, {}); await entered.promise;
    renameSync(node.stateDirectory, `${node.stateDirectory}.original`); mkdirSync(node.stateDirectory); writeFileSync(join(node.stateDirectory, 'foreign.txt'), 'keep');
    release.resolve(); expect(await creating).toMatchObject({ ok: false, failure: 'persistence-unknown' });
    expect(readFileSync(join(node.stateDirectory, 'foreign.txt'), 'utf8')).toBe('keep'); expect(existsSync(join(node.stateDirectory, GROUP_STATE_FILENAME))).toBe(false);
    expect(await secrets.get(GROUP_MATERIAL_SECRET_KEY)).not.toBeNull(); expect(node.runtime.keyring().groupId).toBe('');
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('restart ignores an intact previous-group replica without deleting the saved file', async () => {
  const world = createGroupWorld();
  try {
    const node = await addGroupNode(world, 'replica-membership', { isMaster: true });
    const first = await createGroup(node.context, {}); if (!first.ok) throw Error(first.error);
    const path = listReplicatedConfigPaths()[0]!; node.config.set(path, 'fixture group value'); await node.runtime.announceConfigChange(path);
    const replicaPath = join(node.stateDirectory, GROUP_REPLICA_FILENAME), oldBytes = readFileSync(replicaPath, 'utf8');
    expect((JSON.parse(oldBytes) as { groupId: string }).groupId).toBe(first.data.groupId);
    expect((await leaveGroup(node.context)).ok).toBe(true); const next = await createGroup(node.context, {}); if (!next.ok) throw Error(next.error);
    await node.runtime.stop(); const restarted = await addGroupNode(world, 'replica-restarted', { reuse: node, isMaster: true });
    expect(restarted.runtime.replicaDocument()?.groupId).toBe(next.data.groupId); expect(restarted.runtime.replicaDocument()?.entries).toEqual([]);
    expect(readFileSync(replicaPath, 'utf8')).toBe(oldBytes);
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('stop drains an actual authenticated inbound secret write before the runtime releases its store lifetime', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets(), entered = deferred<void>(), release = deferred<void>();
  try {
    const owner = await addGroupNode(world, 'replication-owner', { isMaster: true }), created = await createGroup(owner.context, {}); if (!created.ok) throw Error(created.error);
    const node = await addGroupNode(world, 'replication-target', { secrets }); expect((await joinGroup(node.context, { groupId: created.data.groupId, joinKey: created.data.joinKey })).ok).toBe(true);
    const path = listReplicatedConfigPaths().find(value => value.startsWith('surfaces.'))!; expect(path).toBeDefined();
    const key = replicatedSecretKeyFor(path); await owner.secrets.set(key, 'fixture peer credential');
    secrets.writeWait = async writtenKey => { if (writtenKey === key) { entered.resolve(); await release.promise; } };
    const announced = owner.runtime.announceSecretChange(path); await entered.promise;
    let stopped = false; const stopping = node.runtime.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    release.resolve(); await announced; await stopping;
    expect(await secrets.get(key)).toBe('fixture peer credential'); expect(node.runtime.keyring().groupId).toBe('');
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});

test('HTTP membership failure preserves explicit persistence-unknown instead of erasing it at the route boundary', async () => {
  const world = createGroupWorld(), secrets = new ControlledSecrets();
  try {
    const node = await addGroupNode(world, 'unknown-route', { secrets }); secrets.failWriteAfterEffect = true;
    const response = await dispatchClusterGroupRoutes(new Request('http://localhost/api/cluster/create', { method: 'POST', body: '{}' }), {
      verbs: createClusterGroupVerbs(node.context), requireAdmin: () => null, parseJsonBody: async () => ({}),
    });
    expect(response?.status).toBe(409); expect(await response?.json()).toMatchObject({ ok: false, failure: 'persistence-unknown' });
  } finally { await stopGroupWorld(world); destroyGroupWorld(world); }
});


test('one store observation distinguishes unreadable data without replacing it with a mutable second read', async () => {
  let reads = 0;
  const observation = await observeGroupKeyMaterial({ async get() { reads += 1; return reads === 1 ? 'unreadable' : null; }, async set() {}, async delete() {} });
  expect(observation).toEqual({ material: null, unreadable: true }); expect(reads).toBe(1);
});
