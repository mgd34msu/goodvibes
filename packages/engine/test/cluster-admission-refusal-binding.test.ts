/**
 * cluster-admission-refusal-binding.test.ts, a refusal is only believed by the
 * machine whose own request it answers.
 *
 * Any datagram on the network that claims to be a REJOIN gets an answer from
 * every member, and the answer is signed with the member's real key. Without a
 * tie between the answer and the asker's own request, anything on the LAN could
 * send a request in a healthy machine's name and make it conclude it had been
 * removed from its own group.
 */
import { expect, test } from 'bun:test';
import { FakeClusterClock, GroupAdmissionService, createGroupKeyMaterial } from '../platform/src/platform/cluster/index.js';
import { encodeIdentityClassMessage, GROUP_MESSAGE_TYPES } from '../platform/src/platform/cluster/group-membership.js';
import { generateNodeKeyMaterial } from '../platform/src/platform/cluster/group-crypto.js';
import { admitMember, createGroupStateDocument, removeMember, type GroupStateDocument } from '../platform/src/platform/cluster/group-state.js';
import type { GroupKeyMaterial } from '../platform/src/platform/cluster/group-store.js';

const GROUP_ID = 'refusal-binding-group';

interface Machine {
  readonly service: GroupAdmissionService;
  readonly material: GroupKeyMaterial;
  readonly sent: string[];
  state: GroupStateDocument;
}

function machine(nodeId: string, clock: FakeClusterClock): Machine {
  const material = createGroupKeyMaterial({ groupId: GROUP_ID, joinKey: 'k', joinSalt: 's', joinVerifier: 'v', nodeId, now: clock.now() });
  const sent: string[] = [];
  let seq = 0;
  const built: Machine = {
    material, sent, state: createGroupStateDocument(GROUP_ID, 'group'),
    service: new GroupAdmissionService({
      nodeId, nodeDisplayName: nodeId, version: '1.0.0', clock,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      material: () => material,
      state: () => built.state,
      async commitState(state) { built.state = state; },
      async send(raw) { sent.push(raw); },
      nextSeq: () => ++seq,
    }),
  };
  return built;
}

async function turns(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve(); }

/** A member M, and a returning machine V that M's roster knows (or has removed). */
function world(options: { readonly removed: boolean }) {
  const clock = new FakeClusterClock();
  const victim = machine('victim', clock);
  const member = machine('member', clock);
  const add = (state: GroupStateDocument, who: string, source: Machine) => admitMember(state, {
    nodeId: who, displayName: who, identityKey: source.material.node.identity.publicKey, agreementKey: source.material.node.agreement.publicKey, now: clock.now(),
  }).state;
  // The returning machine remembers the member; the member's roster has the returning machine, or its removal.
  victim.state = add(victim.state, 'member', member);
  member.state = add(member.state, 'victim', victim);
  if (options.removed) member.state = removeMember(member.state, 'victim', 'removed by operator', clock.now());
  return { clock, victim, member };
}

function forgedRejoin(clock: FakeClusterClock): string {
  const attacker = generateNodeKeyMaterial();
  return encodeIdentityClassMessage({
    type: GROUP_MESSAGE_TYPES.rejoin, nodeId: 'victim', nodeVersion: '9.9.9', seq: 1, ts: clock.now(),
    body: { displayName: 'victim', identityKey: attacker.identity.publicKey, agreementKey: attacker.agreement.publicKey, heldGenerations: [0] },
  }, GROUP_ID, attacker.identity);
}

test('a refusal produced by a forged request in the machine\'s name does not tell it the group removed it', async () => {
  const { clock, victim, member } = world({ removed: false });
  const outcome = victim.service.requestRejoin(60_000);
  await turns();
  // The attacker's request reaches the member before (or beside) the real one.
  await member.service.handle(forgedRejoin(clock), GROUP_MESSAGE_TYPES.rejoin);
  expect(member.sent).toHaveLength(1);
  await victim.service.handle(member.sent[0]!, GROUP_MESSAGE_TYPES.rejoinRefuse);
  clock.advance(60_000);
  expect(await outcome).toMatchObject({ ok: false, failure: 'unverifiable-replies' });
});

test('a refusal to the machine\'s own request is final', async () => {
  const { clock, victim, member } = world({ removed: true });
  const outcome = victim.service.requestRejoin(60_000);
  await turns();
  expect(victim.sent).toHaveLength(1);
  await member.service.handle(victim.sent[0]!, GROUP_MESSAGE_TYPES.rejoin);
  expect(member.sent).toHaveLength(1);
  await victim.service.handle(member.sent[0]!, GROUP_MESSAGE_TYPES.rejoinRefuse);
  expect(await outcome).toMatchObject({ ok: false, failure: 'refused' });
  expect(clock.pendingTimers).toBe(0);
});

test('a refusal that does not name the request it answers is not obeyed', async () => {
  const { victim, member } = world({ removed: true });
  const outcome = victim.service.requestRejoin(60_000);
  await turns();
  await member.service.handle(victim.sent[0]!, GROUP_MESSAGE_TYPES.rejoin);
  const parsed = JSON.parse(member.sent[0]!) as Record<string, unknown>;
  const body = { ...(parsed['body'] as Record<string, unknown>) };
  delete body['forRequest'];
  // Re-signed by the member, as an older build (which sent no such field) would.
  const reissued = encodeIdentityClassMessage({
    type: GROUP_MESSAGE_TYPES.rejoinRefuse, nodeId: 'member', nodeVersion: '1.0.0', seq: 99, ts: Number(parsed['ts']), body,
  }, GROUP_ID, member.material.node.identity);
  await victim.service.handle(reissued, GROUP_MESSAGE_TYPES.rejoinRefuse);
  victim.service.abandon('test over');
  expect(await outcome).toMatchObject({ ok: false, failure: 'abandoned' });
});

test('a refusal to a copy of the machine\'s request with a changed field but the same signature is not obeyed', async () => {
  const { victim, member } = world({ removed: false });
  const outcome = victim.service.requestRejoin(60_000);
  await turns();
  const genuine = JSON.parse(victim.sent[0]!) as Record<string, unknown>;
  const altered = JSON.stringify({ ...genuine, ts: Number(genuine['ts']) + 1 });
  await member.service.handle(altered, GROUP_MESSAGE_TYPES.rejoin);
  expect(member.sent).toHaveLength(1);
  await victim.service.handle(member.sent[0]!, GROUP_MESSAGE_TYPES.rejoinRefuse);
  victim.service.abandon('test over');
  expect(await outcome).toMatchObject({ ok: false, failure: 'abandoned' });
});

test('a member answers a burst of forged requests with a bounded number of refusals', async () => {
  const { clock, member } = world({ removed: false });
  for (let index = 0; index < 100; index++) await member.service.handle(forgedRejoin(clock), GROUP_MESSAGE_TYPES.rejoin);
  expect(member.sent.length).toBeGreaterThan(0);
  expect(member.sent.length).toBeLessThanOrEqual(16);
  clock.advance(11_000);
  const before = member.sent.length;
  await member.service.handle(forgedRejoin(clock), GROUP_MESSAGE_TYPES.rejoin);
  expect(member.sent.length).toBe(before + 1);
});
