/** UNRUN: real signed group flood against an actual held credential read. */
import { expect, test } from 'bun:test';
import { createGroup, joinGroup } from '../sdk/src/platform/cluster/group-operations.ts';
import { CONFIG_MESSAGE_TYPES } from '../sdk/src/platform/cluster/config-replication.ts';
import { MAX_ACTIVE_GROUP_MESSAGES } from '../sdk/src/platform/cluster/ingress-work.ts';
import { encodeEnvelope } from '../sdk/src/platform/cluster/protocol-envelope.ts';
import { replicatedSecretKeyFor } from '../sdk/src/platform/cluster/config-replication-policy.ts';
import { addGroupNode, createGroupWorld, destroyGroupWorld, MemorySecretStore, settle, stopGroupWorld } from './cluster-group-harness.ts';
test('excess authenticated requests never become deferred handlers; stop drains admitted reads without sending late secrets', async () => {
  const release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), world = createGroupWorld();
  const path = 'surfaces.telegram.botToken', key = replicatedSecretKeyFor(path);
  class PausedSecrets extends MemorySecretStore {
    pause = false; reads = 0;
    override async get(selected: string) { const value = await super.get(selected); if (this.pause && selected === key) { this.reads++; entered.resolve(); await release.promise; } return value; }
  }
  const secrets = new PausedSecrets();
  try {
    const master = await addGroupNode(world, 'bounded-master', { secrets, isMaster: true });
    const created = await createGroup(master.context, {}); if (!created.ok) throw Error(created.error);
    const peer = await addGroupNode(world, 'bounded-peer'); const joined = await joinGroup(peer.context, { groupId: created.data.groupId, joinKey: created.data.joinKey }); if (!joined.ok) throw Error(joined.error);
    await secrets.set(key, 'synthetic-held-secret'); await master.runtime.announceSecretChange(path); await settle(); secrets.pause = true;
    for (let i = 0; i < MAX_ACTIVE_GROUP_MESSAGES * 8; i++) await peer.transport.send(encodeEnvelope({ type: CONFIG_MESSAGE_TYPES.request, nodeId: peer.id, nodeVersion: '1.0.0', seq: 100000 + i, ts: world.clock.now(), body: {} }, peer.runtime.keyring()));
    await entered.promise; await settle(); expect(secrets.reads).toBeGreaterThan(0); expect(secrets.reads).toBeLessThanOrEqual(MAX_ACTIVE_GROUP_MESSAGES);
    const admitted = secrets.reads, start = world.wire.length; let stopped = false; const stopping = master.runtime.stop().then(() => { stopped = true; }); await Promise.resolve(); expect(stopped).toBe(false);
    release.resolve(); await stopping; await settle(); expect(secrets.reads).toBe(admitted);
    const laterSecretFrames = world.wire.slice(start).filter(row => row.from === master.id).map(row => JSON.parse(row.raw) as { body?: { sealed?: unknown } }).filter(row => row.body?.sealed !== undefined);
    expect(laterSecretFrames).toHaveLength(0);
  } finally { release.resolve(); await stopGroupWorld(world); destroyGroupWorld(world); }
});
