/** Real admission/crypto ownership regressions, authored and UNRUN. */
import { expect, test } from 'bun:test';
import { GroupAdmissionService, type AdmissionHost } from '../platform/src/platform/cluster/group-admissions.ts';
import { FakeClusterClock } from '../platform/src/platform/cluster/clock.ts';
import { deriveJoinSalt, deriveJoinVerifier, generateNodeKeyMaterial } from '../platform/src/platform/cluster/group-crypto.ts';
import { createGroupKeyMaterial, type GroupKeyMaterial } from '../platform/src/platform/cluster/group-store.ts';
import { admitMember, createGroupStateDocument, type GroupStateDocument } from '../platform/src/platform/cluster/group-state.ts';
import { encodeIdentityClassMessage, encodeJoinClassMessage, GROUP_MESSAGE_TYPES, sealGrant } from '../platform/src/platform/cluster/group-membership.ts';
import { readUnverifiedEnvelope } from '../platform/src/platform/cluster/protocol-envelope.ts';
const groupId = 'gTESTTESTTESTTEST', joinKey = 'fixture passphrase with sufficient entropy';
const logger = { debug() {}, info() {}, warn() {}, error() {} };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const clock = new FakeClusterClock(), salt = deriveJoinSalt(groupId), verifier = await deriveJoinVerifier(joinKey, salt);
  const material = createGroupKeyMaterial({ groupId, joinKey, joinSalt: salt, joinVerifier: verifier, nodeId: 'owner', now: clock.now() });
  const state = admitMember(createGroupStateDocument(groupId, 'fixture', { publicKey: material.groupSigning.publicKey, generation: material.groupSigning.generation }), {
    nodeId: 'owner', displayName: 'fixture', identityKey: material.node.identity.publicKey, agreementKey: material.node.agreement.publicKey, now: clock.now(),
  }).state;
  let currentMaterial: GroupKeyMaterial | null = material, currentState: GroupStateDocument | null = state;
  let afterCommit: (() => Promise<void>) | undefined;
  const sent: string[] = [], nextSend = deferred<string>();
  const host: AdmissionHost = { nodeId: 'owner', nodeDisplayName: 'fixture', version: '3.1.2', clock, logger,
    material: () => currentMaterial, state: () => currentState, nextSeq: () => sent.length + 1,
    async commitState(next) { currentState = next; await afterCommit?.(); },
    async send(raw) { sent.push(raw); nextSend.resolve(raw); },
  };
  return { service: new GroupAdmissionService(host), clock, material, state, sent, nextSend: nextSend.promise,
    setOwner(material: GroupKeyMaterial | null, state: GroupStateDocument | null) { currentMaterial = material; currentState = state; },
    delayCommit(callback: () => Promise<void>) { afterCommit = callback; },
  };
}
function grant(f: Awaited<ReturnType<typeof fixture>>, state = f.state) {
  const material = f.material;
  return { joinKey, joinSalt: material.joinSalt, joinVerifier: material.joinVerifier, keys: material.keys,
    currentGeneration: material.currentGeneration, state, groupSigning: material.groupSigning };
}
function reply(f: Awaited<ReturnType<typeof fixture>>, path: 'join' | 'rejoin', envelopeGroup: string, state = f.state) {
  const draft = { type: path === 'join' ? GROUP_MESSAGE_TYPES.joinAccept : GROUP_MESSAGE_TYPES.rejoinAccept,
    nodeId: 'peer', nodeVersion: '3.1.2', seq: 10, ts: f.clock.now(), body: {
      forNodeId: 'owner', sealed: sealGrant(grant(f, state), f.material.node.agreement.publicKey, path),
    } };
  return path === 'join' ? encodeJoinClassMessage(draft, envelopeGroup, f.material.joinVerifier)
    : encodeIdentityClassMessage(draft, envelopeGroup, f.material.groupSigning);
}
test('concurrent admission cannot replace the original pending owner or leak its deadline', async () => {
  const f = await fixture(), first = f.service.requestRejoin(1000);
  const second = await f.service.requestJoin({ groupId, joinKey, joinSalt: f.material.joinSalt, timeoutMs: 1000 });
  expect(second).toMatchObject({ ok: false, failure: 'not-sent' }); expect(f.clock.pendingTimers).toBe(1);
  f.service.abandon('fixture stop'); expect(await first).toMatchObject({ ok: false, failure: 'abandoned' });
  await f.service.join(); expect(f.clock.pendingTimers).toBe(0);
});
test('stop while actual scrypt is in flight abandons promptly and drains without a late JOIN', async () => {
  const f = await fixture(), pending = f.service.requestJoin({ groupId, joinKey, joinSalt: f.material.joinSalt, timeoutMs: 1000 });
  await Promise.resolve(); // The owned preparation has entered real asynchronous scrypt.
  f.service.stop('fixture shutdown'); expect(await pending).toMatchObject({ ok: false, failure: 'abandoned' });
  await f.service.join(); expect(f.sent).toEqual([]); expect(f.clock.pendingTimers).toBe(0);
  expect(await f.service.requestRejoin(1000)).toMatchObject({ ok: false, failure: 'not-sent' });
});
test('expired preparation cannot send or settle a newer admission owner', async () => {
  const f = await fixture(), first = f.service.requestJoin({ groupId, joinKey, joinSalt: f.material.joinSalt, timeoutMs: 1 });
  await Promise.resolve(); f.clock.advance(1); expect(await first).toMatchObject({ ok: false, failure: 'not-sent' });
  const nextGroup = 'gNEXTNEXTNEXTNEXT', second = f.service.requestJoin({ groupId: nextGroup, joinKey, joinSalt: deriveJoinSalt(nextGroup), timeoutMs: 1000 });
  await f.service.join(); expect(f.sent).toHaveLength(1); expect(readUnverifiedEnvelope(f.sent[0]!)?.envelope.groupId).toBe(nextGroup);
  f.service.abandon('finish'); expect(await second).toMatchObject({ ok: false, failure: 'abandoned' }); expect(f.clock.pendingTimers).toBe(0);
});
test('JOIN scalar binding is captured before asynchronous verifier derivation', async () => {
  const f = await fixture(), input = { groupId, joinKey, joinSalt: f.material.joinSalt, timeoutMs: 1000 };
  const pending = f.service.requestJoin(input); input.groupId = 'different'; input.joinSalt = 'different';
  const wire = await f.nextSend; expect(readUnverifiedEnvelope(wire)?.envelope.groupId).toBe(groupId);
  f.service.abandon('finish'); await pending; await f.service.join();
});
for (const path of ['join', 'rejoin'] as const) {
  test(`${path} rejects an authenticated foreign envelope and a foreign sealed roster before accepting its exact group`, async () => {
    const f = await fixture(), pending = path === 'join'
      ? f.service.requestJoin({ groupId, joinKey, joinSalt: f.material.joinSalt, timeoutMs: 1000 }) : f.service.requestRejoin(1000);
    await f.nextSend;
    const type = path === 'join' ? GROUP_MESSAGE_TYPES.joinAccept : GROUP_MESSAGE_TYPES.rejoinAccept;
    await f.service.handle(reply(f, path, 'foreign'), type); expect(f.clock.pendingTimers).toBe(1);
    await f.service.handle(reply(f, path, groupId, { ...f.state, groupId: 'foreign' }), type); expect(f.clock.pendingTimers).toBe(1);
    await f.service.handle(reply(f, path, groupId), type); expect(await pending).toMatchObject({ ok: true, grant: { state: { groupId } } });
    await f.service.join(); expect(f.clock.pendingTimers).toBe(0);
  });
}
for (const change of ['different-group', 'revoked-roster', 'shutdown'] as const) {
  test(`an incoming JOIN cannot grant secrets after delayed commit and ${change}`, async () => {
    const f = await fixture(), entered = deferred<void>(), release = deferred<void>(), joining = generateNodeKeyMaterial();
    f.delayCommit(async () => { entered.resolve(); await release.promise; });
    const raw = encodeJoinClassMessage({ type: GROUP_MESSAGE_TYPES.join, nodeId: 'joining', nodeVersion: '3.1.1', seq: 1,
      ts: f.clock.now(), body: { displayName: 'joining', identityKey: joining.identity.publicKey, agreementKey: joining.agreement.publicKey } }, groupId, f.material.joinVerifier);
    const handling = f.service.handle(raw, GROUP_MESSAGE_TYPES.join); await entered.promise;
    if (change === 'shutdown') f.service.stop('fixture stop');
    else if (change === 'different-group') f.setOwner({ ...f.material, groupId: 'other' }, { ...f.state, groupId: 'other' });
    else f.setOwner(f.material, f.state); // Original roster excludes the just-admitted requester.
    release.resolve(); await handling; await f.service.join(); expect(f.sent).toEqual([]);
  });
}
